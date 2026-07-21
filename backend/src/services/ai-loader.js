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
 * Recursively walk a directory, collecting .md files.
 * Returns { relativePath_without_ext: content }.
 * For nested files, the key includes the subdirectory path:
 *   "video/ltx-2.3" → content of skills/video/ltx-2.3.md
 */
function walkMdDir(dirPath, baseDir) {
    const result = {};
    if (!fs.existsSync(dirPath)) return result;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            // Recurse into subdirectory
            const subResult = walkMdDir(fullPath, baseDir);
            Object.assign(result, subResult);
        } else if (entry.name.endsWith('.md')) {
            // Compute key relative to baseDir, without .md extension
            const relPath = path.relative(baseDir, fullPath);
            const key = relPath.replace(/\.md$/, '');
            try {
                const content = fs.readFileSync(fullPath, 'utf-8').trim();
                result[key] = content;
            } catch (e) {
                console.warn(`[AI-Loader] Failed to read ${fullPath}: ${e.message}`);
            }
        }
    }
    return result;
}

/**
 * Read all .md files from a directory (recursively), return as { key: content }.
 * Keys are paths relative to the subdirectory, without .md extension.
 * Example: loadMdDir('skills') returns { "video/ltx-2.3": "...", "camera_language": "..." }
 */
function loadMdDir(subdir) {
    const dir = path.join(AI_DIR, subdir);
    return walkMdDir(dir, dir);
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
 * Recursively walk a directory and collect mtime of every file.
 */
function collectAllFiles(dir) {
    const files = [];
    if (!fs.existsSync(dir)) return files;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectAllFiles(fullPath));
        } else {
            files.push(fullPath);
        }
    }
    return files;
}

/**
 * Get mtime for a directory (latest mtime of any file in it, recursively).
 */
function getDirMtime(subdir) {
    const dir = path.join(AI_DIR, subdir);
    if (!fs.existsSync(dir)) return 0;
    const files = collectAllFiles(dir);
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

function getSkillNames() {
    return Object.keys(getSkills());
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
    getSkillNames,
    invalidateCache,
};
