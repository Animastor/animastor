#!/usr/bin/env bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo
echo "=================================="
echo " Mobile Web Tester — build APK"
echo "=================================="
echo

# Ensure Android SDK is configured
if [ ! -f local.properties ]; then
    echo "sdk.dir=/home/sureg/Android/Sdk" > local.properties
fi

./gradlew clean assembleDebug

APK="app/build/outputs/apk/debug/app-debug.apk"

echo
echo "APK: $SCRIPT_DIR/$APK"
echo

# Copy to net-disk so the tablet can download it the usual way
if [ -d /home/sureg/net-disk ]; then
    cp "$APK" /home/sureg/net-disk/mobile-web-tester.apk
    echo "Installed on the tablet via:"
    echo "  https://animastor.in/net-disk/mobile-web-tester.apk"
fi

echo
echo "Done."
