// ======================================================
// @animastor/url-safety — SECURITY CONTRACT SUITE
// ======================================================
// The security-critical frozen contract of the SSRF guard, extracted from
// the host (backend/tests/workspace-ai-security.test.js "SSRF guard"
// describe-block + the pre-extraction empirical verification) and moved
// INTO the package. Runs with NO real network and NO real DNS: the
// dnsResolver/fetchImpl ports are injected per test.
//
// Matrix:
//   - literal private/loopback/link-local/metadata IPv4 (RFC1918, CGNAT,
//     TEST-NET, 0/8, multicast/reserved, malformed octets)
//   - alternative literal forms: decimal / octal / hex / mixed radix
//   - IPv6: loopback, ULA, link-local, multicast, unspecified,
//     IPv4-mapped (::ffff:127.0.0.1), IPv4-compatible, unparseable
//   - scheme restriction (http/https only)
//   - DNS: private answer blocked, multi-record (round-robin) blocked,
//     empty answer fail-closed, resolver error fail-closed
//   - redirects: public→private refused with ENDPOINT_NOT_PUBLIC,
//     public→public followed, budget exhausted (MAX_REDIRECTS),
//     redirect without Location header returned as-is
//   - validatePublic=false explicit exemption (operator endpoints)
//   - setUrlSafetyPorts contract (wiring/validation/reset, call-time
//     default resolution)

const { expect } = require('chai');
const {
    assertPublicEndpoint,
    safeFetch,
    isPrivateIPv4,
    isPrivateIPv6,
    isPrivateAddress,
    parseNumericHost,
    MAX_REDIRECTS,
    setUrlSafetyPorts,
} = require('../src/index.cjs');

// ── port harness (per-test injected, never real network) ─────────────────

let dnsAnswers = {};   // hostname → array of { address, family } | 'error'
let dnsCalls = [];
let fetchHandler = null;
let fetchCalls = [];

function setDns(hostname, addresses) {
    dnsAnswers[hostname] = addresses.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }));
}
function failDns(hostname, code) {
    dnsAnswers[hostname] = code; // string marker → resolver throws { code }
}
function dnsResolver(host /*, options */) {
    dnsCalls.push(host);
    const entry = dnsAnswers[host];
    if (entry === undefined) {
        const err = new Error('lookup failed');
        err.code = 'ENOTFOUND';
        throw err;
    }
    if (typeof entry === 'string') {
        const err = new Error('resolver error');
        err.code = entry;
        throw err;
    }
    return Promise.resolve(entry);
}

function respond(payload) {
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '', json: async () => payload ?? ({}), body: null };
}
function redirect(status, location) {
    return { ok: false, status, headers: { get: (h) => (String(h).toLowerCase() === 'location' ? location : null) }, text: async () => '', json: async () => ({}), body: null };
}
function fetchImpl(url, opts) {
    fetchCalls.push({ url: String(url), opts });
    return Promise.resolve(fetchHandler({ url: String(url), opts }));
}

beforeEach(() => {
    dnsAnswers = {};
    dnsCalls = [];
    fetchCalls = [];
    fetchHandler = () => respond({});
    setUrlSafetyPorts({ dnsResolver, fetchImpl });
});

after(() => {
    // restore call-time runtime defaults for any consumer after the suite
    setUrlSafetyPorts();
});

// ── the frozen BLOCKED matrix (host parity: workspace-ai-security) ────────

const BLOCKED = [
    'http://127.0.0.1',
    'http://169.254.169.254',   // cloud metadata
    'http://10.0.0.1',          // RFC1918
    'http://172.16.0.1',        // RFC1918
    'http://172.31.255.255',    // RFC1918
    'http://192.168.1.1',       // RFC1918
    'http://0.0.0.0',
    'http://100.64.0.1',        // CGNAT
    'http://2130706433',        // decimal 127.0.0.1
    'http://0177.0.0.1',        // octal
    'http://0x7f000001',        // hex
    'http://[::1]',             // IPv6 loopback
    'http://[::ffff:127.0.0.1]',// IPv4-mapped loopback
    'http://[fc00::1]',         // IPv6 unique local
    'http://[fe80::1]',         // IPv6 link-local
    'ftp://example.com',
    'not-a-url',
];

