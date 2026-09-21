// ======================================================
// Auth Contract Tests (Auth Extraction Phase 1)
// ======================================================
// The frozen contract of the auth domain core (auth/core.js +
// book-access.js + cookies.js + auth-config.js), exercised over IN-MEMORY
// ports — no PG, no Express. These tests are the regression safety net the
// audit §11 required and will move into @animastor/auth with the package
// (§12 phase 3).
//
// Regression matrix (user prompt §5): authenticated user / guest /
// anonymous pre-auth / guest workspace expiration / foreign workspace /
// book ownership / workspace membership / authorization DB failure /
// registration rollback / guest→registered conversion / cookie+config.
//
// Historical parity notes are cited where a test pins exact old behaviour
// (auth-mvp / guest-workspace suites remain the HTTP-level safety net and
// run unchanged against the real PG adapter).

const { expect } = require('chai');
const { createAuthService } = require('../src/core');
const { AuthError, WorkspaceExpiredError } = require('../src/auth-errors');
const { normalizeAuthConfig, normalizeCookieDomain, DEFAULT_AUTH_CONFIG } = require('../src/auth-config');
const cookies = require('../src/cookies');
const { assertAuthPorts } = require('../src/ports');
const pkg = require('../src/index.cjs');

// ── in-memory port fixtures ─────────────────────────────────────────────

