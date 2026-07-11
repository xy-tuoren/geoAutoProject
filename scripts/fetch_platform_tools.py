#!/usr/bin/env python3
"""Download Google Android platform-tools into vendor/ for bundling."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
TARGET = VENDOR / "platform-tools"

URLS = {
    "darwin": "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip",
    "windows": "https://dl.google.com/android/repository/platform-tools-latest-windows.zip",
    "linux": "https://dl.google.com/android/repository/platform-tools-latest-linux.zip",
}


def detect_os() -> str:
    if sys.platform == "darwin":
        return "darwin"
    if sys.platform.startswith("win"):
        return "windows"
    return "linux"


def adb_name(os_name: str) -> str:
    return "adb.exe" if os_name == "windows" else "adb"


def copy_existing(src: Path, os_name: str) -> bool:
    binary = src / adb_name(os_name)
    if not binary.is_file():
        return False
    VENDOR.mkdir(parents=True, exist_ok=True)
    if TARGET.exists():
        shutil.rmtree(TARGET)
    shutil.copytree(src, TARGET)
    if os_name != "windows":
        TARGET.joinpath(adb_name(os_name)).chmod(0o755)
    print(f"Copied platform-tools from: {src}")
    return True


def local_candidates(os_name: str) -> list[Path]:
    home = Path.home()
    candidates = [
        Path(os.environ["ANDROID_HOME"]) / "platform-tools" if os.environ.get("ANDROID_HOME") else None,
        Path(os.environ["ANDROID_SDK_ROOT"]) / "platform-tools" if os.environ.get("ANDROID_SDK_ROOT") else None,
        home / ".local" / "share" / "android-platform-tools" / "platform-tools",
        Path("/opt/homebrew/share/android-platform-tools/platform-tools"),
        Path("/usr/local/share/android-platform-tools/platform-tools"),
        Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk" / "platform-tools",
    ]
    return [path for path in candidates if path is not None]


def download(os_name: str) -> None:
    url = URLS[os_name]
    VENDOR.mkdir(parents=True, exist_ok=True)
    print(f"Downloading platform-tools ({os_name})…")
    with tempfile.TemporaryDirectory(prefix="platform-tools-") as tmp:
        tmp_path = Path(tmp)
        zip_path = tmp_path / "platform-tools.zip"
        try:
            urllib.request.urlretrieve(url, zip_path)
        except Exception as exc:  # noqa: BLE001
            raise SystemExit(
                f"下载失败: {exc}\n请手动把 platform-tools 放到: {TARGET}"
            ) from exc
        with zipfile.ZipFile(zip_path) as archive:
            archive.extractall(tmp_path)
        extracted = tmp_path / "platform-tools"
        if TARGET.exists():
            shutil.rmtree(TARGET)
        shutil.move(str(extracted), str(TARGET))
    binary = TARGET / adb_name(os_name)
    if os_name != "windows":
        binary.chmod(0o755)
    if not binary.is_file():
        raise SystemExit(f"Download finished but {binary.name} is missing.")
    print(f"Installed: {binary}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--os",
        choices=sorted(URLS),
        default=detect_os(),
        help="Target OS for platform-tools (default: current machine).",
    )
    parser.add_argument("--force", action="store_true", help="Re-download even if present.")
    args = parser.parse_args()
    os_name: str = args.os
    binary = TARGET / adb_name(os_name)

    if binary.is_file() and not args.force:
        print(f"Already present: {binary}")
        return 0

    if not args.force:
        for candidate in local_candidates(os_name):
            if copy_existing(candidate, os_name):
                return 0

    download(os_name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
