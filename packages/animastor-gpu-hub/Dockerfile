# ── GPU Hub image — dual artifact-delivery mode ─────────────────────────────
# Stage picker (BuildKit): ARG STAGER_STAGE selects the stager stage that
# feeds the runtime's `COPY --from=stager`:
#   * `stager-monorepo` — PRE-SPLIT DEFAULT. Build context is the repo root
#     (docker-compose.yml `context: .`); the stager COPYs the 4 artifact
#     groups out of the monorepo. This stage is dropped from the hub repo
#     at split execution (its COPY sources do not exist there).
#   * `stager-release` — POST-SPLIT STANDALONE. Fetches the exact GitHub
#     Release assets named in artifacts.lock.json (prep plan §2.1/§2.2),
#     verifies each asset's sha256 against the pin (§2.5), then runs the
#     same sha256_tree staging gate — all BEFORE `COPY --from=stager`
#     (§2.3 checksum invariant: mismatch = fail build, pre-COPY).
#     Builds from the standalone animastor-gpu-hub repo root:
#       DOCKER_BUILDKIT=1 docker build -f packages/animastor-gpu-hub/Dockerfile \
#         --build-arg STAGER_STAGE=stager-release .
# Requires BuildKit (docker >= 23 default): the unselected stager stage is
# pruned from the build graph instead of being executed.

ARG STAGER_STAGE=stager-monorepo

# ── Stage 1a: stage monorepo artifacts (PRE-SPLIT default) ──────────────────
# Only the 4 required artifact groups are copied — no monorepo runtime code.
# Build context is the repo root (docker-compose.yml context: .).
# Worker bundle source: canonical packages/animastor-worker/worker/
# (docs/architecture/WORKER_PACKAGE_RELOCATION_CHECKLIST.md).
FROM alpine:3.19 AS stager-monorepo
ARG WORKER_BUNDLE_SRC=packages/animastor-worker/worker

# Minimal directory tree so the build never silently produces an empty image.
RUN mkdir -p /staging/artifacts/{worker-bundle,workflows,installer-src,install-manifests}

COPY ${WORKER_BUNDLE_SRC}/         /staging/artifacts/worker-bundle/
COPY backend/ai/workflows/         /staging/artifacts/workflows/
# Installer extraction: source lives in packages/animastor-installer/src/installer,
# canonical version package.json at the package root. Two COPYs combine into the
# SAME flat installer-src/ layout as before — hub code and tar prefixes unchanged.
COPY packages/animastor-installer/src/installer/ /staging/artifacts/installer-src/
COPY packages/animastor-installer/package.json   /staging/artifacts/installer-src/package.json
COPY packages/animastor-installer/ai/install-manifests/ /staging/artifacts/install-manifests/

# B5 integrity gate (prep plan §2.3): verify the CONTENT DIGEST of every
# staged group against artifacts.lock.json on the staging tree — BEFORE
# the runtime stage's `COPY --from=stager`. Mismatch fails the build here,
# so a silently different artifact can never be baked into the image.
# The gate is delivery-neutral (§2.0): the same check runs over whatever
# materializes /staging/artifacts (monorepo COPYs, release zips, CI staging).
# Digest formula is shared with tools/update-artifacts-lock.cjs.
COPY packages/animastor-gpu-hub/artifacts.lock.json /staging/artifacts.lock.json
COPY packages/animastor-gpu-hub/scripts/verify-staged-artifacts.sh /staging/verify-staged-artifacts.sh
RUN sh /staging/verify-staged-artifacts.sh /staging/artifacts.lock.json /staging/artifacts

# ── Stage 1b: fetch pinned release assets (POST-SPLIT standalone) ────────────
# Zero monorepo source references: this stage must build from the standalone
# animastor-gpu-hub repo root, where the monorepo trees do not exist.
# Delivery contract (prep plan §2.1/§2.2): each group is one GitHub Release
# asset referenced by its exact pinned filename; the asset's sha256 in the
# pin file is the cryptographic anchor of the content.
FROM alpine:3.19 AS stager-release
ARG RELEASE_URL_BASE=https://github.com/Animastor
RUN apk add --no-cache curl unzip
COPY packages/animastor-gpu-hub/artifacts.lock.json /staging/artifacts.lock.json
COPY packages/animastor-gpu-hub/scripts/verify-staged-artifacts.sh /staging/verify-staged-artifacts.sh
COPY packages/animastor-gpu-hub/scripts/fetch-pinned-assets.sh /staging/fetch-pinned-assets.sh
RUN sh /staging/fetch-pinned-assets.sh /staging/artifacts.lock.json /staging/artifacts "$RELEASE_URL_BASE"
RUN sh /staging/verify-staged-artifacts.sh /staging/artifacts.lock.json /staging/artifacts

# ── Stage picker ─────────────────────────────────────────────────────────────
FROM ${STAGER_STAGE} AS stager

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