function buildPorts() {
    const calls = { registerUserWithWorkspace: [] };
    const users = new Map(); // lowerUsername → row
    const sessions = new Map(); // token → {row, revoked}
    const guests = new Map(); // token → row
    const workspaces = new Map();
    const memberships = new Map(); // `${wsId}:${userId}` → role
    const bookWorkspace = new Map(); // bookId → wsId

    let idSeq = 0;
    const id = (p) => `${p}-${++idSeq}`;

    const ports = {
        users: {
            findByUsernameCanonical: async (u) => users.get(String(u).toLowerCase()) || null,
            findByEmail: async (e) => [...users.values()].find((r) => r.email === e) || null,
        },
        sessions: {
            createSession: async (userId, expiresAt) => {
                const token = `sid.tok.${++idSeq}`;
                sessions.set(token, { user_id: userId, expires_at: expiresAt, revoked: false });
                return { sessionId: `s-${idSeq}`, token, expiresAt };
            },
            findByToken: async (token) => {
                const s = sessions.get(token);
                if (!s || s.revoked || s.expires_at <= Date.now()) return null;
                const u = [...users.values()].find((r) => r.user_id === s.user_id);
                return u ? { session_id: s.user_id, user_id: s.user_id, expires_at: s.expires_at, username: u.username, display_name: u.display_name, email: u.email, role: u.role } : null;
            },
            revokeByToken: async (token) => {
                const s = sessions.get(token);
                if (!s || s.revoked) return false;
                s.revoked = true;
                return true;
            },
        },
        guests: {
            createGuest: async ({ workspaceTtlMs, sessionTtlMs }) => {
                const wsId = id('gw');
                workspaces.set(wsId, { id: wsId, name: 'Guest workspace', type: 'temporary', expires_at: Date.now() + workspaceTtlMs });
                const token = `gst.g.${++idSeq}`;
                guests.set(token, { guest_id: id('gid'), workspace_id: wsId, session_expires_at: Date.now() + sessionTtlMs, workspace_expires_at: workspaces.get(wsId).expires_at, revoked: false });
                return { guestId: guests.get(token).guest_id, token, workspace: { id: wsId, name: 'Guest workspace', type: 'temporary' }, workspaceExpiresAt: workspaces.get(wsId).expires_at, sessionExpiresAt: guests.get(token).session_expires_at };
            },
            findByToken: async (token) => {
                const g = guests.get(token);
                if (!g || g.revoked || g.session_expires_at <= Date.now()) return null;
                const w = workspaces.get(g.workspace_id);
                return { guest_id: g.guest_id, session_expires_at: g.session_expires_at, workspace_id: g.workspace_id, workspace_name: w.name, workspace_type: w.type, workspace_expires_at: w.expires_at };
            },
            touchWorkspaceActivity: async (wsId, ttl) => {
                const w = workspaces.get(wsId);
                if (w && (w.expires_at == null || w.expires_at < Date.now() + ttl)) w.expires_at = Date.now() + ttl;
            },
            revokeByToken: async (token) => {
                const g = guests.get(token);
                if (!g || g.revoked) return false;
                g.revoked = true;
                return true;
            },
        },
        workspaces: {
            findById: async (wsId) => workspaces.get(wsId) || null,
            checkBookAccess: async (bookId, userId) => {
                const wsId = bookWorkspace.get(bookId);
                return wsId && memberships.has(`${wsId}:${userId}`) ? wsId : null;
            },
            getMembership: async (wsId, userId) => memberships.has(`${wsId}:${userId}`) ? { workspace_id: wsId, user_id: userId, role: memberships.get(`${wsId}:${userId}`) } : null,
            getWorkspaceIdForBook: async (bookId) => bookWorkspace.get(bookId) || null,
            findPersonalWorkspace: async (userId) => [...workspaces.values()].find((w) => w.owner_user_id === userId && w.type === 'personal') || null,
            createWorkspace: async ({ name, ownerUserId, type }) => {
                const wsId = id('ws');
                const w = { id: wsId, name, owner_user_id: ownerUserId, type: type || 'personal' };
                workspaces.set(wsId, w);
                memberships.set(`${wsId}:${ownerUserId}`, 'owner');
                return w;
            },
            renameWorkspace: async (wsId, name) => {
                const w = workspaces.get(wsId);
                if (w) w.name = name;
                return w || null;
            },
        },
        bookOwnership: {
            // In-memory parity of workspace-ownership.resolveWorkspaceForBook
            // (allowCreate:false): existing attach → wsId; unowned → preferred
            // (self-heal attach, as the real resolver attaches NULL rows).
            resolveAccessWorkspace: async (bookId, { preferredWorkspaceId } = {}) => {
                if (bookWorkspace.has(bookId)) return bookWorkspace.get(bookId);
                if (preferredWorkspaceId) {
                    bookWorkspace.set(bookId, preferredWorkspaceId);
                    return preferredWorkspaceId;
                }
                return null;
            },
            getWorkspaceId: async (bookId) => bookWorkspace.get(bookId) || null,
        },
        registrationTx: {
            registerUserWithWorkspace: async (p) => {
                calls.registerUserWithWorkspace.push(p);
                const key = p.username.toLowerCase();
                if (users.has(key)) {
                    const e = new Error('username registration race (canonical collision)');
                    e.registerRace = true;
                    throw e;
                }
                const userRow = { user_id: id('u'), username: p.username, password_hash: p.passwordHash, email: p.email, display_name: p.displayName };
                users.set(key, userRow);
                let workspaceRow;
                let converted = false;
                if (p.guestConversion) {
                    // In-memory parity of guestRepo.convertTemporaryWorkspace.
                    workspaceRow = workspaces.get(p.guestConversion.workspaceId);
                    if (!workspaceRow || workspaceRow.type !== 'temporary') {
                        throw new Error(`workspace ${p.guestConversion.workspaceId} is not a convertible temporary workspace`);
                    }
                    workspaceRow.type = 'personal';
                    workspaceRow.owner_user_id = userRow.user_id;
                    workspaceRow.expires_at = null;
                    converted = true;
                } else {
                    workspaceRow = await ports.workspaces.createWorkspace({ name: `${p.username}'s Workspace`, ownerUserId: userRow.user_id, type: 'personal' });
                }
                memberships.set(`${workspaceRow.id}:${userRow.user_id}`, 'owner');
                return { userRow, workspaceRow, converted };
            },
        },
    };

    return { ports, calls, users, sessions, guests, workspaces, memberships, bookWorkspace };
}

