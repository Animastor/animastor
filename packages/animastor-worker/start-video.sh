#!/bin/bash

set -e  # стоп при ошибке

echo "=============================="
echo "🚀 Starting ComfyUI setup..."
echo "=============================="

# --- System update ---
echo "📦 Updating system..."
apt update -y

# --- Install Midnight Commander ---
echo "🧰 Installing mc..."
apt install -y mc git
echo "alias mc=\"/usr/bin/mc\"" >> ~/.bashrc

# --- ComfyUI: pin to a working build (verified 27 Jul 2026) ---
COMFY_VER="v0.27.0"
COMFY_REPO="https://github.com/Comfy-Org/ComfyUI.git"
LOCK_FILE="$HOME/animastor/logs/comfy-${COMFY_VER}.lock.txt"

if [ ! -d ~/ComfyUI ]; then
    echo "📦 Cloning ComfyUI ($COMFY_VER)..."
    git clone --branch "$COMFY_VER" --depth 1 "$COMFY_REPO" ~/ComfyUI
elif [ -d ~/ComfyUI/.git ]; then
    echo "🧭 Pinning ComfyUI to $COMFY_VER..."
    git -C ~/ComfyUI fetch --depth 1 origin tag "$COMFY_VER" 2>/dev/null || git -C ~/ComfyUI fetch --depth 1 origin "$COMFY_VER"
    git -C ~/ComfyUI checkout -f FETCH_HEAD
else
    echo "⚠️ ~/ComfyUI exists but is not a git repo, cannot pin version"
fi

# --- Verify exact build ---
COMFY_TAG=$(git -C ~/ComfyUI describe --tags --exact-match 2>/dev/null || echo "no-tag")
COMFY_COMMIT=$(git -C ~/ComfyUI rev-parse HEAD 2>/dev/null || echo "unknown")
echo "ComfyUI version: $COMFY_TAG"
echo "ComfyUI commit:  $COMFY_COMMIT"

# --- Go to ComfyUI ---
cd ~/ComfyUI || { echo "❌ ComfyUI folder not found"; exit 1; }

# --- Install base requirements (from lock if available) ---
if [ -f "$LOCK_FILE" ]; then
    echo "📦 Installing deps from saved lock: $LOCK_FILE"
    pip install -r "$LOCK_FILE"
else
    echo "📦 Installing base requirements (unpinned, lock will be saved after first successful boot)..."
    pip install -r requirements.txt
fi

# --- Install GGUF dependencies (if exists) ---
if [ -d "custom_nodes/ComfyUI-GGUF" ]; then
    echo "🧠 Installing GGUF dependencies..."
    pip install -r custom_nodes/ComfyUI-GGUF/requirements.txt
fi

# --- Reinstall Torch with CUDA 12.4 ---
echo "🔥 Installing PyTorch (CUDA 12.4)..."
pip uninstall torch torchvision torchaudio -y || true
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124

# --- Start ComfyUI in background ---
echo "🎬 Starting ComfyUI..."
nohup python main.py --listen 127.0.0.1 --port 8188 > output.log 2>&1 &

# --- Wait until ComfyUI actually responds (up to 5 min) ---
echo "⏳ Waiting for ComfyUI to become ready..."
COMFY_OK=0
for i in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:8188/system_stats" >/dev/null 2>&1; then
        COMFY_OK=1
        break
    fi
    sleep 5
done

if [ "$COMFY_OK" = "1" ]; then
    echo "✅ ComfyUI is ready (build: $COMFY_TAG / $COMFY_COMMIT)"
    echo "🌐 http://127.0.0.1:8188"
    echo "📄 Logs: ~/ComfyUI/output.log"

    # Save reproducible dependency lock (only from a working build).
    # torch/torchvision/torchaudio are excluded — they are pinned separately
    # below by the cu124 reinstall (torch 2.6.0+cu124).
    mkdir -p "$HOME/animastor/logs"
    pip freeze | grep -viE '^(torch|torchvision|torchaudio)==' > "$LOCK_FILE"
    echo "💾 Dependency lock saved: $LOCK_FILE"
else
    echo "❌ ComfyUI did not become ready in time"
    echo "---- tail of ~/ComfyUI/output.log ----"
    tail -n 30 ~/ComfyUI/output.log
    echo "--------------------------------------"
    exit 1
fi

echo "===================================="
echo "Starting worker after ComfyUI ready"
echo "===================================="

bash ~/animastor/start-worker.sh video >> ~/animastor/logs/worker-video.log 2>&1 &
