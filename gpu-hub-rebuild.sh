#!/usr/bin/env bash
# Rebuild the local GPU Hub from the monorepo fixture ./gpu-hub.
# Phase 10T: uses local dev overlay with bind mounts for artifacts.
# For production, use the GHCR image via overlay-gpu-hub-standalone.yml.

set -e

echo
echo "=================================="
echo " Rebuild GPU HUB (local dev)"
echo "=================================="
echo

docker compose \
  -f docker-compose.yml \
  -f docker/compose/overlay-gpu-hub-local.yml \
  build --no-cache gpu-hub

docker compose \
  -f docker-compose.yml \
  -f docker/compose/overlay-gpu-hub-local.yml \
  up -d gpu-hub

sleep 3

docker compose \
  -f docker-compose.yml \
  -f docker/compose/overlay-gpu-hub-local.yml \
  restart gpu-hub

echo
echo "Waiting 5 seconds for container startup..."
sleep 5

echo
docker compose \
  -f docker-compose.yml \
  -f docker/compose/overlay-gpu-hub-local.yml \
  logs --tail=30 gpu-hub

echo
docker ps
