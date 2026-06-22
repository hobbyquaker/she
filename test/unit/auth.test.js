'use strict';

const express = require('express');
const http = require('http');
const bcrypt = require('bcryptjs');

const TEST_PASS = 'test-password-42';
// 1 bcrypt round — fast enough for tests, still exercises the real hash check
const TEST_HASH = bcrypt.hashSync(TEST_PASS, 1);

let { init, checkAuth, getMode, router } = require('../../src/web/auth');

function makeReq(headers = {}) {
    return { headers };
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
});
