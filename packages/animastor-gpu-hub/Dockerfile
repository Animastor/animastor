# ── Stage 1: stage monorepo artifacts ────────────────────────────────────────
# Only the 4 required artifact groups are copied — no monorepo runtime code.
# Build context is the repo root (docker-compose.yml context: .).
# Worker bundle source: canonical packages/animastor-worker/worker/
# (docs/architecture/WORKER_PACKAGE_RELOCATION_CHECKLIST.md).
FROM alpine:3.19 AS stager
ARG WORKER_BUNDLE_SRC=packages/animastor-worker/worker

# Minimal directory tree so the build never silently produces an empty image.
RUN mkdir -p /staging/artifacts/{worker-bundle,workflows,installer-src,install-manifests}

COPY ${WORKER_BUNDLE_SRC}/         /staging/artifacts/worker-bundle/
COPY backend/ai/workflows/         /staging/artifacts/workflows/
COPY backend/src/installer/        /staging/artifacts/installer-src/
COPY backend/ai/install-manifests/ /staging/artifacts/install-manifests/

# ── Stage 2: GPU Hub runtime ────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

COPY packages/animastor-gpu-hub/package.json ./
RUN npm install --omit=dev

COPY packages/animastor-gpu-hub/gpu-hub.js packages/animastor-gpu-hub/server.js packages/animastor-gpu-hub/tarball.js packages/animastor-gpu-hub/bootstrap.js ./
COPY packages/animastor-gpu-hub/README.md packages/animastor-gpu-hub/LICENSE ./

# Bake in the 4 artifact groups from the staging layer.
COPY --from=stager /staging/artifacts/ /app/artifacts/

# Verify the bake-in at build time — fail fast if any group is missing.
RUN set -e; \
    for d in worker-bundle workflows installer-src install-manifests; do \
      [ -d "/app/artifacts/$d" ] || { echo "FATAL: /app/artifacts/$d missing"; exit 1; }; \
    done; \
    [ -f /app/artifacts/worker-bundle/package.json ] || \
      { echo "FATAL: worker-bundle/package.json missing"; exit 1; }; \
    echo "artifact bake-in verified: 4 groups present"

# Integrity validator — usable via: docker exec <container> /app/scripts/check-artifacts.sh
COPY scripts/check-artifacts.sh /app/scripts/check-artifacts.sh
RUN chmod +x /app/scripts/check-artifacts.sh

EXPOSE 5000

CMD ["node", "server.js"]
