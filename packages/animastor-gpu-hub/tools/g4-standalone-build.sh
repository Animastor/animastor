#!/bin/sh
# ============================================================================
# G4 — GPU Hub build guard  (prep plan §10 / readiness §B9.2)
# ============================================================================
# Proves BOTH artifact-delivery modes of packages/animastor-gpu-hub/Dockerfile:
#
#   1. monorepo mode (pre-split default — what docker-compose builds):
#      context = repo root, stager-monorepo COPYs the 4 artifact groups,
#      sha256_tree gate runs before `COPY --from=stager`.
#   2. standalone mode (the future animastor-gpu-hub repo): a fixture repo
#      is materialised with ONLY the §8.5 hub paths (no backend/, no
#      packages/animastor-worker, no packages/animastor-installer), the 4
#      groups are served as pinned release zips over local HTTP, and the
#      image must build with --build-arg STAGER_STAGE=stager-release —
#      fetch verifies each asset sha256 against artifacts.lock.json, the
#      same gate runs pre-COPY, and the bake-in lands in the image.
#
# Static assertions (pre-COPY invariant + standalone cleanliness):
#   * staging gate line < COPY --from=stager line;
#   * stage picker exists with default stager-monorepo (compose-safe);
#   * the stager-release stage carries ZERO monorepo source references.
#
# Post-split (real standalone checkout, no monorepo sources): the script
# builds from the repo root with the committed pin and real release assets.
#
# Exit 0 = G4 green. Requires: docker (BuildKit), node, python3 (zip fixture).
# ============================================================================

set -eu

HUB_DIR=$(cd "$(dirname "$0")/.." && pwd)          # packages/animastor-gpu-hub
ROOT=$(cd "$HUB_DIR/../.." && pwd)
cd "$ROOT"
DOCKERFILE="$HUB_DIR/Dockerfile"

TAG_M=animastor-gpu-hub:guard
TAG_S=animastor-gpu-hub:guard-standalone

WORK=$(mktemp -d)
LOG_M="$WORK/build-monorepo.log"
LOG_S="$WORK/build-standalone.log"
SERVER_PID=""

