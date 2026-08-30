'use strict';

/**
 * IO layer — Private Worker Installer Phase 2.
 *
 * Every side effect the installation engine performs goes through an `io`
 * object. Production uses createRealIo(); tests inject a mock; --dry-run
 * wraps the real io with a mutation guard that throws on any write.
 *
 * The engine itself is pure orchestration: given the same io behavior it is
 * fully deterministic and testable without network, GPU, or real downloads.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Real IO
// ---------------------------------------------------------------------------

function createRealIo() {
    return {
        fs: {
            existsSync: (p) => fs.existsSync(p),
            isDirectory: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
            readFileSync: (p, enc) => fs.readFileSync(p, enc),
            writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
            appendFileSync: (p, data) => fs.appendFileSync(p, data),
            mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
            renameSync: (a, b) => fs.renameSync(a, b),
            unlinkSync: (p) => fs.unlinkSync(p),
            /** Recursive directory/file removal (uninstaller). */
            rmSync: (p, opts = { recursive: true, force: true }) => fs.rmSync(p, opts),
            rmdirSync: (p) => fs.rmdirSync(p),
            copyFileSync: (a, b) => fs.copyFileSync(a, b),
            chmodSync: (p, mode) => fs.chmodSync(p, mode),
            statSync: (p) => {
                const s = fs.statSync(p);
                return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(), uid: s.uid, gid: s.gid };
            },
            readdirSync: (p) => fs.readdirSync(p),
            readlinkSync: (p) => fs.readlinkSync(p),
        },
        /** Synchronous command execution (git, pip, npm, nvidia-smi…). */
        exec(command, args = [], opts = {}) {
            const r = spawnSync(command, args, {
                cwd: opts.cwd,
                env: opts.env || process.env,
                encoding: 'utf8',
                timeout: opts.timeout || 10 * 60 * 1000,
                maxBuffer: 64 * 1024 * 1024,
                input: opts.input,
            });
            return {
                code: r.status === null ? -1 : r.status,
                stdout: r.stdout || '',
                stderr: r.stderr || '',
                error: r.error ? String(r.error.message || r.error) : null,
            };
        },
        /**
         * Asynchronous command execution — same result shape as exec(), but
         * the Node event loop stays free, so the terminal busy spinner keeps
         * animating while a long pip/npm/git step runs. Used for the slow
         * steps (pip install requirements/torch, …).
         *
         * Options: { cwd, env, timeout, onLine }.
         * `onLine(line)` receives COMPLETE output lines as they are produced
         * (both streams), with carriage-return progress-bar redraws filtered
         * out — useful output (Collecting/Installing/Successfully…) can be
         * surfaced through the terminal renderer while the full raw output is
         * still captured for diagnostics and error messages.
         */
        async execAsync(command, args = [], opts = {}) {
            const { cwd, env, timeout = 10 * 60 * 1000, onLine = null } = opts;
            return await new Promise((resolve) => {
                let child;
                try {
                    child = spawn(command, args, { cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
                } catch (err) {
                    resolve({ code: -1, stdout: '', stderr: '', error: String(err.message || err) });
                    return;
                }
                let stdout = '';
                let stderr = '';
                let outBuf = '';
                let errBuf = '';
                let settled = false;
                let timedOut = false;

                const emitLines = (bufferKey, chunk) => {
                    let buf = bufferKey === 'out' ? outBuf : errBuf;
                    buf += chunk;
                    const parts = buf.split('\n');
                    buf = parts.pop(); // last (possibly incomplete) segment stays buffered
                    for (const line of parts) {
                        if (onLine && !line.includes('\r')) onLine(line);
                    }
                    if (bufferKey === 'out') outBuf = buf; else errBuf = buf;
                };

                const timer = setTimeout(() => {
                    timedOut = true;
                    try { child.kill('SIGTERM'); } catch (_) { /* already gone */ }
                }, timeout);

                const finish = (code, error = null) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve({
                        code,
                        stdout,
                        stderr,
                        error: timedOut ? `timed out after ${timeout} ms` : error,
                    });
                };

                child.stdout.setEncoding('utf8');
                child.stdout.on('data', (chunk) => {
                    stdout += chunk;
                    emitLines('out', chunk);
                });
                child.stderr.setEncoding('utf8');
                child.stderr.on('data', (chunk) => {
                    stderr += chunk;
                    emitLines('err', chunk);
                });
                child.on('error', (err) => finish(-1, String(err.message || err)));
                child.on('close', (code) => {
                    // flush trailing lines that were not newline-terminated
                    if (onLine) {
                        if (outBuf !== '' && !outBuf.includes('\r')) onLine(outBuf);
                        if (errBuf !== '' && !errBuf.includes('\r')) onLine(errBuf);
                        outBuf = '';
                        errBuf = '';
                    }
                    finish(code === null ? -1 : code);
                });
            });
        },
        /** Detached long-running process (ComfyUI server). Returns pid. */
        spawnDaemon(command, args = [], opts = {}) {
            const out = opts.logFile
                ? fs.openSync(opts.logFile, 'a')
                : 'ignore';
            const child = spawn(command, args, {
                cwd: opts.cwd,
                env: opts.env || process.env,
                detached: true,
                stdio: ['ignore', out, out],
            });
            child.unref();
            return child.pid;
        },
        /** Signal a process by pid (used to restart the managed ComfyUI). */
        kill(pid, signal = 'SIGTERM') {
            process.kill(pid, signal);
        },
        /** Global fetch (Node 20+). */
        fetch: (url, opts) => fetch(url, opts),
        http: {
            /**
             * Stream-download a URL to dest. If appendFrom>0, request an HTTP
             * Range and append (resumed=true when the server honors it with
             * 206; otherwise the file is restarted from scratch).
             * Returns { status, bytes, total, resumed, error? }.
             */
            async download({ url, dest, appendFrom = 0, headers = {}, onProgress = null }) {
                const h = { ...headers };
                if (appendFrom > 0) h.Range = `bytes=${appendFrom}-`;
                const res = await fetch(url, { headers: h, redirect: 'follow' });
                if (!(res.status === 200 || res.status === 206 || res.status === 416)) {
                    let body = '';
                    try { body = (await res.text()).slice(0, 300); } catch (_) { /* ignore */ }
                    return { status: res.status, bytes: 0, total: null, resumed: false, error: body };
                }
                if (res.status === 416) {
                    return { status: 416, bytes: 0, total: null, resumed: false };
                }
                const resumed = res.status === 206 && appendFrom > 0;
                const totalHeader = res.headers.get('content-range') || res.headers.get('content-length');
                let total = null;
                if (totalHeader) {
                    const m = /\/(\d+)$/.exec(String(totalHeader));
                    total = m ? Number(m[1]) : Number(totalHeader) + (resumed ? appendFrom : 0);
                }
                let received = resumed ? appendFrom : 0;
                await new Promise((resolve, reject) => {
                    const out = fs.createWriteStream(dest, { flags: resumed ? 'a' : 'w' });
                    (async () => {
                        try {
                            const reader = res.body.getReader();
                            for (;;) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                out.write(Buffer.from(value));
                                received += value.byteLength;
                                if (onProgress) onProgress({ received, total });
                            }
                            out.end();
                            out.on('finish', resolve);
                            out.on('error', reject);
                        } catch (err) {
                            out.destroy();
                            reject(err);
                        }
                    })();
                });
                return { status: res.status, bytes: received, total, resumed };
            },
            async fetchJson(url, opts = {}) {
                const res = await fetch(url, opts);
                let json = null;
                try { json = await res.json(); } catch (_) { /* non-json body */ }
                return { status: res.status, json };
            },
            async fetchText(url, opts = {}) {
                const res = await fetch(url, opts);
                return { status: res.status, text: await res.text().catch(() => '') };
            },
        },
        /** Streaming sha256 of a file (never loads whole multi-GB files). */
        async hashFile(filePath, algo = 'sha256') {
            return new Promise((resolve, reject) => {
                const hash = crypto.createHash(algo);
                const stream = fs.createReadStream(filePath);
                stream.on('data', (d) => hash.update(d));
                stream.on('end', () => resolve(hash.digest('hex')));
                stream.on('error', reject);
            });
        },
        now: () => Date.now(),
    };
}

