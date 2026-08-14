#!/usr/bin/env bash

set -e

echo "Building APK..."
cd frontends/android
./gradlew assembleDebug

echo "Done."