function build(overrides = {}) {
    const f = buildPorts();
    const ports = { ...f.ports, ...overrides.ports };
    if (overrides.users) Object.assign(ports.users, overrides.users);
    if (overrides.workspaces) Object.assign(ports.workspaces, overrides.workspaces);
    if (overrides.registrationTx) Object.assign(ports.registrationTx, overrides.registrationTx);
    const svc = createAuthService({ ports, config: overrides.config || {} });
    return { svc, ...f, ports };
}

const USER = { userId: 'u-1', username: 'alice' };
const GUEST_ID = 'g-1';

function userIdentity(workspace) {
    return { user: USER, workspace };
}
function guestIdentity(workspace) {
    return { guest: { guestId: GUEST_ID }, workspace };
}

// ── suite ───────────────────────────────────────────────────────────────

describe('auth contract: config', () => {
    it('defaults are the frozen historical values', () => {
        const c = normalizeAuthConfig({});
        expect(c).to.deep.equal(DEFAULT_AUTH_CONFIG);
        expect(c.sessionCookieName).to.equal('animastor_sid');
        expect(c.guestCookieName).to.equal('animastor_gid');
        expect(c.sessionTtlMs).to.equal(30 * 24 * 60 * 60 * 1000);
        expect(c.guestWorkspaceTtlMs).to.equal(7 * 24 * 60 * 60 * 1000);
        expect(c.guestWorkspaceGraceMs).to.equal(23 * 24 * 60 * 60 * 1000);
        expect(c.guestSessionTtlMs).to.equal(30 * 24 * 60 * 60 * 1000);
        expect(c.cookieDomain).to.equal('');
    });

    it('normalizes a valid cookie domain (leading dot stripped, lowercased)', () => {
        expect(normalizeCookieDomain('animastor.in')).to.equal('animastor.in');
        expect(normalizeCookieDomain('.animastor.in')).to.equal('animastor.in');
        expect(normalizeCookieDomain('  ANIMASTOR.IN ')).to.equal('animastor.in');
    });

    it('rejects injection attempts and garbage → host-only cookies', () => {
        for (const bad of ['animastor.in; Path=/x', 'evil com', 'a b', '', null, undefined]) {
            expect(normalizeCookieDomain(bad), JSON.stringify(bad)).to.equal('');
        }
    });

    it('rejects non-positive TTLs but accepts zero grace', () => {
        expect(normalizeAuthConfig({ sessionTtlMs: 0 }).sessionTtlMs).to.equal(DEFAULT_AUTH_CONFIG.sessionTtlMs);
        expect(normalizeAuthConfig({ guestWorkspaceGraceMs: 0 }).guestWorkspaceGraceMs).to.equal(0);
    });

    it('createAuthService fails fast on a port missing a method', () => {
        const f = buildPorts();
        delete f.ports.sessions.revokeByToken;
        expect(() => createAuthService({ ports: f.ports })).to.throw(/sessions: missing required method\(s\): revokeByToken/);
    });

    it('assertAuthPorts accepts the complete port set and returns it', () => {
        const f = buildPorts();
        expect(assertAuthPorts(f.ports)).to.equal(f.ports);
    });
});

