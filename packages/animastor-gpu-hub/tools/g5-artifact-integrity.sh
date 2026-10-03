#!/bin/sh
# ============================================================================
# G5 — artifact integrity guard  (prep plan §10 / §2.3, B5)
# ============================================================================
# Layers (each one is a real integrity check, not a static assertion):
#   1. lock freshness      — tools/update-artifacts-lock.cjs --check
#                            (needs the monorepo source trees)
#   1b. release-asset flow — ALWAYS: the 4 groups are materialised PURELY from
#                            the pinned release URL (repo/tag/asset filename) —
#                            no monorepo source tree is read — and every body
#                            must match sha256_asset. Pre-split the release is
#                            a local stand-in (fixture zips served at the
#                            GitHub path shape); post-split it is the real
#                            release base from the Dockerfile (G5_RELEASE_BASE
#                            overrides). This layer IS the post-split lock
#                            freshness check: the committed pin file against
#                            the materialised release artifacts.
#   2. staging gate (live) — scripts/verify-staged-artifacts.sh over a tree
#                            staged exactly like the Dockerfile stager;
#                            a one-byte tamper must make the gate exit non-zero
#   3. post-build check    — check-artifacts.sh inside BOTH built images
#                            (monorepo-mode and standalone-mode, 6/6)
#   4. post-split run      — the §8.5-only checkout built by the fixture has
#                            no monorepo sources: re-running THIS script there
#                            executes layers 1b/5/6 as the post-split repo
#                            would (zero backend/, worker/, installer/)
#   5. standalone asset pin — a served release zip with one appended byte must
#                            fail the standalone build at the sha256_asset pin
#                            (pre-COPY rejection)
#   6. standalone tree pin — correct asset bytes + a corrupted sha256_tree in
#                            the lock must fail the standalone build at the
#                            sha256_tree gate (pre-COPY rejection)
#
# Layers 1b/5/6 are the POST-SPLIT artifact flow and run in BOTH layouts: they
# are driven only by the pin file + release assets (G4's standalone-fixture:
# §8.5-only repo + pinned zips over HTTP) — the real release flow without
# publishing anything. Layer 4 re-runs this guard in that standalone checkout,
# so the post-split branch is executed on every run instead of being skipped.
# Layers 1/2 are monorepo-only staging inputs.
#
# Requires docker (layers 3–6; images come from G4 and are built on demand).
# Exit 0 = G5 green.
# ============================================================================

set -eu

HUB_DIR=$(cd "$(dirname "$0")/.." && pwd)          # packages/animastor-gpu-hub
ROOT=$(cd "$HUB_DIR/../.." && pwd)
cd "$ROOT"

LOCK="$HUB_DIR/artifacts.lock.json"
GATE="$HUB_DIR/scripts/verify-staged-artifacts.sh"
DOCKERFILE="$HUB_DIR/Dockerfile"
FIXTURE="$HUB_DIR/tools/standalone-fixture.cjs"
TAG_M=animastor-gpu-hub:guard
TAG_S=animastor-gpu-hub:guard-standalone

# Release base = the Dockerfile default (real GitHub) unless overridden.
RELEASE_BASE=${G5_RELEASE_BASE:-$(sed -n 's/^ARG RELEASE_URL_BASE=//p' "$DOCKERFILE" | head -n1)}
[ -n "$RELEASE_BASE" ] || RELEASE_BASE=https://github.com/Animastor
# Per-run id appended to every local release URL: the fetch RUN layer is
# cache-busted even if the ephemeral port is reused, so a tampered asset can
# never be served from a previous run's build cache.
RUN_ID=$(date +%s)-$$

