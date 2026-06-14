#!/usr/bin/env bash

set -e

echo
echo "=================================="
echo " Rebuild Backend"
echo "=================================="
echo

docker compose build --no-cache backend
docker compose up -d backend

echo
echo "Waiting 5 seconds for container startup..."
sleep 5

echo
docker ps

echo
docker compose logs --tail=30 backend

echo
echo "=================================="
echo " Build APK"
echo "=================================="
echo

# Ensure Android SDK is configured
if [ ! -f local.properties ]; then
    echo "sdk.dir=/home/sureg/Android/Sdk" > local.properties
fi

cd frontend

./gradlew clean assembleDebug

echo
echo "Copying APK..."

cp app/build/outputs/apk/debug/app-debug.apk \
   /home/sureg/net-disk/app-debug.apk

echo
echo "=================================="
echo " Finished"
echo "=================================="
echo

echo "APK download URL:"
echo "https://animastor.in/net-disk/app-debug.apk"
echo
