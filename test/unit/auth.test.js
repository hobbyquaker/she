'use strict';

const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const TEST_PASS = 'test-password-42';
// 1 bcrypt round — fast enough for tests, still exercises the real hash check
const TEST_HASH = bcrypt.hashSync(TEST_PASS, 1);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let { init, checkAuth, getMode, router } = require('../../src/web/auth');

function makeReq(headers = {}) {
    return { headers };
}

/** Log in and return the cookie header value ("she_session=<hex>"). */
async function login(port, password = TEST_PASS) {
    const res = await httpReq(port, 'POST', '/she/auth/login', { password });
    return res.cookies.find((c) => c.startsWith('she_session=')).split(';')[0];
}

function httpReq(port, method, urlPath, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const payload = body !== undefined ? JSON.stringify(body) : undefined;
        const options = {
            host: '127.0.0.1',
            port,
            path: urlPath,
            method,
            headers: {
                ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
                ...extraHeaders,
            },
        };
        const req = http.request(options, (res) => {
            const cookies = res.headers['set-cookie'] || [];
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data), cookies });
                } catch {
                    resolve({ status: res.statusCode, body: data, cookies });
                }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// ── checkAuth() — no HTTP needed ────────────────────────────────────────────

describe('checkAuth() — none mode', () => {
    beforeEach(() => init({ auth: 'none' }));

    it('always returns true regardless of headers', () => {
        expect(checkAuth(makeReq({}))).toBe(true);
        expect(checkAuth(makeReq({ cookie: 'she_session=' + 'x'.repeat(64) }))).toBe(true);
    });
});

describe('checkAuth() — proxy mode', () => {
    beforeEach(() => init({ auth: 'proxy', proxyHeader: 'X-Remote-User' }));

    it('returns true when the proxy header is present', () => {
        expect(checkAuth(makeReq({ 'x-remote-user': 'alice' }))).toBe(true);
    });

    it('returns false when the proxy header is absent', () => {
        expect(checkAuth(makeReq({}))).toBe(false);
    });

    it('is case-insensitive for the header name (req.headers are lowercased)', () => {
        // Node's http module lowercases incoming header names; init() also lowercases
        expect(checkAuth(makeReq({ 'x-remote-user': 'bob' }))).toBe(true);
    });
});

describe('checkAuth() — password mode (session checks)', () => {
    beforeEach(() => init({ auth: 'password', password: TEST_HASH }));

    it('returns false when no cookie is present', () => {
        expect(checkAuth(makeReq({}))).toBe(false);
    });

    it('returns false when cookie token has wrong format', () => {
        expect(checkAuth(makeReq({ cookie: 'she_session=notatoken' }))).toBe(false);
    });

    it('returns false when cookie contains an unknown 64-hex token', () => {
        expect(checkAuth(makeReq({ cookie: 'she_session=' + 'a'.repeat(64) }))).toBe(false);
    });
});

describe('getMode()', () => {
    it('reflects the mode set by init()', () => {
        init({ auth: 'proxy' });
        expect(getMode()).toBe('proxy');
        init({ auth: 'none' });
        expect(getMode()).toBe('none');
    });
});

// ── Endpoint tests via a minimal Express server ──────────────────────────────

