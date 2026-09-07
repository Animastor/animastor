'use strict';

/**
 * Bootstrap installer scripts — Private Worker onboarding (Phase 3.2,
 * cross-platform extension).
 *
 * The hub serves a SMALL, auditable launcher script at GET /installer. The
 * user runs it on the GPU machine; it performs the full bootstrap:
 *
 *   1. detects the platform implicitly (the script ITSELF is the platform
 *      choice: bash launcher for Linux, PowerShell launcher for Windows);
 *   2. resolves HUB_URL / PROFILE / MODE (embedded at download time,
 *      overridable via env for power users);
 *   3. checks prerequisites (curl|wget, tar, sha256sum) and a Node.js >= 20
 *      runtime — if none is present, a PINNED Node.js runtime is downloaded
 *      from nodejs.org and verified against the official SHASUMS256.txt
 *      (TLS to nodejs.org is the trust anchor), installed under
 *      ~/.animastor/node-runtime/ and reused by later runs;
 *   4. downloads the actual installer bundle from <HUB_URL>/installer/bundle;
 *   5. verifies its integrity against the sha256 the hub publishes at
 *      <HUB_URL>/installer/sha256 (the SAME checksum the web page shows);
 *   6. unpacks it into a temporary directory and runs the real installer
 *      CLI:  node cli.js install --profile <p> --mode <m>  (+ user args);
 *   7. the Worker Key is asked INTERACTIVELY by the installer (hidden
 *      input) — the launcher never accepts, stores or forwards a key.
 *
 * Security model (must hold forever):
 *   - NO credential in the script, the download URL, argv, env or the
 *     bootstrap's own output; credential-bearing env names are actively
 *     REJECTED (fail closed) to stop "just export the token" misuse;
 *   - profile/mode are NOT secrets — they are validated against the hub's
 *     manifest allowlist before being embedded (see gpu-hub.js);
 *   - the installer bundle checksum is verified before anything is executed;
 *   - the Node runtime checksum is verified against nodejs.org SHASUMS256.txt;
 *   - everything else is unpacked into a temp dir wiped on exit.
 */

const BOOTSTRAP_VERSION = '1.1.0';

/** Pinned Node.js runtime provisioned when the host has none (>= 20 required). */
const NODE_VERSION = 'v22.23.2';

/**
 * Build the Linux (bash) bootstrap script. Every interpolation is
 * validated/escaped by the caller (gpu-hub.js): hubUrl/origin are
 * host-checked, profile comes from the canonical manifest allowlist, mode
 * from a fixed enum.
 * @param {{ hubUrl: string, profile: string|null, mode: string|null,
 *           installerVersion: string|null }} args
 * @returns {string} the shell script
 */
