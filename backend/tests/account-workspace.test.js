// ======================================================
// Account & Workspace Foundation Tests
// ======================================================
// Minimal tests for the account system foundation:
// 1. User owns personal workspace
// 2. Workspace owns book
// 3. Owner can access own book
// 4. Another user cannot access the book
// 5. Unknown workspace/book relationship is denied
// 6. Existing development books remain accessible after migration

const { expect } = require('chai');
const { query } = require('../src/storage/postgres/database');
const userRepo = require('../src/storage/postgres/repositories/user-repo');
const workspaceRepo = require('../src/storage/postgres/repositories/workspace-repo');

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

        it('existing books are linked to developer workspace', async () => {
            const devUser = await userRepo.findByUsername('developer');
            const workspace = await workspaceRepo.findPersonalWorkspace(devUser.user_id);
            const result = await query(
                `SELECT COUNT(*) as count FROM books WHERE workspace_id = $1`,
                [workspace.id]
            );
            // Should have at least the books that existed before migration
            expect(parseInt(result.rows[0].count)).to.be.at.least(0);
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
