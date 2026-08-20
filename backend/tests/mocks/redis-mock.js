// In-memory Redis mock for tests.
// Operations are internally consistent: hset/hget/hgetall use flat `key:field` storage,
// scan filters the store by glob pattern, lrange handles stop=-1.

function globToRegex(pattern) {
    let regexStr = '^';
    for (const ch of pattern) {
        if (ch === '*') regexStr += '.*';
        else if (ch === '?') regexStr += '.';
        else if ('[](){}+.^$|\\'.includes(ch)) regexStr += '\\' + ch;
        else regexStr += ch;
    }
    regexStr += '$';
    return new RegExp(regexStr);
}

function createMockRedis() {
    const store = new Map();
    return {
        hset: async (key, field, value) => {
            if (field && typeof field === 'object' && !Array.isArray(field)) {
                for (const [name, fieldValue] of Object.entries(field)) {
                    store.set(`${key}:${name}`, fieldValue);
                }
                return Object.keys(field).length;
            }
            store.set(`${key}:${field}`, value);
            return 1;
        },
        hget: async (key, field) => store.get(`${key}:${field}`) || null,
        hgetall: async (key) => {
            const result = {};
            const prefix = key + ':';
            for (const [k, v] of store) {
                if (k.startsWith(prefix)) {
                    result[k.slice(prefix.length)] = v;
                }
            }
            return Object.keys(result).length > 0 ? result : null;
        },
        hdel: async (key, ...fields) => {
            let n = 0;
            for (const field of fields) {
                if (store.delete(`${key}:${field}`)) n++;
            }
            return n;
        },
        hlen: async (key) => {
            const prefix = key + ':';
            let n = 0;
            for (const k of store.keys()) if (k.startsWith(prefix)) n++;
            return n;
        },
        hexists: async (key, field) => store.has(`${key}:${field}`) ? 1 : 0,
        get: async (key) => store.get(key) || null,
        set: async (key, value, ...args) => {
            const nx = args.includes('NX');
            if (nx && store.has(key)) return null;
            store.set(key, value);
            return 'OK';
        },
        del: async (...keys) => { let n = 0; for (const k of keys) if (store.delete(k)) n++; return n; },
        expire: async (key, ttl) => store.has(key) ? 1 : 0,
        incr: async (key) => { const v = (parseInt(store.get(key) || '0', 10)) + 1; store.set(key, String(v)); return v; },
        decr: async (key) => { const v = Math.max(0, (parseInt(store.get(key) || '0', 10)) - 1); store.set(key, String(v)); return v; },
        exists: async (key) => store.has(key) ? 1 : 0,
        scan: async (cursor, ...args) => {
            let pattern = null;
            for (let i = 0; i < args.length; i++) {
                if (args[i] === 'MATCH') pattern = args[i + 1];
            }
            if (!pattern) return ['0', []];
            const regex = globToRegex(pattern);
            const matched = [...store.keys()].filter(k => regex.test(k));
            return ['0', matched];
        },
        hscan: async (key, cursor, ...args) => {
            const prefix = key + ':';
            const entries = [];
            for (const [k, v] of store) {
                if (k.startsWith(prefix)) {
                    entries.push(k.slice(prefix.length), v);
                }
            }
            return ['0', entries];
        },
        eval: async (script, keysCount, ...args) => {
            if (script.includes('local metadata') && script.includes("ARGV[5] == '1'")) {
                const [metadataKey, completedKey, leaseKey, quotaKey] = args.slice(0, keysCount);
                const [
                    expectedMetadata,
                    markerValue,
                    markerTtl,
                    expectedLease,
                    quotaOwned,
                ] = args.slice(keysCount);
                const metadata = store.get(metadataKey);
                if (metadata === undefined) return store.has(completedKey) ? 2 : 0;
                if (metadata !== expectedMetadata) return -1;
                const lease = store.get(leaseKey);
                if (lease !== undefined && (!expectedLease || lease !== expectedLease)) return -2;
                if (store.has(completedKey)) return 2;

                store.set(completedKey, markerValue);
                store.delete(metadataKey);
                if (lease !== undefined && expectedLease) store.delete(leaseKey);
                if (quotaOwned === '1') {
                    const current = Number(store.get(quotaKey) || 0);
                    if (current > 0) store.set(quotaKey, String(current - 1));
                }
                void markerTtl;
                return 1;
            }
            if (script.includes("current ~= ARGV[1]") && script.includes("redis.call('DEL', KEYS[1])")) {
                const key = args[0];
                const expected = args[keysCount];
                const current = store.get(key);
                if (current === undefined) return 0;
                if (current !== expected) return -1;
                store.delete(key);
                return 1;
            }
            if (script.includes("return redis.call('INCR', key)")) {
                const key = args[0];
                const max = Number(args[keysCount]);
                const current = Number(store.get(key) || 0);
                if (current >= max) return 0;
                const next = current + 1;
                store.set(key, String(next));
                return next;
            }
            // Return array mimicking Lua return: {true, 'corrected', old, new}
            // Callers (e.g. correctCounterWithLua) destructure result[0]..result[3]
            const key = args[0];
            const target = args[keysCount] || args[1];
            let current = store.get(key);
            if (current === undefined) current = null;
            store.set(key, target);
            return ['true', 'corrected', current, target];
        },
        rpush: async (key, ...values) => { const arr = store.get(key) || []; arr.push(...values); store.set(key, arr); return arr.length; },
        lpush: async (key, ...values) => { const arr = store.get(key) || []; arr.unshift(...values); store.set(key, arr); return arr.length; },
        rpoplpush: async (source, destination) => {
            const arr = store.get(source);
            if (!arr || arr.length === 0) return null;
            const value = arr.pop();
            if (arr.length === 0) store.delete(source);
            const dest = store.get(destination) || [];
            dest.unshift(value);
            store.set(destination, dest);
            return value;
        },
        llen: async (key) => { const arr = store.get(key); return arr ? arr.length : 0; },
        lrange: async (key, start, stop) => {
            const arr = store.get(key) || [];
            if (stop === -1 || stop === undefined) return arr.slice(start);
            return arr.slice(start, stop + 1);
        },
        lrem: async (key, count, value) => {
            const arr = store.get(key) || [];
            const index = arr.indexOf(value);
            if (index === -1) return 0;
            arr.splice(index, 1);
            return 1;
        },
        sadd: async (key, member) => { const s = store.get(key) || new Set(); s.add(member); store.set(key, s); return 1; },
        srem: async (key, member) => { const s = store.get(key); if (s) { s.delete(member); return 1; } return 0; },
        smembers: async (key) => { const s = store.get(key); return s ? [...s] : []; },
        scard: async (key) => { const s = store.get(key); return s ? s.size : 0; },
        zrem: async (key, member) => {
            const s = store.get(key);
            if (s && s instanceof Set) { return s.delete(member) ? 1 : 0; }
            return 0;
        },
        multi: () => ({ exec: async () => [] }),
        quit: async () => 'OK',
        disconnect: () => {},
        duplicate: () => createMockRedis(),
    };
}

module.exports = { createMockRedis };
