#!/bin/bash

set -e  # стоп при ошибке

echo "=============================="
echo "🚀 Starting ComfyUI setup..."
echo "=============================="

# --- Pin the Python environment (verified working boot used /opt/venv) ---
PY=/opt/venv/bin/python
PIP=/opt/venv/bin/pip
"$PY" --version

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

# --- Clean stale sqlite DB created by a newer ComfyUI (no user data in it) ---
# v0.27.0 ships no alembic migrations; a DB from v0.28+ blocks clean startup.
if [ -f "$HOME/ComfyUI/user/comfyui.db" ]; then
    echo "🧹 Removing stale comfyui.db (from newer ComfyUI, no user data)..."
    rm -f "$HOME/ComfyUI/user/comfyui.db" "$HOME/ComfyUI/user/comfyui.db.lock" "$HOME/ComfyUI/user/comfyui.db.bkp"
fi

# --- Install base requirements (from lock if available) ---
if [ -f "$LOCK_FILE" ]; then
    echo "📦 Installing deps from saved lock: $LOCK_FILE"
    "$PIP" install -r "$LOCK_FILE"
else
    echo "📦 Installing base requirements (unpinned, lock will be saved after first successful boot)..."
    "$PIP" install -r requirements.txt
fi

# --- Install ALL custom node requirements (GGUF, VHS, easy-use, MelBandRoFormer, ...) ---
for req in custom_nodes/*/requirements.txt; do
    [ -f "$req" ] || continue
    echo "🧠 Installing deps: $req"
    "$PIP" install -r "$req"
done

# --- Purge the CUDA-13 stack if a custom node pulled it in ---
# cu13 packages (cuda-toolkit, cuda-bindings, nvidia-*-cu13, unsuffixed nvidia-*)
# overwrite the cu12 libs that torch 2.6.0+cu124 needs, causing
# CUDNN_STATUS_NOT_INITIALIZED on any convolution.
echo "🧹 Removing CUDA-13 nvidia packages (protect cu12 libs)..."
"$PIP" uninstall -y cuda-toolkit cuda-bindings cuda-pathfinder \
    nvidia-cudnn-cu13 nvidia-cublas nvidia-nccl-cu13 nvidia-nvshmem-cu13 \
    nvidia-cusparselt-cu13 nvidia-cusolver nvidia-cuda-runtime nvidia-cuda-nvrtc \
    nvidia-cuda-cupti nvidia-cuda-nvcc nvidia-nvtx nvidia-cufft nvidia-curand \
    nvidia-cufile nvidia-cusparse nvidia-nvjitlink 2>/dev/null || true

# --- Reinstall Torch with CUDA 12.4 (PINNED to the verified working build) ---
echo "🔥 Installing PyTorch 2.6.0+cu124 (CUDA 12.4)..."
"$PIP" uninstall torch torchvision torchaudio -y || true
"$PIP" install torch==2.6.0+cu124 torchvision==0.21.0+cu124 torchaudio==2.6.0+cu124 --index-url https://download.pytorch.org/whl/cu124

# --- Start ComfyUI in background ---
echo "🎬 Starting ComfyUI..."
nohup "$PY" main.py --listen 127.0.0.1 --port 8188 > output.log 2>&1 &

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
    # by the cu124 reinstall (torch 2.6.0+cu124).
    # CUDA-13 nvidia/cuda packages are excluded too — they shadow the cu12
    # libs torch 2.6.0+cu124 needs (CUDNN_STATUS_NOT_INITIALIZED).
    mkdir -p "$HOME/animastor/logs"
    "$PIP" freeze \
        | grep -viE '^(torch|torchvision|torchaudio)==' \
        | grep -viE '^(cuda-toolkit|cuda-bindings|cuda-pathfinder)==' \
        | grep -viE '^(nvidia-cudnn-cu13|nvidia-nccl-cu13|nvidia-nvshmem-cu13|nvidia-cusparselt-cu13)==' \
        | grep -viE '^nvidia-(cublas|cusolver|cuda-runtime|cuda-nvrtc|cuda-cupti|cuda-nvcc|nvtx|cufft|curand|cufile|cusparse|nvjitlink)==' \
        > "$LOCK_FILE"
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
