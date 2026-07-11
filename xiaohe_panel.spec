# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Xiaohe operator desktop panel (macOS + Windows)."""

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files

ROOT = Path(SPECPATH).resolve()
APP_NAME = "小荷AI医生自动化"
ADB_NAME = "adb.exe" if sys.platform == "win32" else "adb"

u2_datas, u2_binaries, u2_hidden = collect_all("uiautomator2")
adb_datas, adb_binaries, adb_hidden = collect_all("adbutils")
openpyxl_datas = collect_data_files("openpyxl")

platform_tools = ROOT / "vendor" / "platform-tools"
if not (platform_tools / ADB_NAME).is_file():
    raise SystemExit(
        f"Missing vendor/platform-tools/{ADB_NAME}. "
        "Run scripts/fetch_platform_tools.py first."
    )

datas = [
    *u2_datas,
    *adb_datas,
    *openpyxl_datas,
    (str(platform_tools), "platform-tools"),
]

a = Analysis(
    [str(ROOT / "desktop_app.py")],
    pathex=[str(ROOT)],
    binaries=[*u2_binaries, *adb_binaries],
    datas=datas,
    hiddenimports=[
        *u2_hidden,
        *adb_hidden,
        "ask_xiaohe",
        "paths",
        "openpyxl",
        "uiautomator2",
        "adbutils",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=APP_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=sys.platform == "darwin",
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name=APP_NAME,
)

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name=f"{APP_NAME}.app",
        icon=None,
        bundle_identifier="com.geoauto.xiaohe.panel",
        info_plist={
            "CFBundleName": APP_NAME,
            "CFBundleDisplayName": APP_NAME,
            "CFBundleShortVersionString": "0.1.0",
            "NSHighResolutionCapable": True,
            "LSMinimumSystemVersion": "11.0",
        },
    )
