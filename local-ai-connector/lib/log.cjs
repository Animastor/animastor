// ======================================================
// Local connector request log — METADATA-ONLY (AD-6, §10.3)
// ======================================================
// Never stores prompts, messages, or model responses. Safe fields only:
// { ts, op, model, status, error_code, duration_ms, bytes }. Size-capped
// ring buffer; no content ever enters this log by design.
// ======================================================

const MAX_RECORDS = 500;

const records = [];

/**
 * Record one operation. `fields` may contain ONLY the whitelisted metadata
 * keys — everything else is dropped before it can reach the log.
 */
function recordOp(fields = {}) {
    const rec = {
        ts: new Date().toISOString(),
        op: typeof fields.op === 'string' ? fields.op.slice(0, 64) : 'unknown',
        model: typeof fields.model === 'string' ? fields.model.slice(0, 128) : undefined,
        status: fields.status === 'ok' || fields.status === 'error' ? fields.status : 'unknown',
        error_code: typeof fields.error_code === 'string' ? fields.error_code.slice(0, 64) : undefined,
        duration_ms: typeof fields.duration_ms === 'number' ? Math.max(0, Math.round(fields.duration_ms)) : undefined,
        bytes: typeof fields.bytes === 'number' ? Math.max(0, Math.round(fields.bytes)) : undefined,
    };
    records.push(rec);
    if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
    return rec;
}

function list() {
    return records.slice();
}

function reset() {
    records.length = 0;
}

module.exports = { recordOp, list, reset, MAX_RECORDS };
