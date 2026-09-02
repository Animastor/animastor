// ======================================================
// Connector configuration — strict, fail-closed parsing (§10.2)
// ======================================================
// The runtime base URL lives in LOCAL CONFIG ONLY (never received from the
// cloud or any frame). Defaults to loopback; a non-loopback base is refused
// unless --allow-lan is explicitly set (AD-5). Token values are validated by
// shape and NEVER echoed into errors or logs.
// ======================================================

const { RUNTIME_TYPES, isLoopbackBase } = require('./runtime-adapters/index.cjs');

const DEFAULT_RUNTIME_BASE_URL = 'http://127.0.0.1:11434';
const TOKEN_RE = /^(llmc|llmcreg)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const CLI_FLAGS = new Set([
    '--url', '--token', '--base-url', '--runtime-type',
    '--allow-lan', '--log-file', '--heartbeat-interval-ms',
]);

/** True for loopback / link-local dev hosts where plain ws:// is tolerated. */
function isLoopbackWsHost(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1'
        || h === '::ffff:127.0.0.1' || /^127(\.\d+){3}$/.test(h);
}

/**
 * Parse + validate CLI args (env fallbacks for token/url).
 * @returns {{ok:true, config:object}|{ok:false, errors:string[]}}
 */
function parseConfig(argv, { env = process.env } = {}) {
    const cfg = {
        url: null,
        token: null,
        baseUrl: DEFAULT_RUNTIME_BASE_URL,
        runtimeType: 'openai-compatible',
        allowLan: false,
        logFile: null,
        heartbeatIntervalMs: null,
    };
    const args = Array.isArray(argv) ? argv.slice() : [];
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (!CLI_FLAGS.has(flag)) {
            return { ok: false, errors: [`unknown option: ${flag}`] };
        }
        if (flag === '--allow-lan') {
            cfg.allowLan = true;
            continue;
        }
        const value = args[++i];
        if (value === undefined) {
            return { ok: false, errors: [`missing value for ${flag}`] };
        }
        switch (flag) {
            case '--url': cfg.url = value; break;
            case '--token': cfg.token = value; break;
            case '--base-url': cfg.baseUrl = value; break;
            case '--runtime-type': cfg.runtimeType = value; break;
            case '--log-file': cfg.logFile = value; break;
            case '--heartbeat-interval-ms': cfg.heartbeatIntervalMs = Number(value); break;
            default: break;
        }
    }
    if (!cfg.url && env.ANIMASTOR_CONNECTOR_URL) cfg.url = env.ANIMASTOR_CONNECTOR_URL;
    if (!cfg.token && env.ANIMASTOR_CONNECTOR_TOKEN) cfg.token = env.ANIMASTOR_CONNECTOR_TOKEN;

    const errors = [];

    // Cloud WS URL: wss:// mandatory except plain ws:// on loopback (dev).
    try {
        const u = new URL(String(cfg.url || ''));
        if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
            errors.push('url must be a ws:// or wss:// WebSocket endpoint');
        } else if (u.protocol === 'ws:' && !isLoopbackWsHost(u.hostname)) {
            errors.push('url must use wss:// (plain ws:// is allowed only for loopback)');
        }
    } catch (_) {
        errors.push('url is not a valid URL');
    }

    // Credential shape: llmc.* (persistent) or llmcreg.* (one-time
    // registration). Never echoed, only validated.
    if (!cfg.token || !TOKEN_RE.test(cfg.token)) {
        errors.push('token is required and must be an llmc.* credential or llmcreg.* registration token');
    }

    // Runtime base URL: http(s), loopback unless --allow-lan (AD-5).
    try {
        const b = new URL(String(cfg.baseUrl || ''));
        if (b.protocol !== 'http:' && b.protocol !== 'https:') {
            errors.push('base-url must use http:// or https://');
        } else if (!cfg.allowLan && !isLoopbackBase(cfg.baseUrl)) {
            errors.push('base-url must be loopback (use --allow-lan to allow a LAN runtime explicitly)');
        }
    } catch (_) {
        errors.push('base-url is not a valid URL');
    }

    if (!RUNTIME_TYPES.includes(cfg.runtimeType)) {
        errors.push(`runtime-type must be one of: ${RUNTIME_TYPES.join(', ')}`);
    }
    if (cfg.heartbeatIntervalMs != null) {
        if (!Number.isFinite(cfg.heartbeatIntervalMs) || cfg.heartbeatIntervalMs < 250 || cfg.heartbeatIntervalMs > 600000) {
            errors.push('heartbeat-interval-ms must be between 250 and 600000');
        }
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, config: cfg };
}

/** Sanitized one-line usage (no token examples that look real). */
function usage() {
    return [
        'animastor-ai-connector — bridge a local OpenAI-compatible runtime to Animastor',
        '',
        'Required:',
        '  --url <wss://…>          Animastor connector WebSocket endpoint',
        '  --token <llmc.*|llmcreg.*>  credential or one-time registration token',
        '',
        'Runtime:',
        '  --base-url <http://…>    local runtime base (default http://127.0.0.1:11434)',
        '  --runtime-type <type>    ollama | vllm | llamacpp | lmstudio | openai-compatible',
        '  --allow-lan              allow a non-loopback runtime base URL (explicit opt-in)',
        '',
        'Misc:',
        '  --log-file <path>        metadata-only operation log (AD-6; no content ever)',
        '  --heartbeat-interval-ms <ms>  override server-advertised heartbeat cadence',
    ].join('\n');
}

module.exports = { parseConfig, usage, RUNTIME_TYPES, DEFAULT_RUNTIME_BASE_URL, isLoopbackWsHost };
