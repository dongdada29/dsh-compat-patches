#!/usr/bin/env bash
set -euo pipefail
patch_repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  exec node "$patch_repo_dir/bin/dsh-patches.mjs" repair "$@"
fi
dsh_app_path="${DSH_APP:-/Applications/DeepSeek Harness.app}"
dsh_node_binary="$dsh_app_path/Contents/MacOS/DeepSeek Harness"
if [[ -x "$dsh_node_binary" ]]; then
  export ELECTRON_RUN_AS_NODE=1
  exec "$dsh_node_binary" "$patch_repo_dir/bin/dsh-patches.mjs" repair "$@"
fi
printf '%s\n' '需要 Node.js 24+，或已安装的 DeepSeek Harness.app。' >&2
exit 1