describe('auth contract: cookie grammar', () => {
    const base = { secure: true };

    it('session cookie carries the frozen attribute set', () => {
        const v = cookies.sessionCookieHeader('tok', base);
        expect(v).to.equal('animastor_sid=tok; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure');
    });

    it('clear cookie uses Max-Age=0 with identical attributes', () => {
        const v = cookies.clearSessionCookieHeader(base);
        expect(v).to.contain('animastor_sid=;');
        expect(v).to.contain('Max-Age=0');
        expect(v).to.contain('HttpOnly');
        expect(v).to.contain('SameSite=Lax');
    });

    it('guest cookie uses the guest name and TTL', () => {
        const v = cookies.guestCookieHeader('gtok', { secure: false });
        expect(v).to.contain('animastor_gid=gtok');
        expect(v).to.contain('Max-Age=2592000');
        expect(v).to.not.contain('Secure');
    });

    it('Domain attribute appended only when a validated domain is configured', () => {
        const cfg = { cookieDomain: 'animastor.in' };
        expect(cookies.sessionCookieHeader('t', base, cfg)).to.contain('; Domain=animastor.in');
        expect(cookies.clearSessionCookieHeader(base, cfg)).to.contain('; Domain=animastor.in');
        expect(cookies.guestCookieHeader('t', base, cfg)).to.contain('; Domain=animastor.in');
        expect(cookies.clearGuestCookieHeader(base, cfg)).to.contain('; Domain=animastor.in');
        expect(cookies.sessionCookieHeader('t', base)).to.not.contain('Domain=');
    });

    it('parseCookieHeader extracts URL-decoded values (no req needed)', () => {
        expect(cookies.parseCookieHeader('a=1; animastor_sid=tok2', 'animastor_sid')).to.equal('tok2');
        expect(cookies.parseCookieHeader('animastor_gid=abc%20d', 'animastor_gid')).to.equal('abc d');
        expect(cookies.parseCookieHeader(null, 'animastor_sid')).to.equal(null);
        expect(cookies.parseCookieHeader('nonsense', 'animastor_sid')).to.equal(null);
    });
});

