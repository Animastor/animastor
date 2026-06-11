#!/usr/bin/env bash

set -e

echo "Building APK..."
cd frontend
./gradlew assembleDebug

echo "Copying APK..."
cp app/build/outputs/apk/debug/app-debug.apk \
/home/sureg/net-disk/app-debug.apk

echo "Done."

echo "Download:"
echo "https://animastor.in/net-disk/app-debug.apk"
