# Animastor GPU Worker container — Docker deployment of the LINUX platform.
#
# The universal installer runs INSIDE this container (it auto-detects the
# docker deployment via /.dockerenv) and installs ComfyUI + the Animastor
# worker into the persistent volume /data/animastor. The image itself is
# stateless: everything that must survive container replacement lives on
# the volume (see docker/worker/entrypoint.sh).
#
# Base: node 22 (worker + installer runtime) + python 3.11 (ComfyUI venv,
# manifest minimum is 3.10) + git/curl/tar (bootstrap + managed install).
# No NVIDIA driver here — GPU access comes from the HOST runtime
# (NVIDIA Container Toolkit, --gpus all); the container never installs one.

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv \
        git curl ca-certificates tar procps \
        build-essential libsndfile1-dev \
    && rm -rf /var/lib/apt/lists/*

# uid 1001 matches the animastor account on the reference VPS so the
# bind-mounted volume stays ownership-consistent on both sides.
RUN useradd -m -u 1001 -s /bin/bash animastor \
    && mkdir -p /data/animastor \
    && chown animastor:animastor /data/animastor

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

USER animastor
ENV HOME=/home/animastor
# The pytorch cpu index cannot satisfy pip BUILD dependencies (e.g. flit_core
# for the typing-extensions sdist fallback when its index wheel metadata is
# inconsistent) — PyPI is added as the extra index for those, resolution
# order unchanged (cpu index stays primary for torch itself).
ENV PIP_EXTRA_INDEX_URL=https://pypi.org/simple
WORKDIR /home/animastor

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
