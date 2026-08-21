#!/usr/bin/env bash

# ======================================================
# Animastor GPU Worker Startup Script
# ======================================================

echo "===================================="
echo "Animastor Worker Startup"
echo "===================================="

export DEBIAN_FRONTEND=noninteractive

# ======================================================
# 0. WORKER TYPE
# ======================================================

WORKER_TYPE=${1:-image}

if [[ "$WORKER_TYPE" != "image" && "$WORKER_TYPE" != "audio" && "$WORKER_TYPE" != "video" ]]; then
  echo "❌ Invalid worker type: $WORKER_TYPE"
  exit 1
fi

echo "Worker type: $WORKER_TYPE"

# ======================================================
# 1. PATHS
# ======================================================

BASE_DIR=~/animastor

mkdir -p $BASE_DIR/logs
mkdir -p $BASE_DIR/worker

cd $BASE_DIR/worker || exit 1

# ======================================================
# 1.5. LOAD .env (worker-local configuration)
# ======================================================
# The Private Worker credential (ANIMASTOR_WORKER_TOKEN) and optional
# overrides (HUB_URL, WORKER_ID, COMFY_PORT, COMFY_INPUT_DIR, ...) are read
# from ./.env so the token is actually loaded, not silently dropped.
# Format: KEY=VALUE lines, '#' comments. Values are NOT shell-evaluated.

if [ -f .env ]; then
  echo "Loading .env from $(pwd)/.env"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
      *=*) ;;
      *) continue ;;
    esac
    ENV_KEY="${line%%=*}"
    ENV_VAL="${line#*=}"
    # strip optional surrounding quotes
    ENV_VAL="${ENV_VAL%\"}"; ENV_VAL="${ENV_VAL#\"}"
    ENV_VAL="${ENV_VAL%\'}"; ENV_VAL="${ENV_VAL#\'}"
    export "$ENV_KEY=$ENV_VAL"
  done < .env
fi

# ======================================================
# 2. GPU CHECK
# ======================================================

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "ERROR: GPU not detected"
  exit 1
fi

echo "GPU:"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

# ======================================================
# 3. NODEJS
# ======================================================

NODE_VERSION=$(node -v 2>/dev/null | cut -d'.' -f1 | tr -d 'v')

if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 18 ]; then
  echo "Installing Node.js 18..."

  apt-get remove -y nodejs libnode-dev 2>/dev/null || true
  apt-get autoremove -y

  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y nodejs
fi

echo "Node: $(node -v)"

# ======================================================
# 4. DETECT COMFY PORT (AUTO)
# ======================================================
# An explicit COMFY_PORT (env or .env) wins over auto-detection.

COMFY_PORT="${COMFY_PORT:-}"

if [ -z "$COMFY_PORT" ]; then

COMFY_PID=$(pgrep -f "main.py" | head -1)

if [ -n "$COMFY_PID" ]; then
  CMDLINE=$(tr '\0' ' ' < /proc/$COMFY_PID/cmdline)

  COMFY_PORT=$(echo "$CMDLINE" | grep -oP '(?<=--port )[^ ]+' | head -1)
fi

if [ -z "$COMFY_PORT" ]; then
  echo "⚠️ Port not detected, fallback 8188"
  COMFY_PORT=8188
fi

fi

echo "ComfyUI port: $COMFY_PORT"

# ======================================================
# 5. DETECT NOTEBOOK PATH
# ======================================================

NOTEBOOK_PATH=""

COMFY_PID=$(pgrep -f "main.py" | head -1)

if [ -n "$COMFY_PID" ]; then
  CMDLINE=$(tr '\0' ' ' < /proc/$COMFY_PID/cmdline)
  NOTEBOOK_PATH=$(echo "$CMDLINE" | grep -oP '(?<=--baseurl )[^ ]+' | head -1)
fi

if [ -z "$NOTEBOOK_PATH" ]; then
  echo "⚠️ Notebook path not detected, fallback empty"
  NOTEBOOK_PATH=""
fi

echo "Notebook path: ${NOTEBOOK_PATH:-/}"

# ======================================================
# 6. CHECK COMFYUI
# ======================================================

if ! curl -s "http://127.0.0.1:$COMFY_PORT$NOTEBOOK_PATH/system_stats" >/dev/null; then
  echo "⚠️ ComfyUI not ready yet"
fi

# ======================================================
# 7. NPM SETUP
# ======================================================

if [ ! -f package.json ]; then
  npm init -y >/dev/null
  npm pkg set type="module"
fi

if ! npm list node-fetch@3 >/dev/null 2>&1; then
  npm install node-fetch@3
fi

# ======================================================
# 8. ENV
# ======================================================
# Required by worker.cjs: HUB_URL, ANIMASTOR_WORKER_TOKEN, WORKER_TYPE,
# WORKER_ID. Optional: COMFY_PORT, COMFY_INPUT_DIR, NOTEBOOK_PATH, ...
# Values already present in the environment or loaded from .env WIN over
# the defaults below (so a private worker token is never overwritten).

export HUB_URL="${HUB_URL:-https://animastor.in/gpu}"
export NOTEBOOK_PATH="$NOTEBOOK_PATH"
export COMFY_PORT="$COMFY_PORT"
export WORKER_TYPE="$WORKER_TYPE"
export COMFY_INPUT_DIR="${COMFY_INPUT_DIR:-$HOME/ComfyUI/input}"
export WORKER_ID="${WORKER_ID:-gpu-$(hostname)}"

if [ -z "$ANIMASTOR_WORKER_TOKEN" ]; then
  echo "⚠️ ANIMASTOR_WORKER_TOKEN is not set."
  echo "   The worker will run in LEGACY SYSTEM-POOL mode (no workspace binding)."
  echo "   For a Private Worker, set ANIMASTOR_WORKER_TOKEN in ./.env or the"
  echo "   environment (Settings → Private Workers shows it once at creation)."
else
  echo "ANIMASTOR_WORKER_TOKEN: set (private worker mode)"
fi

# ======================================================
# 9. STOP OLD WORKERS (FIX)
# ======================================================

if pgrep -f "node worker.cjs" >/dev/null; then
  echo "Stopping old workers..."
  pkill -f "node worker.cjs"
  sleep 2
fi

# ======================================================
# 10. CHECK WORKER FILE
# ======================================================

if [ ! -f worker.cjs ]; then
  echo "ERROR: worker.cjs not found"
  exit 1
fi

# ======================================================
# 11. START WORKER
# ======================================================

LOG_FILE="$BASE_DIR/logs/worker.log"

echo "Starting $WORKER_TYPE worker..."

setsid node worker.cjs >> "$LOG_FILE" 2>&1 &

WORKER_PID=$!

sleep 3

# ======================================================
# 12. VERIFY
# ======================================================

if kill -0 $WORKER_PID 2>/dev/null; then

  echo "✅ Worker started (PID: $WORKER_PID)"
  echo "Log: $LOG_FILE"

  echo "------ last logs ------"
  tail -n 5 "$LOG_FILE"
  echo "-----------------------"

else

  echo "❌ Failed to start worker"
  tail -n 20 "$LOG_FILE"
  exit 1

fi

echo "===================================="
echo "READY: $WORKER_TYPE worker"
echo "===================================="
