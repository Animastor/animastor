// ======================================================
// Account & Workspace Foundation Tests
// ======================================================
// Tests for the account system foundation:
// 1. User owns personal workspace
// 2. Workspace owns book
// 3. Owner can access own book
// 4. Another user cannot access the book
// 5. Unknown workspace/book relationship is denied
// 6. Book registry: ensureBook workspace attach (insert + conflict)
// 7. Workspace ownership resolver (resolution, self-heal, no overwrite)
// 8. User/email normalization (case/whitespace invariants)
// 9. Existing development books remain accessible after migration

const { expect } = require('chai');
const { query } = require('../src/storage/postgres/database');
const userRepo = require('../src/storage/postgres/repositories/user-repo');
const workspaceRepo = require('../src/storage/postgres/repositories/workspace-repo');
const bookRepo = require('../src/storage/postgres/repositories/book-repo');

describe('Account & Workspace Foundation', () => {
    let testUser1;
    let testUser2;
    let testWorkspace1;
    let testWorkspace2;
    let testBookId;

    before(async () => {
        // Create test users
        testUser1 = await userRepo.createUser({
            username: 'testuser1_' + Date.now(),
            displayName: 'Test User 1',
        });
        testUser2 = await userRepo.createUser({
            username: 'testuser2_' + Date.now(),
            displayName: 'Test User 2',
        });

        // Create workspaces
        testWorkspace1 = await workspaceRepo.createWorkspace({
            name: 'Test Workspace 1',
            ownerUserId: testUser1.user_id,
            type: 'personal',
        });
        testWorkspace2 = await workspaceRepo.createWorkspace({
            name: 'Test Workspace 2',
            ownerUserId: testUser2.user_id,
            type: 'personal',
        });

        // Create a test book in workspace 1
        testBookId = 'test-book-' + Date.now();
        await query(`
            INSERT INTO books (book_id, workspace_id, title)
            VALUES ($1, $2, 'Test Book')
        `, [testBookId, testWorkspace1.id]);
    });

    after(async () => {
        // Cleanup test data
        if (testBookId) {
            await query(`DELETE FROM books WHERE book_id = $1`, [testBookId]);
        }
        if (testWorkspace1) {
            await query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [testWorkspace1.id]);
            await query(`DELETE FROM workspaces WHERE id = $1`, [testWorkspace1.id]);
        }
        if (testWorkspace2) {
            await query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [testWorkspace2.id]);
            await query(`DELETE FROM workspaces WHERE id = $1`, [testWorkspace2.id]);
        }
        if (testUser1) {
            await query(`DELETE FROM users WHERE user_id = $1`, [testUser1.user_id]);
        }
        if (testUser2) {
            await query(`DELETE FROM users WHERE user_id = $1`, [testUser2.user_id]);
        }
    });

    describe('User Creation', () => {
        it('creates a user with username', async () => {
            expect(testUser1).to.exist;
            expect(testUser1.username).to.be.a('string');
            expect(testUser1.user_id).to.be.a('string');
        });

        it('creates unique usernames', async () => {
            expect(testUser1.username).to.not.equal(testUser2.username);
        });
    });

    describe('Workspace Creation', () => {
        it('creates a workspace with owner', async () => {
            expect(testWorkspace1).to.exist;
            expect(testWorkspace1.owner_user_id).to.equal(testUser1.user_id);
            expect(testWorkspace1.type).to.equal('personal');
        });

        it('automatically adds owner as workspace member', async () => {
            const membership = await workspaceRepo.getMembership(testWorkspace1.id, testUser1.user_id);
            expect(membership).to.exist;
            expect(membership.role).to.equal('owner');
        });

        it('lists user workspaces', async () => {
            const workspaces = await workspaceRepo.listUserWorkspaces(testUser1.user_id);
            expect(workspaces).to.be.an('array');
            expect(workspaces.length).to.be.at.least(1);
            const found = workspaces.find(w => w.id === testWorkspace1.id);
            expect(found).to.exist;
        });
    });

    describe('Book Ownership', () => {
        it('links book to workspace', async () => {
            const result = await query(
                `SELECT workspace_id FROM books WHERE book_id = $1`,
                [testBookId]
            );
            expect(result.rows[0].workspace_id).to.equal(testWorkspace1.id);
        });

        it('allows workspace member to access book', async () => {
            const workspaceId = await workspaceRepo.checkBookAccess(testBookId, testUser1.user_id);
            expect(workspaceId).to.equal(testWorkspace1.id);
        });

        it('denies access to non-member user', async () => {
            const workspaceId = await workspaceRepo.checkBookAccess(testBookId, testUser2.user_id);
            expect(workspaceId).to.be.null;
        });

        it('denies access for unknown book', async () => {
            const workspaceId = await workspaceRepo.checkBookAccess('nonexistent-book', testUser1.user_id);
            expect(workspaceId).to.be.null;
        });
    });

    describe('Book Registry — workspace attachment', () => {
        let blankBookId;
        const registered = [];

        after(async () => {
            for (const id of registered) {
                await query(`DELETE FROM books WHERE book_id = $1`, [id]);
            }
        });

        it('ensureBook creates the registry row with workspace_id (new book)', async () => {
            blankBookId = `aw-ensure-${Date.now()}`;
            registered.push(blankBookId);
            await bookRepo.ensureBook(blankBookId, 'Blank Book', null, 'ru', testWorkspace1.id);
            const wsId = await bookRepo.getWorkspaceId(blankBookId);
            expect(wsId).to.equal(testWorkspace1.id);
        });

        it('ensureBook does NOT overwrite an existing workspace on conflict', async () => {
            await bookRepo.ensureBook(blankBookId, 'Blank Book v2', 'me', 'en', testWorkspace2.id);
            const wsId = await bookRepo.getWorkspaceId(blankBookId);
            expect(wsId).to.equal(testWorkspace1.id); // original wins
        });

        it('attachWorkspaceIfMissing only sets NULL workspaces', async () => {
            const attached = await bookRepo.attachWorkspaceIfMissing(blankBookId, testWorkspace2.id);
            expect(attached).to.equal(false);
            expect(await bookRepo.getWorkspaceId(blankBookId)).to.equal(testWorkspace1.id);

            const orphanId = `aw-orphan-${Date.now()}`;
            registered.push(orphanId);
            await query(`INSERT INTO books (book_id, title) VALUES ($1, 'orphan')`, [orphanId]);
            const attachedOrphan = await bookRepo.attachWorkspaceIfMissing(orphanId, testWorkspace2.id);
            expect(attachedOrphan).to.equal(true);
            expect(await bookRepo.getWorkspaceId(orphanId)).to.equal(testWorkspace2.id);
        });

        it('listBookIdsByWorkspace lists only books of that workspace', async () => {
            const owned = await bookRepo.listBookIdsByWorkspace(testWorkspace1.id);
            const ids = owned.map(r => r.book_id);
            expect(ids).to.include(blankBookId); // created in ws1
            expect(ids).to.include(testBookId);  // created in ws1 via direct INSERT
        });
    });

    describe('Workspace Ownership Resolver', () => {
        const ownership = require('../src/middleware/workspace-ownership');
        const resolverBookIds = [];

        before(() => ownership.resetCache());
        after(async () => {
            for (const id of resolverBookIds) {
                await query(`DELETE FROM books WHERE book_id = $1`, [id]);
            }
            ownership.resetCache();
        });

        it('resolves the already-attached workspace', async () => {
            const wsId = await ownership.resolveWorkspaceForBook(testBookId);
            expect(wsId).to.equal(testWorkspace1.id);
        });

        it('prefers preferredWorkspaceId when the book is unowned', async () => {
            const bookId = `aw-pref-${Date.now()}`;
            resolverBookIds.push(bookId);
            const wsId = await ownership.resolveWorkspaceForBook(bookId, {
                bookTitle: 'Pref',
                preferredWorkspaceId: testWorkspace2.id,
            });
            expect(wsId).to.equal(testWorkspace2.id);
            expect(await bookRepo.getWorkspaceId(bookId)).to.equal(testWorkspace2.id);
        });

        it('falls back to the seeded default workspace when unowned', async () => {
            const bookId = `aw-def-${Date.now()}`;
            resolverBookIds.push(bookId);
            const wsId = await ownership.resolveWorkspaceForBook(bookId);
            const dev = await userRepo.findByUsername('developer');
            const devWs = await workspaceRepo.findPersonalWorkspace(dev.user_id);
            expect(wsId).to.equal(devWs.id);
        });

        it('never overwrites a workspace attached by another owner', async () => {
            const bookId = `aw-owner-${Date.now()}`;
            resolverBookIds.push(bookId);
            await query(
                `INSERT INTO books (book_id, workspace_id, title) VALUES ($1, $2, 'owned')`,
                [bookId, testWorkspace1.id]
            );
            const wsId = await ownership.resolveWorkspaceForBook(bookId, {
                preferredWorkspaceId: testWorkspace2.id,
            });
            expect(wsId).to.equal(testWorkspace1.id);
        });
    });

    describe('Account identifier normalization', () => {
        let normUser;
        after(async () => {
            if (normUser) await query(`DELETE FROM users WHERE user_id = $1`, [normUser.user_id]);
        });

        it('normalizes username whitespace and email case/whitespace on create', async () => {
            normUser = await userRepo.createUser({
                username: `  norm_${Date.now()} `,
                email: '  NormUser@Example.COM ',
                displayName: 'Norm',
            });
            expect(normUser.username.trim()).to.equal(normUser.username);
            expect(normUser.email).to.equal('normuser@example.com');
        });

        it('normalizes email/username on update (no phantom UNIQUE collisions)', async () => {
            const updated = await userRepo.updateUser(normUser.user_id, {
                email: ' NORM_updated@Example.com ',
            });
            expect(updated.email).to.equal('norm_updated@example.com');
        });
    });

    describe('Attach idempotency & non-overwrite', () => {
        let idemBookId;
        after(async () => {
            if (idemBookId) await query(`DELETE FROM books WHERE book_id = $1`, [idemBookId]);
        });

        it('ensureBook never overwrites an already-attached workspace on conflict', async () => {
            idemBookId = 'aw-idem-' + Date.now();
            await query(
                `INSERT INTO books (book_id, workspace_id, title) VALUES ($1, $2, 'Idem')`,
                [idemBookId, testWorkspace1.id]
            );
            // ensureBook on conflict (re-import / re-register) must not re-own the book
            const bookRepo = require('../src/storage/postgres/repositories/book-repo');
            await bookRepo.ensureBook(idemBookId, 'Idem v2', null, null, testWorkspace2.id);
            const { rows } = await query(`SELECT workspace_id FROM books WHERE book_id = $1`, [idemBookId]);
            expect(rows[0].workspace_id).to.equal(testWorkspace1.id);
        });
    });

    describe('Development Books Migration', () => {
        it('has development user', async () => {
            const devUser = await userRepo.findByUsername('developer');
            expect(devUser).to.exist;
            expect(devUser.role).to.equal('admin');
        });

        it('has personal workspace for developer', async () => {
            const devUser = await userRepo.findByUsername('developer');
            const workspace = await workspaceRepo.findPersonalWorkspace(devUser.user_id);
            expect(workspace).to.exist;
            expect(workspace.type).to.equal('personal');
        });

        it('no book row is left without a workspace after the seed', async () => {
            const result = await query(`SELECT COUNT(*)::int AS n FROM books WHERE workspace_id IS NULL`);
            expect(result.rows[0].n).to.equal(0);
        });

        it('seeding is idempotent across restarts (single developer user, single workspace)', async () => {
            const { rows: users } = await query(`SELECT user_id FROM users WHERE username = 'developer'`);
            expect(users).to.have.length(1);
            const { rows: wss } = await query(
                `SELECT id FROM workspaces WHERE owner_user_id = $1 AND type = 'personal'`,
                [users[0].user_id]
            );
            expect(wss).to.have.length(1);
        });
    });

    describe('Auth Context Middleware', () => {
        it('exports required functions', () => {
            const authContext = require('../src/middleware/auth-context');
            expect(authContext.authContext).to.be.a('function');
            expect(authContext.requireAuth).to.be.a('function');
            expect(authContext.requireBookAccess).to.be.a('function');
            expect(authContext.checkBookAccess).to.be.a('function');
        });
    });
});
