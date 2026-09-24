"""Publish immutable Windows assets before switching the public update manifest."""

import argparse
import base64
from contextlib import closing
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import threading
import time

import crcmod
from qcloud_cos import CosConfig, CosS3Client, CosServiceError
import requests
import semver
import yaml

PREFIX = "geo-updates/win/"
FIXED_INSTALLER = "question-automation-electron-setup.exe"
PART_BYTES = 1024 * 1024
IDLE_SECONDS = 180
TRANSIENT = {"write_timeout", "read_timeout", "connect_timeout", "dns_error",
             "connection_reset", "connection_error", "timeout", "service_unavailable"}


class DeploymentError(Exception):
    pass


def event(name, **fields):
    print(json.dumps({"event": name, **fields}, ensure_ascii=False), flush=True)


def error_reason(error):
    # Never print SDK exception strings: they may contain signed URLs or credentials.
    message = str(error).lower()
    status = getattr(error, "get_status_code", lambda: None)()
    if status in (429, 500, 502, 503, 504):
        return "service_unavailable"
    for reason, markers in (
        ("write_timeout", ("write operation timed out",)),
        ("read_timeout", ("read timed out", "readtimeout")),
        ("connect_timeout", ("connecttimeout", "connection timed out")),
        ("dns_error", ("nameresolution", "name resolution", "getaddrinfo")),
        ("tls_error", ("sslerror", "certificate verify failed")),
        ("connection_reset", ("connection reset", "broken pipe", "remote end closed")),
        ("timeout", ("timeout", "timed out")),
        ("connection_error", ("connectionerror", "connection aborted", "failed to establish")),
    ):
        if any(marker in message for marker in markers):
            return reason
    return "unclassified_client_or_service_error"


@dataclass(frozen=True)
class Asset:
    path: Path
    size: int
    sha512: str
    crc64: str
    content_type: str

    @classmethod
    def read(cls, path, content_type):
        digest = hashlib.sha512()
        # Same CRC64 parameters used by COS SDK's download integrity check.
        crc = crcmod.Crc(0x142F0E1EBA9EA3693, initCrc=0,
                         xorOut=0xffffffffffffffff, rev=True)
        size = 0
        with path.open("rb") as stream:
            while chunk := stream.read(PART_BYTES):
                digest.update(chunk)
                crc.update(chunk)
                size += len(chunk)
        if not size:
            raise DeploymentError(f"Empty release asset: {path.name}")
        return cls(path, size, base64.b64encode(digest.digest()).decode(),
                   str(crc.crcValue), content_type)


def parse_manifest(body):
    if len(body) > 65536:
        raise DeploymentError("Update manifest exceeds 64 KiB")
    data = yaml.safe_load(body)
    if not isinstance(data, dict):
        raise DeploymentError("Invalid update manifest")
    version = semver.Version.parse(str(data.get("version", "")))
    if version.prerelease or version.build:
        raise DeploymentError("Only stable releases can update the production feed")
    return data


def load_release(directory, tag):
    body = (directory / "latest.yml").read_bytes()
    manifest = parse_manifest(body)
    version = manifest["version"]
    name = f"question-automation-electron-setup-{version}.exe"
    if tag != f"v{version}" or manifest.get("path") != name:
        raise DeploymentError("Release tag, version and installer path must match")
    installer = Asset.read(directory / name, "application/vnd.microsoft.portable-executable")
    files = manifest.get("files", [])
    if (manifest.get("sha512") != installer.sha512 or not isinstance(files, list)
            or len(files) != 1 or not isinstance(files[0], dict)
            or files[0].get("url") != name or files[0].get("sha512") != installer.sha512
            or files[0].get("size") != installer.size):
        raise DeploymentError("Installer size/SHA-512 differs from release manifest")
    blockmap = Asset.read(directory / f"{name}.blockmap", "application/octet-stream")
    return body, manifest, (installer, blockmap)


