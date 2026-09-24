"""Offline deployment invariants. Run explicitly; no cloud or device access."""

import base64
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import deploy_cos_update as deploy


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.path = self.directory / "question-automation-electron-setup-1.2.3.exe"
        self.path.write_bytes(b"MZ-offline-installer")
        self.asset = deploy.Asset.read(self.path, "application/octet-stream")
        self.client = Mock()
        self.publisher = deploy.Publisher(self.client, "offline-123", "ap-guangzhou",
                                          "v1.2.3", self.directory)
        self.manifest = dict(version="1.2.3", path=self.path.name, sha512=self.asset.sha512)

    def head(self, asset=None):
        asset = asset or self.asset
        return {"content-length": str(asset.size), "x-cos-meta-sha512": asset.sha512,
                "x-cos-hash-crc64ecma": asset.crc64}

    def test_remote_complete_object_skips_transfer(self):
        self.client.head_object.return_value = self.head()
        self.publisher.upload(self.asset)
        self.client.upload_file.assert_not_called()
        self.client.copy_object.assert_not_called()

    def test_immutable_conflict_is_not_overwritten(self):
        self.client.head_object.return_value = {**self.head(), "content-length": "999"}
        with self.assertRaises(deploy.DeploymentError):
            self.publisher.upload(self.asset)
        self.client.upload_file.assert_not_called()

    def test_downgrade_and_same_version_changed_bytes_are_rejected(self):
        for current in ({**self.manifest, "version": "2.0.0"},
                        {**self.manifest, "sha512": "different"}):
            with self.subTest(current=current), patch.object(
                    self.publisher, "current_manifest", return_value=(b"old", current)):
                with self.assertRaises(deploy.DeploymentError):
                    self.publisher.guard_version(self.manifest)
        self.client.put_object.assert_not_called()

    def test_local_corruption_fails_before_cloud_access(self):
        manifest = {**self.manifest, "files": [dict(url=self.path.name,
                    size=self.asset.size, sha512=self.asset.sha512)]}
        (self.directory / "latest.yml").write_text(deploy.yaml.safe_dump(manifest))
        self.path.write_bytes(b"corrupted")
        with self.assertRaises(deploy.DeploymentError):
            self.publisher.run("upload")
        self.assertEqual(self.client.mock_calls, [])

    def test_public_asset_failure_never_writes_manifest(self):
        with patch.object(self.publisher, "guard_version"), patch.object(
                self.publisher, "require_match"), patch.object(self.publisher, "public_range",
                side_effect=deploy.DeploymentError("Range unavailable")):
            with self.assertRaises(deploy.DeploymentError):
                self.publisher.publish(b"new", self.manifest, [self.asset])
        self.client.put_object.assert_not_called()
        self.client.copy_object.assert_not_called()

    def test_fixed_installer_failure_keeps_previous_manifest(self):
        with patch.object(self.publisher, "guard_version"), patch.object(
                self.publisher, "verify"), patch.object(self.publisher, "head", return_value=None), \
                patch.object(self.publisher, "copy"), patch.object(self.publisher, "public_range",
                side_effect=deploy.DeploymentError("Fixed download unavailable")):
            with self.assertRaises(deploy.DeploymentError):
                self.publisher.publish(b"new", self.manifest, [self.asset])
        self.client.put_object.assert_not_called()
        self.client.upload_file.assert_not_called()

    def test_publish_recovery_reuses_fixed_object_and_rechecks_assets(self):
        self.client.head_object.return_value = self.head()
        with patch.object(self.publisher, "guard_version", return_value=b"new"), \
                patch.object(self.publisher, "verify") as verify, \
                patch.object(self.publisher, "public_range"), \
                patch.object(self.publisher, "public_read", return_value=(200, {}, b"new")):
            self.publisher.publish(b"new", self.manifest, [self.asset])
        verify.assert_called_once_with([self.asset])
        self.client.copy_object.assert_not_called()
        self.client.put_object.assert_not_called()
        self.client.upload_file.assert_not_called()

    def test_legacy_metadata_requires_real_sha_before_backfill(self):
        head = {k: v for k, v in self.head().items() if k != "x-cos-meta-sha512"}
        with self.path.open("rb") as stream, patch.object(self.publisher, "copy") as copy:
            self.client.get_object.return_value = {"Body": Mock(get_raw_stream=lambda: stream)}
            self.assertTrue(self.publisher.reuse_legacy(self.path.name, self.asset, head))
            copy.assert_called_once()
        self.path.write_bytes(b"bad body")
        with self.path.open("rb") as stream, patch.object(self.publisher, "copy") as copy:
            self.client.get_object.return_value = {"Body": Mock(get_raw_stream=lambda: stream)}
            self.assertFalse(self.publisher.reuse_legacy(self.path.name, self.asset, head))
            copy.assert_not_called()

    def test_resumed_legacy_multipart_backfills_metadata_without_reupload(self):
        head = {k: v for k, v in self.head().items() if k != "x-cos-meta-sha512"}
        with patch.object(self.publisher, "head", side_effect=[None, head, self.head()]), \
                patch.object(self.publisher, "reuse_legacy", return_value=True) as backfill:
            self.publisher.upload(self.asset)
        self.client.upload_file.assert_called_once()
        backfill.assert_called_once_with(self.path.name, self.asset, head)

    def test_reused_bytes_do_not_inflate_network_throughput(self):
        now = [0.0]
        progress = deploy.UploadProgress("file", 1000, 1, clock=lambda: now[0])
        progress.set_reused(800)
        now[0] = 10.0
        progress.uploaded(9, 100)
        state = progress.snapshot()
        self.assertEqual(state["bytes_per_second"], 10)
        self.assertEqual(state["eta_seconds"], 10)

    def test_stalled_queue_does_not_issue_more_network_writes(self):
        client = deploy.ReleaseCosClient(deploy.CosConfig(Region="ap-guangzhou",
                                           SecretId="offline", SecretKey="offline"))
        client.progress = deploy.UploadProgress("file", 1000, 1)
        client.progress.stalled.set()
        with patch.object(deploy.CosS3Client, "upload_part") as upload:
            with self.assertRaises(deploy.DeploymentError):
                client.upload_part("offline-123", "key", b"bytes", 1, "offline-id")
            upload.assert_not_called()

    def test_hashes_include_known_cos_crc_vector(self):
        self.path.write_bytes(b"123456789")
        asset = deploy.Asset.read(self.path, "application/octet-stream")
        self.assertEqual(asset.crc64, "11051210869376104954")
        self.assertEqual(asset.sha512, base64.b64encode(hashlib.sha512(b"123456789").digest()).decode())


if __name__ == "__main__":
    unittest.main()