describe('auth contract: bookAccessDecision (canonical decision layer)', () => {
    it('pre-auth (no identity) → ok pre-auth with the anonymous sentinel', async () => {
        const { svc } = build();
        for (const identity of [null, {}, { user: null, guest: null }]) {
            const d = await svc.bookAccessDecision(identity, 'b-1');
            expect(d).to.deep.equal({ ok: true, mode: 'pre-auth', workspace: { id: 'anonymous', name: 'Anonymous', type: 'temporary' } });
        }
    });

    it('authenticated owner → ok via ownership resolver (self-heal semantics)', async () => {
        const { svc } = build();
        const ws = { id: 'ws-alice', name: 'alice', type: 'personal' };
        const d = await svc.bookAccessDecision(userIdentity(ws), 'b-own');
        expect(d.ok).to.equal(true);
        expect(d.mode).to.equal('user');
        expect(d.workspace).to.equal(ws);
    });

    it('foreign workspace book → 403 denied even for a registered user', async () => {
        const f = build();
        f.bookWorkspace.set('b-foreign', 'ws-someone-else');
        const d = await f.svc.bookAccessDecision(userIdentity({ id: 'ws-alice' }), 'b-foreign');
        expect(d).to.include({ ok: false, status: 403, mode: 'denied' });
    });

    it('cross-workspace membership fallback → ok (collaboration-ready)', async () => {
        const f = build();
        // Book owned by ws-other; alice is a member of ws-other but her active
        // workspace is ws-alice (resolver resolves ws-other → membership → ok).
        f.bookWorkspace.set('b-shared', 'ws-other');
        f.workspaces.set('ws-other', { id: 'ws-other', name: 'other', type: 'personal' });
        f.memberships.set('ws-other:u-1', 'member');
        const d = await f.svc.bookAccessDecision(userIdentity({ id: 'ws-alice' }), 'b-shared');
        expect(d.ok).to.equal(true);
        expect(d.mode).to.equal('user');
        expect(d.workspace).to.include({ id: 'ws-other' });
    });

    it('unknown book for a user (resolver null) falls back to the legacy chain and denies', async () => {
        const f = build();
        f.ports.bookOwnership.resolveAccessWorkspace = async () => null;
        const d = await f.svc.bookAccessDecision(userIdentity({ id: 'ws-alice' }), 'ghost');
        expect(d).to.include({ ok: false, status: 403, mode: 'denied' });
    });

    it('authorization DB failure for a user → 403 FAIL CLOSED', async () => {
        const f = build();
        f.ports.bookOwnership.resolveAccessWorkspace = async () => { throw new Error('PG down'); };
        const d = await f.svc.bookAccessDecision(userIdentity({ id: 'ws-alice' }), 'b-1');
        expect(d).to.include({ ok: false, status: 403, mode: 'denied' });
    });

    it('expired guest workspace → 410 expired (before any port call)', async () => {
        const f = build();
        let portCalled = 0;
        f.ports.bookOwnership.getWorkspaceId = async () => { portCalled++; return 'gw-1'; };
        const d = await f.svc.bookAccessDecision(guestIdentity({ id: 'gw-1', type: 'temporary', status: 'expired' }), 'b-1');
        expect(d).to.include({ ok: false, status: 410, mode: 'expired' });
        expect(portCalled).to.equal(0);
    });

    it('guest book inside its workspace → ok guest', async () => {
        const f = build();
        f.bookWorkspace.set('b-guest', 'gw-1');
        const d = await f.svc.bookAccessDecision(guestIdentity({ id: 'gw-1', type: 'temporary', status: 'active' }), 'b-guest');
        expect(d.ok).to.equal(true);
        expect(d.mode).to.equal('guest');
        expect(d.workspace).to.include({ id: 'gw-1' });
    });

    it('guest book in a foreign workspace → 403 denied', async () => {
        const f = build();
        f.bookWorkspace.set('b-foreign', 'gw-other');
        const d = await f.svc.bookAccessDecision(guestIdentity({ id: 'gw-1', type: 'temporary', status: 'active' }), 'b-foreign');
        expect(d).to.include({ ok: false, status: 403, mode: 'denied' });
    });

    it('authorization DB failure for a guest → 410 FAIL CLOSED (historical guest path)', async () => {
        const f = build();
        f.ports.bookOwnership.getWorkspaceId = async () => { throw new Error('PG down'); };
        const d = await f.svc.bookAccessDecision(guestIdentity({ id: 'gw-1', type: 'temporary', status: 'active' }), 'b-1');
        expect(d).to.include({ ok: false, status: 410, mode: 'expired' });
    });

    it('accessibleBookWorkspace: workspace|null + WorkspaceExpiredError on 410', async () => {
        const f = build();
        f.bookWorkspace.set('b-guest', 'gw-1');
        const ws = await f.svc.accessibleBookWorkspace(guestIdentity({ id: 'gw-1', type: 'temporary', status: 'active' }), 'b-guest');
        expect(ws).to.include({ id: 'gw-1' });
        // Unknown book: the resolver self-heal-attaches the caller's own
        // workspace (historical workspace-ownership semantics — attached rows
        // then resolve to their own workspace), so the outcome is allowed.
        const attached = await f.svc.accessibleBookWorkspace(userIdentity({ id: 'ws-alice' }), 'ghost');
        expect(attached).to.include({ id: 'ws-alice' });
        // A book resolving to a FOREIGN workspace without membership denies.
        f.bookWorkspace.set('b-foreign', 'ws-someone-else');
        expect(await f.svc.accessibleBookWorkspace(userIdentity({ id: 'ws-alice' }), 'b-foreign')).to.equal(null);
        let threw = null;
        try {
            await f.svc.accessibleBookWorkspace(guestIdentity({ id: 'gw-1', type: 'temporary', status: 'expired' }), 'b-1');
        } catch (e) { threw = e; }
        expect(threw).to.be.instanceOf(WorkspaceExpiredError);
        expect(threw.status).to.equal(410);
    });
});

