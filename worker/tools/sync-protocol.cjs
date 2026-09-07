#!/usr/bin/env node
// ======================================================
// Phase 9D — Job Protocol v2 sync into the standalone worker bundle
// ======================================================
// Resolves Phase 9C blocker B2: the worker ships as a self-contained
// zero-runtime-dependency bundle (Phase 9B freeze) delivered to GPU
// machines without an npm registry, so it cannot `require("@animastor/contracts")`
// at runtime. This generator therefore produces an EXPLICITLY GENERATED,
// byte-exact copy of the canonical Job Protocol v2 implementation inside
// the bundle — NOT a second, hand-maintained implementation:
//
//   canonical source : packages/animastor-contracts/src/job-protocol-v2.js   (@animastor/contracts)
//   generated output : worker/worker/job-protocol-v2.cjs  (header + verbatim body)
//
// The copy is guarded by:
//   - parity:   the body after the GENERATED header must be byte-identical
//               to the canonical source (verifyBody below);
//   - version:  the header records the @animastor/contracts version and the
//               canonical source sha256 at generation time;
//   - tests:    worker/tests/job-protocol.test.cjs (runtime parity) and
//               backend/tests/architecture/phase9d-worker-package.test.js
//               (repo-level guard, incl. negative control).
//
// Usage:
//   node worker/tools/sync-protocol.cjs           # regenerate if out of sync
//   node worker/tools/sync-protocol.cjs --check   # verify only; exit 1 on drift
//
// If packages/animastor-contracts/src/job-protocol-v2.js changes, regenerate and commit both
// files together (worker.cjs consumes the copy; hub/backend keep their own
// integration surfaces — see docs/architecture/JOB_PROTOCOL_V2.md).

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CANONICAL_PATH = path.join(REPO_ROOT, "packages", "animastor-contracts", "src", "job-protocol-v2.js");
const CANONICAL_PKG_PATH = path.join(REPO_ROOT, "packages", "animastor-contracts", "package.json");
const BUNDLE_TARGET = path.join(REPO_ROOT, "worker", "worker", "job-protocol-v2.cjs");

// The generated file is exactly: HEADER + canonical bytes. Everything after
// the marker line is canonical, byte for byte — the parity contract.
const GENERATED_HEADER = `// ======================================================
// GENERATED FILE — DO NOT EDIT BY HAND
// ======================================================
// Generated copy of the canonical Job Protocol v2 implementation:
//   package:   @animastor/contracts
//   source:    packages/animastor-contracts/src/job-protocol-v2.js
//   sha256:    {{CANONICAL_SHA256}}
//   generated: {{CONTRACTS_VERSION}} snapshot
// Generator:  worker/tools/sync-protocol.cjs (Phase 9D — blocker B2, option B)
//
// The worker bundle ships with zero runtime npm dependencies (Phase 9B
// freeze) and is delivered to GPU machines without an npm registry, so it
// cannot require @animastor/contracts at runtime. This file is a byte-exact
// copy of the canonical source below the marker line — it is NOT a second
// implementation. Any edit here diverges the wire contract and will be
// caught by the parity guards:
//   worker/tests/job-protocol.test.cjs
//   backend/tests/architecture/phase9d-worker-package.test.js
//
// Regenerate after any change to the canonical source:
//   node worker/tools/sync-protocol.cjs

// ===8<=== canonical source (verbatim, do not edit) ====================
`;

function canonicalSha256(source) {
    return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

function readCanonical() {
    const source = fs.readFileSync(CANONICAL_PATH, "utf8");
    let version = null;
    try {
        version = JSON.parse(fs.readFileSync(CANONICAL_PKG_PATH, "utf8")).version || null;
    } catch (_) { /* version stamp is advisory */ }
    return { source, version, sha256: canonicalSha256(source) };
}

function buildGeneratedSource({ source, version, sha256 }) {
    return GENERATED_HEADER
        .replace("{{CANONICAL_SHA256}}", sha256)
        .replace("{{CONTRACTS_VERSION}}", version || "unknown")
        + source;
}

/**
 * Verify the bundle copy against the canonical source.
 * @returns {{ ok: boolean, errors: string[] }}
 */
function verify() {
    const errors = [];
    let generated;
    try {
        generated = fs.readFileSync(BUNDLE_TARGET, "utf8");
    } catch (err) {
        return { ok: false, errors: [`bundle copy missing: ${BUNDLE_TARGET}`] };
    }
    const canonical = readCanonical();

    if (!generated.startsWith(GENERATED_HEADER
        .replace("{{CANONICAL_SHA256}}", canonical.sha256)
        .replace("{{CONTRACTS_VERSION}}", canonical.version || "unknown"))) {
        // Distinguish a fully stale header (drift) from a missing one.
        if (!generated.startsWith(GENERATED_HEADER.split("{{CANONICAL_SHA256}}")[0])) {
            errors.push("bundle copy does not carry the GENERATED header — treat any manual edit as a protocol divergence");
        } else {
            errors.push(`header sha256/version stale — canonical source sha256 is ${canonical.sha256} (contracts ${canonical.version || "?"}); regenerate`);
        }
    }

    const marker = GENERATED_HEADER.trimEnd().split("\n").slice(-1)[0] + "\n";
    const body = generated.slice(generated.indexOf(marker) + marker.length);
    if (body !== canonical.source) {
        errors.push("bundle copy body diverges from the canonical source (byte comparison failed)");
    }

    // Runtime parity: the copy must expose the same protocol surface.
    try {
        const copy = require(BUNDLE_TARGET);
        const canonicalImpl = require(CANONICAL_PATH);
        if (copy.PROTOCOL_VERSION !== canonicalImpl.PROTOCOL_VERSION) {
            errors.push(`runtime PROTOCOL_VERSION drift: copy=${copy.PROTOCOL_VERSION} canonical=${canonicalImpl.PROTOCOL_VERSION}`);
        }
        if (String(copy.JOB_ID_SPLIT_RE) !== String(canonicalImpl.JOB_ID_SPLIT_RE)) {
            errors.push(`runtime JOB_ID_SPLIT_RE drift: copy=${copy.JOB_ID_SPLIT_RE} canonical=${canonicalImpl.JOB_ID_SPLIT_RE}`);
        }
    } catch (err) {
        errors.push(`runtime parity check failed: ${err.message}`);
    }

    return { ok: errors.length === 0, errors };
}

function main() {
    const checkOnly = process.argv.includes("--check");
    if (checkOnly) {
        const res = verify();
        if (res.ok) {
            console.log("sync-protocol: worker bundle copy is in sync with @animastor/contracts");
            return 0;
        }
        for (const e of res.errors) console.error(`sync-protocol: DRIFT — ${e}`);
        console.error(`sync-protocol: regenerate with \`node worker/tools/sync-protocol.cjs\` and commit the result`);
        return 1;
    }
    const canonical = readCanonical();
    const generated = buildGeneratedSource(canonical);
    fs.writeFileSync(BUNDLE_TARGET, generated);
    const res = verify();
    console.log(`sync-protocol: wrote ${path.relative(REPO_ROOT, BUNDLE_TARGET)} (contracts ${canonical.version || "?"}, sha256 ${canonical.sha256})`);
    if (!res.ok) {
        for (const e of res.errors) console.error(`sync-protocol: verification FAILED — ${e}`);
        return 1;
    }
    return 0;
}

module.exports = {
    CANONICAL_PATH,
    BUNDLE_TARGET,
    GENERATED_HEADER,
    buildGeneratedSource,
    canonicalSha256,
    readCanonical,
    verify,
};

if (require.main === module) process.exit(main());
