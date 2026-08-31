# Animastor worker container — Docker deployment (linux platform).
#
# First run (install, interactive — the hidden Worker Key prompt runs here):
#   docker build -t animastor-worker -f docker/worker/Dockerfile docker/worker
#   docker run -it --rm \
#     -v ~/animastor/data:/data/animastor \
#     --entrypoint /usr/local/bin/entrypoint.sh \
#     -e ANIMASTOR_EXIT_AFTER_INSTALL=1 \
#     -e ANIMASTOR_HUB_URL=https://animastor.in/gpu \
#     -e ANIMASTOR_PROFILE=audio/qwen-tts \
#     animastor-worker install
#
# Runtime container (stays alive, hosts ComfyUI + worker):
#   docker run -d --name animastor-worker \
#     --restart unless-stopped \
#     -v ~/animastor/data:/data/animastor \
#     animastor-worker
#
# NVIDIA GPU host (driver belongs to the HOST; NVIDIA Container Toolkit
# must be installed there — never inside the container): add
#   --gpus all
# to the docker run line above. Nothing else changes.