// ---------------------------------------------------------------------------
// In-memory FS (tests, and a safe sandbox for unit-running the engine)
// ---------------------------------------------------------------------------

function createMemoryFs(initial = {}) {
    const files = new Map(); // path -> { data: Buffer|string, mode }
    const dirs = new Set(['/']);
    for (const [p, data] of Object.entries(initial)) {
        files.set(norm(p), { data, mode: 0o644 });
        let d = path.dirname(norm(p));
        // guard: dirname('.') === '.' on POSIX (a Windows-style path with no
        // posix separator) — the loop must always make progress
        while (d && d !== '/' && d !== path.dirname(d)) { dirs.add(d); d = path.dirname(d); }
    }

    function norm(p) {
        // Backslashes are normalized to slashes so the in-memory fs can be
        // used as a cross-platform test double (Windows-style paths in
        // platform-adapter tests behave exactly like POSIX ones).
        return path.posix.normalize(String(p).replace(/\\/g, '/'));
    }
    function assertParent(p) {
        const d = path.dirname(norm(p));
        if (d !== '/' && !dirs.has(d)) throw Object.assign(new Error(`ENOENT: no such directory ${d}`), { code: 'ENOENT' });
    }

    return {
        _files: files,
        _dirs: dirs,
        existsSync: (p) => files.has(norm(p)) || dirs.has(norm(p)),
        isDirectory: (p) => dirs.has(norm(p)),
        readFileSync: (p) => {
            const f = files.get(norm(p));
            if (!f) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
            return typeof f.data === 'string' ? f.data : Buffer.from(f.data).toString('utf8');
        },
        readBufferSync(p) {
            const f = files.get(norm(p));
            if (!f) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
            return Buffer.from(f.data);
        },
        writeFileSync: (p, data) => { assertParent(p); files.set(norm(p), { data, mode: 0o644 }); },
        appendFileSync: (p, data) => {
            assertParent(p);
            const cur = files.has(norm(p)) ? files.get(norm(p)).data : '';
            files.set(norm(p), { data: String(cur) + String(data), mode: 0o644 });
        },
        mkdirSync: (p, opts) => {
            const target = norm(p);
            if (opts && opts.recursive) {
                let d = target;
                const stack = [];
                while (d && d !== '/' && !dirs.has(d)) { stack.push(d); d = path.dirname(d); }
                for (const dd of stack.reverse()) dirs.add(dd);
                return;
            }
            assertParent(p);
            dirs.add(target);
        },
        renameSync: (a, b) => {
            const na = norm(a);
            const nb = norm(b);
            const f = files.get(na);
            if (f) {
                assertParent(b);
                files.set(nb, f);
                files.delete(na);
                return;
            }
            // directory rename (real-fs semantics): move the dir and every
            // entry beneath it
            if (dirs.has(na)) {
                assertParent(b);
                const prefix = `${na}/`;
                for (const key of [...files.keys()]) {
                    if (key.startsWith(prefix)) {
                        files.set(nb + key.slice(na.length), files.get(key));
                        files.delete(key);
                    }
                }
                for (const key of [...dirs]) {
                    if (key === na || key.startsWith(prefix)) {
                        dirs.add(nb + key.slice(na.length));
                        dirs.delete(key);
                    }
                }
                return;
            }
            throw Object.assign(new Error(`ENOENT: ${a}`), { code: 'ENOENT' });
        },
        unlinkSync: (p) => {
            if (!files.has(norm(p))) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
            files.delete(norm(p));
        },
        /** Recursive removal: deletes a dir and everything under it. */
        rmSync: (p, opts = {}) => {
            const target = norm(p);
            const isDir = dirs.has(target);
            const isFile = files.has(target);
            if (!isDir && !isFile) {
                if (opts && opts.force) return;
                throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
            }
            const prefix = target === '/' ? '/' : `${target}/`;
            for (const key of [...files.keys()]) {
                if (key === target || key.startsWith(prefix)) files.delete(key);
            }
            if (isDir) {
                for (const key of [...dirs]) {
                    if (key === target || key.startsWith(prefix)) dirs.delete(key);
                }
            } else if (opts && opts.force) {
                // nothing else to do for a file
            }
        },
        rmdirSync: (p) => {
            const target = norm(p);
            if (!dirs.has(target)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
            const prefix = `${target}/`;
            const hasChildren = [...files.keys(), ...dirs].some((k) => k !== target && k.startsWith(prefix));
            if (hasChildren) throw Object.assign(new Error(`ENOTEMPTY: ${p}`), { code: 'ENOTEMPTY' });
            dirs.delete(target);
        },
        copyFileSync: (a, b) => {
            const f = files.get(norm(a));
            if (!f) throw Object.assign(new Error(`ENOENT: ${a}`), { code: 'ENOENT' });
            assertParent(b);
            files.set(norm(b), { ...f });
        },
        chmodSync: (p, mode) => {
            const f = files.get(norm(p));
            if (f) f.mode = mode;
        },
        statSync: (p) => {
            const f = files.get(norm(p));
            if (f) return { size: Buffer.byteLength(f.data), isFile: true, isDirectory: false };
            if (dirs.has(norm(p))) return { size: 0, isFile: false, isDirectory: true };
            throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        },
        readdirSync: (p) => {
            const target = norm(p);
            if (!dirs.has(target)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
            const out = new Set();
            const prefix = target === '/' ? '/' : `${target}/`;
            for (const key of [...files.keys(), ...dirs]) {
                if (key !== target && key.startsWith(prefix)) {
                    out.add(key.slice(prefix.length).split('/')[0]);
                }
            }
            return Array.from(out).sort();
        },
    };
}

/**
 * Wrap an io so that ANY mutation throws. Used for --dry-run and for the
 * "zero mutations" test invariant. Reads and prompts stay allowed.
 */
function createDryRunIo(io) {
    const guard = (name) => () => {
        throw new Error(`dry-run violation: attempted mutating operation "${name}"`);
    };
    return {
        ...io,
        fs: {
            existsSync: io.fs.existsSync,
            isDirectory: io.fs.isDirectory,
            readFileSync: io.fs.readFileSync,
            statSync: io.fs.statSync,
            readdirSync: io.fs.readdirSync,
            writeFileSync: guard('fs.writeFileSync'),
            appendFileSync: guard('fs.appendFileSync'),
            mkdirSync: guard('fs.mkdirSync'),
            renameSync: guard('fs.renameSync'),
            unlinkSync: guard('fs.unlinkSync'),
            rmSync: guard('fs.rmSync'),
            rmdirSync: guard('fs.rmdirSync'),
            copyFileSync: guard('fs.copyFileSync'),
            chmodSync: guard('fs.chmodSync'),
        },
        exec: guard('exec'),
        spawnDaemon: guard('spawnDaemon'),
        kill: guard('kill'),
        fetch: guard('fetch'),
        http: {
            download: guard('http.download'),
            fetchJson: guard('http.fetchJson'),
            fetchText: guard('http.fetchText'),
        },
        hashFile: io.hashFile, // read-only — allowed in dry-run
        dryRun: true,
    };
}

module.exports = {
    createRealIo,
    createMemoryFs,
    createDryRunIo,
};
