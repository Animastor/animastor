#!/usr/bin/env bash

set -e

echo "Building APK..."

# Ensure Android SDK is configured
if [ ! -f local.properties ]; then
    echo "sdk.dir=/home/sureg/Android/Sdk" > local.properties
fi

# Clean build — кеш компилятора часто даёт артефакты при изменении ViewModel логики
./gradlew clean assembleDebug

echo "Copying APK..."

cp app/build/outputs/apk/debug/app-debug.apk \
/home/sureg/net-disk/app-debug.apk

echo "Done."

echo "Download:"
echo "https://animastor.in/net-disk/app-debug.apk"
