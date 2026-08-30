'use strict';

/**
 * Bootstrap installer script — Private Worker onboarding (Phase 3.2).
 *
 * The hub serves a small, auditable shell script at GET /installer. The
 * user runs it on the GPU machine; it performs the full bootstrap:
 *
 *   1. resolves HUB_URL / PROFILE / MODE (embedded at download time,
 *      overridable via env for power users);
 *   2. checks prerequisites (curl|wget, tar, sha256sum, Node.js >= 20)
 *      and prints exact remediation instead of guessing;
 *   3. downloads the actual installer bundle from <HUB_URL>/installer/bundle;
 *   4. verifies its integrity against the sha256 the hub publishes at
 *      <HUB_URL>/installer/sha256 (the SAME checksum the web page shows);
 *   5. unpacks it into a temporary directory and runs the real installer
 *      CLI:  node cli.js install --profile <p> --mode <m>  (+ user args);
 *   6. the Worker Key is asked INTERACTIVELY by the installer (hidden
 *      input) — this script never accepts, stores or forwards a key.
 *
 * Security model (must hold forever):
 *   - NO credential in the script, the download URL, argv, env or the
 *     bootstrap's own output; credential-bearing env names are actively
 *     REJECTED (fail closed) to stop "just export the token" misuse;
 *   - profile/mode are NOT secrets — they are validated against the hub's
 *     manifest allowlist before being embedded (see gpu-hub.js);
 *   - the bundle checksum is verified before anything is executed;
 *   - everything is unpacked into a temp dir wiped on exit.
 */

const BOOTSTRAP_VERSION = '1.0.0';

/**
 * Build the bootstrap script. Every interpolation is validated/escaped by
 * the caller (gpu-hub.js): hubUrl/origin are host-checked, profile comes
 * from the canonical manifest allowlist, mode from a fixed enum.
 * @param {{ hubUrl: string, profile: string|null, mode: string|null,
 *           installerVersion: string|null }} args
 * @returns {string} the shell script
 */
