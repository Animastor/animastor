#!/usr/bin/env bash

set -e

echo "Building APK..."

# Ensure Android SDK is configured (Gradle looks for local.properties
# in the project root where build.gradle.kts lives = frontends/android/)
ANDROID_DIR="frontends/android"
if [ ! -f "$ANDROID_DIR/local.properties" ]; then
    echo "sdk.dir=${HOME}/Android/Sdk" > "$ANDROID_DIR/local.properties"
fi

# Clean build — кеш компилятора часто даёт артефакты при изменении ViewModel логики
cd "$ANDROID_DIR"
./gradlew clean assembleDebug

echo "Done."

