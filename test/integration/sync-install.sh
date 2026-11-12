#!/usr/bin/env bash
# Copy the working tree into the disposable profile's installed package.
#
# pnpm materializes a `file:` dependency as a hard-linked copy, so edits to the
# working tree are not visible to a profile that already installed the plugin.
# The integration loop calls this between runs; the live desktop install uses
# the real `dsh plugin add` flow instead.
set -euo pipefail
profile="${1:?usage: sync-install.sh <profile-name>}"
source_dir="$(cd "$(dirname "$0")/../.." && pwd)"
modules="${DSH_HOME:-$HOME/.dsh}/profiles/$profile/node_modules"

sync() {
  local name="$1" source="$2"
  shift 2
  local target="$modules/$name"
  if [[ ! -d "$target" ]]; then
    echo "installed package not found: $target" >&2
    exit 1
  fi
  rm -rf "$target"
  mkdir -p "$target"
  for entry in "$@"; do
    cp -a "$source/$entry" "$target/$entry"
  done
  echo "synced $source -> $target"
}

sync dsh-plugin-presets "$source_dir" lib locale cordis.patch.yml icon.svg README.md LICENSE package.json
sync dsh-plugin-presets-it-fixture "$source_dir/test/integration/fixture" lib cordis.patch.yml package.json
sync dsh-plugin-presets-it-harness "$source_dir/test/integration/harness" lib cordis.patch.yml package.json
