#!/usr/bin/env bash

set -e

echo
echo "=================================="
echo " Rebuild Backend"
echo "=================================="
echo

docker compose build --no-cache backend
docker compose up -d backend

sleep 3

docker compose restart backend

echo
echo "Waiting 5 seconds for container startup..."
sleep 5

echo
docker compose logs --tail=30 backend

echo
docker ps

