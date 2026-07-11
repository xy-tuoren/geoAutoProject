# Build a standalone Windows folder + zip with bundled Python deps + adb.
# Run this on a Windows machine (or via GitHub Actions). PyInstaller cannot
# cross-compile a Windows .exe from macOS.
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path (Join-Path $ScriptDir "..")
Set-Location $Root

$AppName = "小荷AI医生自动化"
$DistRoot = Join-Path $Root "dist"
$DistDir = Join-Path $DistRoot $AppName
$ZipPath = Join-Path $DistRoot ($AppName + "-Windows.zip")

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Error "未找到 uv。请先安装: https://docs.astral.sh/uv/getting-started/installation/"
  exit 1
}

uv sync --group build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

uv run python (Join-Path $ScriptDir "fetch_platform_tools.py") --os windows --force
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$BuildDir = Join-Path $Root "build"
if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
if (Test-Path $DistDir) { Remove-Item -Recurse -Force $DistDir }
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }

uv run pyinstaller --noconfirm (Join-Path $Root "xiaohe_panel.spec")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path (Join-Path $DistDir "$AppName.exe"))) {
  Write-Error "Build finished but $AppName.exe was not found under dist\"
  exit 1
}

Compress-Archive -Path $DistDir -DestinationPath $ZipPath -Force
Write-Host ""
Write-Host "打包完成: $DistDir"
Write-Host "分发压缩包: $ZipPath"
Write-Host "用户解压后双击 $AppName.exe；只需连接手机并授权 USB 调试。"
