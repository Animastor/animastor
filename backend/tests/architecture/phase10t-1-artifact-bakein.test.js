'use strict';

/**
 * Phase 10T.1 — GPU Hub artifact bake-in guardrails.
 *
 * Verifies (at test time, against the monorepo source tree):
 *   AB1. Dockerfile stages all 4 artifact groups via multi-stage build.
 *   AB2. docker-compose.yml uses repo-root context (required for COPY).
 *   AB3. resolveArtifactDir() prefers baked-in, fallback matches frozen mounts.
 *   AB4. Installer MANIFEST_ROOT checks /app/artifacts/install-manifests first.
 *   AB5. Installer getWorkerBundleVersion() checks /app/artifacts/worker-bundle first.
 *   AB6. No /worker-source in frozen route set or runtime code.
 *   AB7. scripts/check-artifacts.sh exists and is executable.
 *   AB8. Local-dev overlay still provides the 4 frozen bind mounts.
 */

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HUB_DIR = path.join(REPO_ROOT, 'packages', 'animastor-gpu-hub');

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// ── AB1 — Dockerfile stages all 4 artifact groups ──────────────────────────

describe('Phase 10T.1: Dockerfile artifact bake-in', () => {
  it('Dockerfile has a stager stage that copies all 4 artifact groups', () => {
    const df = read('packages/animastor-gpu-hub/Dockerfile');
    expect(df).to.include('AS stager');
    expect(df).to.include('COPY --from=stager');
    expect(df).to.include('/app/artifacts/');
    for (const d of ['worker-bundle', 'workflows', 'installer-src', 'install-manifests']) {
      expect(df, `Dockerfile missing artifact group: ${d}`).to.include(d);
    }
  });

  it('Dockerfile verifies all 4 groups exist at build time', () => {
    const df = read('packages/animastor-gpu-hub/Dockerfile');
    expect(df).to.include('artifact bake-in verified');
    for (const d of ['worker-bundle', 'workflows', 'installer-src', 'install-manifests']) {
      expect(df, `Dockerfile missing build-time check for: ${d}`).to.include(`[ -d "/app/artifacts/$d" ]`);
    }
  });

  it('Dockerfile does NOT copy the entire monorepo', () => {
    const df = read('packages/animastor-gpu-hub/Dockerfile');
    // Should not have a bare "COPY . ." that includes the whole repo
    // (the stager uses selective COPY, the runtime stage copies only gpu-hub/)
    const lines = df.split('\n');
    const copyAllLines = lines.filter(l => /^\s*COPY\s+\.\s+\.\/?\s*$/.test(l));
    // At most 1 COPY . . (in the runtime stage for gpu-hub source only)
    expect(copyAllLines.length).to.be.at.most(1);
  });
});

// ── AB2 — docker-compose.yml uses repo-root context ────────────────────────

describe('Phase 10T.1: docker-compose build context', () => {
  it('gpu-hub build uses repo-root context with explicit dockerfile', () => {
    const compose = read('docker-compose.yml');
    // Must use extended build syntax, not shorthand "build: ./gpu-hub"
    expect(compose).to.include('context: .');
    expect(compose).to.include('dockerfile: packages/animastor-gpu-hub/Dockerfile');
    // Shorthand must be gone
    expect(compose).not.to.match(/^(\s*)build:\s+\.\/gpu-hub\s*$/m);
  });
});

// ── AB3 — resolveArtifactDir prefers baked-in ──────────────────────────────

describe('Phase 10T.1: resolveArtifactDir resolution order', () => {
  it('resolves baked-in artifacts/ before mount fallback', () => {
    const src = read('packages/animastor-gpu-hub/gpu-hub.js');
    expect(src).to.include("path.join(__dirname, 'artifacts')");
    expect(src).to.include('fs.existsSync(bakedPath)');
  });

  it('all 4 artifact dirs have correct baked-in names and mount fallbacks', () => {
    const src = read('packages/animastor-gpu-hub/gpu-hub.js');
    const frozen = [
      ['worker-bundle', '/app/worker-bundle'],
      ['workflows',     '/app/workflows'],
      ['installer-src', '/app/installer-src'],
      ['install-manifests', '/app/install-manifests'],
    ];
    for (const [name, fallback] of frozen) {
      expect(src, `baked-in name ${name} missing`).to.include(`'${name}'`);
      expect(src, `mount fallback ${fallback} missing`).to.include(`'${fallback}'`);
    }
  });
});

