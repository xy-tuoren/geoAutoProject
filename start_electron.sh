#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# GUI and automation launchers do not necessarily load ~/.zshrc, so npm may
# be installed through nvm but absent from their inherited PATH.
# shellcheck source=scripts/ensure-node-runtime.sh
source "$ROOT/scripts/ensure-node-runtime.sh"

if [[ ! -d node_modules/electron ]]; then
  npm install
fi

exec npm start
