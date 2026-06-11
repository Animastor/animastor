const fs = require('fs');
const path = require('path');

const AI_DIR = process.env.AI_DIR || path.join(__dirname, '../../ai');

const CACHE_TTL_MS = process.env.AI_CACHE_TTL
    ? parseInt(process.env.AI_CACHE_TTL, 10)
    : 60_000; // 1 minute

const cache = {
    rules: { data: null, mtime: 0 },
    skills: { data: null, mtime: 0 },
    examples: { data: null, mtime: 0 },
    all: { data: null, mtime: 0 },
};

/**
 * Read all .md files from a directory, return as { filename (no ext): content }
 */
function loadMdDir(subdir) {
    const dir = path.join(AI_DIR, subdir);
    const result = {};
    if (!fs.existsSync(dir)) return result;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
        const key = path.basename(file, '.md');
        const content = fs.readFileSync(path.join(dir, file), 'utf-8').trim();
        result[key] = content;
    }
    return result;
}

/**
 * Read all .json files from a directory, return as { filename (no ext): parsed object }
 */
function loadJsonDir(subdir) {
    const dir = path.join(AI_DIR, subdir);
    const result = {};
    if (!fs.existsSync(dir)) return result;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
        const key = path.basename(file, '.json');
        const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
        try {
            result[key] = JSON.parse(raw);
        } catch (e) {
            console.warn(`[AI-Loader] Failed to parse ${file}: ${e.message}`);
        }
    }
    return result;
}

/**
 * Get mtime for a directory (latest mtime of any file in it)
 */
function getDirMtime(subdir) {
    const dir = path.join(AI_DIR, subdir);
    if (!fs.existsSync(dir)) return 0;
    const files = fs.readdirSync(dir).map(f => path.join(dir, f));
    if (files.length === 0) return 0;
    const stats = files.map(f => {
        try { return fs.statSync(f).mtimeMs; } catch { return 0; }
    });
    return Math.max(...stats);
}

function isCacheValid(cacheEntry) {
    return cacheEntry.data !== null && Date.now() - cacheEntry.mtime < CACHE_TTL_MS;
}

function getRules() {
    if (!isCacheValid(cache.rules)) {
        cache.rules.data = loadMdDir('rules');
        cache.rules.mtime = Date.now();
    }
    return cache.rules.data;
}

function getSkills() {
    if (!isCacheValid(cache.skills)) {
        cache.skills.data = loadMdDir('skills');
        cache.skills.mtime = Date.now();
    }
    return cache.skills.data;
}

function getExamples() {
    if (!isCacheValid(cache.examples)) {
        cache.examples.data = loadJsonDir('examples');
        cache.examples.mtime = Date.now();
    }
    return cache.examples.data;
}

function getAll() {
    if (!isCacheValid(cache.all)) {
        cache.all.data = {
            rules: getRules(),
            skills: getSkills(),
            examples: getExamples(),
        };
        cache.all.mtime = Date.now();
    }
    return cache.all.data;
}

/**
 * Get a specific rule by name (without .md extension)
 */
function getRule(name) {
    return getRules()[name] || null;
}

/**
 * Get a specific skill by name (without .md extension)
 */
function getSkill(name) {
    return getSkills()[name] || null;
}

/**
 * Get a specific example by name (without .json extension)
 */
function getExample(name) {
    return getExamples()[name] || null;
}

function invalidateCache() {
    Object.keys(cache).forEach(k => { cache[k].data = null; cache[k].mtime = 0; });
}

module.exports = {
    getRules,
    getSkills,
    getExamples,
    getAll,
    getRule,
    getSkill,
    getExample,
    invalidateCache,
};