describe('auth HTTP endpoints', () => {
    let srv, port;

    beforeAll((done) => {
        init({ auth: 'password', password: TEST_HASH });
        const app = express();
        app.use(express.json());
        app.use('/she/auth', router);
        srv = http.createServer(app);
        srv.listen(0, '127.0.0.1', () => {
            port = srv.address().port;
            done();
        });
    });

    afterAll(() => new Promise((resolve) => srv.close(resolve)));

    beforeEach(() => init({ auth: 'password', password: TEST_HASH }));

    it('GET /she/auth/mode returns the current mode', async () => {
        const res = await httpReq(port, 'GET', '/she/auth/mode');
        expect(res.status).toBe(200);
        expect(res.body.mode).toBe('password');
    });

    it('GET /she/auth/mode is public (no auth required)', async () => {
        init({ auth: 'password', password: TEST_HASH });
        const res = await httpReq(port, 'GET', '/she/auth/mode');
        expect(res.status).toBe(200);
    });

    it('POST /she/auth/login with correct password returns 200 and sets cookie', async () => {
        const res = await httpReq(port, 'POST', '/she/auth/login', { password: TEST_PASS });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.cookies.some((c) => c.startsWith('she_session='))).toBe(true);
    });

    it('POST /she/auth/login with wrong password returns 401', async () => {
        const res = await httpReq(port, 'POST', '/she/auth/login', { password: 'wrong' });
        expect(res.status).toBe(401);
    });

    it('POST /she/auth/login sets an HttpOnly cookie', async () => {
        const res = await httpReq(port, 'POST', '/she/auth/login', { password: TEST_PASS });
        expect(res.cookies.some((c) => c.includes('HttpOnly'))).toBe(true);
    });

    it('valid session cookie grants checkAuth() true', async () => {
        const loginRes = await httpReq(port, 'POST', '/she/auth/login', { password: TEST_PASS });
        const cookieHeader = loginRes.cookies.find((c) => c.startsWith('she_session='));
        const token = cookieHeader.split(';')[0]; // "she_session=<hex>"
        expect(checkAuth(makeReq({ cookie: token }))).toBe(true);
    });

    it('POST /she/auth/logout clears the session cookie', async () => {
        const loginRes = await httpReq(port, 'POST', '/she/auth/login', { password: TEST_PASS });
        const cookieHeader = loginRes.cookies.find((c) => c.startsWith('she_session='));
        const token = cookieHeader.split(';')[0];

        await httpReq(port, 'POST', '/she/auth/logout', {}, { cookie: token });
        // After logout the token should no longer be valid
        expect(checkAuth(makeReq({ cookie: token }))).toBe(false);
    });

    it('POST /she/auth/login returns 400 when not in password mode', async () => {
        init({ auth: 'none' });
        const res = await httpReq(port, 'POST', '/she/auth/login', { password: TEST_PASS });
        expect(res.status).toBe(400);
    });

    describe('session lifetime', () => {
        afterEach(() => jest.restoreAllMocks());

        it('accepts a session up to SESSION_TTL_MS after login and rejects it afterwards', async () => {
            const cookie = await login(port);
            const t0 = Date.now();
            const now = jest.spyOn(Date, 'now');

            now.mockReturnValue(t0 + SESSION_TTL_MS - 60_000);
            expect(checkAuth(makeReq({ cookie }))).toBe(true);

            now.mockReturnValue(t0 + SESSION_TTL_MS + 60_000);
            expect(checkAuth(makeReq({ cookie }))).toBe(false);
        });

        it('forgets an expired session for good', async () => {
            const cookie = await login(port);
            const t0 = Date.now();
            const now = jest.spyOn(Date, 'now').mockReturnValue(t0 + SESSION_TTL_MS + 60_000);
            expect(checkAuth(makeReq({ cookie }))).toBe(false);

            // the clock going back must not revive it
            now.mockReturnValue(t0);
            expect(checkAuth(makeReq({ cookie }))).toBe(false);
        });
    });

    describe('POST /she/auth/setup', () => {
        let dir, configPath;
        const readCfg = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));

        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-auth-'));
            configPath = path.join(dir, 'config', 'config.json');
        });

        afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

        it('switches from none to password mode and stores a bcrypt hash, not the password', async () => {
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, JSON.stringify({ port: 8080, name: 'kept' }));
            init({ auth: 'none', configPath });

            const res = await httpReq(port, 'POST', '/she/auth/setup', { mode: 'password', password: 'new-secret' });
            expect(res.status).toBe(200);

            const cfg = readCfg();
            expect(cfg.auth).toBe('password');
            expect(cfg.password).not.toBe('new-secret');
            expect(bcrypt.compareSync('new-secret', cfg.password)).toBe(true);
            // unrelated settings survive
            expect(cfg).toMatchObject({ port: 8080, name: 'kept' });

            // applied without a restart
            expect(getMode()).toBe('password');
            expect((await httpReq(port, 'POST', '/she/auth/login', { password: TEST_PASS })).status).toBe(401);
            expect((await httpReq(port, 'POST', '/she/auth/login', { password: 'new-secret' })).status).toBe(200);
        });

        it('creates the config file when there is none yet', async () => {
            init({ auth: 'none', configPath });
            const res = await httpReq(port, 'POST', '/she/auth/setup', { mode: 'proxy' });
            expect(res.status).toBe(200);
            expect(readCfg()).toEqual({ auth: 'proxy', proxyHeader: 'X-Remote-User' });
        });

        it('requires a session in password mode', async () => {
            init({ auth: 'password', password: TEST_HASH, configPath });
            const res = await httpReq(port, 'POST', '/she/auth/setup', { mode: 'none' });
            expect(res.status).toBe(401);
            expect(getMode()).toBe('password');
            expect(fs.existsSync(configPath)).toBe(false);
        });

        it('changes the password for a logged-in caller', async () => {
            init({ auth: 'password', password: TEST_HASH, configPath });
            const cookie = await login(port);

            const res = await httpReq(port, 'POST', '/she/auth/setup', { mode: 'password', password: 'changed' }, { cookie });
            expect(res.status).toBe(200);
            expect(bcrypt.compareSync('changed', readCfg().password)).toBe(true);
            expect((await httpReq(port, 'POST', '/she/auth/login', { password: TEST_PASS })).status).toBe(401);
            expect((await httpReq(port, 'POST', '/she/auth/login', { password: 'changed' })).status).toBe(200);
        });

        it('switches to proxy mode, stores the header and drops the password hash', async () => {
            init({ auth: 'password', password: TEST_HASH, configPath });
            const cookie = await login(port);

            const res = await httpReq(port, 'POST', '/she/auth/setup', { mode: 'proxy', proxyHeader: 'X-Auth-User', proxyLogoutUrl: 'https://sso.example/logout' }, { cookie });
            expect(res.status).toBe(200);
            expect(readCfg()).toEqual({ auth: 'proxy', proxyHeader: 'X-Auth-User', proxyLogoutUrl: 'https://sso.example/logout' });

            expect(checkAuth(makeReq({ 'x-auth-user': 'alice' }))).toBe(true);
            expect(checkAuth(makeReq({ 'x-remote-user': 'alice' }))).toBe(false);
            const mode = await httpReq(port, 'GET', '/she/auth/mode');
            expect(mode.body).toEqual({ mode: 'proxy', proxyLogoutUrl: 'https://sso.example/logout' });
        });

        it('invalidates every session when leaving password mode', async () => {
            init({ auth: 'password', password: TEST_HASH, configPath });
            const cookie = await login(port);
            expect(checkAuth(makeReq({ cookie }))).toBe(true);

            expect((await httpReq(port, 'POST', '/she/auth/setup', { mode: 'none' }, { cookie })).status).toBe(200);
            expect(readCfg().password).toBeUndefined();

            // back in password mode the old cookie must not work any more
            expect((await httpReq(port, 'POST', '/she/auth/setup', { mode: 'password', password: TEST_PASS })).status).toBe(200);
            expect(checkAuth(makeReq({ cookie }))).toBe(false);
        });

        it('rejects an unknown mode and a password mode without a password', async () => {
            init({ auth: 'none', configPath });
            expect((await httpReq(port, 'POST', '/she/auth/setup', { mode: 'ldap' })).status).toBe(400);
            expect((await httpReq(port, 'POST', '/she/auth/setup', { mode: 'password' })).status).toBe(400);
            expect((await httpReq(port, 'POST', '/she/auth/setup', { mode: 'password', password: '' })).status).toBe(400);
            expect(getMode()).toBe('none');
            expect(fs.existsSync(configPath)).toBe(false);
        });
    });

    describe('session persistence', () => {
        let dir, sessionFile;
        const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
        const tokenOf = (cookie) => cookie.split('=')[1];
        const stored = () => JSON.parse(fs.readFileSync(sessionFile, 'utf8')).sessions;
        const start = (opts = {}) => init({ auth: 'password', password: TEST_HASH, sessionFile, ...opts });
        /** What a restarted daemon sees: a module with no state of its own, reading the same file. */
        function restarted(opts = {}) {
            let fresh;
            jest.isolateModules(() => {
                fresh = require('../../src/web/auth');
            });
            fresh.init({ auth: 'password', password: TEST_HASH, sessionFile, ...opts });
            return fresh;
        }

        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-sessions-'));
            sessionFile = path.join(dir, 'config', 'sessions.json');
        });

        afterEach(() => {
            jest.restoreAllMocks();
            init({ auth: 'none' });
            fs.rmSync(dir, { recursive: true, force: true });
        });

        it('a session survives a restart', async () => {
            start();
            const cookie = await login(port);

            expect(restarted().checkAuth(makeReq({ cookie }))).toBe(true);
            // and re-initialising the same module reads it back as well
            start();
            expect(checkAuth(makeReq({ cookie }))).toBe(true);
        });

        it('without a session file the sessions die with the process', async () => {
            init({ auth: 'password', password: TEST_HASH });
            const cookie = await login(port);
            expect(checkAuth(makeReq({ cookie }))).toBe(true);
            expect(fs.existsSync(sessionFile)).toBe(false);
            expect(restarted().checkAuth(makeReq({ cookie }))).toBe(false);
        });

        it('the file holds the hash of the token, never the token', async () => {
            start();
            const cookie = await login(port);
            const token = tokenOf(cookie);

            const raw = fs.readFileSync(sessionFile, 'utf8');
            expect(raw).not.toContain(token);
            expect(Object.keys(stored())).toEqual([sha256(token)]);
            expect(typeof stored()[sha256(token)]).toBe('number');
            // a stolen file is no cookie: the stored hash does not log in
            expect(checkAuth(makeReq({ cookie: 'she_session=' + sha256(token) }))).toBe(false);
        });

        it('the file is private to the daemon user and leaves no temporary file behind', async () => {
            start();
            await login(port);
            await login(port);
            if (process.platform !== 'win32') expect(fs.statSync(sessionFile).mode & 0o777).toBe(0o600);
            expect(fs.readdirSync(path.dirname(sessionFile))).toEqual(['sessions.json']);
        });

        it('expired sessions are pruned when the file is loaded', () => {
            const live = 'a'.repeat(64);
            const dead = 'b'.repeat(64);
            const now = Date.now();
            fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
            fs.writeFileSync(sessionFile, JSON.stringify({ version: 1, sessions: { [sha256(live)]: now - 1000, [sha256(dead)]: now - SESSION_TTL_MS - 1000 } }));

            start();
            expect(checkAuth(makeReq({ cookie: 'she_session=' + live }))).toBe(true);
            expect(checkAuth(makeReq({ cookie: 'she_session=' + dead }))).toBe(false);
            expect(Object.keys(stored())).toEqual([sha256(live)]);
        });

        it('expired sessions are pruned when the file is written', async () => {
            start();
            const old = await login(port);
            const t0 = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(t0 + SESSION_TTL_MS + 60_000);

            const recent = await login(port);
            expect(Object.keys(stored())).toEqual([sha256(tokenOf(recent))]);
            expect(checkAuth(makeReq({ cookie: old }))).toBe(false);
        });

        it('a session that expires while the daemon runs leaves the file too', async () => {
            start();
            const cookie = await login(port);
            jest.spyOn(Date, 'now').mockReturnValue(Date.now() + SESSION_TTL_MS + 60_000);
            expect(checkAuth(makeReq({ cookie }))).toBe(false);
            expect(stored()).toEqual({});
        });

        it('a logout is persisted: the cookie stays dead after a restart', async () => {
            start();
            const gone = await login(port);
            const kept = await login(port);

            await httpReq(port, 'POST', '/she/auth/logout', {}, { cookie: gone });
            expect(Object.keys(stored())).toEqual([sha256(tokenOf(kept))]);

            const fresh = restarted();
            expect(fresh.checkAuth(makeReq({ cookie: gone }))).toBe(false);
            expect(fresh.checkAuth(makeReq({ cookie: kept }))).toBe(true);
        });

        it('leaving password mode removes the stored sessions', async () => {
            const configPath = path.join(dir, 'config', 'config.json');
            start({ configPath });
            const cookie = await login(port);
            expect(fs.existsSync(sessionFile)).toBe(true);

            expect((await httpReq(port, 'POST', '/she/auth/setup', { mode: 'none' }, { cookie })).status).toBe(200);
            expect(fs.existsSync(sessionFile)).toBe(false);
            expect(restarted().checkAuth(makeReq({ cookie }))).toBe(false);
        });

        it('a start outside password mode discards sessions left in the file', async () => {
            start();
            const cookie = await login(port);

            // the mode was changed in config.json by hand, and back again later
            restarted({ auth: 'none', password: null });
            expect(fs.existsSync(sessionFile)).toBe(false);
            expect(restarted().checkAuth(makeReq({ cookie }))).toBe(false);
        });

        it.each([
            ['garbage', 'not json {{{'],
            ['an empty file', ''],
            ['a JSON null', 'null'],
            ['an array', '[]'],
            ['another version', JSON.stringify({ version: 99, sessions: { ['c'.repeat(64)]: Date.now() } })],
            ['sessions as a list', JSON.stringify({ version: 1, sessions: ['c'.repeat(64)] })],
        ])('tolerates %s in the session file', async (_name, content) => {
            fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
            fs.writeFileSync(sessionFile, content);

            expect(() => start()).not.toThrow();
            expect(checkAuth(makeReq({ cookie: 'she_session=' + 'c'.repeat(64) }))).toBe(false);

            // and the next login replaces it with a good file
            const cookie = await login(port);
            expect(Object.keys(stored())).toEqual([sha256(tokenOf(cookie))]);
            expect(restarted().checkAuth(makeReq({ cookie }))).toBe(true);
        });

        it('skips malformed entries and keeps the good ones', () => {
            const good = 'd'.repeat(64);
            const now = Date.now();
            fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
            fs.writeFileSync(
                sessionFile,
                JSON.stringify({ version: 1, sessions: { [sha256(good)]: now, 'not-a-hash': now, ['e'.repeat(64)]: 'yesterday', ['f'.repeat(64)]: null } }),
            );

            start();
            expect(checkAuth(makeReq({ cookie: 'she_session=' + good }))).toBe(true);
            expect(Object.keys(stored())).toEqual([sha256(good)]);
        });

        it('a session file that cannot be written does not break the login', async () => {
            // the "directory" of the session file is a regular file
            fs.writeFileSync(path.join(dir, 'config'), 'in the way');

            expect(() => start()).not.toThrow();
            const res = await httpReq(port, 'POST', '/she/auth/login', { password: TEST_PASS });
            expect(res.status).toBe(200);
            const cookie = res.cookies.find((c) => c.startsWith('she_session=')).split(';')[0];
            expect(checkAuth(makeReq({ cookie }))).toBe(true);
            expect((await httpReq(port, 'POST', '/she/auth/logout', {}, { cookie })).status).toBe(200);
            expect(checkAuth(makeReq({ cookie }))).toBe(false);
        });
    });
});
