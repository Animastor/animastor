#!/usr/bin/env bash
# ======================================================
# Animastor Runtime Audit — read-only diagnostic script
# ======================================================
# Usage:
#   ./animastor-runtime-audit.sh
#   ./animastor-runtime-audit.sh > animastor-runtime-audit.txt
#
# What it does:
#   Inspects the local Animastor GPU/ComfyUI/worker install and prints a
#   single text report to stdout. Never modifies the system. Never prints
#   secret values. Safe to run as a regular user.
#
# Conventions:
#   - Missing tools are skipped, not fatal.
#   - Missing files are reported as "(not found)".
#   - Secret values (ANIMASTOR_WORKER_TOKEN, POSTGRES_PASSWORD, HF_TOKEN,
#     WORKSPACE_SECRET_KEY, GPU_HUB_API_KEY, OPENROUTER_API_KEY) are
#     replaced with [REDACTED] whenever a name match is detected.
# ======================================================

set -u
# Note: deliberately no `set -e` — a missing command must not abort the
# whole audit. Each probe is wrapped in a helper that handles its own errors.

# ---------- output helpers ----------
hr()  { printf '%s\n' "------------------------------------------------------------"; }
hr2() { printf '%s\n' "============================================================"; }
say() { printf '%s\n' "$*"; }
has() { command -v "$1" >/dev/null 2>&1; }

# run_or_skip <label> <command...>
# Run a command, capture its stdout+stderr. On error, print "(skipped: ...)".
run_or_skip() {
  local label="$1"; shift
  local out rc
  out=$("$@" 2>&1) || rc=$?
  if [ -n "${rc:-0}" ] && [ "$rc" -ne 0 ]; then
    say "$label: (skipped: exit $rc)"
    [ -n "$out" ] && printf '    %s\n' "$out" | head -5 | sed 's/^/    /'
    return 0
  fi
  [ -n "$out" ] && printf '%s\n' "$out"
}

# safe_read <path>
# Read a file if it exists, else print "(not found)".
safe_read() {
  if [ -f "$1" ]; then
    cat "$1"
  else
    say "(not found: $1)"
  fi
}

# human_size <bytes>
# Print a human-readable size. Pure POSIX awk — no gawk-only features.
human_size() {
  local bytes=${1:-0}
  echo "$bytes" | awk '{
    b = $1 + 0
    if (b >= 1099511627776)      printf "%.2f TiB", b/1099511627776
    else if (b >= 1073741824)    printf "%.2f GiB", b/1073741824
    else if (b >= 1048576)       printf "%.2f MiB", b/1048576
    else if (b >= 1024)          printf "%.2f KiB", b/1024
    else                         printf "%d B", b
  }'
}

# Regex of env-key names treated as secrets. Anything matching this is
# redacted in any .env / config file we print.
SECRET_NAMES='^(ANIMASTOR_WORKER_TOKEN|POSTGRES_PASSWORD|HF_TOKEN|HUGGINGFACE_HUB_TOKEN|WORKSPACE_SECRET_KEY|GPU_HUB_API_KEY|OPENROUTER_API_KEY|.*_TOKEN|.*_SECRET|.*_PASSWORD|.*_API_KEY)$'

# redact_file <path>
# Print a file with values for secret-looking env-style lines redacted.
redact_file() {
  awk -v pat="$SECRET_NAMES" '
    {
      line = $0
      stripped = line
      sub(/^[[:space:]]+/, "", stripped)
      if (stripped ~ /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/) {
        n = split(stripped, parts, "=")
        key = parts[1]
        if (key ~ pat) {
          sub(/=.*/, "= [REDACTED]", line)
        }
      }
      print line
    }
  ' "$1" | sed 's/^/    /'
}