describe('auth contract: registration (ports + transaction boundary)', () => {
    it('register creates user + personal workspace + owner membership via the registrationTx port', async () => {
        const f = build();
        const r = await f.svc.register({ username: 'alice', password: 'valid-pass-123', email: 'Alice@Example.COM' });
        expect(r.user).to.include({ username: 'alice', display_name: 'alice', role: 'user' });
        expect(r.workspace.type).to.equal('personal');
        expect(r.session.token).to.be.a('string');
        expect(r.converted).to.equal(false);
        // email normalized before the port
        expect(f.calls.registerUserWithWorkspace[0].email).to.equal('alice@example.com');
        expect(f.calls.registerUserWithWorkspace[0].guestConversion).to.equal(null);
        // owner membership recorded
        expect(f.memberships.get(`${r.workspace.id}:` + r.user.id)).to.equal('owner');
    });

    it('register maps a canonical race to 409 with the historical email/username split', async () => {
        const f = build();
        await f.svc.register({ username: 'alice', password: 'valid-pass-123' });
        // Case-variant duplicate hitting the race discriminator inside the tx.
        try {
            await f.svc.register({ username: 'ALICE', password: 'valid-pass-123' });
            throw new Error('must not reach');
        } catch (e) {
            expect(e).to.be.instanceOf(AuthError);
            expect(e.status).to.equal(409);
            expect(e.reason).to.equal('register_username_taken');
        }
    });

    it('register maps a true unique violation to 409 register_conflict', async () => {
        const f = build();
        f.ports.registrationTx.registerUserWithWorkspace = async () => {
            const e = new Error('duplicate key value violates unique constraint "users_email_key"');
            throw e;
        };
        try {
            await f.svc.register({ username: 'bob', password: 'valid-pass-123' });
            throw new Error('must not reach');
        } catch (e) {
            expect(e).to.be.instanceOf(AuthError);
            expect(e.status).to.equal(409);
            expect(e.reason).to.equal('register_conflict');
        }
    });

    it('register ROLLS BACK atomically: a failing tx leaves NO session and rethrows', async () => {
        const f = build();
        let txStarted = 0;
        f.ports.registrationTx.registerUserWithWorkspace = async () => {
            txStarted++;
            throw new Error('constraint violation mid-transaction');
        };
        try {
            await f.svc.register({ username: 'carol', password: 'valid-pass-123' });
            throw new Error('must not reach');
        } catch (e) {
            expect(e).to.not.be.instanceOf(AuthError);
        }
        expect(txStarted).to.equal(1);
        // No user persisted by the domain layer, no session created after the
        // failed tx (historical behaviour: session strictly post-commit).
        expect(f.sessions.size).to.equal(0);
    });

    it('register with a live guest token converts the workspace IN PLACE', async () => {
        const f = build();
        const g = await f.ports.guests.createGuest({ workspaceTtlMs: 60000, sessionTtlMs: 60000 });
        f.bookWorkspace.set('b-kept', g.workspace.id); // a book inside the guest ws
        const r = await f.svc.register({ username: 'dave', password: 'valid-pass-123', guestToken: g.token });
        expect(r.converted).to.equal(true);
        expect(r.workspace.id).to.equal(g.workspace.id); // SAME workspace — nothing copied
        expect(r.workspace.type).to.equal('personal');
        // Book ownership row untouched by conversion (same workspace_id).
        expect(f.bookWorkspace.get('b-kept')).to.equal(g.workspace.id);
        // Old guest token revoked post-commit.
        expect(await f.ports.guests.findByToken(g.token)).to.equal(null);
        // Conversion was requested inside the tx.
        expect(f.calls.registerUserWithWorkspace[0].guestConversion).to.deep.equal({ workspaceId: g.workspace.id, username: 'dave' });
    });

    it('register with a stale guest token → 410 (never a silent fresh workspace)', async () => {
        const f = build();
        f.ports.guests.findByToken = async () => null;
        try {
            await f.svc.register({ username: 'eve', password: 'valid-pass-123', guestToken: 'gst.stale' });
            throw new Error('must not reach');
        } catch (e) {
            expect(e).to.be.instanceOf(AuthError);
            expect(e.status).to.equal(410);
            expect(e.reason).to.equal('register_guest_expired');
        }
    });

    it('register input validation keeps the historical 400 reasons', async () => {
        const f = build();
        for (const [input, reason] of [
            [{ username: ' ', password: 'valid-pass-123' }, 'register_invalid_username'],
            [{ username: 'ok', password: 'short' }, 'register_weak_password'],
            [{ username: 'ok', password: 'valid-pass-123', email: 'not-an-email' }, 'register_invalid_email'],
        ]) {
            try {
                await f.svc.register(input);
                throw new Error('must not reach');
            } catch (e) {
                expect(e).to.be.instanceOf(AuthError);
                expect(e.status).to.equal(400);
                expect(e.reason).to.equal(reason);
            }
        }
    });

    it('register pre-checks keep the historical 409s (username/email taken)', async () => {
        const f = build();
        await f.svc.register({ username: 'alice', password: 'valid-pass-123', email: 'a@x.com' });
        try {
            await f.svc.register({ username: 'ALICE', password: 'valid-pass-123' });
            throw new Error('must not reach');
        } catch (e) {
            expect(e.reason).to.equal('register_username_taken');
        }
        try {
            await f.svc.register({ username: 'newname', password: 'valid-pass-123', email: 'a@x.com' });
            throw new Error('must not reach');
        } catch (e) {
            expect(e.reason).to.equal('register_email_taken');
        }
    });
});

