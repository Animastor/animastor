// ======================================================
// JOB SCHEMA — COMPATIBILITY FACADE (Phase 9C)
// ======================================================
// The canonical Job Protocol v2 implementation now lives in the
// @animastor/contracts package: contracts/src/job-protocol-v2.js
// (normative spec: docs/architecture/JOB_PROTOCOL_V2.md, FROZEN).
//
// This file is a thin re-export facade kept so existing backend imports
// (`require('.../job-schema')`) do not break. Do NOT add new behavior
// here — extend the contracts package instead.
//
// Resolution: there is deliberately NO npm dependency in backend/package.json
// yet (a file:../contracts dep would break the docker build, whose context is
// ./backend — see docs/architecture/PHASE_9C_CONTRACTS_EXTRACTION_AUDIT.md
// §3.1, blocker B3). The package is resolved via the repo-root node_modules
// symlink, created once from the repo root:
//   mkdir -p node_modules/@animastor && ln -sfn ../../contracts node_modules/@animastor/contracts
// and mounted read-only into the backend container by docker-compose
// (./contracts:/app/node_modules/@animastor/contracts:ro).
// Before Phase 9C the format was documented here; the historical header
// (job_id formats, parse-from-the-end rationale) is preserved verbatim in
// the contracts package.
//
// Версия протокола backend ↔ gpu-hub ↔ worker. Передаётся в task и callback
// payload. Все три компонента отклоняют несовпадающую версию: mixed-version
// rollout допускается только после остановки выдачи задач старому worker.
//
// T2 консолидации (docs/03-audit/ORCHESTRATION_CONSOLIDATION_TODO.md):
// единый контракт job_id backend ↔ gpu-hub ↔ worker.

module.exports = require('@animastor/contracts').jobProtocolV2;
