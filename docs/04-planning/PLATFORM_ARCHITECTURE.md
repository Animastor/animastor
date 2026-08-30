# Platform Architecture — Cross-Platform Installer

> **Version:** 1.0.0
> **Status:** Implemented (2026-08-30)
> **Installer version:** 1.3.0
>
> This document describes the **implemented** cross-platform architecture
> of Animastor Installer — two orthogonal dimensions: **Platform (OS)** and
> **Deployment (runtime environment)** — and how adapters compose them.

---

## Table of Contents

1. [Two Dimensions, Not Two Installers](#1-two-dimensions)
2. [Platform Dimension (OS)](#2-platform-dimension)
3. [Deployment Dimension](#3-deployment-dimension)
4. [Bootstrap → Node → Universal Installer → Adapters](#4-bootstrap-chain)
5. [Platform Adapter Interface](#5-adapter-interface)
6. [Deployment Adapter Interface](#6-deployment-interface)
7. [CLI Boot Sequence](#7-cli-boot)
8. [Security Model](#8-security)
9. [Path Handling](#9-paths)
10. [Testing Strategy](#10-testing)
11. [Current State](#11-current-state)

---

## 1. Two Dimensions, Not Two Installers {#1-two-dimensions}

Platform and Deployment are **orthogonal**. A platform (Linux/Windows) runs with
any supported deployment (Native/Docker). They are never mixed:

```
Platform        Deployment   Status
─────────────────────────────────────
Linux           Native       ← production-ready (unchanged behavior)
Linux           Docker       ← experimental (productionReady: false)
Windows         Native       ← architectural preview (not production-validated)
Windows         Docker       ← rejected (no container runtime on Windows)
```

**Key invariant:** Selecting a platform never changes the installer's behavior
beyond OS-specific process discovery, script generation, and path handling.
The install workflow, profile format, security model, and business logic are
identical across platforms.

---

## 2. Platform Dimension (OS) {#2-platform-dimension}

Platforms are **detected from the live host**, never from a CLI flag or env var.
`ANIMASTOR_PLATFORM` is rejected at boot.

| Platform | Adapter | Detection | Status |
|----------|---------|-----------|--------|
| linux    | `platform/linux.js` | `process.platform === 'linux'` | Production-ready |
| windows  | `platform/windows.js` | `process.platform === 'win32'` | Preview |
| unsupported | — | Error thrown | — |

Source: `backend/src/installer/platform/index.js`

---

## 3. Deployment Dimension {#3-deployment-dimension}

Deployments **are** env-selectable (`ANIMASTOR_DEPLOYMENT`). Detection order:
1. `process.env.ANIMASTOR_DEPLOYMENT` overrides everything
2. `/.dockerenv` present → docker
3. Windows always → native
4. Default → native

Source: `backend/src/installer/platform/index.js`

---

## 4. Bootstrap → Node → Universal Installer → Adapters {#4-bootstrap-chain}

```
┌────────────────────────────────────────────────────────────────┐
│ GPU Hub  (GET /installer?platform=linux|windows)               │
│                                                                │
│  Bash launcher (*.sh)          PowerShell launcher (*.ps1)     │
│  ├─ credential rejection       ├─ credential rejection         │
│  ├─ Node.js ≥ 20 check         ├─ Node.js ≥ 20 check          │
│  ├─ pin v22.23.2 auto-provision├─ pin v22.23.2 auto-provision │
│  └─ runs: node installer.js    └─ runs: node installer.js     │
└────────────────────────────────────────────────────────────────┘
         │                           │
         └───────────┬───────────────┘
                     ▼
┌────────────────────────────────────────────────────────────────┐
│ Universal Node.js Installer  (installer.js / cli.js)          │
│                                                                │
│  bootPlatform() → resolveRuntime(platform, deployment)         │
│  adapter = getPlatformAdapter(platform)                        │
│  depAdapter = getDeploymentAdapter(deployment)                 │
│                                                                │
│  All OS-specific logic goes through adapter.*                  │
│  All deploy-specific logic goes through depAdapter.*           │
└────────────────────────────────────────────────────────────────┘
```

The installer is a **single Node.js file**. No separate binaries per platform.
Bootstrap scripts select the launcher format; the installer selects the adapter.

---

## 5. Platform Adapter Interface {#5-adapter-interface}

Every platform adapter exposes these methods/properties:

| Property | Description |
|----------|-------------|
| `name` | `'linux'` or `'windows'` |
| `pidCheckCommand(pid)` | Shell command to test process existence |
| `readPidMarker(io, workerDir)` | Read JSON pid marker from worker dir |
| `onWorkerSpawned(io, opts)` | Write pid marker after spawn |
| `checkDaemonAlive(io, opts)` | Check if a daemon process is alive |
| `findComfyUIPids(io, opts)` | Find ComfyUI processes |
| `sleepCommand(seconds)` | Command to pause (sleep/ping) |
| `findPidsByCmdlineAndCwd(io, opts)` | Process + CWD matching |
| `findPidsByCwdPrefix(io, opts)` | CWD prefix matching |
| `pidUid(io, pid)` | Get UID of a process (not used on Windows) |
| `killProcess(io, pid, signal)` | Send signal |
| `readProcessCmdline(io, pid)` | Get command line |
| `remediationMessage` | Install instructions |
| `buildPrereqScript(io, opts, prereqs)` | Generate install script |
| `pythonBin` / `venvPythonBin(venvDir)` | Python paths |
| `aptCommand(io, opts)` | Package manager command |
| `hostPackageCommand(io, pkg, opts)` | System package management |
| `checkBuildPrerequisites(io, opts)` | Check compiler toolchain |
| `HOME_ENV` | `'HOME'` or `'USERPROFILE'` |
| `defaultRootDir()` | `~/.animastor` or `USERPROFILE/.animastor` |
| `defaultWorkerDir(root)` | `root/.worker` or `root\\worker` |

Source: `backend/src/installer/platform/linux.js`, `platform/windows.js`

---

## 6. Deployment Adapter Interface {#6-deployment-interface}

| Property | Description |
|----------|-------------|
| `name` | `'native'` or `'docker'` |
| `productionReady` | `true` for native, `false` for docker |
| `markSupported(ok)` | Returns support status |
| `containerImageName(base, profile)` | Docker image name |
| `workerCwdForHost(hostRoot)` | Host-side CWD for worker |
| `workerAdditionalFlags(profile)` | Extra Docker run flags |
| `healthGetUrl(base, port)` | URL for health check |
| `workerLogPath(hostRoot)` | Path to worker log |

Source: `backend/src/installer/platform/deployment/native.js`, `deployment/docker.js`

---

## 7. CLI Boot Sequence {#7-cli-boot}

```
cli.js
  ├─ bootPlatform(platform, deployment)
  │    ├─ resolveRuntime(platform, deployment)
  │    │    ├─ resolveDeployment(platform, deployment)
  │    │    └─ { platform, deployment, adapters }
  │    └─ sets runtime全局变量
  │
  ├─ platform adapter chosen, cached globally
  ├─ layout/paths use adapter's HOME_ENV, defaultRootDir, etc.
  └─ printPlatformNotices() for preview/docker warnings
```

Source: `backend/src/installer/cli.js`

---

## 8. Security Model {#8-security}

| Rule | Implementation |
|------|---------------|
| Worker Key never in URL | Hub strips key from logs/bootstrap |
| No secret in CLI args | `--worker-key` optional, not logged |
| Credential env rejection | Both launchers check + exit immediately |
| SHA-256 verification | nodejs.org checksum over TLS |
| pin v22.23.2 | Hash pinned at build time |
| .env never in stdout | Logged as `[hidden]` |

---

## 9. Path Handling {#9-paths}

| Context | Linux | Windows |
|---------|-------|---------|
| Root dir | `~/.animastor` | `USERPROFILE\.animastor` |
| Worker dir | `~/.worker` | `USERPROFILE\.animastor\worker` |
| Logs | Same dir as worker | Same dir as worker |
| PID marker | `.worker/worker.pid` | `worker\worker.pid` |
| venv Python | `.venv/bin/python3` | `.venv\Scripts\python.exe` |
| ComfyUI Python | `venvs/<name>/bin/python3` | `venvs\<name>\Scripts\python.exe` |

Windows adapter uses `winJoin()` — produces true backslash paths regardless of
host OS (critical for testability on Linux CI).

---

## 10. Testing Strategy {#10-testing}

### Adapter isolation

Each adapter is loaded in a **forked child process** — tests verify that
`require('platform/windows')` never touches Linux-only modules and vice versa.

### Memory filesystem

`createMemoryFs()` is a POSIX-only in-memory fs. Windows paths (`C:\...`) are
**normalized to slashes** inside the memory fs so the same test tool works for
both platforms. Pre-existing bug fixed: `path.dirname('.')` infinite loop on
Windows-style paths.

### IO mock pattern

All installer tests mock `io.fs`, `io.exec`, `io.spawnDaemon`. Platform adapters
use the same `io` primitives. Tests never shell out to real OS commands.

---

## 11. Current State {#11-current-state}

| Component | Status |
|-----------|--------|
| `platform/index.js` | ✅ detectPlatform, detectDeployment, getPlatformAdapter, resolveRuntime |
| `platform/linux.js` | ✅ Full adapter (production-ready) |
| `platform/windows.js` | ✅ Full adapter (preview) |
| `deployment/native.js` | ✅ Passthrough adapter |
| `deployment/docker.js` | ✅ Experimental (productionReady:false) |
| Engine modules (worker/comfyui/prereq/probe/engine) | ✅ All delegate via adapter |
| management.js | ✅ Tool scripts, readPidPort via adapter |
| uninstaller.js | ✅ Process discovery via adapter |
| cli.js | ✅ Platform boot, path config, banner, notices |
| Bootstrap (bash + PowerShell) | ✅ Node auto-provision, SHA-256 gates |
| Hub platform routing | ✅ `.ps1` for windows, `.sh` for linux, 400 for unknown |
| Test suite | ✅ 252 installer + 33 platform = 285 pass, 0 fail |
