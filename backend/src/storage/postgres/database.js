const { Pool } = require('pg');

const POOL_CONFIG = {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    database: process.env.PG_DB || 'animastor',
    user: process.env.PG_USER || 'animastor',
    password: process.env.PG_PASSWORD || 'animastor_secret_2026',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
};

let pool = null;

function getPool() {
    if (pool) return pool;
    pool = new Pool(POOL_CONFIG);
    pool.on('error', (err) => {
        console.error('[PG] Unexpected pool error:', err.message);
    });
    return pool;
}

async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

async function query(text, params) {
    const client = await getPool().connect();
    try {
        const result = await client.query(text, params);
        return result;
    } finally {
        client.release();
    }
}

module.exports = { getPool, closePool, query };