WORK=$(mktemp -d)
SERVER_PID=""
cleanup() {
    if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
    rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

fail() { echo "G5 FAIL: $*" >&2; exit 1; }

echo "== G5: artifact integrity =="

HAS_MONO=0
if [ -d "$ROOT/backend/ai/workflows" ] \
   && [ -d "$ROOT/packages/animastor-worker/worker" ] \
   && [ -d "$ROOT/packages/animastor-installer" ]; then
    HAS_MONO=1
fi

# ── fixture asset server ────────────────────────────────────────────────────
serve_start() { # <asset-dir> — sets PORT + BASE_PRE (restarts the server)
    if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""; fi
    rm -f "$WORK/port"
    node "$FIXTURE" serve "$1" >"$WORK/port" &
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
    BASE_PRE="http://127.0.0.1:$PORT"
}

build_standalone() { # <fixture-dir> <url-case> <tag> <logfile> → docker exit
    DOCKER_BUILDKIT=1 docker build --progress=plain --network=host \
        -f "$1/repo/packages/animastor-gpu-hub/Dockerfile" \
        --build-arg STAGER_STAGE=stager-release \
        --build-arg RELEASE_URL_BASE="$BASE_PRE/$2/$RUN_ID" \
        -t "$3" "$1/repo" >"$4" 2>&1
}

# ── 1. lock freshness (monorepo staging inputs) ─────────────────────────────
if [ "$HAS_MONO" -eq 1 ]; then
    node "$HUB_DIR/tools/update-artifacts-lock.cjs" --check
    echo "  ok: artifacts.lock.json in sync with the source trees"
else
    echo "  info: lock --check needs monorepo source trees — post-split the"
    echo "        equivalent is layer 1b (pin file vs materialised release assets)"
fi

# ── 1b. release-asset materialisation — the POST-SPLIT flow, always ────────
if [ "$HAS_MONO" -eq 1 ]; then
    # Pre-split stand-in: build the release zips from the committed GROUPS,
    # serve them at the exact GitHub release path shape, then re-materialise
    # them through the SAME acquisition code post-split uses (download →
    # sha256_asset → pin file verbatim → §8.5 repo, zero monorepo reads).
    node "$FIXTURE" make "$WORK/fx-release" \
        || fail "standalone fixture generation failed"
    serve_start "$WORK/fx-release/assets"
    node "$FIXTURE" assets-from-release "$WORK/fx-dl" \
        "$BASE_PRE/release/$RUN_ID" "$WORK/fx-release/artifacts.lock.json" \
        || fail "release-asset materialisation failed (stand-in release)"
else
    # Post-split reality: the committed pin file + the real release base.
    node "$FIXTURE" assets-from-release "$WORK/fx-dl" "$RELEASE_BASE" \
        || fail "release-asset materialisation failed ($RELEASE_BASE) — pinned releases must exist"
fi
echo "  ok: 4 groups materialised from <repo>/releases/download/<tag>/<asset>, sha256_asset verified"

# ── 2 + 3. staging gate over a freshly staged tree, then tamper test ───────
if [ "$HAS_MONO" -eq 1 ]; then
    STAGE="$WORK/stage"
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
        fail "staging gate accepted a tampered artifact group"
    fi
    echo "  ok: staging gate exit 1 after a one-byte tamper (pre-COPY rejection)"
else
    echo "  skip: monorepo staging layers (post-split layout) — release-asset layers apply"
fi

# ── 4. images exist (both delivery modes) ──────────────────────────────────
need_build=0
if ! docker image inspect "$TAG_S" >/dev/null 2>&1; then need_build=1; fi
if [ "$HAS_MONO" -eq 1 ] && ! docker image inspect "$TAG_M" >/dev/null 2>&1; then need_build=1; fi
if [ "$need_build" -eq 1 ]; then
    echo "  building guard images via G4 ..."
    sh "$HUB_DIR/tools/g4-standalone-build.sh" >/dev/null \
        || fail "G4 (image build) failed — cannot verify image integrity"
fi

run_check() { # <tag> <label>
    OUT=$(docker run --rm "$1" /app/scripts/check-artifacts.sh 2>&1) || {
        echo "$OUT" >&2; fail "check-artifacts.sh failed inside $1"; }
    echo "$OUT" | grep -q 'ALL CHECKS PASSED' || {
        echo "$OUT" >&2; fail "check-artifacts.sh did not report ALL CHECKS PASSED in $1"; }
    echo "  ok: check-artifacts.sh 6/6 inside $2 ($1)"
}

if [ "$HAS_MONO" -eq 1 ]; then
    run_check "$TAG_M" "monorepo image"
fi
run_check "$TAG_S" "standalone image"

# ── 4. POST-SPLIT run — this guard executed in a standalone checkout ───────
# The §8.5-only tree built by the fixture (hub package + root
# scripts/check-artifacts.sh + this tool dir) has NO backend/, NO
# packages/animastor-worker, NO packages/animastor-installer — so re-running
# THIS script there exercises the post-split branch for real: layer 1b
# acquires the 4 groups from the release URL and layers 5/6 below reject both
# tampered assets, with zero monorepo sources available. G5_POST_SPLIT stops
# the recursion.
if [ "$HAS_MONO" -eq 1 ] && [ -z "${G5_POST_SPLIT:-}" ]; then
    PS_ROOT="$WORK/fx-release/repo"
    rm -rf "$PS_ROOT/packages/animastor-gpu-hub/tools"
    cp -r "$HUB_DIR/tools" "$PS_ROOT/packages/animastor-gpu-hub/tools"
    serve_start "$WORK/fx-release/assets"
    if ! G5_POST_SPLIT=1 G5_RELEASE_BASE="$BASE_PRE/release/$RUN_ID" \
        sh "$PS_ROOT/packages/animastor-gpu-hub/tools/g5-artifact-integrity.sh" \
        >"$WORK/post-split.log" 2>&1; then
        tail -n 60 "$WORK/post-split.log" >&2
        fail "post-split (asset-only) run of this guard failed"
    fi
    grep -q 'G5: PASSED' "$WORK/post-split.log" || {
        tail -n 60 "$WORK/post-split.log" >&2
        fail "post-split run finished 0 but did not report G5: PASSED"; }
    echo "  ok: post-split run (standalone checkout, zero monorepo sources):"
    sed 's/^/      /' "$WORK/post-split.log"
fi

# ── 5 + 6. standalone tamper resistance (release/pinned-asset path) ────────
# Runs in BOTH layouts: inputs are the materialised release assets only.
# 5. asset pin: one byte appended to a served zip must fail the build
cp -r "$WORK/fx-dl" "$WORK/fx-asset"
printf 'x' >> "$WORK/fx-asset/assets/hub-workflows-v1.zip"
serve_start "$WORK/fx-asset/assets"
if build_standalone "$WORK/fx-asset" "asset-tamper" "animastor-gpu-hub:guard-tamper-asset" "$WORK/log-asset"; then
    fail "standalone build ACCEPTED a tampered release asset (sha256_asset pin broken)"
fi
grep -q 'asset sha256 mismatch' "$WORK/log-asset" || {
    tail -n 40 "$WORK/log-asset" >&2
    fail "tamper build failed, but not at the asset sha256 pin"; }
echo "  ok: standalone build rejected the tampered asset (sha256_asset pin, pre-COPY)"

# 6. tree pin: correct asset bytes, corrupted sha256_tree in the lock →
#    the asset pin passes and the sha256_tree gate must still stop it
cp -r "$WORK/fx-dl" "$WORK/fx-tree"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const lock = JSON.parse(fs.readFileSync(p, "utf8"));
    lock.artifacts["hub-workflows"].sha256_tree = "0".repeat(64);
    fs.writeFileSync(p, JSON.stringify(lock, null, 2) + "\n");
' "$WORK/fx-tree/repo/packages/animastor-gpu-hub/artifacts.lock.json"
serve_start "$WORK/fx-tree/assets"
if build_standalone "$WORK/fx-tree" "tree-tamper" "animastor-gpu-hub:guard-tamper-tree" "$WORK/log-tree"; then
    fail "standalone build ACCEPTED a lock/tree mismatch (sha256_tree gate broken)"
fi
grep -q 'digest mismatch' "$WORK/log-tree" || {
    tail -n 40 "$WORK/log-tree" >&2
    fail "tamper build failed, but not at the sha256_tree gate"; }
echo "  ok: standalone build rejected a lock/tree mismatch (sha256_tree gate, pre-COPY)"

echo "G5: PASSED"
