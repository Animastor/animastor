#!/usr/bin/env bash

set -e

echo "Building APK..."

# Ensure Android SDK is configured
if [ ! -f local.properties ]; then
    echo "sdk.dir=/home/sureg/Android/Sdk" > local.properties
fi

# Clean build — кеш компилятора часто даёт артефакты при изменении ViewModel логики
cd frontend
./gradlew clean assembleDebug

echo "Done."

