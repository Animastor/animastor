#!/bin/sh
# ============================================================================
# G5 — artifact integrity guard  (prep plan §10 / §2.3, B5)
# ============================================================================
# Layers, as defined by the readiness matrix:
#   1. lock freshness      — tools/update-artifacts-lock.cjs --check
#   2. staging gate (live) — scripts/verify-staged-artifacts.sh over a tree
#                            staged exactly like the Dockerfile stager
#   3. tamper resistance   — one byte appended to a staged group must make
#                            the gate exit non-zero
#   4. post-build check    — check-artifacts.sh inside the built image (6/6)
#
# Requires docker for layers 3–4 (the image is built by G4; this script
# builds it when absent). Exit 0 = G5 green.
# ============================================================================

set -eu

HUB_DIR=$(cd "$(dirname "$0")/.." && pwd)          # packages/animastor-gpu-hub
ROOT=$(cd "$HUB_DIR/../.." && pwd)
cd "$ROOT"

LOCK="$HUB_DIR/artifacts.lock.json"
GATE="$HUB_DIR/scripts/verify-staged-artifacts.sh"
TAG=animastor-gpu-hub:guard

echo "== G5: artifact integrity =="

# ── 1. lock freshness ──────────────────────────────────────────────────────
node "$HUB_DIR/tools/update-artifacts-lock.cjs" --check
echo "  ok: artifacts.lock.json in sync with the source trees"

# ── 2 + 3. staging gate over a freshly staged tree, then tamper test ───────
if [ -d "$ROOT/backend/ai/workflows" ] && [ -d "$ROOT/packages/animastor-worker/worker" ]; then
    STAGE=$(mktemp -d)
    trap 'rm -rf "$STAGE"' EXIT
    mkdir -p "$STAGE/worker-bundle" "$STAGE/workflows" "$STAGE/installer-src" "$STAGE/install-manifests"

    # Mirror the Dockerfile stager COPYs byte for byte.
    (cd "$ROOT/packages/animastor-worker/worker" && tar cf - .) | (cd "$STAGE/worker-bundle" && tar xf -)
    (cd "$ROOT/backend/ai/workflows"          && tar cf - .) | (cd "$STAGE/workflows"        && tar xf -)
    (cd "$ROOT/packages/animastor-installer/src/installer" && tar cf - .) | (cd "$STAGE/installer-src" && tar xf -)
    cp "$ROOT/packages/animastor-installer/package.json" "$STAGE/installer-src/package.json"
    (cd "$ROOT/packages/animastor-installer/ai/install-manifests" && tar cf - .) | (cd "$STAGE/install-manifests" && tar xf -)

    sh "$GATE" "$LOCK" "$STAGE" >/dev/null
    echo "  ok: staging gate exit 0 on a clean staged tree"

    printf 'x' >> "$STAGE/workflows/img-qwen-image.json"
    if sh "$GATE" "$LOCK" "$STAGE" >/dev/null 2>&1; then
        echo "G5 FAIL: staging gate accepted a tampered artifact group" >&2
        exit 1
    fi
    echo "  ok: staging gate exit 1 after a one-byte tamper (pre-COPY rejection)"
else
    echo "  skip: monorepo source trees absent (post-split layout) — release-asset staging applies"
fi

# ── 4. post-build check inside the image ───────────────────────────────────
if docker image inspect "$TAG" >/dev/null 2>&1 || sh "$HUB_DIR/tools/g4-standalone-build.sh" >/dev/null; then
    OUT=$(docker run --rm "$TAG" /app/scripts/check-artifacts.sh 2>&1) || {
        echo "G5 FAIL: check-artifacts.sh failed inside the image" >&2
        echo "$OUT" >&2
        exit 1
    }
    echo "$OUT" | grep -q 'ALL CHECKS PASSED' || {
        echo "G5 FAIL: check-artifacts.sh did not report ALL CHECKS PASSED" >&2
        echo "$OUT" >&2
        exit 1
    }
    echo "  ok: check-artifacts.sh 6/6 inside the built image"
else
    echo "G5 FAIL: hub image unavailable and docker build failed" >&2
    exit 1
fi

echo "G5: PASSED"
