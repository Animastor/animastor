#!/usr/bin/env bash

# ======================================================
# Animastor GPU Worker Startup Script v2.1 (FINAL FIX)
# ======================================================

echo "===================================="
echo "Animastor Worker Startup v2.1"
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
# 4. DETECT COMFY PORT (AUTO 🔥)
# ======================================================

COMFY_PORT=""

COMFY_PID=$(pgrep -f "main.py" | head -1)

if [ -n "$COMFY_PID" ]; then
  CMDLINE=$(tr '\0' ' ' < /proc/$COMFY_PID/cmdline)

  COMFY_PORT=$(echo "$CMDLINE" | grep -oP '(?<=--port )[^ ]+' | head -1)
fi

if [ -z "$COMFY_PORT" ]; then
  echo "⚠️ Port not detected, fallback 8188"
  COMFY_PORT=8188
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

export HUB_URL="https://animastor.in/gpu"
export NOTEBOOK_PATH="$NOTEBOOK_PATH"
export COMFY_PORT="$COMFY_PORT"
export WORKER_TYPE="$WORKER_TYPE"
export COMFY_INPUT_DIR="$HOME/ComfyUI/input"

# ======================================================
# 9. STOP OLD WORKERS (FIX 🔥)
# ======================================================

if pgrep -f "node worker.js" >/dev/null; then
  echo "Stopping old workers..."
  pkill -f "node worker.js"
  sleep 2
fi

# ======================================================
# 10. CHECK WORKER FILE
# ======================================================

if [ ! -f worker.js ]; then
  echo "ERROR: worker.js not found"
  exit 1
fi

# ======================================================
# 11. START WORKER
# ======================================================

LOG_FILE="$BASE_DIR/logs/worker.log"

echo "Starting $WORKER_TYPE worker..."

setsid node worker.js >> "$LOG_FILE" 2>&1 &

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
