#!/usr/bin/env bash
# ======================================================
# Syntax smoke test — проверяет весь production JS/CJS
# на синтаксическую валидность.
# ======================================================
# Использование:
#   ./scripts/syntax-smoke.sh          # проверить всё
#   ./scripts/syntax-smoke.sh backend  # только backend/src
#   ./scripts/syntax-smoke.sh gpu-hub  # только gpu-hub
#   ./scripts/syntax-smoke.sh worker   # только worker
# ======================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXIT_CODE=0
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "========================================"
echo " Syntax smoke test"
echo "========================================"

check_dir() {
    local label="$1"
    local dir="$2"
    local errors_found=false

    echo ""
    echo "--- Checking ${label} (${dir}) ---"

    while IFS= read -r -d '' f; do
        local rel_path="${f#$ROOT_DIR/}"
        if node --check "$f" 2>> "$TMPFILE"; then
            echo -e "  ${GREEN}*${NC} ${rel_path}"
        else
            echo -e "  ${RED}X${NC} ${rel_path} -- SYNTAX ERROR"
            errors_found=true
            EXIT_CODE=1
        fi
    done < <(find "$dir" \
        -path '*/node_modules' -prune -o \
        \( -name '*.js' -o -name '*.cjs' \) -type f -print0)

    if [ "$errors_found" = false ]; then
        echo -e "  ${GREEN}All files OK${NC}"
    fi
}

if [ $# -eq 0 ]; then
    BACKEND_SRC="$ROOT_DIR/backend/src"
    GPU_HUB_SRC="$ROOT_DIR/gpu-hub"
    WORKER_SRC="$ROOT_DIR/worker"

    if [ -d "$BACKEND_SRC" ]; then
        check_dir "backend/src" "$BACKEND_SRC"
    fi
    if [ -d "$GPU_HUB_SRC" ]; then
        check_dir "gpu-hub" "$GPU_HUB_SRC"
    fi
    if [ -d "$WORKER_SRC" ]; then
        check_dir "worker" "$WORKER_SRC"
    fi
else
    for area in "$@"; do
        case "$area" in
            backend)
                check_dir "backend/src" "$ROOT_DIR/backend/src"
                ;;
            gpu-hub)
                check_dir "gpu-hub" "$ROOT_DIR/gpu-hub"
                ;;
            worker)
                check_dir "worker" "$ROOT_DIR/worker"
                ;;
            *)
                echo -e "${YELLOW}Unknown area: ${area}${NC}"
                exit 1
                ;;
        esac
    done
fi

echo ""
echo "========================================"

if [ $EXIT_CODE -eq 0 ]; then
    echo -e " ${GREEN}All production JS/CJS files pass syntax check${NC}"
else
    echo -e " ${RED}Some files have syntax errors${NC}"
    if [ -s "$TMPFILE" ]; then
        echo ""
        echo "Error details:"
        cat "$TMPFILE"
    fi
fi

echo "========================================"
exit $EXIT_CODE
