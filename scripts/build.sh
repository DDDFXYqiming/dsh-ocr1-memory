#!/bin/bash
# Build dsh-ocr1-memory: plain ESM plugin — no tsc host compilation.
# Validates all modules and self-heals the profile junction link.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Syntax check (node --check, all modules) ==="
npm run build

echo "=== Self-heal profile junction ==="
PROFILE_NM="${DSH_PROFILE_NODE_MODULES:-C:/Users/39795/.dsh/profiles/web/node_modules}"
if [ -d "$PROFILE_NM/@dsh-external" ]; then
  TARGET_WIN="$(cygpath -w "$ROOT" 2>/dev/null || (cd "$ROOT" && pwd -W 2>/dev/null) || echo "$ROOT")"
  LINK="$PROFILE_NM/@dsh-external/dsh-ocr1-memory"
  node -e "
    const fs = require('fs');
    const link = process.argv[1];
    const target = process.argv[2];
    let ok = false;
    try {
      const real = fs.realpathSync(link);
      const want = fs.realpathSync(target);
      ok = real.toLowerCase() === want.toLowerCase();
    } catch {}
    if (!ok) {
      fs.rmSync(link, { recursive: true, force: true });
      fs.mkdirSync(require('path').dirname(link), { recursive: true });
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      console.log('re-linked ' + link);
    } else {
      console.log('junction ok: ' + link);
    }
  " "$LINK" "$TARGET_WIN"
fi

echo "=== Build complete ==="