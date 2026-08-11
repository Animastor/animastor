+++fix-nodes.sh

#!/bin/bash

(
echo "Waiting for ComfyUI..."

until pgrep -f "/home/jovyan/ComfyUI/main.py" > /dev/null; do
    sleep 5
done

echo "ComfyUI detected"

cd /home/jovyan/ComfyUI/custom_nodes || exit

echo "Installing GGUF deps..."
pip install -r ComfyUI-GGUF/requirements.txt

echo "Restarting ComfyUI..."
pkill -f ComfyUI

echo "Done."

) & disown
