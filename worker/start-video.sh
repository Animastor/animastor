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
apt install -y mc
echo "alias mc=\"/usr/bin/mc\"" >> ~/.bashrc

# --- Go to ComfyUI ---
cd ~/ComfyUI || { echo "❌ ComfyUI folder not found"; exit 1; }

# --- Install base requirements ---
echo "📦 Installing base requirements..."
pip install -r requirements.txt

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

echo "=============================="
echo "✅ ComfyUI started!"
echo "🌐 http://127.0.0.1:8188"
echo "📄 Logs: ~/ComfyUI/output.log"
echo "=============================="

echo "===================================="
echo "Starting worker after ComfyUI ready"
echo "===================================="

bash ~/animastor/start-worker.sh video >> ~/animastor/logs/worker-video.log 2>&1 &