function buildBootstrapScript({ hubUrl, profile = null, mode = null, installerVersion = null }) {
    const escaped = (v) => String(v).replace(/(["\\$`])/g, '\\$1');
    return `#!/usr/bin/env bash
# ============================================================================
# Animastor GPU Worker installer bootstrap (Linux) v${BOOTSTRAP_VERSION}
# installer bundle version: ${installerVersion ? escaped(installerVersion) : 'latest'}
# hub: ${escaped(hubUrl)}
#
# What it does: verifies prerequisites, provisions a pinned Node.js runtime
# if the host has none, downloads the installer bundle, verifies its SHA-256
# against the checksum published by the hub, unpacks it and runs the real
# installer (which asks for the Worker Key interactively, hidden input —
# NEVER pass the key to this script or in the environment).
#
# Auditable on purpose: read this file before running it.
# ============================================================================
set -euo pipefail

# ---- Configuration (embedded; environment overrides for power users) ----
HUB_URL="\${ANIMASTOR_HUB_URL:-${escaped(hubUrl)}}"
INSTALL_PROFILE="\${ANIMASTOR_PROFILE:-${profile ? escaped(profile) : ''}}"
INSTALL_MODE="\${ANIMASTOR_MODE:-${mode ? escaped(mode) : ''}}"
NODE_VERSION="${NODE_VERSION}"

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

# ---- 0. Node.js runtime (system node preferred, pinned runtime provisioned) ----
NODE_MAJOR_OK() { [ "\$("\$1" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)" -ge 20 ]; }
NODE_BIN=""
for candidate in node node20 node22; do
  if command -v "\$candidate" >/dev/null 2>&1 && NODE_MAJOR_OK "\$candidate"; then NODE_BIN="\$candidate"; break; fi
done

if [ -z "\$NODE_BIN" ]; then
  say "[0/4] No usable Node.js >= 20 found — provisioning the pinned runtime (\$NODE_VERSION) ..."
  ARCH=\$(uname -m)
  case "\$ARCH" in
    x86_64)          ARCH="x64" ;;
    aarch64|arm64)   ARCH="arm64" ;;
    *) fail "unsupported architecture '\$ARCH' — install Node.js >= 20 manually and re-run." ;;
  esac
  TARBALL="node-\$NODE_VERSION-linux-\$ARCH.tar.gz"
  RUNTIME_DIR="\$HOME/.animastor/node-runtime/\$NODE_VERSION"
  mkdir -p "\$RUNTIME_DIR"
  fetch "\$RUNTIME_DIR/SHASUMS256.txt" "https://nodejs.org/dist/\$NODE_VERSION/SHASUMS256.txt" \\
    || fail "could not download the Node.js checksum list from nodejs.org. Install Node.js >= 20 manually and re-run."
  EXPECTED_NODE_SHA=\$(grep " \$TARBALL\\\$" "\$RUNTIME_DIR/SHASUMS256.txt" | awk '{print \$1}')
  [ -n "\$EXPECTED_NODE_SHA" ] || fail "nodejs.org SHASUMS256.txt has no entry for \$TARBALL — refusing to run an unverified runtime."
  if [ ! -f "\$RUNTIME_DIR/\$TARBALL" ]; then
    fetch "\$RUNTIME_DIR/\$TARBALL" "https://nodejs.org/dist/\$NODE_VERSION/\$TARBALL" \\
      || fail "could not download \$TARBALL from nodejs.org. Install Node.js >= 20 manually and re-run."
  fi
  ACTUAL_NODE_SHA=\$(sha256sum "\$RUNTIME_DIR/\$TARBALL" | awk '{print \$1}')
  if [ "\$ACTUAL_NODE_SHA" != "\$EXPECTED_NODE_SHA" ]; then
    fail "Node.js runtime integrity check FAILED — the downloaded runtime does not match nodejs.org SHASUMS256.txt. It was NOT used. Re-run to retry."
  fi
  if [ ! -x "\$RUNTIME_DIR/node-\$NODE_VERSION-linux-\$ARCH/bin/node" ]; then
    tar -xzf "\$RUNTIME_DIR/\$TARBALL" -C "\$RUNTIME_DIR"
  fi
  NODE_BIN="\$RUNTIME_DIR/node-\$NODE_VERSION-linux-\$ARCH/bin/node"
  [ -x "\$NODE_BIN" ] || fail "provisioned Node.js runtime is not executable — install Node.js >= 20 manually and re-run."
  # The installer itself spawns "node"/"npm" by name: make the pinned
  # runtime visible to it for this run (and only this run).
  export PATH="\$RUNTIME_DIR/node-\$NODE_VERSION-linux-\$ARCH/bin:\$PATH"
  say "      using provisioned Node.js \$("\$NODE_BIN" --version)"
else
  say "[0/4] Node.js found: \$("\$NODE_BIN" --version)"
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

/**
 * Build the Windows (PowerShell) bootstrap script — the platform-specific
 * launcher for the SAME universal installer. Architectural preview: the
 * flow mirrors the bash bootstrap (credential rejection, node provisioning,
 * checksum verification, temp-dir hygiene), but Windows itself is not
 * production-supported by the installer yet.
 * @param {{ hubUrl: string, profile: string|null, mode: string|null,
 *           installerVersion: string|null }} args
 * @returns {string} the PowerShell script
 */
function buildWindowsBootstrapScript({ hubUrl, profile = null, mode = null, installerVersion = null }) {
    const psString = (v) => String(v).replace(/'/g, "''");
    return `# =============================================================================
# Animastor GPU Worker installer bootstrap (Windows) v${BOOTSTRAP_VERSION}
# installer bundle version: ${installerVersion ? psString(installerVersion) : 'latest'}
# hub: ${psString(hubUrl)}
#
# Run with:  powershell -ExecutionPolicy Bypass -File .\\animastor-installer.ps1
#
# What it does: verifies prerequisites, provisions a pinned Node.js runtime
# if the host has none, downloads the installer bundle, verifies its SHA-256
# against the checksum published by the hub, unpacks it and runs the real
# installer (which asks for the Worker Key interactively, hidden input —
# NEVER pass the key to this script or in the environment).
#
# Auditable on purpose: read this file before running it.
# Windows support status: PREVIEW — the platform adapter is implemented, but
# Windows is not production-validated yet.
# =============================================================================
$ErrorActionPreference = 'Stop'

# ---- Configuration (embedded; environment overrides for power users) ----
$HubUrl         = if ($env:ANIMASTOR_HUB_URL) { $env:ANIMASTOR_HUB_URL } else { '${psString(hubUrl)}' }
$InstallProfile = if ($env:ANIMASTOR_PROFILE)  { $env:ANIMASTOR_PROFILE }  else { '${profile ? psString(profile) : ''}' }
$InstallMode    = if ($env:ANIMASTOR_MODE)     { $env:ANIMASTOR_MODE }     else { '${mode ? psString(mode) : ''}' }
$NodeVersion    = '${NODE_VERSION}'

# ---- Fail closed: this script NEVER takes credentials ----
foreach ($var in 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TOKEN', 'WORKER_KEY') {
    if ([Environment]::GetEnvironmentVariable($var)) {
        Write-Error "ERROR: $var is set in the environment. The bootstrap never accepts the Worker Key - run the script WITHOUT it; the installer will ask for the key interactively."
        exit 3
    }
}
foreach ($arg in $args) {
    if ($arg -match 'wrk\\.' -or $arg -match '^--worker-key' -or $arg -match '^--worker-token') {
        Write-Error "ERROR: credential-like argument detected. The Worker Key must be typed at the installer's hidden prompt."
        exit 3
    }
}

if (-not $HubUrl) {
    Write-Error 'ERROR: no hub URL configured (ANIMASTOR_HUB_URL or the embedded default).'
    exit 3
}
$HubUrl = $HubUrl.TrimEnd('/')

function Fail($message) {
    Write-Error "ERROR: $message"
    exit 1
}

function FetchFile($dest, $url) {
    # Invoke-WebRequest is built into every supported Windows PowerShell.
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $dest
    if (-not (Test-Path $dest)) { Fail "download failed: $url" }
}

# ---- Prerequisites ----
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    Fail "tar.exe is required (bundled with Windows 10 1803+). Update Windows or install Node.js >= 20 manually and re-run."
}

# ---- 0. Node.js runtime (system node preferred, pinned runtime provisioned) ----
$NodeBin = $null
foreach ($candidate in @('node', 'node20', 'node22')) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) {
        $v = (& $cmd.Source -v) 2>$null
        if ($v -match '^v(\\d+)') { if ([int]$Matches[1] -ge 20) { $NodeBin = $cmd.Source; break } }
    }
}

if (-not $NodeBin) {
    Write-Host "[0/4] No usable Node.js >= 20 found - provisioning the pinned runtime ($NodeVersion) ..."
    $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { Fail '32-bit Windows is not supported - install Node.js >= 20 manually and re-run.' }
    $zipName    = "node-$NodeVersion-win-$arch.zip"
    $runtimeDir = Join-Path $env:USERPROFILE ".animastor\\node-runtime\\$NodeVersion"
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    FetchFile (Join-Path $runtimeDir 'SHASUMS256.txt') "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt"
    $shaLine = (Select-String -Path (Join-Path $runtimeDir 'SHASUMS256.txt') -Pattern ([regex]::Escape($zipName)) | Select-Object -First 1).Line
    if (-not $shaLine) { Fail "nodejs.org SHASUMS256.txt has no entry for $zipName - refusing to run an unverified runtime." }
    $expectedNodeSha = ($shaLine -split '\\s+')[0].ToLower()
    $zipPath = Join-Path $runtimeDir $zipName
    if (-not (Test-Path $zipPath)) {
        FetchFile $zipPath "https://nodejs.org/dist/$NodeVersion/$zipName"
    }
    $actualNodeSha = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLower()
    if ($actualNodeSha -ne $expectedNodeSha) {
        Fail "Node.js runtime integrity check FAILED - the downloaded runtime does not match nodejs.org SHASUMS256.txt. It was NOT used. Re-run to retry."
    }
    $nodeDir = Join-Path $runtimeDir "node-$NodeVersion-win-$arch"
    if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
        Expand-Archive -Path $zipPath -DestinationPath $runtimeDir -Force
    }
    $NodeBin = Join-Path $nodeDir 'node.exe'
    if (-not (Test-Path $NodeBin)) { Fail 'provisioned Node.js runtime is not executable - install Node.js >= 20 manually and re-run.' }
    # The installer itself spawns node/npm by name: make the pinned runtime
    # visible to it for this run (and only this run).
    $env:PATH = "$nodeDir;$env:PATH"
    Write-Host "      using provisioned Node.js $(& $NodeBin -v)"
} else {
    Write-Host "[0/4] Node.js found: $(& $NodeBin -v)"
}

