#!/bin/sh
# ============================================================================
# G3 — Job Protocol v2 drift guard  (prep plan §10 / B6)
# ============================================================================
# The canonical protocol lives in @animastor/contracts (public package
# entrypoint — no deep `src/` import, no monorepo-relative candidate paths).
# The worker bundle carries a byte-exact generated copy; this guard fails on
# any drift.
#
#   owner after split: animastor-worker  (ci.yml)
#   backend keeps a facade-level copy of the same check until the split.
#
# Exit 0 = G3 green, exit 1 = protocol drift.
# ============================================================================

set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

TOOL=packages/animastor-worker/tools/sync-protocol.cjs
[ -f "$TOOL" ] || { echo "G3 FAIL: $TOOL not found" >&2; exit 1; }

echo "== G3: protocol parity (sync-protocol --check) =="
node "$TOOL" --check

# The worker dev harness must pin the canonical package (B6): without
# @animastor/contracts in devDependencies the check would silently lose its
# source of truth after the split.
node -e '
const fs = require("fs");
const p = "packages/animastor-worker/package.json";
const d = JSON.parse(fs.readFileSync(p, "utf8"));
const deps = Object.assign({}, d.dependencies, d.devDependencies);
if (!deps["@animastor/contracts"]) {
  console.error("G3 FAIL: " + p + " does not declare @animastor/contracts");
  process.exit(1);
}
console.log("  ok: worker devDependencies pin @animastor/contracts " + deps["@animastor/contracts"]);
'

echo "G3: PASSED"
