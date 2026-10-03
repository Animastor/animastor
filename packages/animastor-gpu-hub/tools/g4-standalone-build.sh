#!/bin/sh
# ============================================================================
# G4 — GPU Hub standalone build guard  (prep plan §10 / readiness §B9.2)
# ============================================================================
# Builds the hub image and asserts the artifact contract holds at build time:
#   * the SHA256 staging gate runs BEFORE `COPY --from=stager`
#     (static assertion on the Dockerfile line numbers), and
#   * the build log proves the gate and the bake-in actually executed.
#
# Layout detection:
#   * monorepo layout (packages/animastor-worker/ + backend/ present)
#       → build context = repo root, dockerfile = packages/animastor-gpu-hub/Dockerfile
#       (the stager COPYs the 4 groups out of the monorepo — pre-split reality)
#   * standalone layout (the future animastor-gpu-hub repo)
#       → build context = this package directory
#
# Exit 0 = G4 green.
# ============================================================================

set -eu

HUB_DIR=$(cd "$(dirname "$0")/.." && pwd)          # packages/animastor-gpu-hub
ROOT=$(cd "$HUB_DIR/../.." && pwd)
cd "$ROOT"

DOCKERFILE="$HUB_DIR/Dockerfile"
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT

echo "== G4: GPU Hub docker build =="

# ── 1. static assertion: gate ordering (pre-COPY checksum invariant) ──────
gate_line=$(grep -nE '^[[:space:]]*RUN .*verify-staged-artifacts\.sh' "$DOCKERFILE" | head -n1 | cut -d: -f1 || true)
copy_line=$(grep -nE '^[[:space:]]*COPY --from=stager' "$DOCKERFILE" | head -n1 | cut -d: -f1 || true)
if [ -z "$gate_line" ] || [ -z "$copy_line" ]; then
    echo "G4 FAIL: cannot locate the staging gate / COPY --from=stager in the Dockerfile" >&2
    exit 1
fi
if [ "$gate_line" -ge "$copy_line" ]; then
    echo "G4 FAIL: staging gate (line $gate_line) does NOT run before COPY --from=stager (line $copy_line)" >&2
    exit 1
fi
echo "  ok: staging gate line $gate_line < COPY --from=stager line $copy_line"

# ── 2. build ───────────────────────────────────────────────────────────────
if [ -d "$ROOT/packages/animastor-worker" ] && [ -d "$ROOT/backend" ]; then
    CONTEXT="$ROOT"
    DF_ARG="-f packages/animastor-gpu-hub/Dockerfile"
    MODE="monorepo-layout"
else
    CONTEXT="$HUB_DIR"
    DF_ARG="-f Dockerfile"
    MODE="standalone-layout"
fi

TAG=animastor-gpu-hub:guard
echo "  mode: $MODE"
echo "  context: $CONTEXT"

# shellcheck disable=SC2086
docker build $DF_ARG -t "$TAG" "$CONTEXT" >"$LOG" 2>&1 || {
    echo "G4 FAIL: docker build failed" >&2
    tail -n 40 "$LOG" >&2
    exit 1
}

grep -q 'artifact integrity gate: 4/4 groups match artifacts.lock.json (staging, pre-COPY)' "$LOG" \
    || grep -A1 -F 'RUN sh /staging/verify-staged-artifacts.sh' "$LOG" | grep -q 'CACHED' || {
    echo "G4 FAIL: staging gate neither executed nor cached-verified in this build" >&2
    tail -n 40 "$LOG" >&2
    exit 1
}

# The bake-in is asserted against the IMAGE (not the log) so a fully cached
# build still proves the 4 groups are actually present in /app/artifacts.
docker run --rm --entrypoint sh "$TAG" -c \
    'set -e; for d in worker-bundle workflows installer-src install-manifests; do [ -d "/app/artifacts/$d" ]; done; [ -f /app/artifacts/worker-bundle/package.json ]' \
    || { echo "G4 FAIL: baked-in artifact groups missing from the image" >&2; exit 1; }

echo "  ok: staging gate executed (or cache-verified) before COPY --from=stager"
echo "  ok: 4 artifact groups baked into the image"
echo "  ok: image built ($TAG)"
echo "G4: PASSED"
