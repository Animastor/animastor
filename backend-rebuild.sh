#!/bin/bash

echo "=== Rebuild backend (no cache) ==="

docker compose build --no-cache backend && \
docker compose up -d backend && \

echo "Waiting 5 seconds for container startup..."
sleep 5

docker ps

echo
docker compose logs --tail=30 backend

echo "=== Done ==="
