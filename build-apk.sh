#!/usr/bin/env bash

set -e

echo "Building APK..."
cd frontend
./gradlew assembleDebug

echo "Done."

