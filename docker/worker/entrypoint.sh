#!/bin/sh
# Animastor worker container entrypoint — docker deployment (linux platform).
#
# Responsibilities (container lifecycle owns the processes; the installer
# inside the container owns the installation):
#   1. fail-closed credential gates (bootstrap parity: never a Worker Key
#      through environment or argv);
#   2. fetch the installer bundle from the hub ONCE into the persistent
#      volume, verifying the hub-published sha256 (integrity gate);
#   3. first boot  → `install` (interactive prompts, incl. the hidden
#      Worker Key prompt, come over stdin);
#      re-boot     → idempotent `resume` (recorded decisions, token kept in
#      the volume .env, ComfyUI + worker re-started automatically);
#   4. stay alive as PID 1 so the detached daemons keep running.
set -eu

DATA=/data/animastor
INSTALLER_DIR="$DATA/installer"
CLI="$INSTALLER_DIR/src/installer/cli.js"
STATE="$DATA/comfyui/.animastor-installer/install-state.json"
HUB_URL="${ANIMASTOR_HUB_URL:-https://animastor.in/gpu}"
PROFILE="${ANIMASTOR_PROFILE:-audio/qwen-tts}"
MODE="${ANIMASTOR_MODE:-managed}"

# --- 1. credential gates: the entrypoint never accepts a Worker Key -------
for v in ANIMASTOR_WORKER_TOKEN WORKER_TOKEN WORKER_KEY; do
    if env | grep -q "^${v}="; then
        echo "entrypoint: refusing to start — $v is set in the environment." >&2
        echo "The Worker Key is entered interactively inside the installer." >&2
        exit 3
    fi
done
for a in "$@"; do
    case "$a" in
        wrk.*|*worker-key=*|*worker_key=*)
            echo "entrypoint: refusing to start — credential material in argv." >&2
            exit 3
            ;;
    esac
done

# --- 2. persistent installer copy (hub bundle + sha256 verification) ------
if [ ! -f "$CLI" ]; then
    echo "[entrypoint] fetching installer bundle from $HUB_URL ..."
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT INT TERM
    curl -fsSL "$HUB_URL/installer/bundle" -o "$TMP/bundle.tar.gz"
    EXPECTED="$(curl -fsSL "$HUB_URL/installer/sha256" \
        | sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{64\}\)".*/\1/p')"
    if [ -z "$EXPECTED" ]; then
        echo "entrypoint: hub did not publish a bundle sha256 — refusing." >&2
        exit 4
    fi
    ACTUAL="$(sha256sum "$TMP/bundle.tar.gz" | cut -d' ' -f1)"
    if [ "$EXPECTED" != "$ACTUAL" ]; then
        echo "entrypoint: bundle sha256 mismatch ($ACTUAL != $EXPECTED) — refusing." >&2
        exit 4
    fi
    tar -xzf "$TMP/bundle.tar.gz" -C "$TMP"
    mkdir -p "$INSTALLER_DIR"
    cp -a "$TMP/animastor-installer/." "$INSTALLER_DIR/"
    rm -rf "$TMP"
    trap - EXIT INT TERM
    echo "[entrypoint] installer bundle verified and persisted at $INSTALLER_DIR"
fi

# --- 3. install (first boot) or idempotent resume (re-boot) ----------------
COMMON="--root $DATA/comfyui --worker-dir $DATA/worker --tools-dir $DATA/tools --state $STATE --hub-url $HUB_URL"
if [ -f "$STATE" ]; then
    echo "[entrypoint] installation found — resuming (starts ComfyUI + worker)"
    node "$CLI" resume $COMMON "$@"
    STATUS=$?
else
    echo "[entrypoint] first boot — installing profile $PROFILE (mode: $MODE)"
    echo "[entrypoint] the installer will ask for the Worker Key (hidden input)"
    node "$CLI" install --profile "$PROFILE" --mode "$MODE" $COMMON "$@"
    STATUS=$?
fi

# --- 4. lifecycle ----------------------------------------------------------
# Install containers (ANIMASTOR_EXIT_AFTER_INSTALL=1, run with -i --rm)
# propagate the installer's exit code. Runtime containers stay alive as
# PID 1 so the detached ComfyUI/worker daemons keep running; on docker
# restart this entrypoint runs again and resumes (auto-reconnect).
if [ "${ANIMASTOR_EXIT_AFTER_INSTALL:-0}" = "1" ] || [ "$STATUS" -ne 0 ]; then
    exit "$STATUS"
fi
echo "[entrypoint] installer finished (code $STATUS) — container stays alive"
exec sh -c 'trap "exit 0" TERM INT; while :; do sleep 60; done'