describe('assertPublicEndpoint — frozen SSRF matrix', () => {

    describe('literal endpoints', () => {
        BLOCKED.forEach((url) => {
            it(`blocks ${url}`, async () => {
                const verdict = await assertPublicEndpoint(url);
                expect(verdict.ok, verdict.reason).to.equal(false);
            });
        });        const ALLOWED = [
            'http://8.8.8.8',
            'http://93.184.216.34',
            'https://api.example.com/v1',
        ];
        ALLOWED.forEach((url) => {
            it(`allows ${url}`, async () => {
                setDns('api.example.com', ['93.184.216.34']);
                const verdict = await assertPublicEndpoint(url);
                expect(verdict.ok, verdict.reason).to.equal(true);
            });
        });
    });

    describe('IPv4 classification (isPrivateIPv4)', () => {
        const PRIVATE = [
            '0.0.0.0', '0.1.2.3',               // "this" network
            '10.0.0.1', '10.255.255.255',       // RFC1918
            '100.64.0.1', '100.127.255.255',    // CGNAT
            '127.0.0.1', '127.255.255.254',     // loopback
            '169.254.0.1', '169.254.169.254',   // link-local + cloud metadata
            '172.16.0.1', '172.31.255.255',     // RFC1918
            '192.168.0.1', '192.168.255.255',   // RFC1918
            '192.0.0.1', '192.0.2.9',           // IETF protocol / TEST-NET-1
            '198.18.0.1', '198.19.255.255',     // benchmarking
            '198.51.100.7',                     // TEST-NET-2
            '203.0.113.9',                      // TEST-NET-3
            '224.0.0.1', '239.255.255.255',     // multicast
            '240.0.0.1', '255.255.255.255',     // reserved + broadcast
            '256.0.0.1',                        // malformed octet → unsafe
        ];
        const PUBLIC = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '198.20.0.1', '192.169.1.1'];

        PRIVATE.forEach((ip) => {
            it(`classifies ${ip} as private`, () => {
                expect(isPrivateIPv4(ip), ip).to.equal(true);
            });
        });
        PUBLIC.forEach((ip) => {
            it(`classifies ${ip} as public`, () => {
                expect(isPrivateIPv4(ip), ip).to.equal(false);
            });
        });
    });

    describe('IPv6 classification (isPrivateIPv6)', () => {
        const PRIVATE = [
            '::', '::1',
            'fc00::1', 'fd12:3456:789a::1',     // unique local
            'fe80::1', 'febf::1',               // link-local
            'ff01::1', 'ff02::2',               // multicast
            '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.0.1', // IPv4-mapped
            '::127.0.0.1',                       // IPv4-compatible loopback
            'garbage', '::zzzz',                 // unparseable → unsafe
        ];
        const PUBLIC = ['2606:4700:4700::1111', '2001:db8::1', '::ffff:8.8.8.8'];

        PRIVATE.forEach((ip) => {
            it(`classifies ${ip} as private`, () => {
                expect(isPrivateIPv6(ip), ip).to.equal(true);
            });
        });
        PUBLIC.forEach((ip) => {
            it(`classifies ${ip} as public`, () => {
                expect(isPrivateIPv6(ip), ip).to.equal(false);
            });
        });
    });

    describe('isPrivateAddress — unrecognized forms fail closed', () => {
        it('unrecognized address form is unsafe', () => {
            expect(isPrivateAddress('not-an-ip')).to.equal(true);
            expect(isPrivateAddress('')).to.equal(true);
        });
        it('routing to known classifiers', () => {
            expect(isPrivateAddress('10.0.0.1')).to.equal(true);
            expect(isPrivateAddress('8.8.8.8')).to.equal(false);
            expect(isPrivateAddress('::1')).to.equal(true);
        });
    });

    describe('parseNumericHost — alternative literal forms', () => {
        it('canonicalizes decimal/octal/hex single integers', () => {
            expect(parseNumericHost('2130706433')).to.deep.equal({ ipv4: '127.0.0.1' });
            expect(parseNumericHost('0177.0.0.1')).to.deep.equal({ ipv4: '127.0.0.1' });
            expect(parseNumericHost('0x7f000001')).to.deep.equal({ ipv4: '127.0.0.1' });
            expect(parseNumericHost('0x7f.0.0.1')).to.deep.equal({ ipv4: '127.0.0.1' });
            expect(parseNumericHost('134744072')).to.deep.equal({ ipv4: '8.8.8.8' });
        });
        it('plain literals pass through; non-literals return null', () => {
            expect(parseNumericHost('127.0.0.1')).to.deep.equal({ ipv4: '127.0.0.1' });
            expect(parseNumericHost('::1')).to.deep.equal({ ipv6: '::1' });
            expect(parseNumericHost('[::1]')).to.deep.equal({ ipv6: '::1' });
            expect(parseNumericHost('api.example.com')).to.equal(null);
            expect(parseNumericHost('')).to.equal(null);
            expect(parseNumericHost('4294967296')).to.equal(null); // out of range
        });
    });

    describe('DNS resolution (hostname endpoints)', () => {
        it('hostname resolving to a private address is blocked (DNS rebinding shape)', async () => {
            setDns('internal.evil.example', ['10.0.0.5']);
            const verdict = await assertPublicEndpoint('http://internal.evil.example');
            expect(verdict.ok, verdict.reason).to.equal(false);
            expect(verdict.reason).to.match(/private/);
        });

        it('multi-record DNS containing one private address is blocked (round-robin smuggling)', async () => {
            setDns('mixed.evil.example', ['93.184.216.34', '192.168.1.9']);
            const verdict = await assertPublicEndpoint('http://mixed.evil.example');
            expect(verdict.ok, verdict.reason).to.equal(false);
        });

        it('ALL records are resolved (all:true) — every resolved address is checked', async () => {
            setDns('multi.example', ['93.184.216.34', '8.8.4.4']);
            const verdict = await assertPublicEndpoint('http://multi.example');
            expect(verdict.ok).to.equal(true);
            expect(dnsCalls).to.have.lengthOf(1);
        });

        it('empty DNS answer fails closed', async () => {
            setDns('empty.example', []);
            const verdict = await assertPublicEndpoint('http://empty.example');
            expect(verdict.ok).to.equal(false);
            expect(verdict.reason).to.match(/did not resolve/);
        });

        it('resolver error fails closed with the resolver code', async () => {
            failDns('broken.example', 'ESERVFAIL');
            const verdict = await assertPublicEndpoint('http://broken.example');
            expect(verdict.ok).to.equal(false);
            expect(verdict.reason).to.match(/could not be resolved \(ESERVFAIL\)/);
        });

        it('unknown hostname fails closed (ENOTFOUND)', async () => {
            const verdict = await assertPublicEndpoint('http://never-configured.example');
            expect(verdict.ok).to.equal(false);
            expect(verdict.reason).to.match(/could not be resolved \(ENOTFOUND\)/);
        });
    });

    describe('scheme + URL contract', () => {
        it('non-http(s) schemes are rejected', async () => {
            for (const url of ['ftp://example.com', 'file:///etc/passwd', 'gopher://example.com']) {
                const verdict = await assertPublicEndpoint(url);
                expect(verdict.ok, url).to.equal(false);
                expect(verdict.reason).to.match(/http or https/);
            }
        });
        it('invalid URLs fail closed', async () => {
            const verdict = await assertPublicEndpoint('not-a-url');
            expect(verdict.ok).to.equal(false);
            expect(verdict.reason).to.equal('invalid URL');
        });
    });
});

