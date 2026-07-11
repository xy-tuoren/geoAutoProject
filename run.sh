#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# shellcheck source=scripts/resolve_uv_python.sh
source "$SCRIPT_DIR/scripts/resolve_uv_python.sh"

uv sync
exec uv run python ask_xiaohe.py "$@"
