"""Resolve project / bundle paths and the bundled adb binary."""

from __future__ import annotations

import os
import sys
from pathlib import Path

ADB_NAME = "adb.exe" if os.name == "nt" else "adb"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def app_root() -> Path:
    """Directory that contains the project scripts, or the frozen bundle resources."""
    if is_frozen():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def writable_root() -> Path:
    """User-writable directory for captures and temp files."""
    if is_frozen():
        return Path.home() / "Documents" / "XiaoheCaptures"
    return Path(__file__).resolve().parent


def _is_runnable(path: Path) -> bool:
    if not path.is_file():
        return False
    if os.name == "nt":
        return True
    return os.access(path, os.X_OK)


def adb_binary() -> Path:
    """Prefer bundled platform-tools, then PATH."""
    candidates = [
        app_root() / "platform-tools" / ADB_NAME,
        app_root() / "vendor" / "platform-tools" / ADB_NAME,
    ]
    if not is_frozen():
        candidates.insert(0, Path(__file__).resolve().parent / "vendor" / "platform-tools" / ADB_NAME)
    for path in candidates:
        if _is_runnable(path):
            return path

    from shutil import which

    found = which("adb")
    if found:
        return Path(found)
    raise FileNotFoundError(
        "找不到 adb。请使用打包版应用（已内置），或安装 Android Platform Tools。"
    )


def ensure_adb_env() -> Path:
    """Point subprocesses and adbutils at the resolved adb binary."""
    path = adb_binary()
    os.environ["ADBUTILS_ADB_PATH"] = str(path)
    bin_dir = str(path.parent)
    current = os.environ.get("PATH", "")
    if bin_dir not in current.split(os.pathsep):
        os.environ["PATH"] = bin_dir + os.pathsep + current
    return path
