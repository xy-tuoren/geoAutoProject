#!/usr/bin/env bash
# Source this file to set UV_PYTHON to an interpreter with a working Tk.
# Apple's system Tk 8.5 shows blank windows on recent macOS.

if [[ -n "${UV_PYTHON:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi

_candidates=(
  /opt/homebrew/bin/python3.14
  /opt/homebrew/bin/python3.13
  /opt/homebrew/bin/python3.12
  /opt/homebrew/bin/python3
  /usr/local/bin/python3.14
  /usr/local/bin/python3.13
  /usr/local/bin/python3.12
  /usr/local/bin/python3
)

for _py in "${_candidates[@]}"; do
  if [[ -x "$_py" ]] && "$_py" -c 'import tkinter as t; assert float(t.TkVersion) >= 8.6' 2>/dev/null; then
    export UV_PYTHON="$_py"
    unset _py _candidates
    return 0 2>/dev/null || exit 0
  fi
done

unset _py _candidates
echo "未找到带可用 Tk(≥8.6) 的 Python。macOS 请先执行: brew install python-tk" >&2
echo "然后重新运行本脚本。也可手动设置: export UV_PYTHON=/opt/homebrew/bin/python3.14" >&2
return 1 2>/dev/null || exit 1
