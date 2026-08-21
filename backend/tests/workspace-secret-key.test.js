// =====================================================
// WORKSPACE_SECRET_KEY — Production Fail-Closed Tests
// =====================================================
// Regression coverage for the secret-hardening task:
//
//   ✗ Production + missing key  → throws
//   ✗ Production + empty key    → throws
//   ✗ Production + whitespace   → throws
//   ✓ Production + valid key    → returns derived key
//   ✓ Development + missing key → dev fallback (legacy)
//   ✓ Development + valid key   → derived key
//   ✓ Roundtrip encrypt/decrypt still works with valid key
//   ✓ validateSecretKeyRaw rejects bad inputs

const { expect } = require('chai');

// Save originals so every test restores them.
const origNodeEnv = process.env.NODE_ENV;
const origWsKey = process.env.WORKSPACE_SECRET_KEY;

describe('WORKSPACE_SECRET_KEY — production fail-closed', () => {
    let ws;

    before(() => {
        // Require the module fresh (it caches, but we re-set env before each call).
        ws = require('../src/services/workspace-ai-provider');
    });

    afterEach(() => {
        // Restore env after every test to avoid cross-contamination.
        if (origNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = origNodeEnv;

        if (origWsKey === undefined) delete process.env.WORKSPACE_SECRET_KEY;
        else process.env.WORKSPACE_SECRET_KEY = origWsKey;
    });

    // ── production: must fail closed ─────────────────────────────────

    it('throws when NODE_ENV=production and WORKSPACE_SECRET_KEY is missing', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.WORKSPACE_SECRET_KEY;
        expect(() => ws.getSecretKey()).to.throw(/WORKSPACE_SECRET_KEY is required in production/);
    });

    it('throws when NODE_ENV=production and WORKSPACE_SECRET_KEY is empty string', () => {
        process.env.NODE_ENV = 'production';
        process.env.WORKSPACE_SECRET_KEY = '';
        expect(() => ws.getSecretKey()).to.throw(/WORKSPACE_SECRET_KEY is required in production/);
    });

    it('throws when NODE_ENV=production and WORKSPACE_SECRET_KEY is whitespace-only', () => {
        process.env.NODE_ENV = 'production';
        process.env.WORKSPACE_SECRET_KEY = '   \t  \n  ';
        expect(() => ws.getSecretKey()).to.throw(/WORKSPACE_SECRET_KEY is required in production/);
    });

    it('returns a Buffer when NODE_ENV=production and WORKSPACE_SECRET_KEY is valid', () => {
        process.env.NODE_ENV = 'production';
        process.env.WORKSPACE_SECRET_KEY = 'a-real-production-secret-key-32chars!';
        const key = ws.getSecretKey();
        expect(key).to.be.an.instanceOf(Buffer);
        expect(key.length).to.equal(32);
    });

    // ── development: legacy fallback preserved ───────────────────────

    it('returns the dev fallback when NODE_ENV is NOT production and key is missing', () => {
        process.env.NODE_ENV = 'development';
        delete process.env.WORKSPACE_SECRET_KEY;
        const key = ws.getSecretKey();
        expect(key).to.be.an.instanceOf(Buffer);
        expect(key.length).to.equal(32);
    });

    it('returns a derived key when NODE_ENV is NOT production and key is valid', () => {
        process.env.NODE_ENV = 'development';
        process.env.WORKSPACE_SECRET_KEY = 'dev-secret-key';
        const key = ws.getSecretKey();
        expect(key).to.be.an.instanceOf(Buffer);
        expect(key.length).to.equal(32);
    });

    // ── validateSecretKeyRaw ─────────────────────────────────────────

    describe('validateSecretKeyRaw', () => {
        it('throws for undefined', () => {
            expect(() => ws.validateSecretKeyRaw(undefined)).to.throw(/WORKSPACE_SECRET_KEY is required in production/);
        });

        it('throws for null', () => {
            expect(() => ws.validateSecretKeyRaw(null)).to.throw(/WORKSPACE_SECRET_KEY is required in production/);
        });

        it('throws for empty string', () => {
            expect(() => ws.validateSecretKeyRaw('')).to.throw(/WORKSPACE_SECRET_KEY is required in production/);
        });

        it('throws for whitespace-only string', () => {
            expect(() => ws.validateSecretKeyRaw('   ')).to.throw(/WORKSPACE_SECRET_KEY is required in production/);
        });

        it('returns trimmed value for valid input', () => {
            const result = ws.validateSecretKeyRaw('  my-key  ');
            expect(result).to.equal('my-key');
        });
    });

    // ── encryption roundtrip still works ─────────────────────────────

    describe('encryption compatibility', () => {
        it('encrypts and decrypts with a valid production key', () => {
            process.env.NODE_ENV = 'production';
            process.env.WORKSPACE_SECRET_KEY = 'roundtrip-test-key-1234567890!';
            const plaintext = 'sk-test-api-key-for-roundtrip';
            const encrypted = ws.encryptSecret(plaintext);
            const decrypted = ws.decryptSecret(encrypted);
            expect(decrypted).to.equal(plaintext);
        });

        it('encrypted value never contains the plaintext', () => {
            process.env.NODE_ENV = 'production';
            process.env.WORKSPACE_SECRET_KEY = 'another-test-key-1234567890!!';
            const plaintext = 'sk-super-secret-api-key';
            const encrypted = ws.encryptSecret(plaintext);
            expect(encrypted).to.not.include(plaintext);
        });
    });
});