describe('auth contract: login / logout / session', () => {
    it('login: unknown user and wrong password produce the SAME generic 401 (no enumeration)', async () => {
        const f = build();
        await f.svc.register({ username: 'alice', password: 'valid-pass-123' });
        let err1, err2;
        try { await f.svc.login({ username: 'ghost', password: 'valid-pass-123' }); } catch (e) { err1 = e; }
        try { await f.svc.login({ username: 'alice', password: 'wrong-pass-99' }); } catch (e) { err2 = e; }
        for (const e of [err1, err2]) {
            expect(e).to.be.instanceOf(AuthError);
            expect(e.status).to.equal(401);
            expect(e.message).to.equal('Invalid username or password');
            expect(e.reason).to.equal('login_invalid_credentials');
        }
        expect(err1.message).to.equal(err2.message);
    });

    it('login: case-insensitive username, correct password → session + personal workspace', async () => {
        const f = build();
        await f.svc.register({ username: 'Alice', password: 'valid-pass-123' });
        const r = await f.svc.login({ username: '  alice  ', password: 'valid-pass-123' });
        expect(r.user.username).to.equal('Alice');
        expect(r.workspace.type).to.equal('personal');
        expect(r.session.expiresAt).to.be.greaterThan(Date.now() + 29 * 24 * 3600e3); // 30d TTL
    });

    it('logout is idempotent; revoked session no longer resolves', async () => {
        const f = build();
        await f.svc.register({ username: 'alice', password: 'valid-pass-123' });
        const s = await f.ports.sessions.createSession('u-1', Date.now() + 60000);
        expect((await f.svc.logout(s.token)).ok).to.equal(true);
        expect((await f.svc.logout(s.token)).ok).to.equal(true);
        expect(await f.svc.resolveSession(s.token)).to.equal(null);
    });

    it('resolveSession returns the userId-shape user + workspace', async () => {
        const f = build();
        const r = await f.svc.register({ username: 'alice', password: 'valid-pass-123' });
        const resolved = await f.svc.resolveSession(r.session.token);
        expect(resolved.user).to.include({ userId: r.user.id, username: 'alice' });
        expect(resolved.workspace).to.include({ id: r.workspace.id });
        expect(await f.svc.resolveSession('sid.bogus.bogus')).to.equal(null);
        expect(await f.svc.resolveSession(null)).to.equal(null);
    });
});

