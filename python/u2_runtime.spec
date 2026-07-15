from PyInstaller.utils.hooks import collect_data_files


u2_datas = collect_data_files("uiautomator2")
rapidocr_datas = collect_data_files("rapidocr")

a = Analysis(
    ["src/geoauto_u2/bridge.py"],
    pathex=["src"],
    binaries=[],
    datas=u2_datas + rapidocr_datas,
    hiddenimports=["rapidocr.inference_engine.onnxruntime"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="geoauto-u2",
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="geoauto-u2",
)
