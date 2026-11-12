#!/usr/bin/env bash
# Reset the disposable integration profile to its pristine state:
#   - bundles: dsh-base, the plugin itself, the harness (fixture is not live)
#   - cordis.patch.yml: comments plus an empty flow list (the shape that once
#     broke structured edits)
#   - plugin data directory and leftover export files removed
set -euo pipefail
profile="${1:?usage: reset-profile.sh <profile-name>}"
home_dir="${DSH_HOME:-$HOME/.dsh}"
profile_dir="$home_dir/profiles/$profile"

if [[ ! -d "$profile_dir" ]]; then
  echo "profile not found: $profile_dir" >&2
  exit 1
fi

node --input-type=module - "$profile_dir/package.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
const path = process.argv[2]
const manifest = JSON.parse(readFileSync(path, 'utf8'))
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles = [
  '@deepseek-ai/dsh-base',
  'dsh-plugin-presets',
  'dsh-plugin-presets-it-harness',
]
writeFileSync(path, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
NODE

cat > "$profile_dir/cordis.patch.yml" <<'EOF'
# Local profile patch for the integration profile.
# Keep this comment block to verify presets preserve patch comments.
[]
EOF

rm -rf "$home_dir/plugin-presets/$profile"
rm -f "$profile_dir"/preset-it-export-*.json "$profile_dir"/preset-it-bad-*.json
echo "reset $profile_dir"
