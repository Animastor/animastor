#!/usr/bin/env bash
# Rebuild the local GPU Hub from the transitional monorepo fixture ./gpu-hub.
# Phase 10J: the hub source of truth is Animastor/animastor-gpu-hub; after
# the cutover this script becomes obsolete (image pull + redeploy instead
# of a local build — see docker/compose/overlay-gpu-hub-standalone.yml).

set -e

echo
echo "=================================="
echo " Rebuild GPU HUB"
echo "=================================="
echo

docker compose build --no-cache gpu-hub
docker compose up -d gpu-hub

sleep 3

docker compose restart gpu-hub

echo
echo "Waiting 5 seconds for container startup..."
sleep 5

echo
docker compose logs --tail=30 gpu-hub

echo
docker ps