describe('auth contract: guest identity lifecycle', () => {
    it('createGuest → resolveGuest roundtrip with active status + touch extends', async () => {
        const f = build();
        const g = await f.svc.createGuest();
        expect(g.token).to.match(/^gst\./);
        const resolved = await f.svc.resolveGuest(g.token);
        expect(resolved.guest.guestId).to.equal(g.guestId);
        expect(resolved.workspace).to.include({ id: g.workspace.id, type: 'temporary', status: 'active' });
        const before = f.workspaces.get(g.workspace.id).expires_at;
        await f.svc.touchGuestWorkspace(g.workspace.id);
        expect(f.workspaces.get(g.workspace.id).expires_at).to.be.at.least(before);
    });

    it('expired workspace still RESOLVES but reports status expired (410 upstream)', async () => {
        const f = build();
        const g = await f.svc.createGuest();
        f.workspaces.get(g.workspace.id).expires_at = Date.now() - 1000;
        const resolved = await f.svc.resolveGuest(g.token);
        expect(resolved.workspace.status).to.equal('expired');
    });

    it('guestWorkspaceStatus mirrors guest-repo semantics', () => {
        const { svc } = build();
        expect(svc.guestWorkspaceStatus(null)).to.equal('active');
        expect(svc.guestWorkspaceStatus(Date.now() + 1000)).to.equal('active');
        expect(svc.guestWorkspaceStatus(Date.now() - 1000)).to.equal('expired');
    });
});

// ==========================================================
// Public API surface (frozen) — package root ↔ APB-G7 parity
// ==========================================================
// The package root export map is the ENTIRE public surface of
// @animastor/auth (no deep exports). The host boundary guard
// (backend/tests/architecture/auth-package-boundary.test.js, APB-G7) pins
// the same list — keep the two in lockstep. REQUIRED/assertPort (ports.js)
// are intentionally NOT public: hosts assert through assertAuthPorts.

describe('auth contract: package public API (frozen)', () => {
    const FROZEN_PUBLIC_API = [
        'createAuthService', 'decideBookAccess', 'authorizedWorkspace',
        'ANONYMOUS_WORKSPACE', 'AuthError', 'WorkspaceExpiredError',
        'DEFAULT_AUTH_CONFIG', 'normalizeAuthConfig', 'normalizeCookieDomain',
        'cookies', 'password', 'assertAuthPorts',
    ];

    it('exports exactly the frozen public API — no more, no less', () => {
        expect(Object.keys(pkg).sort()).to.deep.equal([...FROZEN_PUBLIC_API].sort());
    });

    it('every frozen name is bound to a real capability', () => {
        expect(typeof pkg.createAuthService).to.equal('function');
        expect(typeof pkg.decideBookAccess).to.equal('function');
        expect(typeof pkg.authorizedWorkspace).to.equal('function');
        expect(pkg.ANONYMOUS_WORKSPACE).to.be.an('object');
        expect(typeof pkg.AuthError).to.equal('function');
        expect(typeof pkg.WorkspaceExpiredError).to.equal('function');
        expect(pkg.DEFAULT_AUTH_CONFIG).to.be.an('object');
        expect(typeof pkg.normalizeAuthConfig).to.equal('function');
        expect(typeof pkg.normalizeCookieDomain).to.equal('function');
        expect(pkg.cookies).to.be.an('object');
        expect(pkg.password).to.be.an('object');
        expect(typeof pkg.assertAuthPorts).to.equal('function');
    });

    it('error contract keeps the frozen status/reason semantics', () => {
        const e = new pkg.AuthError(403, 'nope', 'forbidden');
        expect(e).to.be.an.instanceOf(Error);
        expect(e.status).to.equal(403);
        expect(e.reason).to.equal('forbidden');
        const g = new pkg.WorkspaceExpiredError();
        expect(g).to.be.an.instanceOf(Error);
        expect(g.status).to.equal(410);
        expect(g.code).to.equal('workspace_expired');
        expect(g.message).to.equal('workspace_expired');
    });

    it('cookie + password namespaces keep the frozen grammar/primitives', () => {
        expect(pkg.cookies.SESSION_COOKIE_NAME).to.equal('animastor_sid');
        expect(pkg.cookies.GUEST_COOKIE_NAME).to.equal('animastor_gid');
        expect(typeof pkg.cookies.sessionCookieHeader).to.equal('function');
        expect(typeof pkg.cookies.parseCookieHeader).to.equal('function');
        expect(typeof pkg.password.hashPassword).to.equal('function');
        expect(typeof pkg.password.verifyPassword).to.equal('function');
        expect(typeof pkg.password.validatePasswordPolicy).to.equal('function');
    });
});
