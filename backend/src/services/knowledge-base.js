// ======================================================
// Knowledge Base Loader
// ======================================================
// Loads examples, rules, and skills from the ai/ directory.
// Still available but NOT included in prompts — kept for reference.
// ======================================================

const fs = require('fs');
const path = require('path');

/**
 * Load all knowledge base files from the ai/ directory structure.
 * Returns { examples, rules, skills, loaded_files, total_chars }
 */
function loadKnowledgeBase() {
    const kb = { examples: {}, rules: {}, skills: {}, loaded_files: [], total_chars: 0 };

    const examplesDir = path.join(__dirname, '../../ai/examples');
    if (fs.existsSync(examplesDir)) {
        function walkDir(dir, depth) {
            if (depth > 4) return;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            entries.sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) walkDir(fullPath, depth + 1);
                else if (entry.name.endsWith('.json')) {
                    const relPath = path.relative(examplesDir, fullPath);
                    try {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        kb.examples[relPath] = JSON.parse(content);
                        kb.loaded_files.push(relPath);
                        kb.total_chars += content.length;
                    } catch (e) {
                        console.warn(`[KNOWLEDGE-BASE] Failed to load example ${fullPath}: ${e.message}`);
                    }
                }
            }
        }
        walkDir(examplesDir, 0);
    }

    const rulesDir = path.join(__dirname, '../../ai/rules');
    if (fs.existsSync(rulesDir)) {
        for (const f of fs.readdirSync(rulesDir).filter(f => f.endsWith('.md'))) {
            try {
                const content = fs.readFileSync(path.join(rulesDir, f), 'utf8');
                kb.rules[path.basename(f, '.md')] = content;
                kb.loaded_files.push(`rules/${f}`);
                kb.total_chars += content.length;
            } catch (e) {
                console.warn(`[KNOWLEDGE-BASE] Failed to load rule ${f}: ${e.message}`);
            }
        }
    }

    const skillsDir = path.join(__dirname, '../../ai/skills');
    if (fs.existsSync(skillsDir)) {
        for (const f of fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'))) {
            try {
                const content = fs.readFileSync(path.join(skillsDir, f), 'utf8');
                kb.skills[path.basename(f, '.md')] = content;
                kb.loaded_files.push(`skills/${f}`);
                kb.total_chars += content.length;
            } catch (e) {
                console.warn(`[KNOWLEDGE-BASE] Failed to load skill ${f}: ${e.message}`);
            }
        }
    }

    console.log(`[KNOWLEDGE-BASE] Loaded: ${kb.loaded_files.length} files, ${kb.total_chars} chars`);
    return kb;
}

module.exports = { loadKnowledgeBase };
