// O-3 dependency/SCC audit — full require graph (static + lazy) over
// backend/src, iterative Tarjan SCC. Run with: node scripts/o3-scc-audit.cjs
// Mirrors the §32.4 measurement method (reconnaissance): resolves relative
// specifiers to files (extensionless + .js/.cjs/.json), keeps package
// specifiers as opaque external nodes, builds both the static graph and the
// full graph (including in-function lazy requires), runs Tarjan on each and
// prints the mandated edge checks.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'backend', 'src');

function listFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) listFiles(p, out);
        else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(p);
    }
    return out;
}

// Extract require(spec) with position, distinguishing top-level vs in-function
// (lazy) by tracking brace depth at the call site.
function extractRequires(src) {
    const out = [];
    const re = /require\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*([A-Za-z_$][\w$.]*)\s*\)/g;
    let depth = 0;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{' || ch === '(' || ch === '[') depth++;
        else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    }
    // Brace-depth per position (second pass; simple scanner).
    const depths = new Array(src.length);
    let d = 0;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        depths[i] = d;
        if (ch === '{' || ch === '(' || ch === '[') d++;
        else if (ch === '}' || ch === ')' || ch === ']') d = Math.max(0, d - 1);
    }
    let m;
    while ((m = re.exec(src)) !== null) {
        const spec = m[1] || null; // null = computed/identifier require
        if (spec === null) continue; // identifier requires can't be resolved statically
        out.push({ spec, top: depths[m.index] <= 1 });
    }
    return out;
}

function resolveSpecifier(fromFile, spec) {
    if (!spec.startsWith('.')) return null; // package or builtin — opaque
    const base = path.resolve(path.dirname(fromFile), spec);
    const candidates = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`,
        path.join(base, 'index.js'), path.join(base, 'index.cjs')];
    for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
}

function buildGraph(includeLazy) {
    const files = listFiles(SRC);
    const byFile = new Map(files.map((f) => [f, extractRequires(fs.readFileSync(f, 'utf8'))]));
    const graph = new Map(files.map((f) => [f, new Set()]));
    const lazyEdges = [];
    for (const [f, reqs] of byFile) {
        for (const { spec, top } of reqs) {
            if (!includeLazy && !top) continue;
            const target = resolveSpecifier(f, spec);
            if (target && graph.has(target)) {
                graph.get(f).add(target);
                if (!top) lazyEdges.push(`${rel(f)} -> ${rel(target)} (lazy)`);
            }
        }
    }
    return { graph, lazyEdges };
}

function rel(p) { return path.relative(SRC, p); }

// Iterative Tarjan SCC.
function tarjan(graph) {
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const sccs = [];
    let counter = 0;
    for (const v of graph.keys()) {
        if (index.has(v)) continue;
        const work = [[v, 0]];
        while (work.length) {
            const frame = work[work.length - 1];
            const [v, pi] = frame;
            if (pi === 0) {
                index.set(v, counter);
                low.set(v, counter);
                counter++;
                stack.push(v);
                onStack.add(v);
            }
            const neighbors = [...graph.get(v)];
            let advanced = false;
            while (frame[1] < neighbors.length) {
                const w = neighbors[frame[1]];
                frame[1]++;
                if (!index.has(w)) {
                    work.push([w, 0]);
                    advanced = true;
                    break;
                } else if (onStack.has(w)) {
                    low.set(v, Math.min(low.get(v), index.get(w)));
                }
            }
            if (advanced) continue;
            if (low.get(v) === index.get(v)) {
                const comp = [];
                let w;
                do {
                    w = stack.pop();
                    onStack.delete(w);
                    comp.push(w);
                } while (w !== v);
                sccs.push(comp);
            }
            work.pop();
            if (work.length) {
                const parent = work[work.length - 1][0];
                low.set(parent, Math.min(low.get(parent), low.get(v)));
            }
        }
    }
    return sccs;
}

function edgeExists(graph, fromRel, toRel) {
    for (const [f, targets] of graph) {
        if (rel(f) !== fromRel) continue;
        for (const t of targets) {
            if (rel(t) === toRel || rel(t).startsWith(toRel.replace(/\/?$/, '/'))) return true;
        }
    }
    return false;
}

function countEdges(graph, fromDir, toPrefix) {
    let n = 0;
    const list = [];
    for (const [f, targets] of graph) {
        const fr = rel(f);
        if (!fr.startsWith(fromDir)) continue;
        for (const t of targets) {
            const tr = rel(t);
            if (tr === toPrefix || tr.startsWith(toPrefix)) { n++; list.push(`${fr} -> ${tr}`); }
        }
    }
    return { n, list };
}

function run(label, includeLazy) {
    const { graph, lazyEdges } = buildGraph(includeLazy);
    const sccs = tarjan(graph).filter((c) => c.length > 1);
    console.log(`\n===== ${label} =====`);
    console.log(`nodes: ${graph.size}, lazy edges: ${includeLazy ? lazyEdges.length : 'n/a'}`);
    const checks = [
        ['runtime -> orchestration', countEdges(graph, 'runtime/', 'orchestration/')],
        ['services -> orchestration', countEdges(graph, 'services/', 'orchestration/')],
        ['orchestration -> book', countEdges(graph, 'orchestration/', 'book/')],
        ['runtime -> book', countEdges(graph, 'runtime/', 'book/')],
        ['orchestration -> storage', countEdges(graph, 'orchestration/', 'storage/')],
        ['runtime -> storage', countEdges(graph, 'runtime/', 'storage/')],
    ];
    for (const [label2, { n, list }] of checks) {
        console.log(`${label2}: ${n}${n ? '\n  ' + list.join('\n  ') : ''}`);
    }
    console.log(`SCCs > 1 node: ${sccs.length}`);
    for (const c of sccs) console.log('  SCC:', c.map(rel).sort().join(' <-> '));
    return sccs;
}

const fullSccs = run('FULL GRAPH (static + lazy requires)', true);
run('STATIC GRAPH (top-level requires only)', false);

console.log('\n===== VERDICT =====');
const expected = {
    'runtime -> orchestration (full)': 0,
    'services -> orchestration (full)': 0,
    'orchestration -> book (full)': 0,
    'runtime -> book (full)': 0,
};
const results = [];
{
    const { graph } = buildGraph(true);
    results.push(['runtime -> orchestration', countEdges(graph, 'runtime/', 'orchestration/').n]);
    results.push(['services -> orchestration', countEdges(graph, 'services/', 'orchestration/').n]);
    results.push(['orchestration -> book', countEdges(graph, 'orchestration/', 'book/').n]);
    results.push(['runtime -> book', countEdges(graph, 'runtime/', 'book/').n]);
    results.push(['new SCCs (pre-existing workspace-ai-provider<->system-ai excluded)',
        fullSccs.filter((c) => !c.map(rel).join().includes('workspace-ai-provider')).length]);
}
let ok = true;
for (const [name, n] of results) {
    const pass = n === 0;
    ok = ok && pass;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name} = ${n}`);
}
process.exit(ok ? 0 : 1);
