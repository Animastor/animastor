#!/bin/sh
# ============================================================================
# B5 — pinned release-asset fetcher (stager-release stage, prep plan §2.1–2.5)
# ============================================================================
# Materializes the 4 GPU Hub artifact groups in <staging-root> by downloading
# the EXACT GitHub Release assets named in artifacts.lock.json:
#
#   <base>/<source_repository>/releases/download/<release_tag>/<asset_filename>
#
# For every group, in order:
#   1. read the pin (source_repository, release_tag, asset_filename,
#      sha256_asset) from the lock — no implicit asset choice (§2.1);
#   2. FAIL when sha256_asset is not pinned (the committed pre-split lock has
#      null — the first real release pins it; next-blockers §B5 POST-SPLIT);
#   3. download and verify the asset's sha256 against the pin — a mismatch
#      fails the build AT STAGING, before `COPY --from=stager` (§2.3);
#   4. unzip into the consumer-facing group directory (hub-workflows →
#      workflows/, the Dockerfile stager layout).
# The sha256_tree gate (verify-staged-artifacts.sh) then re-verifies the
# EXTRACTED trees against the same lock: asset pin + content-tree pin.
#
# POSIX sh + busybox toolset (alpine stager): curl/unzip via apk, no bash.
#
# Usage: fetch-pinned-assets.sh <artifacts.lock.json> <staging-root> <release-url-base>
# ============================================================================

set -eu

LOCK="${1:?usage: fetch-pinned-assets.sh <artifacts.lock.json> <staging-root> <release-url-base>}"
STAGE="${2:?usage: fetch-pinned-assets.sh <artifacts.lock.json> <staging-root> <release-url-base>}"
BASE="${3:?usage: fetch-pinned-assets.sh <artifacts.lock.json> <staging-root> <release-url-base>}"
BASE=${BASE%/}

fail() { echo "FATAL (fetch-pinned-assets): $*" >&2; exit 1; }

[ -f "$LOCK" ]       || fail "artifacts lock not found: $LOCK"
command -v curl      >/dev/null 2>&1 || fail "curl missing in stager image (apk add curl)"
command -v unzip     >/dev/null 2>&1 || fail "unzip missing in stager image (apk add unzip)"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum missing in stager image"

# extract_field <artifact-name> <field> → raw scalar (quotes/trim stripped).
# The lock is machine-written by tools/update-artifacts-lock.cjs with one
# field per line and stable ordering, so line-oriented extraction is safe.
extract_field() {
    awk -v name="\"$1\"" -v field="\"$2\"" '
        index($0, name ":") > 0 { in_art = 1 }
        in_art && /\}/          { in_art = 0 }
        in_art && index($0, field ":") > 0 {
            line = $0
            sub(/^[^:]*:[[:space:]]*/, "", line)
            sub(/[[:space:]]*,[[:space:]]*$/, "", line)
            sub(/^"/, "", line)
            sub(/"$/, "", line)
            print line
            exit
        }
    ' "$LOCK"
}

checked=0
for name in worker-bundle hub-workflows installer-src install-manifests; do
    repo=$(extract_field "$name" source_repository)
    tag=$(extract_field "$name" release_tag)
    asset=$(extract_field "$name" asset_filename)
    sha=$(extract_field "$name" sha256_asset)

    [ -n "$repo" ] && [ -n "$tag" ] && [ -n "$asset" ] \
        || fail "incomplete pin for '$name' in $LOCK"
    [ -n "$sha" ] && [ "$sha" != "null" ] \
        || fail "'$name' has no sha256_asset pin in $LOCK — pin the released zip (POST-SPLIT, prep plan §2.5)"
    case "$sha" in
        *[!0-9a-f]*) fail "'$name'.sha256_asset is not a hex digest" ;;
    esac
    [ "${#sha}" -eq 64 ] || fail "'$name'.sha256_asset must be 64 hex chars, got ${#sha}"

    # Contract name → staged directory (same mapping as verify-staged):
    case "$name" in
        hub-workflows) dir=workflows ;;
        *)             dir=$name ;;
    esac

    url="$BASE/$repo/releases/download/$tag/$asset"
    zip="/tmp/pinned-$name.zip"
    mkdir -p "$STAGE/$dir"

    echo "  fetch: $name <- $asset"
    curl -fsSL --retry 2 -o "$zip" "$url" \
        || fail "download failed (the pinned asset must exist at its exact URL): $url"

    actual=$(sha256sum "$zip" | cut -d' ' -f1)
    [ "$actual" = "$sha" ] \
        || fail "asset sha256 mismatch for '$name': downloaded=$actual pinned=$sha"

    unzip -q -o "$zip" -d "$STAGE/$dir" || fail "unzip failed: $asset"
    rm -f "$zip"
    checked=$((checked + 1))
done

[ "$checked" -eq 4 ] || fail "expected 4 pinned assets, fetched $checked"
echo "pinned assets fetched and sha256-verified: 4/4"
