#!/bin/sh
# ============================================================================
# G1 — registry-only dependency guard  (prep plan §10 / readiness §B9.2)
# ============================================================================
# Checks:
#   1. backend/package.json            — no "file:" / "link" specifiers
#   2. frontends/app/package.json      — no "file:" / "link" specifiers
#   3. the two package-lock.json files — 0 "file:" / 0 "link":true /
#      0 relative ("resolved": "../…") entries
#   4. docker-compose.yml              — no monorepo runtime mounts of
#      ./packages/** into /app/node_modules (the B2a mount set)
#
# After the physical split this script lives in animastor-backend
# (whitelist §8.1 keeps `scripts/`); the paths it cannot find are skipped,
# so the same file works in the monorepo and in the split repo.
#
# Exit 0 = G1 green, exit 1 = violation (with file:line on stderr).
# ============================================================================

set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

FAIL=0
note() { printf '  ok: %s\n' "$1"; }
bad()  { printf 'G1 FAIL: %s\n' "$1" >&2; FAIL=1; }

count() { # count <pattern> <file>  → number of matches (0 when absent/none)
    if [ ! -f "$2" ]; then echo 0; return 0; fi
    grep -c "$1" "$2" 2>/dev/null | head -n1 || true
}

check_manifest() {
    f=$1
    [ -f "$f" ] || return 0
    n=$(count '"file:' "$f")
    if [ "$n" != "0" ]; then bad "$f has $n \"file:\" specifier(s) — publish registry versions instead"; else note "$f: no \"file:\" specifiers"; fi
    n=$(count '"link"' "$f")
    if [ "$n" != "0" ]; then bad "$f has $n \"link\" specifier(s)"; else note "$f: no \"link\" specifiers"; fi
}

check_lock() {
    f=$1
    [ -f "$f" ] || return 0
    n=$(count '"file:' "$f")
    if [ "$n" != "0" ]; then bad "$f has $n \"file:\" entries"; else note "$f: 0 \"file:\" entries"; fi
    n=$(count '"link": true' "$f")
    if [ "$n" != "0" ]; then bad "$f has $n \"link\": true entries"; else note "$f: 0 \"link\":true entries"; fi
    n=$(count '"resolved": "\.\./' "$f")
    if [ "$n" != "0" ]; then bad "$f has $n relative \"resolved\" entries (../…) — regenerate against the registry"; else note "$f: 0 relative resolved entries"; fi
}

echo "== G1: registry-only dependencies =="

check_manifest backend/package.json
check_lock    backend/package-lock.json

check_manifest frontends/app/package.json
check_lock    frontends/app/package-lock.json

# B2a — the 5 read-only monorepo runtime mounts are gone from compose.
if [ -f docker-compose.yml ]; then
    n=$(grep -cE '^\s*-\s+\./packages/[a-z0-9-]+:.*:/app/' docker-compose.yml || true)
    if [ "$n" != "0" ]; then
        bad "docker-compose.yml has $n ./packages/** runtime mount(s) into /app"
    else
        note "docker-compose.yml: no ./packages/** runtime mounts into /app"
    fi
fi

if [ "$FAIL" -ne 0 ]; then
    echo "G1: FAILED" >&2
    exit 1
fi
echo "G1: PASSED"
exit 0