// ── AB4 — Installer MANIFEST_ROOT prefers baked-in ─────────────────────────

describe('Phase 10T.1: Installer MANIFEST_ROOT resolution', () => {
  it('checks /app/artifacts/install-manifests before repo path', () => {
    const src = read('backend/src/installer/install-manifest.js');
    expect(src).to.include("path.join('/app', 'artifacts', 'install-manifests')");
    expect(src).to.include('MANIFEST_ROOT');
  });
});

// ── AB5 — Installer getWorkerBundleVersion prefers baked-in ─────────────────

describe('Phase 10T.1: Installer getWorkerBundleVersion resolution', () => {
  it('checks /app/artifacts/worker-bundle/package.json before repo path', () => {
    const src = read('backend/src/installer/setup-contract.js');
    expect(src).to.include("path.join('/app', 'artifacts', 'worker-bundle', 'package.json')");
    expect(src).to.include('getWorkerBundleVersion');
  });
});

// ── AB6 — No /worker-source in frozen route set or runtime code ────────────

describe('Phase 10T.1: /worker-source removal', () => {
  it('frozen route set does not include /worker-source', () => {
    const src = read('packages/animastor-gpu-hub/gpu-hub.js');
    // The route handler for /worker-source must not exist
    const routeMatch = src.match(/app\.(get|post)\(\s*['"]\/worker-source/);
    expect(routeMatch).to.be.null;
  });

  it('runtime files contain no /worker-source references', () => {
    const runtimeFiles = ['gpu-hub.js', 'server.js', 'tarball.js', 'bootstrap.js'];
    for (const file of runtimeFiles) {
      const src = read(path.join('packages/animastor-gpu-hub', file));
      expect(src, `${file} still references /worker-source`).not.to.include('/worker-source');
    }
  });
});

// ── AB7 — check-artifacts.sh exists and is executable ──────────────────────

describe('Phase 10T.1: integrity check script', () => {
  it('scripts/check-artifacts.sh exists and is executable', () => {
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'check-artifacts.sh');
    expect(fs.existsSync(scriptPath), 'check-artifacts.sh missing').to.be.true;
    const stat = fs.statSync(scriptPath);
    expect(stat.mode & 0o111, 'check-artifacts.sh not executable').to.not.equal(0);
  });

  it('check-artifacts.sh validates all 4 artifact groups', () => {
    const src = read('scripts/check-artifacts.sh');
    for (const d of ['worker-bundle', 'workflows', 'installer-src', 'install-manifests']) {
      expect(src, `check-artifacts.sh missing check for: ${d}`).to.include(d);
    }
    expect(src).to.include('worker-bundle/package.json');
    expect(src).to.include('baseline_sha256');
    expect(src).to.include('min_version');
  });
});

// ── AB8 — Local-dev overlay preserves frozen bind mounts ───────────────────

describe('Phase 10T.1: local-dev overlay mounts', () => {
  it('overlay-gpu-hub-local.yml contains all 4 frozen bind mounts', () => {
    const overlay = read('docker/compose/overlay-gpu-hub-local.yml');
    const frozenTargets = [
      '/app/worker-bundle',
      '/app/workflows',
      '/app/installer-src',
      '/app/install-manifests',
    ];
    for (const t of frozenTargets) {
      expect(overlay, `mount target ${t} missing from local overlay`).to.include(t);
    }
    const frozenSources = [
      // canonical worker bundle source (relocated with the package);
      // legacy ./worker/worker stays valid until the move commit
      './packages/animastor-worker/worker',
      './backend/ai/workflows',
      './backend/src/installer',
      './backend/ai/install-manifests',
    ];
    for (const s of frozenSources) {
      expect(overlay, `mount source ${s} missing from local overlay`).to.include(s);
    }
  });
});
