#!/bin/sh
# ============================================================================
# Pre-split guard runner — G1 … G5  (prep plan §10, readiness §B9.3)
# ============================================================================
#   G1  registry-only dependencies        (scripts/split-guards/g1-…)
#   G2  deep subpath ↔ package exports    (scripts/split-guards/g2-…)
#   G3  Job Protocol v2 parity            (scripts/split-guards/g3-…)
#   G4  GPU Hub standalone docker build   (packages/animastor-gpu-hub/tools/…)
#   G5  artifact integrity                (packages/animastor-gpu-hub/tools/…)
#
# G4/G5 need a docker daemon — pass --no-docker to run the fast guards only
# (the CI matrix runs G4/G5 on the gpu-hub runner).
#
# Exit 0 = all requested guards green.
# ============================================================================

set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

WITH_DOCKER=1
for arg in "$@"; do
    case "$arg" in
        --no-docker) WITH_DOCKER=0 ;;
        *) echo "usage: run-all.sh [--no-docker]" >&2; exit 2 ;;
    esac
done

run() {
    label=$1; shift
    echo
    echo "── ${label} ─────────────────────────────────────────────"
    "$@"
}

FAILED=""
if ! run "G1 registry-only deps"     sh   scripts/split-guards/g1-registry-only.sh; then FAILED="$FAILED G1"; fi
if ! run "G2 exports scan"           node scripts/split-guards/g2-exports-scan.cjs; then FAILED="$FAILED G2"; fi
if ! run "G3 protocol parity"        sh   scripts/split-guards/g3-protocol-parity.sh; then FAILED="$FAILED G3"; fi

if [ "$WITH_DOCKER" -eq 1 ]; then
    if ! run "G4 hub standalone build" sh packages/animastor-gpu-hub/tools/g4-standalone-build.sh; then FAILED="$FAILED G4"; fi
    if ! run "G5 artifact integrity"   sh packages/animastor-gpu-hub/tools/g5-artifact-integrity.sh; then FAILED="$FAILED G5"; fi
else
    echo
    echo "── G4/G5 skipped (--no-docker) ────────────────────────"
fi

echo
if [ -n "$FAILED" ]; then
    echo "split guards: FAILED —$FAILED" >&2
    exit 1
fi
echo "split guards: ALL GREEN (G1 G2 G3$([ "$WITH_DOCKER" -eq 1 ] && echo ' G4 G5'))"
