#!/usr/bin/env bash

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