if (-not $InstallProfile) {
    Write-Error 'ERROR: no install profile configured. Download the bootstrap from the Animastor setup page - it embeds the profile and mode you selected.'
    exit 3
}

# ---- Temporary workspace (wiped on exit) ----
$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("animastor-installer-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
$bundleTgz = Join-Path $workDir 'animastor-installer.tar.gz'

try {
    # ---- 1. Download the installer bundle ----
    Write-Host "[1/4] Downloading the Animastor installer bundle from $HubUrl ..."
    FetchFile $bundleTgz "$HubUrl/installer/bundle"

    # ---- 2. Verify integrity against the hub-published checksum ----
    Write-Host '[2/4] Verifying integrity (SHA-256) ...'
    $metaPath = Join-Path $workDir 'installer-sha256.json'
    FetchFile $metaPath "$HubUrl/installer/sha256"
    $meta = Get-Content $metaPath -Raw | ConvertFrom-Json
    $expectedSha = if ($meta.sha256) { [string]$meta.sha256 } else { $null }
    if (-not ($expectedSha -match '^[0-9a-fA-F]{64}$')) {
        Fail "integrity check failed: $HubUrl/installer/sha256 did not return a valid sha256. Refusing to run an unverified installer."
    }
    $actualSha = (Get-FileHash -Algorithm SHA256 $bundleTgz).Hash.ToLower()
    if ($actualSha -ne $expectedSha.ToLower()) {
        Write-Host "  expected: $expectedSha"
        Write-Host "  actual:   $actualSha"
        Fail 'integrity check FAILED - the downloaded installer does not match the published checksum. It was NOT executed. Re-download and try again.'
    }
    Write-Host ("  checksum OK (" + $expectedSha.Substring(0, 16) + "...)" )

    # ---- 3. Unpack into the temporary workspace ----
    Write-Host '[3/4] Unpacking ...'
    tar -xzf $bundleTgz -C $workDir
    if ($LASTEXITCODE -ne 0) { Fail 'unpacking the installer bundle failed - the bundle may be corrupt, re-download.' }
    $cli = Join-Path $workDir 'animastor-installer\\src\\installer\\cli.js'
    if (-not (Test-Path $cli)) { Fail 'unexpected bundle layout: animastor-installer/src/installer/cli.js not found. The bundle may be corrupt - re-download.' }

    # ---- 4. Run the real installer (profile/mode embedded - nothing to type) ----
    Write-Host "[4/4] Starting the Animastor installer (profile: $InstallProfile, mode: $InstallMode) ..."
    Write-Host '      It will ask for the Worker Key (hidden input) - paste the key from the setup page.'
    Write-Host ''
    Push-Location $workDir
    & $NodeBin $cli install --profile $InstallProfile --mode $InstallMode @args
    $status = $LASTEXITCODE
    Pop-Location
} finally {
    Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
}

Write-Host ''
if ($status -eq 0) {
    Write-Host 'Done. Return to the Animastor setup page - the worker status becomes Online after its first heartbeat (usually within 30 seconds).'
    exit 0
} else {
    Write-Host "The installer exited with an error (code $status). Nothing was hidden:" -ForegroundColor Yellow
    Write-Host 'scroll up for the remediation the installer printed, fix the issue and re-run this script - it is safe to run repeatedly.'
    exit $status
}
`;
}

module.exports = { buildBootstrapScript, buildWindowsBootstrapScript, BOOTSTRAP_VERSION, NODE_VERSION };