cleanup() {
    if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
    rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

fail() { echo "G4 FAIL: $*" >&2; exit 1; }

echo "== G4: GPU Hub docker build =="

# ── 1. static assertions ───────────────────────────────────────────────────
# 1a. the sha256 staging gate runs BEFORE `COPY --from=stager` (§2.3)
gate_line=$(grep -nE '^[[:space:]]*RUN .*verify-staged-artifacts\.sh' "$DOCKERFILE" | head -n1 | cut -d: -f1 || true)
copy_line=$(grep -nE '^[[:space:]]*COPY --from=stager' "$DOCKERFILE" | head -n1 | cut -d: -f1 || true)
[ -n "$gate_line" ] && [ -n "$copy_line" ] \
    || fail "cannot locate the staging gate / COPY --from=stager in the Dockerfile"
[ "$gate_line" -lt "$copy_line" ] \
    || fail "staging gate (line $gate_line) does NOT run before COPY --from=stager (line $copy_line)"
echo "  ok: staging gate line $gate_line < COPY --from=stager line $copy_line"

# 1b. stage picker: default keeps the pre-split compose behaviour
grep -qE '^ARG STAGER_STAGE=stager-monorepo$' "$DOCKERFILE" \
    || fail "stager stage picker default missing (ARG STAGER_STAGE=stager-monorepo)"
grep -qE '^FROM \$\{STAGER_STAGE\} AS stager$' "$DOCKERFILE" \
    || fail "stager picker stage missing (FROM \${STAGER_STAGE} AS stager)"
echo "  ok: stage picker present (default = stager-monorepo, compose unchanged)"

# 1c. the standalone stager must not reference monorepo artifact sources
start=$(grep -nE 'AS stager-release$' "$DOCKERFILE" | head -n1 | cut -d: -f1 || true)
[ -n "$start" ] || fail "stager-release stage missing from the Dockerfile"
end=$(awk -v s="$start" 'NR > s && /^FROM / { print NR; exit }' "$DOCKERFILE")
[ -n "$end" ] || fail "no stage boundary found after stager-release"
rel_section=$(sed -n "${start},$((end - 1))p" "$DOCKERFILE")
echo "$rel_section" | grep -q 'fetch-pinned-assets.sh' \
    || fail "stager-release does not fetch the pinned release assets"
echo "$rel_section" | grep -q 'verify-staged-artifacts.sh' \
    || fail "stager-release lacks the sha256_tree staging gate"
if echo "$rel_section" | grep -qE 'animastor-worker|animastor-installer|backend/'; then
    fail "stager-release references monorepo sources (worker/backend/installer)"
fi
echo "  ok: stager-release standalone-clean (pinned fetch + gate, zero monorepo refs)"

# build-log assertion helper: with --progress=plain the gate either printed
# its success line in this build, or the step was executed/cached-verified.
log_gate_ok() { # <log> <run-pattern>
    grep -q 'artifact integrity gate: 4/4 groups match artifacts.lock.json (staging, pre-COPY)' "$1" \
        || { grep -A5 -F "$2" "$1" 2>/dev/null | grep -qE 'CACHED|DONE'; }
}

image_has_groups() { # <tag>
    docker run --rm --entrypoint sh "$1" -c \
        'set -e; for d in worker-bundle workflows installer-src install-manifests; do [ -d "/app/artifacts/$d" ]; done; [ -f /app/artifacts/worker-bundle/package.json ]'
}

HAS_MONO=0
if [ -d "$ROOT/packages/animastor-worker/worker" ] \
   && [ -d "$ROOT/backend/ai/workflows" ] \
   && [ -d "$ROOT/packages/animastor-installer" ]; then
    HAS_MONO=1
fi

# ── 2. monorepo mode (pre-split default — what compose builds) ─────────────
if [ "$HAS_MONO" -eq 1 ]; then
    echo "  build: monorepo mode (default stager) — context: $ROOT"
    DOCKER_BUILDKIT=1 docker build --progress=plain \
        -f packages/animastor-gpu-hub/Dockerfile -t "$TAG_M" "$ROOT" >"$LOG_M" 2>&1 \
        || { echo "G4 FAIL: monorepo docker build failed" >&2; tail -n 40 "$LOG_M" >&2; exit 1; }
    log_gate_ok "$LOG_M" 'RUN sh /staging/verify-staged-artifacts.sh' \
        || { echo "G4 FAIL: staging gate neither executed nor cache-verified (monorepo build)" >&2; tail -n 40 "$LOG_M" >&2; exit 1; }
    image_has_groups "$TAG_M" \
        || fail "baked-in artifact groups missing from the monorepo image"
    echo "  ok: monorepo build — gate pre-COPY, 4 groups baked ($TAG_M)"
else
    echo "  skip: monorepo sources absent — pre-split default build not applicable"
fi

# ── 3. standalone mode ─────────────────────────────────────────────────────
if [ "$HAS_MONO" -eq 1 ]; then
    # Pre-split proof: simulate the future repo from ONLY the §8.5 paths and
    # serve the 4 groups as pinned release zips (local GitHub Release stand-in).
    echo "  build: standalone mode (pinned release zips) — fixture repo"
    node "$HUB_DIR/tools/standalone-fixture.cjs" make "$WORK/fixture" \
        || fail "standalone fixture generation failed"

    node "$HUB_DIR/tools/standalone-fixture.cjs" serve "$WORK/fixture/assets" >"$WORK/port" &
    SERVER_PID=$!
    PORT=""
    i=0
    while [ "$i" -lt 100 ]; do
        PORT=$(sed -n 's/^PORT=//p' "$WORK/port" 2>/dev/null | head -n1 || true)
        [ -n "$PORT" ] && break
        sleep 0.1
        i=$((i + 1))
    done
    [ -n "$PORT" ] || fail "fixture asset server did not start"

    DOCKER_BUILDKIT=1 docker build --progress=plain --network=host \
        -f "$WORK/fixture/repo/packages/animastor-gpu-hub/Dockerfile" \
        --build-arg STAGER_STAGE=stager-release \
        --build-arg RELEASE_URL_BASE="http://127.0.0.1:$PORT" \
        -t "$TAG_S" "$WORK/fixture/repo" >"$LOG_S" 2>&1 \
        || { echo "G4 FAIL: standalone docker build failed" >&2; tail -n 40 "$LOG_S" >&2; exit 1; }
    grep -q 'pinned assets fetched and sha256-verified: 4/4' "$LOG_S" \
        || { grep -A5 -F 'RUN sh /staging/fetch-pinned-assets.sh' "$LOG_S" 2>/dev/null | grep -qE 'CACHED|DONE'; } \
        || { echo "G4 FAIL: pinned asset fetch did not run in the standalone build" >&2; tail -n 40 "$LOG_S" >&2; exit 1; }
    log_gate_ok "$LOG_S" 'RUN sh /staging/verify-staged-artifacts.sh' \
        || { echo "G4 FAIL: staging gate neither executed nor cache-verified (standalone build)" >&2; tail -n 40 "$LOG_S" >&2; exit 1; }
    image_has_groups "$TAG_S" \
        || fail "baked-in artifact groups missing from the standalone image"
    echo "  ok: standalone build from repo root — sha256(pin) fetch + gate pre-COPY, 4 groups baked ($TAG_S)"

    kill "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
else
    # Post-split reality: real standalone checkout, committed pin, real releases.
    echo "  build: standalone mode (committed pin, real release assets) — context: $ROOT"
    DOCKER_BUILDKIT=1 docker build --progress=plain \
        -f packages/animastor-gpu-hub/Dockerfile \
        --build-arg STAGER_STAGE=stager-release \
        -t "$TAG_S" "$ROOT" >"$LOG_S" 2>&1 \
        || { echo "G4 FAIL: standalone docker build failed" >&2; tail -n 40 "$LOG_S" >&2; exit 1; }
    grep -q 'pinned assets fetched and sha256-verified: 4/4' "$LOG_S" \
        || { grep -A5 -F 'RUN sh /staging/fetch-pinned-assets.sh' "$LOG_S" 2>/dev/null | grep -qE 'CACHED|DONE'; } \
        || { echo "G4 FAIL: pinned asset fetch did not run in the standalone build" >&2; tail -n 40 "$LOG_S" >&2; exit 1; }
    log_gate_ok "$LOG_S" 'RUN sh /staging/verify-staged-artifacts.sh' \
        || { echo "G4 FAIL: staging gate neither executed nor cache-verified (standalone build)" >&2; tail -n 40 "$LOG_S" >&2; exit 1; }
    image_has_groups "$TAG_S" \
        || fail "baked-in artifact groups missing from the standalone image"
    echo "  ok: standalone build from repo root — sha256(pin) fetch + gate pre-COPY, 4 groups baked ($TAG_S)"
fi

echo "G4: PASSED"