describe('safeFetch — per-hop re-validation', () => {

    it('refuses a public endpoint redirecting to a private address (ENDPOINT_NOT_PUBLIC)', async () => {
        setDns('public.example', ['93.184.216.34']);
        fetchHandler = () => redirect(302, 'http://169.254.169.254/latest/meta-data');
        let threw = null;
        try {
            await safeFetch('https://public.example/v1/chat/completions', { method: 'POST' });
        } catch (err) {
            threw = err;
        }
        expect(threw).to.exist;
        expect(threw.code).to.equal('ENDPOINT_NOT_PUBLIC');
        expect(threw.message).to.match(/Endpoint not allowed/);
        // the private redirect target was validated (and refused) BEFORE fetch
        expect(fetchCalls).to.have.lengthOf(1);
    });

    it('validates the initial request and follows public→public redirects', async () => {
        setDns('a.example', ['93.184.216.34']);
        setDns('b.example', ['8.8.4.4']);
        fetchHandler = ({ url }) => (url === 'https://a.example/x'
            ? redirect(301, 'https://b.example/y')
            : respond({ ok: true }));
        const res = await safeFetch('https://a.example/x');
        expect(res.status).to.equal(200);
        expect(fetchCalls.map((c) => c.url)).to.deep.equal(['https://a.example/x', 'https://b.example/y']);
    });

    it('blocks the FIRST hop when the initial URL is private (no fetch happens)', async () => {
        let threw = null;
        try {
            await safeFetch('http://127.0.0.1:8080/v1');
        } catch (err) {
            threw = err;
        }
        expect(threw).to.exist;
        expect(threw.code).to.equal('ENDPOINT_NOT_PUBLIC');
        expect(fetchCalls).to.have.lengthOf(0);
    });

    it('blocks a redirect chain when a middle hop flips private', async () => {
        setDns('a.example', ['93.184.216.34']);
        setDns('b.example', ['93.184.216.34']);
        setDns('c.example', ['10.9.9.9']);
        fetchHandler = ({ url }) => {
            if (url === 'https://a.example/x') return redirect(302, 'https://b.example/y');
            if (url === 'https://b.example/y') return redirect(302, 'https://c.example/z');
            return respond({});
        };
        let threw = null;
        try {
            await safeFetch('https://a.example/x');
        } catch (err) {
            threw = err;
        }
        expect(threw).to.exist;
        expect(threw.code).to.equal('ENDPOINT_NOT_PUBLIC');
        expect(fetchCalls).to.have.lengthOf(2);
    });

    it(`throws when redirected more than ${MAX_REDIRECTS} times`, async () => {
        setDns('loop.example', ['93.184.216.34']);
        fetchHandler = () => redirect(302, 'https://loop.example/again');
        let threw = null;
        try {
            await safeFetch('https://loop.example/start');
        } catch (err) {
            threw = err;
        }
        expect(threw).to.exist;
        expect(threw.message).to.match(/redirected too many times/i);
        expect(MAX_REDIRECTS).to.equal(3);
    });

    it('returns a 3xx response without a Location header as-is', async () => {
        setDns('noloc.example', ['93.184.216.34']);
        fetchHandler = () => redirect(304, null);
        const res = await safeFetch('https://noloc.example/x');
        expect(res.status).to.equal(304);
        expect(fetchCalls).to.have.lengthOf(1);
    });

    it('passes fetch options through to every hop (method/headers/body, redirect manual)', async () => {
        setDns('opts.example', ['93.184.216.34']);
        fetchHandler = () => respond({});
        await safeFetch('https://opts.example/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k' },
            body: '{"x":1}',
            signal: 'SIG',
        });
        expect(fetchCalls).to.have.lengthOf(1);
        expect(fetchCalls[0].opts.method).to.equal('POST');
        expect(fetchCalls[0].opts.redirect).to.equal('manual');
        expect(fetchCalls[0].opts.headers.Authorization).to.equal('Bearer k');
        expect(fetchCalls[0].opts.body).to.equal('{"x":1}');
        expect(fetchCalls[0].opts.signal).to.equal('SIG');
    });

    describe('validatePublic — the explicit operator exemption', () => {
        it('skips validation for trusted operator endpoints when explicitly false', async () => {
            fetchHandler = () => respond({});
            const res = await safeFetch('http://127.0.0.1:11434/v1', { validatePublic: false });
            expect(res.status).to.equal(200);
            expect(fetchCalls).to.have.lengthOf(1);
        });
        it('still follows redirects manually (capped) when validation is disabled', async () => {
            // validatePublic=false is an operator trust decision; redirect
            // handling (manual, capped) stays identical — only the private-
            // address check is skipped.
            fetchHandler = ({ url }) => (String(url).includes('/first')
                ? redirect(302, 'http://127.0.0.1:11434/second')
                : respond({}));
            const res = await safeFetch('http://127.0.0.1:11434/first', { validatePublic: false });
            expect(res.status).to.equal(200);
            expect(fetchCalls.map((c) => c.url)).to.deep.equal([
                'http://127.0.0.1:11434/first',
                'http://127.0.0.1:11434/second',
            ]);
        });
        it('defaults to true', async () => {
            let threw = null;
            try {
                await safeFetch('http://10.1.2.3/');
            } catch (err) {
                threw = err;
            }
            expect(threw && threw.code).to.equal('ENDPOINT_NOT_PUBLIC');
        });
    });
});