function buildBootstrapScript({ hubUrl, profile = null, mode = null, installerVersion = null }) {
    const escaped = (v) => String(v).replace(/(["\\$`])/g, '\\$1');
    return `#!/usr/bin/env bash
# ============================================================================
# Animastor GPU Worker installer bootstrap v${BOOTSTRAP_VERSION}
# installer bundle version: ${installerVersion ? escaped(installerVersion) : 'latest'}
# hub: ${escaped(hubUrl)}
#
# What it does: verifies prerequisites, downloads the installer bundle,
# verifies its SHA-256 against the checksum published by the hub, unpacks it
# and runs the real installer (which asks for the Worker Key interactively,
# hidden input — NEVER pass the key to this script or in the environment).
#
# Auditable on purpose: read this file before running it.
# ============================================================================
set -euo pipefail

# ---- Configuration (embedded; environment overrides for power users) ----
HUB_URL="\${ANIMASTOR_HUB_URL:-${escaped(hubUrl)}}"
INSTALL_PROFILE="\${ANIMASTOR_PROFILE:-${profile ? escaped(profile) : ''}}"
INSTALL_MODE="\${ANIMASTOR_MODE:-${mode ? escaped(mode) : ''}}"

# ---- Fail closed: this script NEVER takes credentials ----
# The Worker Key is entered interactively inside the real installer (hidden
# input). If someone tries to hand it to the bootstrap, refuse loudly.
for var in ANIMASTOR_WORKER_TOKEN WORKER_TOKEN WORKER_KEY; do
  if [ -n "\${!var:-}" ]; then
    echo "ERROR: \$var is set in the environment." >&2
    echo "       The bootstrap never accepts the Worker Key — run the script" >&2
    echo "       WITHOUT it; the installer will ask for the key interactively." >&2
    exit 3
  fi
done
for arg in "$@"; do
  case "\$arg" in
    *wrk.*|--worker-key*|--worker-token*)
      echo "ERROR: credential-like argument detected: '\$arg'." >&2
      echo "       The Worker Key must be typed at the installer's hidden prompt." >&2
      exit 3 ;;
  esac
done

if [ -z "\$HUB_URL" ]; then
  echo "ERROR: no hub URL configured (ANIMASTOR_HUB_URL or the embedded default)." >&2
  exit 3
fi
HUB_URL="\${HUB_URL%/}"

say()  { printf '%s\\n' "\$*"; }
fail() { printf 'ERROR: %s\\n' "\$*" >&2; exit 1; }

# ---- Prerequisites (checked, never auto-installed) ----
FETCH=""
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL -o "\$1" "\$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "\$1" "\$2"; }
else
  fail "curl or wget is required to download the installer. Install one of them (e.g. 'sudo apt-get install curl') and re-run this script."
fi
command -v tar >/dev/null 2>&1 || fail "tar is required to unpack the installer. Install it (e.g. 'sudo apt-get install tar') and re-run."
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required to verify the installer integrity. Install coreutils and re-run."

NODE_BIN=""
for candidate in node node20 node22; do
  if command -v "\$candidate" >/dev/null 2>&1; then NODE_BIN="\$candidate"; break; fi
done
if [ -z "\$NODE_BIN" ]; then
  say "ERROR: Node.js >= 20 is required to run the Animastor installer." >&2
  say "" >&2
  say "Install it with one of the following and re-run this script:" >&2
  say "  # Debian/Ubuntu (NodeSource)" >&2
  say "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs" >&2
  say "  # or via nvm (no root required)" >&2
  say "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22" >&2
  exit 1
fi
NODE_MAJOR=\$("\$NODE_BIN" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)
if [ "\$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  fail "Node.js >= 20 is required (found: \$("\$NODE_BIN" --version)). Upgrade Node.js and re-run."
fi

if [ -z "\$INSTALL_PROFILE" ]; then
  say "ERROR: no install profile configured." >&2
  say "Download the bootstrap from the Animastor setup page — it embeds the" >&2
  say "profile and mode you selected (e.g. /gpu/installer?profile=image%2Fqwen-image&mode=managed)." >&2
  exit 3
fi

# ---- Temporary workspace (wiped on exit) ----
WORK_DIR=\$(mktemp -d "\${TMPDIR:-/tmp}/animastor-installer.XXXXXX")
cleanup() { rm -rf "\$WORK_DIR"; }
trap cleanup EXIT INT TERM

BUNDLE_TGZ="\$WORK_DIR/animastor-installer.tar.gz"

# ---- 1. Download the installer bundle ----
say "[1/4] Downloading the Animastor installer bundle from \$HUB_URL ..."
fetch "\$BUNDLE_TGZ" "\$HUB_URL/installer/bundle" || fail "download failed: \$HUB_URL/installer/bundle is unreachable. Check your network (HTTPS required) and try again."

# ---- 2. Verify integrity against the hub-published checksum ----
say "[2/4] Verifying integrity (SHA-256) ..."
META_URL="\$HUB_URL/installer/sha256"
if fetch "\$WORK_DIR/installer-sha256.json" "\$META_URL"; then
  # Parse the "sha256" field without jq (busybox/GNU sed safe). The value is
  # hex from the hub itself; re-validate the shape before using it.
  EXPECTED_SHA=\$(sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\\([0-9a-fA-F]\\{64\\}\\)".*/\\1/p' "\$WORK_DIR/installer-sha256.json" | head -n1)
  if [ -z "\$EXPECTED_SHA" ]; then
    fail "integrity check failed: \$META_URL did not return a valid sha256. Refusing to run an unverified installer."
  fi
  ACTUAL_SHA=\$(sha256sum "\$BUNDLE_TGZ" | awk '{print \$1}')
  if [ "\$ACTUAL_SHA" != "\$EXPECTED_SHA" ]; then
    say "  expected: \$EXPECTED_SHA" >&2
    say "  actual:   \$ACTUAL_SHA" >&2
    fail "integrity check FAILED — the downloaded installer does not match the published checksum. It was NOT executed. Re-download and try again."
  fi
  say "  checksum OK (\$\{EXPECTED_SHA:0:16}...)"
else
  fail "integrity check failed: could not fetch \$META_URL. Refusing to run an unverified installer."
fi

# ---- 3. Unpack into the temporary workspace ----
say "[3/4] Unpacking ..."
tar -xzf "\$BUNDLE_TGZ" -C "\$WORK_DIR"
CLI="\$WORK_DIR/animastor-installer/src/installer/cli.js"
[ -f "\$CLI" ] || fail "unexpected bundle layout: animastor-installer/src/installer/cli.js not found. The bundle may be corrupt — re-download."

# ---- 4. Run the real installer (profile/mode embedded — nothing to type) ----
say "[4/4] Starting the Animastor installer (profile: \$INSTALL_PROFILE, mode: \$INSTALL_MODE) ..."
say "      It will ask for the Worker Key (hidden input) — paste the key from the setup page."
say ""
cd "\$WORK_DIR"
set +e
"\$NODE_BIN" "\$CLI" install --profile "\$INSTALL_PROFILE" --mode "\$INSTALL_MODE" "\$@"
STATUS=\$?
set -e

say ""
if [ \$STATUS -eq 0 ]; then
  say "Done. Return to the Animastor setup page — the worker status becomes"
  say "Online after its first heartbeat (usually within 30 seconds)."
else
  say "The installer exited with an error (code \$STATUS). Nothing was hidden:" >&2
  say "scroll up for the remediation the installer printed, fix the issue and" >&2
  say "re-run this script — it is safe to run repeatedly." >&2
fi
exit \$STATUS
`;
}

module.exports = { buildBootstrapScript, BOOTSTRAP_VERSION };