class UploadProgress:
    """Counts verified reuse separately from successful new transfers, per attempt."""

    def __init__(self, name, total, attempt, clock=time.monotonic):
        self.name, self.total, self.attempt, self.clock = name, total, attempt, clock
        self.started = self.last_advance = clock()
        self.reused = 0
        self.parts = {}
        self.failures = set()
        self.lock = threading.Lock()
        self.done = threading.Event()
        self.stalled = threading.Event()

    def set_reused(self, size):
        with self.lock:
            self.reused = size
            self.last_advance = self.clock()
        self.report()

    def uploaded(self, number, size):
        with self.lock:
            self.parts[number] = size
            self.last_advance = self.clock()

    def failed(self, number):
        with self.lock:
            self.failures.add(number)

    def snapshot(self):
        with self.lock:
            now = self.clock()
            sent = sum(self.parts.values())
            elapsed = max(now - self.started, 0.001)
            speed = sent / elapsed
            remaining = max(0, self.total - self.reused - sent)
            return dict(asset=self.name, attempt=self.attempt, reused_bytes=self.reused,
                        uploaded_bytes=sent, total_bytes=self.total,
                        bytes_per_second=round(speed),
                        eta_seconds=round(remaining / speed) if speed else None,
                        failed_parts=len(self.failures),
                        idle_seconds=round(now - self.last_advance))

    def report(self):
        event("upload_progress", **self.snapshot())

    def monitor(self):
        while not self.done.wait(10):
            state = self.snapshot()
            if state["idle_seconds"] >= IDLE_SECONDS:
                self.stalled.set()
                event("upload_stalled", **state)
                return
            if self.clock() - self.last_report >= 30:
                self.report()
                self.last_report = self.clock()

    def __enter__(self):
        self.last_report = self.clock()
        self.thread = threading.Thread(target=self.monitor, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.done.set()
        self.thread.join(timeout=1)
        self.report()


class ReleaseCosClient(CosS3Client):
    progress = None

    def _check_all_upload_parts(self, bucket, key, uploadid, local_path, parts_num,
                                part_size, last_size, already_exist_parts):
        # Pinned SDK 1.9.44 verifies each reused part's size and MD5 here.
        valid = super()._check_all_upload_parts(bucket, key, uploadid, local_path,
                                               parts_num, part_size, last_size, already_exist_parts)
        if self.progress:
            reused = sum(last_size if part == parts_num else part_size
                         for part in already_exist_parts) if valid else 0
            self.progress.set_reused(reused)
        return valid

    def upload_part(self, Bucket, Key, Body, PartNumber, UploadId, EnableMD5=False, **kwargs):
        if self.progress and self.progress.stalled.is_set():
            raise DeploymentError("No new successful parts for 180 seconds; stopping queued uploads")
        try:
            result = super().upload_part(Bucket, Key, Body, PartNumber, UploadId, EnableMD5, **kwargs)
            if self.progress:
                self.progress.uploaded(PartNumber, len(Body))
            return result
        except Exception as error:
            reason = error_reason(error)
            self.part_error_reasons.append(reason)
            if self.progress:
                self.progress.failed(PartNumber)
            event("part_failed", part=PartNumber, reason=reason,
                  status=getattr(error, "get_status_code", lambda: None)())
            raise


class Publisher:
    def __init__(self, client, bucket, region, tag, directory=Path("release-assets")):
        self.client, self.bucket, self.region, self.tag = client, bucket, region, tag
        self.directory = directory
        self.base = f"https://{bucket}.cos.{region}.myqcloud.com/{PREFIX}"

    def head(self, name):
        try:
            return {key.lower(): value for key, value in self.client.head_object(
                Bucket=self.bucket, Key=PREFIX + name).items()}
        except CosServiceError as error:
            if error.get_status_code() == 404:
                return None
            raise

    def current_manifest(self):
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=PREFIX + "latest.yml")
            with closing(response["Body"].get_raw_stream()) as stream:
                body = stream.read(65537)
            return body, parse_manifest(body)
        except CosServiceError as error:
            if error.get_status_code() == 404:
                return None, None
            raise

    def guard_version(self, manifest):
        body, current = self.current_manifest()
        if current:
            old = semver.Version.parse(str(current["version"]))
            new = semver.Version.parse(str(manifest["version"]))
            if old > new:
                raise DeploymentError(f"Refusing update downgrade: {old} -> {new}")
            if old == new and any(current.get(k) != manifest.get(k) for k in ("path", "sha512")):
                raise DeploymentError("Refusing to replace a published version with different bytes")
        return body

    @staticmethod
    def matches(head, asset):
        return bool(head and int(head.get("content-length", -1)) == asset.size
                    and head.get("x-cos-meta-sha512") == asset.sha512
                    and head.get("x-cos-hash-crc64ecma") == asset.crc64)

    def require_match(self, name, asset):
        head = self.head(name)
        if not self.matches(head, asset):
            raise DeploymentError(f"COS size/SHA-512 metadata/CRC64 verification failed: {name}")
        return head

    def copy(self, source, destination, asset, cache):
        self.client.copy_object(
            Bucket=self.bucket, Key=PREFIX + destination,
            CopySource={"Bucket": self.bucket, "Region": self.region, "Key": PREFIX + source},
            CopyStatus="Replaced", ACL="public-read", ContentType=asset.content_type,
            CacheControl=cache, Metadata={"x-cos-meta-sha512": asset.sha512})
        self.require_match(destination, asset)

    def reuse_legacy(self, name, asset, head):
        # Older releases lack SHA-512 metadata. Verify their actual body once before backfilling it.
        if (int(head.get("content-length", -1)) != asset.size
                or head.get("x-cos-hash-crc64ecma") != asset.crc64):
            return False
        event("legacy_object_hash_check", asset=name, bytes=asset.size)
        result = self.client.get_object(Bucket=self.bucket, Key=PREFIX + name)
        digest, size = hashlib.sha512(), 0
        started = last_report = time.monotonic()
        with closing(result["Body"].get_raw_stream()) as stream:
            while chunk := stream.read(PART_BYTES):
                digest.update(chunk)
                size += len(chunk)
                now = time.monotonic()
                if size > asset.size or now - started > 300:
                    raise DeploymentError("Legacy object verification exceeded size/time budget")
                if now - last_report >= 30:
                    event("legacy_object_hash_progress", asset=name, verified_bytes=size,
                          total_bytes=asset.size)
                    last_report = now
        if size != asset.size or base64.b64encode(digest.digest()).decode() != asset.sha512:
            return False
        self.copy(name, name, asset, "public, max-age=31536000, immutable")
        return True

    def reuse(self, asset):
        name = asset.path.name
        head = self.head(name)
        if head:
            if self.matches(head, asset) or (not head.get("x-cos-meta-sha512")
                                             and self.reuse_legacy(name, asset, head)):
                event("asset_reused", asset=name, bytes=asset.size)
                return True
            raise DeploymentError(f"Existing immutable release asset differs: {name}")
        return False

    def upload(self, asset):
        name = asset.path.name
        for attempt in range(1, 4):
            # A completion response can time out after COS already committed the object.
            if self.reuse(asset):
                return
            self.client.part_error_reasons = []
            uploaded = False
            with UploadProgress(name, asset.size, attempt) as progress:
                self.client.progress = progress
                try:
                    self.client.upload_file(
                        Bucket=self.bucket, Key=PREFIX + name, LocalFilePath=str(asset.path),
                        PartSize=1, MAXThread=3, EnableMD5=True, ACL="public-read",
                        ContentType=asset.content_type,
                        CacheControl="public, max-age=31536000, immutable",
                        Metadata={"x-cos-meta-sha512": asset.sha512})
                    if progress.stalled.is_set():
                        raise DeploymentError("Upload stopped after 180 seconds without progress")
                    if asset.size <= PART_BYTES:
                        progress.uploaded(1, asset.size)
                    uploaded = True
                except Exception as error:
                    if progress.stalled.is_set():
                        raise DeploymentError("Upload stopped after 180 seconds without progress") from None
                    reasons = set(self.client.part_error_reasons) or {error_reason(error)}
                    if attempt == 3 or not reasons <= TRANSIENT:
                        raise
                    event("upload_retry", asset=name, attempt=attempt, reasons=sorted(reasons))
                finally:
                    self.client.progress = None
            if uploaded:
                # Verification is not upload inactivity and must not skew upload throughput.
                # Resumed sessions created by older workflows may lack SHA metadata.
                head = self.head(name)
                if head and not head.get("x-cos-meta-sha512"):
                    self.reuse_legacy(name, asset, head)
                self.require_match(name, asset)
                event("asset_uploaded", asset=name, bytes=asset.size)
                return
            time.sleep(attempt * 2)

    def public_read(self, name, limit, headers=None):
        for attempt in range(1, 4):
            try:
                with requests.get(self.base + name, headers=headers, stream=True,
                                  timeout=(10, 30)) as response:
                    if response.status_code in (429, 500, 502, 503, 504) and attempt < 3:
                        event("public_read_retry", asset=name, attempt=attempt,
                              status=response.status_code)
                    else:
                        response.raise_for_status()
                        return response.status_code, response.headers, response.raw.read(limit)
            except Exception as error:
                if attempt == 3 or error_reason(error) not in TRANSIENT:
                    raise
                event("public_read_retry", asset=name, attempt=attempt, reason=error_reason(error))
            time.sleep(attempt * 2)

    def public_range(self, name, asset):
        # Read only the requested bytes, even if a server unexpectedly ignores Range.
        status, headers, body = self.public_read(name, 3, {"Range": "bytes=0-1"})
        if status != 206 or headers.get("Content-Range") != f"bytes 0-1/{asset.size}":
            raise DeploymentError(f"Public range verification failed: {name}")
        with asset.path.open("rb") as stream:
            if body != stream.read(2):
                raise DeploymentError(f"Public range content differs: {name}")

    def verify(self, assets):
        for asset in assets:
            self.require_match(asset.path.name, asset)
            self.public_range(asset.path.name, asset)
        event("versioned_assets_verified")

    def publish(self, body, manifest, assets):
        self.guard_version(manifest)
        self.verify(assets)
        installer = assets[0]
        if not self.matches(self.head(FIXED_INSTALLER), installer):
            self.copy(installer.path.name, FIXED_INSTALLER, installer, "no-cache")
            event("fixed_installer_copied")
        else:
            event("fixed_installer_reused")
        self.public_range(FIXED_INSTALLER, installer)
        # Recheck immediately before the mutable manifest write; workflows also share a lock.
        current = self.guard_version(manifest)
        if current != body:
            self.client.put_object(Bucket=self.bucket, Key=PREFIX + "latest.yml", Body=body,
                                   EnableMD5=True, ACL="public-read", ContentType="application/yaml",
                                   CacheControl="no-cache, no-store, must-revalidate")
        _, _, published = self.public_read("latest.yml", 65537)
        if published != body:
            raise DeploymentError("Published public manifest differs from release")
        event("manifest_published" if current != body else "manifest_reused", version=manifest["version"])

    def cleanup(self):
        _, current = self.current_manifest()
        if not current or f"v{current['version']}" != self.tag:
            raise DeploymentError("Cleanup target is no longer the published version")
        installers, marker = [], ""
        while True:
            result = self.client.list_objects(Bucket=self.bucket,
                Prefix=PREFIX + "question-automation-electron-setup-", Marker=marker, MaxKeys=1000)
            for item in result.get("Contents", []):
                match = re.fullmatch(re.escape(PREFIX) + r"question-automation-electron-setup-(.+)\.exe", item["Key"])
                if match:
                    try:
                        installers.append((semver.Version.parse(match[1]), item["Key"]))
                    except ValueError:
                        continue
            if str(result.get("IsTruncated", "false")).lower() != "true":
                break
            marker = result["NextMarker"]
        for _, key in sorted(installers, reverse=True)[5:]:
            if key == PREFIX + current["path"]:
                continue
            self.client.delete_object(Bucket=self.bucket, Key=key + ".blockmap")
            self.client.delete_object(Bucket=self.bucket, Key=key)
            event("stale_release_deleted", asset=key.removeprefix(PREFIX))

    def run(self, phase):
        if phase == "cleanup":
            return self.cleanup()
        body, manifest, assets = load_release(self.directory, self.tag)
        self.guard_version(manifest)
        if phase == "upload":
            for asset in assets:
                self.upload(asset)
        elif phase == "verify":
            self.verify(assets)
        elif phase == "publish":
            self.publish(body, manifest, assets)
        else:
            raise DeploymentError(f"Unknown deployment phase: {phase}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("upload", "verify", "publish", "cleanup"))
    parser.add_argument("--assets", type=Path, default=Path("release-assets"))
    args = parser.parse_args()
    bucket, region = os.environ["TENCENT_COS_BUCKET"], os.environ["TENCENT_COS_REGION"]
    client = ReleaseCosClient(CosConfig(Region=region,
        SecretId=os.environ["TENCENT_COS_SECRET_ID"], SecretKey=os.environ["TENCENT_COS_SECRET_KEY"],
        Scheme="https", Timeout=(30, 60), AutoSwitchDomainOnRetry=True), retry=1)
    publisher = Publisher(client, bucket, region, os.environ["RELEASE_TAG"], args.assets)
    try:
        publisher.run(args.phase)
        event("deployment_phase_complete", phase=args.phase)
    except Exception as error:
        fields = {"phase": args.phase, "type": type(error).__name__, "reason": error_reason(error)}
        if isinstance(error, DeploymentError):
            fields["message"] = str(error)
        event("deployment_phase_failed", **fields)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