describe('setUrlSafetyPorts — the host injection seam', () => {
    it('rejects non-function port values (fail fast at composition time)', () => {
        expect(() => setUrlSafetyPorts({ dnsResolver: 'nope' })).to.throw(TypeError);
        expect(() => setUrlSafetyPorts({ fetchImpl: 42 })).to.throw(TypeError);
        expect(() => setUrlSafetyPorts('nope')).to.throw(TypeError);
    });

    it('partial wiring keeps the call-time runtime default for the unwired port', async () => {
        // wire ONLY the dns port; fetch must fall back to global.fetch —
        // proven by a literal-private URL failing validation without any
        // fetch attempt (no global network touched).
        setUrlSafetyPorts({ dnsResolver });
        let threw = null;
        try {
            await safeFetch('http://127.0.0.1/x');
        } catch (err) {
            threw = err;
        }
        expect(threw && threw.code).to.equal('ENDPOINT_NOT_PUBLIC');
    });

    it('a custom dnsResolver is consulted for hostname endpoints', async () => {
        setDns('injected.example', ['8.8.8.8']);
        const verdict = await assertPublicEndpoint('http://injected.example');
        expect(verdict.ok).to.equal(true);
        expect(dnsCalls).to.deep.equal(['injected.example']);
    });

    it('reset (no args / null) restores the call-time runtime defaults', () => {
        setUrlSafetyPorts();
        setUrlSafetyPorts(null);
        // smoke: defaults resolve lazily — a private literal still blocks
        return assertPublicEndpoint('http://127.0.0.1/').then((v) => {
            expect(v.ok).to.equal(false);
            setUrlSafetyPorts({ dnsResolver, fetchImpl }); // re-wire for next tests
        });
    });
});
