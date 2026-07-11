#!/usr/bin/env bash
# Build a standalone macOS .app with bundled Python deps + adb.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

if [[ -z "${UV_PYTHON:-}" ]]; then
  # shellcheck source=resolve_uv_python.sh
  source "$SCRIPT_DIR/resolve_uv_python.sh"
fi

uv sync --group build
uv run python "$SCRIPT_DIR/fetch_platform_tools.py" --os darwin

rm -rf "$ROOT/build" "$ROOT/dist/小荷AI医生自动化.app" "$ROOT/dist/小荷AI医生自动化" "$ROOT/dist/小荷AI医生自动化-macOS.zip"
uv run pyinstaller --noconfirm "$ROOT/xiaohe_panel.spec"
# COLLECT 目录在打出 .app 后不再需要
rm -rf "$ROOT/dist/小荷AI医生自动化"

APP="$ROOT/dist/小荷AI医生自动化.app"
ZIP="$ROOT/dist/小荷AI医生自动化-macOS.zip"
if [[ -d "$APP" ]]; then
  rm -f "$ZIP"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
  echo
  echo "打包完成: $APP"
  echo "分发压缩包: $ZIP"
  echo "用户解压后拖到「应用程序」即可；只需连接手机并授权 USB 调试。"
else
  echo "未找到 .app，请检查 PyInstaller 输出。" >&2
  exit 1
fi