# redact_env_keys <path>
# Print an env file: keys with redacted values, plus comments/blank lines.
redact_env_keys() {
  awk -v pat="$SECRET_NAMES" '
    {
      line = $0
      stripped = line
      sub(/^[[:space:]]*[#].*/, "", stripped)  # drop comments for matching
      if (stripped == "") { print line; next }
      sub(/^[[:space:]]+/, "", stripped)
      if (stripped ~ /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/) {
        n = split(stripped, parts, "=")
        key = parts[1]
        if (key ~ pat) {
          # Print as "KEY=<REDACTED>" (one KEY, one =)
          print key "=<REDACTED>"
          next
        } else {
          # Print as "KEY=<set>" (one KEY, one =)
          print key "=<set>"
          next
        }
      }
      print line
    }
  ' "$1" | sed 's/^/    /'
}

# ---------- header ----------
hr2
say "ANIMASTOR RUNTIME AUDIT"
hr2
say "hostname : $(hostname 2>/dev/null || echo unknown)"
say "date     : $(date -u +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)"
say "user     : $(id -un 2>/dev/null || echo unknown)"
say "cwd      : $(pwd 2>/dev/null || echo unknown)"
say "script   : $(readlink -f "$0" 2>/dev/null || echo "$0")"
hr

# ---------- 1. SYSTEM ----------
hr2
say "[1] SYSTEM"
hr2

if [ -f /etc/os-release ]; then
  say "/etc/os-release:"
  sed 's/^/    /' /etc/os-release
else
  say "OS: /etc/os-release not found"
fi

say ""
say "kernel: $(uname -srm 2>/dev/null || uname -a)"

if has lscpu; then
  say ""
  say "CPU:"
  lscpu 2>/dev/null | sed 's/^/    /' | head -25
elif [ -f /proc/cpuinfo ]; then
  say ""
  say "CPU (from /proc/cpuinfo):"
  grep -E '^model name|^cpu cores|^cpu MHz' /proc/cpuinfo | head -4 | sed 's/^/    /'
fi

if has free; then
  say ""
  say "memory:"
  free -h 2>/dev/null | sed 's/^/    /'
fi

say ""
say "disk space:"
if has df; then
  df -h 2>/dev/null | sed 's/^/    /'
else
  say "    (df not available)"
fi

# ---------- 2. NVIDIA / CUDA ----------
hr2
say "[2] NVIDIA / CUDA"
hr2

if has nvidia-smi; then
  say "nvidia-smi:"
  nvidia-smi 2>&1 | sed 's/^/    /'
  echo ""
  say "nvidia-smi --query-gpu=…:"
  nvidia-smi --query-gpu=index,name,driver_version,memory.total,memory.free --format=csv 2>/dev/null | sed 's/^/    /'
  echo ""
  say "CUDA version (from nvidia-smi):"
  nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 | sed 's/^/    driver: /'
  has nvcc && nvcc --version 2>/dev/null | sed 's/^/    /' || say "    nvcc: not on PATH"
else
  say "nvidia-smi: not found (no NVIDIA driver on PATH)"
fi

# ---------- 3. PYTHON / RUNTIME ----------
hr2
say "[3] PYTHON / RUNTIME"
hr2

PY_BIN=""
for candidate in /opt/venv/bin/python python3 python; do
  if has "$candidate" || [ -x "$candidate" ]; then
    PY_BIN="$candidate"
    break
  fi
done

if [ -n "$PY_BIN" ]; then
  say "python: $($PY_BIN --version 2>&1)"
  say "path  : $(readlink -f "$PY_BIN" 2>/dev/null || echo "$PY_BIN")"
  if [ -n "${VIRTUAL_ENV:-}" ]; then
    say "venv  : $VIRTUAL_ENV (active)"
  else
    say "venv  : (no VIRTUAL_ENV active)"
  fi
  if [ -x "$(dirname "$PY_BIN")/pip" ] || has pip3 || has pip; then
    PIP_BIN="$(dirname "$PY_BIN")/pip"
    [ -x "$PIP_BIN" ] || PIP_BIN=$(command -v pip3 2>/dev/null || command -v pip 2>/dev/null || echo pip)
    say "pip   : $($PIP_BIN --version 2>&1 | head -1)"
  fi
  say ""
  say "torch:"
  "$PY_BIN" -c "import torch, sys; print('    version     :', torch.__version__); print('    cuda built  :', torch.version.cuda); print('    cudnn       :', torch.backends.cudnn.version()); print('    available   :', torch.cuda.is_available()); print('    device count:', torch.cuda.device_count())" 2>&1 | sed 's/^/    /' || say "    (torch not importable)"
else
  say "python: not found on PATH"
fi

# ---------- 4. COMFYUI ----------
hr2
say "[4] COMFYUI"
hr2

# Find ComfyUI directory.
COMFY_DIR=""
for candidate in "$HOME/ComfyUI" /home/jovyan/ComfyUI /opt/ComfyUI /srv/ComfyUI; do
  if [ -d "$candidate" ] && [ -f "$candidate/main.py" ]; then
    COMFY_DIR="$candidate"
    break
  fi
done
# Fallback: search one level under $HOME.
if [ -z "$COMFY_DIR" ] && [ -d "$HOME" ]; then
  while IFS= read -r -d '' d; do
    if [ -f "$d/main.py" ] && [ -d "$d/custom_nodes" ]; then
      COMFY_DIR="$d"
      break
    fi
  done < <(find "$HOME" -maxdepth 3 -type d -name ComfyUI -print0 2>/dev/null)
fi

if [ -z "$COMFY_DIR" ]; then
  say "ComfyUI: (not found under $HOME or well-known locations)"
else
  say "ComfyUI dir : $COMFY_DIR"
  say "main.py     : $([ -f "$COMFY_DIR/main.py" ] && echo present || echo missing)"
  say "size on disk: $(du -sh "$COMFY_DIR" 2>/dev/null | awk '{print $1}')"

  if [ -d "$COMFY_DIR/.git" ]; then
    say ""
    say "git status:"
    (
      cd "$COMFY_DIR" || exit
      git remote -v 2>/dev/null | sed 's/^/    remote: /'
      git rev-parse HEAD 2>/dev/null | sed 's/^/    commit: /'
      git describe --tags --exact-match 2>/dev/null | sed 's/^/    tag   : /' || echo "    tag   : (no exact tag)"
      git describe --tags 2>/dev/null | sed 's/^/    desc  : /'
    )
  else
    say ""
    say "git: not a git repository (plain directory)"
  fi

  if [ -f "$COMFY_DIR/requirements.txt" ]; then
    say ""
    say "requirements.txt (first 20 lines):"
    head -20 "$COMFY_DIR/requirements.txt" 2>/dev/null | sed 's/^/    /'
  fi

  if [ -d "$COMFY_DIR/user" ]; then
    say ""
    say "user/:"
    find "$COMFY_DIR/user" -maxdepth 2 -type d 2>/dev/null | sed 's/^/    /' | head -30
  fi

  # Config files.
  say ""
  say "config files:"
  for cf in extra_model_paths.yaml config.yml config.yaml; do
    for base in "$COMFY_DIR" "$COMFY_DIR/user" "$COMFY_DIR/user/default"; do
      if [ -f "$base/$cf" ]; then
        say "  found: $base/$cf"
      fi
    done
  done
  # Print config contents (with secret redaction).
  for base in "$COMFY_DIR" "$COMFY_DIR/user" "$COMFY_DIR/user/default"; do
    for cf in extra_model_paths.yaml config.yml config.yaml; do
      if [ -f "$base/$cf" ]; then
        echo ""
        say "  --- $base/$cf (sanitised) ---"
        redact_file "$base/$cf"
      fi
    done
  done
fi

# ---------- helper: redact_file ----------
# redact_file / redact_env_keys / human_size are defined near the top of
# the script (before any call sites) so they remain available inside
# subshells used by `while read … done < <(find …)`.

# ---------- 5. MODELS ----------
hr2
say "[5] MODELS (under ComfyUI/models)"
hr2

if [ -z "$COMFY_DIR" ] || [ ! -d "$COMFY_DIR/models" ]; then
  say "(ComfyUI/models not found)"
else
  say "tree (depth 2):"
  if has tree; then
    tree -L 2 -F "$COMFY_DIR/models" 2>/dev/null | sed 's/^/    /'
  else
    find "$COMFY_DIR/models" -maxdepth 2 -mindepth 1 2>/dev/null | sort | sed 's/^/    /'
  fi

  say ""
  say "model files (path, size, sha256[:12] when small enough):"
  # Hashing policy: only hash files smaller than 256 MiB by default. Big
  # models (>256 MiB) get size only, with a marker that the hash was
  # skipped to avoid CPU/disk thrash. Override via HASH_LIMIT_BYTES.
  HASH_LIMIT_BYTES="${HASH_LIMIT_BYTES:-268435456}"

  find "$COMFY_DIR/models" -type f \( \
       -iname '*.gguf' -o -iname '*.safetensors' -o -iname '*.ckpt' \
       -o -iname '*.pt' -o -iname '*.pth' -o -iname '*.bin' \
       -o -iname '*.onnx' -o -iname '*.ggml' \) \
       -printf '%s\t%p\n' 2>/dev/null \
    | sort -k2 \
    | while IFS=$'\t' read -r size path; do
        rel="${path#$COMFY_DIR/models/}"
        parent="$(dirname "$rel")"
        name="$(basename "$rel")"
        if [ "$size" -le "$HASH_LIMIT_BYTES" ]; then
          h=$(sha256sum "$path" 2>/dev/null | awk '{print $1}' | cut -c1-12)
          printf '    %-12s  %s  %s  [%s]\n' "$(human_size "$size")" "$parent" "$name" "$h"
        else
          printf '    %-12s  %s  %s  [hash skipped: >%s bytes]\n' \
                 "$(human_size "$size")" "$parent" "$name" "$(human_size "$HASH_LIMIT_BYTES")"
        fi
      done

  say ""
  say "totals by subdir:"
  du -sh "$COMFY_DIR/models"/* 2>/dev/null | sort -h | sed 's/^/    /'
fi

# ---------- 6. CUSTOM NODES ----------
hr2
say "[6] CUSTOM NODES"
hr2

if [ -z "$COMFY_DIR" ] || [ ! -d "$COMFY_DIR/custom_nodes" ]; then
  say "(ComfyUI/custom_nodes not found)"
else
  for d in "$COMFY_DIR/custom_nodes"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    size=$(du -sh "$d" 2>/dev/null | awk '{print $1}')
    has_git="no"
    remote=""
    commit=""
    tag=""
    if [ -d "$d/.git" ]; then
      has_git="yes"
      remote=$(git -C "$d" remote get-url origin 2>/dev/null || echo "")
      commit=$(git -C "$d" rev-parse --short HEAD 2>/dev/null || echo "")
      tag=$(git -C "$d" describe --tags --exact-match 2>/dev/null || echo "")
    fi
    has_req="no"
    [ -f "$d/requirements.txt" ] && has_req="yes"
    has_init="no"
    [ -f "$d/__init__.py" ] && has_init="yes"
    printf '  %-40s  size=%-6s  git=%-3s  req=%-3s  init=%-3s\n' \
           "$name" "$size" "$has_git" "$has_req" "$has_init"
    if [ -n "$remote" ]; then
      printf '      remote : %s\n' "$remote"
      [ -n "$commit" ] && printf '      commit : %s\n' "$commit"
      [ -n "$tag" ] && printf '      tag    : %s\n' "$tag"
    fi
  done
  say ""
  say "  (directories without .git are plain installs — cannot be re-cloned by URL)"
fi

# ---------- 7. WORKFLOWS ----------
hr2
say "[7] WORKFLOWS"
hr2

WF_DIRS=()
[ -n "$COMFY_DIR" ] && [ -d "$COMFY_DIR/user/default/workflows" ] && WF_DIRS+=("$COMFY_DIR/user/default/workflows")
# Also consider repo's own workflows directory if we're inside the audit.
[ -d "./backend/ai/workflows" ] && WF_DIRS+=("./backend/ai/workflows")
[ -d "/home/animastor/animastor/backend/ai/workflows" ] && WF_DIRS+=("/home/animastor/animastor/backend/ai/workflows")

if [ ${#WF_DIRS[@]} -eq 0 ]; then
  say "(no workflow directories found)"
else
  for wfd in "${WF_DIRS[@]}"; do
    say ""
    say "directory: $wfd"
    while IFS= read -r -d '' f; do
      size=$(stat -c%s "$f" 2>/dev/null || echo 0)
      rel="${f#$wfd/}"
      printf '  %-12s  %s\n' "$(human_size "$size")" "$rel"
    done < <(find "$wfd" -maxdepth 2 -type f -name '*.json' -print0 2>/dev/null | sort -z)

    # For each workflow JSON, extract node classes and any filename/model
    # references. Keep it bounded — first ~80 lines per file.
    say ""
    say "  -- node classes & filename references --"
    for f in "$wfd"/*.json; do
      [ -f "$f" ] || continue
      rel="${f#$wfd/}"
      [ "${rel#old_}" != "$rel" ] && continue  # skip old_*.json
      echo ""
      say "  file: $rel"
      if has jq; then
        # Extract every class_type.
        classes=$(jq -r '.. | objects | select(has("class_type")) | .class_type' "$f" 2>/dev/null | sort -u | head -60)
        say "    class_type:"
        if [ -n "$classes" ]; then
          printf '      %s\n' $classes
        else
          say "      (none / parse failed)"
        fi
        # Extract filename-ish string values from any inputs field.
        refs=$(jq -r '.. | objects | select(has("inputs")) | .inputs | to_entries[] | .value | select(type=="string") | select(test("\\.(gguf|safetensors|ckpt|pt|pth|bin|onnx|ggml)$"; "i"))' "$f" 2>/dev/null | sort -u)
        say "    file refs (.gguf / .safetensors / .ckpt / .pt / .pth / .bin / .onnx / .ggml):"
        if [ -n "$refs" ]; then
          printf '      %s\n' $refs
        else
          say "      (none)"
        fi
        # Extract model_repo values (Qwen3TTS etc.).
        repos=$(jq -r '.. | objects | select(has("inputs")) | .inputs | to_entries[] | select(.key=="model_repo") | .value | select(type=="string")' "$f" 2>/dev/null | sort -u)
        if [ -n "$repos" ]; then
          say "    model_repo:"
          printf '      %s\n' $repos
        fi
      elif has python3; then
        # Fallback parser using python3 (no jq required).
        python3 - "$f" <<'PYEOF' 2>/dev/null | sed 's/^/    /'
import json, re, sys
try:
    with open(sys.argv[1], 'r') as fh:
        data = json.load(fh)
except Exception as e:
    print(f"  (parse error: {e})")
    sys.exit(0)

FILE_RE = re.compile(r'\.(gguf|safetensors|ckpt|pt|pth|bin|onnx|ggml)$', re.I)

def walk(obj, classes, refs, repos):
    if isinstance(obj, dict):
        if 'class_type' in obj and isinstance(obj['class_type'], str):
            classes.add(obj['class_type'])
        if 'inputs' in obj and isinstance(obj['inputs'], dict):
            for k, v in obj['inputs'].items():
                if isinstance(v, str):
                    if FILE_RE.search(v):
                        refs.add(v)
                    if k == 'model_repo' and '/' in v and not v.startswith('http'):
                        repos.add(v)
        for v in obj.values():
            walk(v, classes, refs, repos)
    elif isinstance(obj, list):
        for v in obj:
            walk(v, classes, refs, repos)

classes, refs, repos = set(), set(), set()
walk(data, classes, refs, repos)
print('  class_type:')
for c in sorted(classes)[:60]:
    print(f'    {c}')
print('  file refs:')
for r in sorted(refs):
    print(f'    {r}')
if repos:
    print('  model_repo:')
    for r in sorted(repos):
        print(f'    {r}')
PYEOF
      else
        say "    (neither jq nor python3 available for JSON parsing)"
      fi
    done
  done
fi

# ---------- 8. WORKER ----------
hr2
say "[8] WORKER"
hr2

# Search common locations for worker files.
WORKER_CANDIDATES=(
  "$HOME/animastor/worker"
  "./worker/worker"
  "./worker"
  "/home/animastor/animastor/worker/worker"
  "/home/animastor/animastor/worker"
)

WORKER_DIR=""
for d in "${WORKER_CANDIDATES[@]}"; do
  if [ -d "$d" ] && [ -f "$d/worker.cjs" ]; then
    WORKER_DIR="$d"
    break
  fi
done

if [ -z "$WORKER_DIR" ]; then
  # Wider search: one level up.
  while IFS= read -r -d '' f; do
    WORKER_DIR="$(dirname "$f")"
    break
  done < <(find "$HOME" /home -maxdepth 5 -type f -name 'worker.cjs' -print0 2>/dev/null)
fi

if [ -z "$WORKER_DIR" ]; then
  say "worker.cjs: (not found)"
else
  say "worker dir: $WORKER_DIR"
  for fn in worker.cjs worker-cleanup.cjs worker-cleanup-journal.cjs package.json .env.example; do
    if [ -f "$WORKER_DIR/$fn" ]; then
      size=$(stat -c%s "$WORKER_DIR/$fn" 2>/dev/null || echo 0)
      printf '  %-32s  %s\n' "$fn" "$(human_size "$size")"
    else
      printf '  %-32s  (missing)\n' "$fn"
    fi
  done

  # Other worker-related files.
  say ""
  say "other worker-related files (top-level only):"
  for f in "$WORKER_DIR"/*; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    case "$base" in
      worker.cjs|worker-cleanup.cjs|worker-cleanup-journal.cjs|package.json|package-lock.json|.env.example) continue ;;
    esac
    size=$(stat -c%s "$f" 2>/dev/null || echo 0)
    printf '  %-32s  %s\n' "$base" "$(human_size "$size")"
  done

  # If the worker dir is itself a git repo, show commit.
  if [ -d "$WORKER_DIR/../.git" ] || [ -d "$WORKER_DIR/.git" ]; then
    say ""
    say "git:"
    for gitdir in "$WORKER_DIR/.git" "$WORKER_DIR/../.git"; do
      [ -d "$gitdir" ] || continue
      wd="$(dirname "$gitdir")"
      (
        cd "$wd" || exit
        git rev-parse --short HEAD 2>/dev/null | sed 's/^/    commit: /'
        git describe --tags --exact-match 2>/dev/null | sed 's/^/    tag   : /' || true
        git log -1 --pretty=format:'    date  : %ad%n' --date=short 2>/dev/null | sed 's/^/    /'
      )
      break
    done
  else
    say ""
    say "git: (worker dir is not a git repo)"
  fi

  # Show first ~20 lines of worker.cjs header (no secrets expected there).
  if [ -f "$WORKER_DIR/worker.cjs" ]; then
    say ""
    say "worker.cjs header (first 25 lines):"
    head -25 "$WORKER_DIR/worker.cjs" 2>/dev/null | sed 's/^/    /'
  fi
fi

# Worker launch scripts in $HOME/animastor.
say ""
say "worker launch scripts under $HOME/animastor:"
if [ -d "$HOME/animastor" ]; then
  for f in "$HOME/animastor"/start-*.sh "$HOME/animastor"/bootstrap-*.sh "$HOME/animastor"/fix-nodes-*.sh; do
    [ -f "$f" ] || continue
    size=$(stat -c%s "$f" 2>/dev/null || echo 0)
    printf '  %-40s  %s\n' "$(basename "$f")" "$(human_size "$size")"
  done
else
  say "  (no ~/animastor directory)"
fi

# ---------- 9. ENVIRONMENT (.env) ----------
hr2
say "[9] ENVIRONMENT (variable names only, secrets redacted)"
hr2

ENV_FILES=()
for cand in \
  "$WORKER_DIR/.env" \
  "$WORKER_DIR/.env.example" \
  "$HOME/animastor/.env" \
  "$HOME/animastor/.env.example" \
  "$HOME/.env" \
  "$PWD/.env" \
  "$PWD/.env.example"
do
  [ -f "$cand" ] && ENV_FILES+=("$cand")
done

if [ ${#ENV_FILES[@]} -eq 0 ]; then
  say "(no .env / .env.example found in known locations)"
else
  for f in "${ENV_FILES[@]}"; do
    say ""
    say "$f:"
    # Print keys only, redacting values for known secret names. Keep blank
    # lines and comments.
    redact_env_keys "$f"
  done
fi

# ---------- 10. STORAGE / TOTALS ----------
hr2
say "[10] STORAGE"
hr2

if [ -n "$COMFY_DIR" ]; then
  say "ComfyUI total      : $(du -sh "$COMFY_DIR" 2>/dev/null | awk '{print $1}')"
  [ -d "$COMFY_DIR/models" ] && say "  models/         : $(du -sh "$COMFY_DIR/models" 2>/dev/null | awk '{print $1}')"
  [ -d "$COMFY_DIR/custom_nodes" ] && say "  custom_nodes/  : $(du -sh "$COMFY_DIR/custom_nodes" 2>/dev/null | awk '{print $1}')"
  [ -d "$COMFY_DIR/user" ] && say "  user/          : $(du -sh "$COMFY_DIR/user" 2>/dev/null | awk '{print $1}')"
  [ -d "$COMFY_DIR/user/default/workflows" ] && say "  user/default/workflows/ : $(du -sh "$COMFY_DIR/user/default/workflows" 2>/dev/null | awk '{print $1}')"
  [ -d "$COMFY_DIR/output" ] && say "  output/        : $(du -sh "$COMFY_DIR/output" 2>/dev/null | awk '{print $1}')"
fi
if [ -n "$WORKER_DIR" ]; then
  say "worker dir total   : $(du -sh "$WORKER_DIR" 2>/dev/null | awk '{print $1}')"
fi
[ -d "$HOME/animastor" ] && say "~/animastor total   : $(du -sh "$HOME/animastor" 2>/dev/null | awk '{print $1}')"

say ""
if has df; then
  say "filesystem (df -h /):"
  df -h / 2>/dev/null | sed 's/^/    /'
fi

# ---------- 11. SUMMARY / SUGGESTIONS ----------
hr2
say "[11] NOTES"
hr2
say "  - This script is read-only. It does not install, upgrade, or remove"
say "    anything."
say "  - Secret-looking values (ANIMASTOR_WORKER_TOKEN, POSTGRES_PASSWORD,"
say "    HF_TOKEN, WORKSPACE_SECRET_KEY, GPU_HUB_API_KEY, OPENROUTER_API_KEY)"
say "    are replaced with [REDACTED] wherever a .env file is parsed."
say "  - SHA-256 is computed only for model files smaller than 256 MiB by"
say "    default. Set HASH_LIMIT_BYTES to override."
say "  - Workflows are parsed to extract class_type + filename references;"
say "    full JSON is never printed."

hr2
say "AUDIT COMPLETE — $(date -u +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)"
hr2
