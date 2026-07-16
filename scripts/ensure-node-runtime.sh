#!/usr/bin/env bash

# Resolve Node.js for launchers that do not load the user's interactive shell
# configuration (for example Finder, Electron, or desktop automation tools).
ensure_node_runtime() {
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    local nvm_dir="${NVM_DIR:-${HOME:-}/.nvm}"
    if [[ -n "$nvm_dir" && -s "$nvm_dir/nvm.sh" ]]; then
      export NVM_DIR="$nvm_dir"
      # nvm selects its default Node version while it is initialised.
      # shellcheck source=/dev/null
      . "$NVM_DIR/nvm.sh"
    fi
  fi

  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "错误：当前启动环境找不到 Node.js/npm。请安装 Node.js 22+，或在 NVM_DIR（默认 ~/.nvm）中配置 nvm 默认版本。" >&2
    return 127
  fi

  local node_version node_major
  node_version="$(node --version 2>/dev/null || true)"
  if [[ "$node_version" =~ ^v([0-9]+) ]]; then
    node_major="${BASH_REMATCH[1]}"
  else
    echo "错误：无法识别 Node.js 版本：${node_version:-无输出}" >&2
    return 1
  fi

  if (( node_major < 22 )); then
    echo "错误：需要 Node.js 22+，当前版本为 $node_version。" >&2
    return 1
  fi
}

ensure_node_runtime
