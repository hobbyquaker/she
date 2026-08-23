'use strict';

const http = require('http');
const bcrypt = require('bcryptjs');

// Pre-compute once — 1 round is enough for test speed
const TEST_HASH = bcrypt.hashSync('secret', 1);

function httpGet(port, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                let body = null;
                try {
                    body = JSON.parse(data);
                } catch {
                    /* not JSON — tests that care pass a JSON route */
                }
                resolve({ status: res.statusCode, body });
            });
        });
        req.on('error', reject);
    });
}

function httpPost(port, urlPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(body);
        const options = {
            host: '127.0.0.1',
            port,
            path: urlPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
                ...headers,
            },
        };
        const req = http.request(options, (res) => {
            const cookies = res.headers['set-cookie'] || [];
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode, cookies }));
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

describe('web server registry', () => {
    let registerRoute, unregisterRoutesByScript;

    // Use a fresh module (and fresh registry Map) for every test
    beforeEach(() => {
        jest.resetModules();
        ({ registerRoute, unregisterRoutesByScript } = require('../../src/web/server'));
    });

    test('registers a new route without error', () => {
        expect(() => registerRoute('get', '/api/s/foo', () => {})).not.toThrow();
    });

    test('throws on duplicate method+path', () => {
        registerRoute('get', '/api/s/dup', () => {});
        expect(() => registerRoute('get', '/api/s/dup', () => {})).toThrow('Route already registered: GET /api/s/dup');
    });

    test('allows same path with a different HTTP method', () => {
        registerRoute('get', '/api/s/shared', () => {});
        expect(() => registerRoute('post', '/api/s/shared', () => {})).not.toThrow();
    });

    test('allows different paths to coexist', () => {
        registerRoute('get', '/api/s/a', () => {});
        expect(() => registerRoute('get', '/api/s/b', () => {})).not.toThrow();
    });

    test('unregisterRoutesByScript allows re-registration after unload', () => {
        registerRoute('get', '/api/myscript/foo', () => {});
        registerRoute('post', '/api/myscript/bar', () => {});
        expect(() => registerRoute('get', '/api/myscript/foo', () => {})).toThrow('Route already registered');

        unregisterRoutesByScript('myscript');

        expect(() => registerRoute('get', '/api/myscript/foo', () => {})).not.toThrow();
        expect(() => registerRoute('post', '/api/myscript/bar', () => {})).not.toThrow();
    });

    test('unregisterRoutesByScript does not affect other scripts', () => {
        registerRoute('get', '/api/scriptA/foo', () => {});
        registerRoute('get', '/api/scriptB/foo', () => {});

        unregisterRoutesByScript('scriptA');

        // scriptB's route should still be registered
        expect(() => registerRoute('get', '/api/scriptB/foo', () => {})).toThrow('Route already registered');
        // scriptA's route can be re-registered
        expect(() => registerRoute('get', '/api/scriptA/foo', () => {})).not.toThrow();
    });
});

describe('password authentication', () => {
    let startServer, stopServer, serverPort;

    beforeEach(() => {
        jest.resetModules();
        ({ startServer, stopServer } = require('../../src/web/server'));
    });

    afterEach(() => stopServer());

    test('passes /she/* requests when no auth is configured', async () => {
        serverPort = await startServer(0);
        const res = await httpGet(serverPort, '/she/config');
        expect(res.status).not.toBe(401);
    });

    test('rejects /she/* request with no session cookie when password auth is set', async () => {
        serverPort = await startServer(0, { auth: 'password', password: TEST_HASH });
        const res = await httpGet(serverPort, '/she/config');
        expect(res.status).toBe(401);
    });

    test('rejects /she/* request with wrong session cookie when password auth is set', async () => {
        serverPort = await startServer(0, { auth: 'password', password: TEST_HASH });
        const res = await httpGet(serverPort, '/she/config', { cookie: 'she_session=' + 'a'.repeat(64) });
        expect(res.status).toBe(401);
    });

    test('accepts /she/* request with valid session cookie after login', async () => {
        serverPort = await startServer(0, { auth: 'password', password: TEST_HASH });
        const loginRes = await httpPost(serverPort, '/she/auth/login', { password: 'secret' });
        expect(loginRes.status).toBe(200);
        const sessionCookie = loginRes.cookies.find((c) => c.startsWith('she_session='));
        const cookieHeader = sessionCookie.split(';')[0];
        const res = await httpGet(serverPort, '/she/config', { cookie: cookieHeader });
        expect(res.status).not.toBe(401);
    });

    test('/api/* requests are not protected by password auth', async () => {
        serverPort = await startServer(0, { auth: 'password', password: TEST_HASH });
        const res = await httpGet(serverPort, '/api/anything');
        expect(res.status).not.toBe(401);
    });
});

describe('health endpoint (A1)', () => {
    let startServer, stopServer, setHealthProvider, serverPort;

    beforeEach(() => {
        jest.resetModules();
        ({ startServer, stopServer, setHealthProvider } = require('../../src/web/server'));
    });

    afterEach(() => stopServer());

    const health = (over = {}) => ({ started: true, mqttConfigured: true, mqttConnected: true, scripts: 3, safeMode: false, ...over });

    test('200 and status ok when started and the broker is connected', async () => {
        setHealthProvider(() => health());
        serverPort = await startServer(0);
        const res = await httpGet(serverPort, '/she/health');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'ok', started: true, mqtt: 'connected', scripts: 3 });
        expect(res.body.safeMode).toBeUndefined();
    });

    test('200 when no broker is configured at all', async () => {
        setHealthProvider(() => health({ mqttConfigured: false, mqttConnected: false }));
        serverPort = await startServer(0);
        const res = await httpGet(serverPort, '/she/health');
        expect(res.status).toBe(200);
        expect(res.body.mqtt).toBe('disabled');
    });

    test('503 while a configured broker is disconnected', async () => {
        setHealthProvider(() => health({ mqttConnected: false }));
        serverPort = await startServer(0);
        const res = await httpGet(serverPort, '/she/health');
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ status: 'degraded', mqtt: 'disconnected' });
    });

    test('503 while the daemon is still waiting to start scripts', async () => {
        setHealthProvider(() => health({ started: false }));
        serverPort = await startServer(0);
        const res = await httpGet(serverPort, '/she/health');
        expect(res.status).toBe(503);
        expect(res.body.started).toBe(false);
    });

    test('503 when no provider is registered (daemon not wired up)', async () => {
        serverPort = await startServer(0);
        const res = await httpGet(serverPort, '/she/health');
        expect(res.status).toBe(503);
        expect(res.body.mqtt).toBe('unknown');
    });

    test('safe mode stays healthy but is reported', async () => {
        setHealthProvider(() => health({ safeMode: true, scripts: 0 }));
        serverPort = await startServer(0);
        const res = await httpGet(serverPort, '/she/health');
        expect(res.status).toBe(200);
        expect(res.body.safeMode).toBe(true);
    });

    test('reachable without a session in password mode, and hides the version there', async () => {
        setHealthProvider(() => health());
        serverPort = await startServer(0, { auth: 'password', password: TEST_HASH });
        const res = await httpGet(serverPort, '/she/health');
        expect(res.status).toBe(200);
        expect(res.body.version).toBeUndefined();
    });

    test('includes the version when the caller is authenticated', async () => {
        setHealthProvider(() => health());
        serverPort = await startServer(0);
        const res = await httpGet(serverPort, '/she/health');
        expect(res.body.version).toBe(require('../../package.json').version);
    });
});
