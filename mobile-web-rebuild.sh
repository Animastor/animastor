#!/usr/bin/env bash

set -e

# Script location = project root (works when invoked from any directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$SCRIPT_DIR/frontends/mobile"

echo
echo "=================================="
echo " Rebuild Mobile Web Frontend"
echo "=================================="
echo

if [ ! -d "$MOBILE_DIR" ]; then
    echo "❌ Directory not found: $MOBILE_DIR"
    exit 1
fi

cd "$MOBILE_DIR"

echo
echo "Installing dependencies (npm ci)..."
npm ci

echo
echo "Typechecking (tsc --noEmit)..."
npm run typecheck

echo
echo "Building (vite build -> dist/)..."
npm run build

echo
echo "=================================="
echo " Finished"
echo "=================================="
echo

echo "Build output: $MOBILE_DIR/dist"
echo "Served at:    https://m.animastor.in/"
echo "Note: nginx serves ./frontends/mobile via bind-mount,"
echo "      so the new dist is live immediately — no restart needed."
echo
