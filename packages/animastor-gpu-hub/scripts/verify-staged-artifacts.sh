#!/bin/sh
# ============================================================================
# B5 — artifact integrity gate (prep plan §2.3, §2.5)
# ============================================================================
# Verifies the CONTENT DIGEST of every staged artifact group against
# artifacts.lock.json — on the STAGING tree, BEFORE `COPY --from=stager`
# moves it into the runtime image. A mismatch fails the docker build, so
# the build can never silently bake a different artifact.
#
# Scope guard (Phase 10T.1 package boundary): this script lives INSIDE
# packages/animastor-gpu-hub/ (it is part of the hub deployment story).
# scripts/check-artifacts.sh (repo root) stays the post-build validator:
#   [4/6] per-workflow SHA256 baseline check (content-level, already exists)
#   [3/6] worker min_version compat check (already exists)
# This gate adds the MISSING level: per-GROUP digest check of the staging
# tree itself (prep plan §2.3 level 1).
#
# Digest definition (sha256-tree): sha256 over newline-joined
#   "<sha256(file)>  <relative-path>" lines, paths sorted C-locale,
#   LF-terminated — matching tools/update-artifacts-lock.cjs.
#
# POSIX sh + busybox toolset only (stager stage is alpine:3.19):
# no node, no jq, no bashisms.
# ============================================================================

set -eu

LOCK="${1:?usage: verify-staged-artifacts.sh <artifacts.lock.json> <staging-root>}"
STAGE_ROOT="${2:?usage: verify-staged-artifacts.sh <artifacts.lock.json> <staging-root>}"

# ── minimal JSON field extraction (busybox sed) ────────────────────────────
# The lock file is machine-written by tools/update-artifacts-lock.cjs with
# one field per line and stable ordering, so line-oriented extraction is
# deterministic. If the shape changes, update the writer, not this parser.
json_str() { # json_str <key> <section>  → string value or empty
    sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*{.*/\\1/p; s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\\1/p" "$LOCK" \
      | head -n 1
}

# Better approach for a flat-per-artifact layout: use awk over lines between
# the artifact's quoted name and the closing brace. Implemented portably:
extract_artifact_field() { # <artifact-name> <field>
    awk -v name="\"$1\"" -v field="\"$2\"" '
        index($0, name ":") > 0 || index($0, name " :") > 0 { in_art = 1 }
        in_art && /\}/                       { in_art = 0 }
        in_art && index($0, field ":") > 0 {
            line = $0
            sub(/.*"[^"]*"[[:space:]]*:[[:space:]]*"/, "", line)
            sub(/".*$/, "", line)
            print line
            exit
        }
    ' "$LOCK"
}

fail() { echo "FATAL (verify-staged-artifacts): $*" >&2; exit 1; }

[ -f "$LOCK" ] || fail "artifacts lock not found: $LOCK"
[ -d "$STAGE_ROOT" ] || fail "staging root not found: $STAGE_ROOT"

checked=0
for name in worker-bundle hub-workflows installer-src install-manifests; do
    expected=$(extract_artifact_field "$name" "sha256_tree")
    [ -n "$expected" ] || fail "artifact '$name' missing sha256_tree in $LOCK"

    # Contract name → staged directory name (Dockerfile stager layout):
    # the hub-workflows group is staged as workflows/ (consumer-facing name).
    case "$name" in
        hub-workflows) dir_name=workflows ;;
        *)             dir_name=$name ;;
    esac

    dir="$STAGE_ROOT/$dir_name"
    [ -d "$dir" ] || fail "staged group '$name' missing at $dir"

    # Canonical digest: sha256 over sorted "<sha256(file)>  <relpath>" lines.
    # -type f only; excludes nothing — the staged trees contain exactly the
    # contract files (the lock writer walks the same trees at pin time).
    actual=$(
        cd "$dir" && find . -type f ! -name package-lock.json | LC_ALL=C sort | while IFS= read -r f; do
            printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "${f#./}"
        done | sha256sum | cut -d' ' -f1
    )

    if [ "$actual" != "$expected" ]; then
        fail "artifact '$name' digest mismatch: staged=$actual locked=$expected"
    fi

    echo "  ok: $name (sha256_tree ${expected#????????})"
    checked=$((checked + 1))
done

[ "$checked" -eq 4 ] || fail "expected 4 artifact groups, checked $checked"
echo "artifact integrity gate: 4/4 groups match artifacts.lock.json (staging, pre-COPY)"
