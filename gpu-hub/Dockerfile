# ── Stage 1: stage monorepo artifacts ────────────────────────────────────────
# Only the 4 required artifact groups are copied — no monorepo runtime code.
# Build context is the repo root (docker-compose.yml context: .).
FROM alpine:3.19 AS stager

# Minimal directory tree so the build never silently produces an empty image.
RUN mkdir -p /staging/artifacts/{worker-bundle,workflows,installer-src,install-manifests}

COPY worker/worker/                /staging/artifacts/worker-bundle/
COPY backend/ai/workflows/         /staging/artifacts/workflows/
COPY backend/src/installer/        /staging/artifacts/installer-src/
COPY backend/ai/install-manifests/ /staging/artifacts/install-manifests/

# ── Stage 2: GPU Hub runtime ────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

COPY gpu-hub/package.json ./
RUN npm install --omit=dev

COPY gpu-hub/gpu-hub.js gpu-hub/server.js gpu-hub/tarball.js gpu-hub/bootstrap.js ./
COPY gpu-hub/README.md gpu-hub/LICENSE ./

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

EXPOSE 5000

CMD ["node", "server.js"]
