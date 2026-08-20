// ======================================================
// Password Hashing (Node built-in scrypt)
// ======================================================
// Standard library crypto.scrypt — no external dependency, no native build.
// scrypt is a memory-hard KDF approved for password storage (OWASP) and is
// the natural fit for the current Node-only backend stack.
//
// Storage format (single column, self-describing):
//   scrypt$N=16384,r=8,p=1$<salt.b64>$<hash.b64>
//
// Verification is timing-attack resistant (timingSafeEqual after scrypt and
// a constant-cost path when the user / stored hash is missing).
// ======================================================

const crypto = require('crypto');

const SCRYPT_N = 1 << 14; // 16384 — memory-hard without noticeable login latency
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

// Minimal, reasonable policy (NOT enterprise): short enough to be usable,
// long enough to stop the most common broken passwords.
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 512;

/**
 * Hash a password for storage. Never logs anything.
 * @param {string} password - plaintext password
 * @returns {Promise<string>} encoded hash string
 */
async function hashPassword(password) {
    if (typeof password !== 'string') throw new Error('password must be a string');
    const salt = crypto.randomBytes(SALT_LEN);
    const derived = await new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 }, (err, key) => {
            if (err) return reject(err);
            resolve(key);
        });
    });
    return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function parseStoredHash(stored) {
    if (!stored || typeof stored !== 'string') return null;
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return null;
    const params = {};
    for (const kv of parts[1].split(',')) {
        const [k, v] = kv.split('=');
        const n = parseInt(v, 10);
        if (!k || !Number.isFinite(n) || n <= 0) return null;
        params[k] = n;
    }
    if (!params.N || !params.r || !params.p) return null;
    if ((params.N & (params.N - 1)) !== 0) return null; // N must be a power of two
    return { N: params.N, r: params.r, p: params.p, saltB64: parts[2], hashB64: parts[3] };
}

async function derive(password, parsed) {
    const salt = Buffer.from(parsed.saltB64, 'base64');
    const expected = Buffer.from(parsed.hashB64, 'base64');
    const derived = await new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, expected.length, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: 64 * 1024 * 1024 }, (err, key) => {
            if (err) return reject(err);
            resolve(key);
        });
    });
    return crypto.timingSafeEqual(derived, expected);
}

/**
 * Verify a password against a stored hash.
 * @param {string} password - plaintext candidate
 * @param {string|null} storedHash - stored value (null when user absent)
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, storedHash) {
    const candidate = typeof password === 'string' ? password : '';
    const parsed = parseStoredHash(storedHash);
    if (!parsed) {
        // No stored hash (unknown user / legacy row). Run a dummy derivation so
        // the "user not found" path costs the same as a real comparison — this
        // removes the dominant timing difference used for username enumeration.
        try {
            await hashPassword(candidate || 'dummy');
        } catch (_) { /* timing equalization only */ }
        return false;
    }
    try {
        return await derive(candidate, parsed);
    } catch (_) {
        return false;
    }
}

/** Min length 8, max 512. No composition rules (deliberately minimal). */
function validatePasswordPolicy(password) {
    if (typeof password !== 'string') return 'Password is required';
    if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
    if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
    return null;
}

module.exports = { hashPassword, verifyPassword, validatePasswordPolicy, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH };
