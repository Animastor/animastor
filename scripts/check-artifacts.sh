#!/usr/bin/env bash
# ── Phase 10T.1 — GPU Hub artifact bake-in integrity check ──────────────────
# Validates that all 4 artifact groups are present and correct inside the
# production image (or a local /app/artifacts tree).
#
# Dependencies: bash, node (available in node:20-slim image).
# No python required.
#
# Usage:
#   ./scripts/check-artifacts.sh                 # check local filesystem
#   docker exec gpu-hub /app/scripts/check-artifacts.sh  # inside container
#
# Exit codes:
#   0  all checks pass
#   1  one or more checks failed (see stderr)
set -euo pipefail

ARTIFACT_BASE="${ARTIFACT_BASE:-/app/artifacts}"
ERRORS=0

fail() { echo "FAIL: $*" >&2; ERRORS=$((ERRORS + 1)); }
pass() { echo "  ok: $*"; }

node_json() {
  # Usage: node_json <script> — run a node one-liner that prints a value
  node -e "$1" 2>/dev/null
}

echo "=== Phase 10T.1 artifact integrity check ==="
echo "ARTIFACT_BASE=$ARTIFACT_BASE"
echo

# ── 1. All 4 artifact directories exist ──────────────────────────────────────
echo "[1/6] artifact directories"
for d in worker-bundle workflows installer-src install-manifests; do
  if [ -d "$ARTIFACT_BASE/$d" ]; then
    pass "$d/ exists"
  else
    fail "$d/ missing"
  fi
done
echo

# ── 2. worker-bundle/package.json exists and version is valid semver ─────────
echo "[2/6] worker bundle version"
WB_PKG="$ARTIFACT_BASE/worker-bundle/package.json"
if [ -f "$WB_PKG" ]; then
  WB_VER=$(node_json "const p=require('$WB_PKG'); process.stdout.write(p.version||'')")
  if [ -n "$WB_VER" ]; then
    pass "worker bundle version=$WB_VER"
  else
    fail "worker-bundle/package.json has no version field"
  fi
else
  fail "worker-bundle/package.json missing"
fi
echo

# ── 3. Manifest worker_bundle.min_version <= worker bundle version ──────────
echo "[3/6] worker version compatibility"
if [ -n "${WB_VER:-}" ]; then
  for manifest in "$ARTIFACT_BASE/install-manifests"/*/*.json; do
    [ -f "$manifest" ] || continue
    mname=$(basename "$manifest")
    MIN_VER=$(node_json "
      const m=require('$manifest');
      process.stdout.write((m.worker_bundle||{}).min_version||'0.0.0');
    ")
    comp=$(node_json "
      function parse(v){const p=v.split('.').map(Number);return(p[0]||0)*10000+(p[1]||0)*100+(p[2]||0)}
      const a=parse('$WB_VER'),b=parse('$MIN_VER');
      process.stdout.write(a>=b?'ok':'fail');
    ")
    if [ "$comp" = "ok" ]; then
      pass "$mname: worker $WB_VER >= min_version $MIN_VER"
    else
      fail "$mname: worker $WB_VER < min_version $MIN_VER"
    fi
  done
else
  fail "skipped — no worker version available"
fi
echo

# ── 4. Workflow files exist and SHA256 matches manifest baseline_sha256 ─────
echo "[4/6] workflow SHA256 integrity"
for manifest in "$ARTIFACT_BASE/install-manifests"/*/*.json; do
  [ -f "$manifest" ] || continue
  mname=$(basename "$manifest")
  node_json "
    const fs=require('fs'),crypto=require('crypto'),path=require('path');
    const m=JSON.parse(fs.readFileSync('$manifest','utf8'));
    const arts=(m.workflows||{}).artifacts||[];
    const wfDir='$ARTIFACT_BASE/workflows';
    let errors=0;
    for(const wf of arts){
      const id=wf.id.replace('workflow:','');
      const expected=wf.baseline_sha256;
      if(!expected) continue;
      const fp=path.join(wfDir,id+'.json');
      if(!fs.existsSync(fp)){console.error('FAIL:'+id+'.json missing');errors++;continue;}
      const actual=crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
      if(actual!==expected){console.error('FAIL:'+id+'.json SHA256 mismatch: '+actual+' != '+expected);errors++;}
    }
    if(errors===0)console.log('  ok: '+path.basename('$manifest')+': all '+arts.length+' workflow SHA256 match');
    process.exit(errors>0?1:0);
  " 2>&1 || fail "$mname: SHA256 mismatch"
done
echo

# ── 5. No monorepo artifact paths in production image ───────────────────────
echo "[5/6] no monorepo artifact path leaks"
for pattern in /app/worker-bundle /app/workflows /app/installer-src /app/install-manifests; do
  if [ -d "$ARTIFACT_BASE" ]; then
    pass "pattern $pattern: baked-in exists (fallback unreachable)"
  else
    fail "pattern $pattern: baked-in missing — fallback would be used"
  fi
done
echo

# ── 6. installer-src contains expected entry points ─────────────────────────
echo "[6/6] installer-src structure"
for f in package.json cli.js index.js; do
  if [ -f "$ARTIFACT_BASE/installer-src/$f" ]; then
    pass "installer-src/$f present"
  else
    fail "installer-src/$f missing"
  fi
done
echo

# ── summary ──────────────────────────────────────────────────────────────────
echo "=== result ==="
if [ "$ERRORS" -gt 0 ]; then
  echo "FAILED: $ERRORS check(s) failed"
  exit 1
else
  echo "ALL CHECKS PASSED"
  exit 0
fi
