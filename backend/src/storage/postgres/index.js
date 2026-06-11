const { runMigrations } = require('./schema');
const { getPool, closePool } = require('./database');
const repos = require('./repositories');

async function initialize() {
    await runMigrations();
    console.log('[PG] PostgreSQL storage initialized');
    return { pool: getPool(), repos };
}

module.exports = {
    initialize,
    query: require('./database').query,
    getPool,
    closePool,
    repos,
};
