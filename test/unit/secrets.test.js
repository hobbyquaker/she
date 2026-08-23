'use strict';

/** Unit tests for src/lib/secrets.js and src/web/secrets-api.js (roadmap A5). */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const secrets = require('../../src/lib/secrets');
const { router } = require('../../src/web/secrets-api');

function httpRequest(method, port, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body !== undefined ? JSON.stringify(body) : undefined;
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: urlPath,
                method,
                headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    let b;
                    try {
                        b = JSON.parse(data);
                    } catch {
                        b = data;
                    }
                    resolve({ status: res.statusCode, body: b });
                });
            },
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

let dir;
let file;
let keyFile;
const fresh = (env = {}) => {
    secrets.init({ file, keyFile, env });
    return secrets.load();
};

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-secrets-'));
    file = path.join(dir, 'secrets.enc');
    keyFile = path.join(dir, 'secrets.key');
    fresh();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('secrets store', () => {
    test('starts empty without creating anything', () => {
        expect(secrets.status()).toMatchObject({ status: 'empty', keySource: null, groups: 0 });
        expect(fs.existsSync(file)).toBe(false);
        expect(fs.existsSync(keyFile)).toBe(false);
    });

    test('set / get / has / list, persisted encrypted with a generated 0600 key file', () => {
        secrets.set('smtp', 'password', 'hunter22', 1000);
        secrets.set('smtp', 'host', 'mail.example', 2000);
        expect(secrets.get('smtp/password')).toBe('hunter22');
        expect(secrets.get('smtp')).toEqual({ host: 'mail.example', password: 'hunter22' });
        expect(Object.isFrozen(secrets.get('smtp'))).toBe(true);
        expect(secrets.has('smtp/host')).toBe(true);
        expect(secrets.has('smtp/nope')).toBe(false);
        expect(secrets.get('nope/x')).toBeUndefined();
        expect(secrets.get('bad name/x')).toBeUndefined();
        expect(secrets.list()).toEqual([
            {
                name: 'smtp',
                changed: 2000,
                fields: [
                    { name: 'host', changed: 2000, secret: true },
                    { name: 'password', changed: 1000, secret: true },
                ],
            },
        ]);
        const raw = fs.readFileSync(file, 'utf8');
        expect(raw).not.toContain('hunter22');
        expect(JSON.parse(raw).alg).toBe('aes-256-gcm');
        expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        // a fresh instance reads it back with the key file
        expect(fresh()).toMatchObject({ status: 'ok', keySource: 'file', groups: 1 });
        expect(secrets.get('smtp/password')).toBe('hunter22');
    });

    test('remove field / group', () => {
        secrets.set('a', 'x', 'value1');
        secrets.set('a', 'y', 'value2');
        secrets.set('b', 'z', 'value3');
        expect(secrets.remove('a', 'x')).toBe(true);
        expect(secrets.remove('a', 'x')).toBe(false);
        expect(secrets.get('a')).toEqual({ y: 'value2' });
        expect(secrets.remove('a', 'y')).toBe(true);
        expect(secrets.get('a')).toBeUndefined(); // empty group disappears
        expect(secrets.remove('b')).toBe(true);
        expect(secrets.list()).toEqual([]);
        expect(fresh().groups).toBe(0);
    });

    test('validation: names, empty value, size cap', () => {
        expect(() => secrets.set('bad name', 'x', 'v')).toThrow(/names/);
        expect(() => secrets.set('a', 'x/y', 'v')).toThrow(/names/);
        expect(() => secrets.set('a', 'x', '')).toThrow(/non-empty/);
        expect(() => secrets.set('a', 'x', 42)).toThrow(/non-empty/);
        expect(() => secrets.set('a', 'x', 'v'.repeat(secrets.MAX_VALUE + 1))).toThrow(/exceeds/);
        secrets.set('a', 'x', 'line1\nline2\n-----END KEY-----');
        expect(secrets.get('a/x')).toBe('line1\nline2\n-----END KEY-----');
    });

    test('SHE_SECRETS_KEY wins over the key file and is accepted as hex or base64', () => {
        const key = Buffer.alloc(32, 7);
        fresh({ SHE_SECRETS_KEY: key.toString('hex') });
        secrets.set('g', 'f', 'secret-value');
        expect(fs.existsSync(keyFile)).toBe(false);
        expect(secrets.status().keySource).toBe('env');
        expect(fresh({ SHE_SECRETS_KEY: key.toString('base64') })).toMatchObject({ status: 'ok', keySource: 'env' });
        expect(secrets.get('g/f')).toBe('secret-value');
        expect(fresh({ SHE_SECRETS_KEY: 'too-short' })).toMatchObject({ status: 'error' });
        expect(secrets.status().error).toMatch(/32-byte/);
    });

    test('locked: missing key or wrong key → get undefined, set throws LOCKED, file untouched', () => {
        secrets.set('g', 'f', 'secret-value');
        const before = fs.readFileSync(file, 'utf8');
        fs.unlinkSync(keyFile);
        expect(fresh()).toMatchObject({ status: 'locked' });
        expect(secrets.status().error).toMatch(/no key/);
        expect(secrets.get('g/f')).toBeUndefined();
        expect(secrets.has('g/f')).toBe(false);
        expect(() => secrets.set('g', 'f', 'new')).toThrow(expect.objectContaining({ code: 'LOCKED' }));
        expect(() => secrets.remove('g')).toThrow(expect.objectContaining({ code: 'LOCKED' }));
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
        expect(fs.existsSync(keyFile)).toBe(false);
        expect(fresh({ SHE_SECRETS_KEY: Buffer.alloc(32, 1).toString('hex') })).toMatchObject({ status: 'locked' });
        expect(secrets.status().error).toMatch(/wrong key/);
    });

    test('plain vs secret fields: kind on creation, listed values for plain only, one-way mark', () => {
        secrets.set('smtp', 'user', 'alice@example.org', { secret: false, now: 10 });
        secrets.set('smtp', 'password', 'hunter22', { now: 20 }); // default: secret
        expect(secrets.list()[0].fields).toEqual([
            { name: 'password', changed: 20, secret: true },
            { name: 'user', changed: 10, secret: false, value: 'alice@example.org' },
        ]);
        // plain values are not redacted, secrets are
        expect(secrets.redact('alice@example.org hunter22')).toBe('alice@example.org ***');
        // a secret cannot be downgraded by a later set
        secrets.set('smtp', 'password', 'hunter23', { secret: false });
        expect(secrets.list()[0].fields[0]).toMatchObject({ name: 'password', secret: true });
        expect(secrets.get('smtp/password')).toBe('hunter23');
        // marking is one-way and survives a reload
        expect(secrets.mark('smtp', 'nope')).toBe(false);
        expect(secrets.mark('smtp', 'user')).toBe(true);
        expect(fresh().status).toBe('ok');
        expect(secrets.list()[0].fields.find((f) => f.name === 'user')).toEqual({ name: 'user', changed: 10, secret: true });
        expect(secrets.get('smtp/user')).toBe('alice@example.org');
        expect(secrets.redact('alice@example.org')).toBe('***');
    });

    test('redact replaces known values of 6+ chars, longest first', () => {
        secrets.set('api', 'token', 'tok-abcdef-123456');
        secrets.set('api', 'short', 'ab12');
        secrets.set('api', 'sub', 'abcdef');
        expect(secrets.redact('got tok-abcdef-123456 and ab12 and abcdef')).toBe('got *** and ab12 and ***');
        expect(secrets.redact('nothing here')).toBe('nothing here');
        expect(secrets.redact(42)).toBe(42);
        secrets.remove('api');
        expect(secrets.redact('tok-abcdef-123456')).toBe('tok-abcdef-123456');
    });

    test('cli: set (stdin), list (names only), delete', () => {
        const out = [];
        const errs = [];
        const io = (stdin) => ({ stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => errs.push(s) }, stdin: () => stdin });
        expect(secrets.cli(['--secret-set', 'smtp/password'], io('hunter22\n'))).toBe(0);
        expect(secrets.get('smtp/password')).toBe('hunter22');
        expect(secrets.cli(['--secret-set', 'smtp'], io('x'))).toBe(1);
        expect(secrets.cli(['--secret-list'], io(''))).toBe(0);
        expect(secrets.cli(['--secret-set', 'smtp/user', '--plain'], io('alice\n'))).toBe(0);
        expect(secrets.cli(['--secret-set', 'smtp/x', '--bogus'], io('v'))).toBe(1);
        expect(secrets.cli(['--secret-list'], io(''))).toBe(0);
        expect(out.join('')).toMatch(
            /set smtp\/password \(secret\)\nsmtp\/password\t\d{4}-[^\n]*\tsecret\nset smtp\/user \(plain\)\nsmtp\/password\t[^\n]*\tsecret\nsmtp\/user\t[^\n]*\tplain: alice\n/,
        );
        expect(out.join('')).not.toContain('hunter22');
        expect(secrets.cli(['--secret-delete', 'smtp/nope'], io(''))).toBe(1);
        expect(secrets.cli(['--secret-delete', 'smtp'], io(''))).toBe(0);
        expect(fresh().groups).toBe(0);
        expect(errs.join('')).toContain('usage');
    });
});

describe('secrets HTTP API (write-only)', () => {
    let server;
    let port;
    beforeEach(async () => {
        const app = express();
        app.use(express.json());
        app.use('/she/secrets', router);
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        port = server.address().port;
    });
    afterEach(async () => {
        await new Promise((r) => server.close(r));
    });

    test('PUT / GET / DELETE — values never come back', async () => {
        let r = await httpRequest('PUT', port, '/she/secrets/smtp/password', { value: 'hunter22' });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, group: 'smtp', field: 'password' });
        r = await httpRequest('GET', port, '/she/secrets');
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ status: 'ok', keySource: 'file', groups: [{ name: 'smtp', fields: [{ name: 'password', secret: true }] }] });
        expect(JSON.stringify(r.body)).not.toContain('hunter22');
        // plain field: value comes back, until it is marked secret
        r = await httpRequest('PUT', port, '/she/secrets/smtp/user', { value: 'alice', secret: false });
        expect(r.body).toMatchObject({ ok: true, secret: false });
        r = await httpRequest('GET', port, '/she/secrets');
        expect(r.body.groups[0].fields.find((f) => f.name === 'user')).toEqual({ name: 'user', changed: expect.any(Number), secret: false, value: 'alice' });
        r = await httpRequest('POST', port, '/she/secrets/smtp/user/secret');
        expect(r.body).toEqual({ ok: true });
        r = await httpRequest('POST', port, '/she/secrets/smtp/nope/secret');
        expect(r.status).toBe(404);
        r = await httpRequest('GET', port, '/she/secrets');
        expect(r.body.groups[0].fields.find((f) => f.name === 'user')).toEqual({ name: 'user', changed: expect.any(Number), secret: true });
        expect(JSON.stringify(r.body)).not.toContain('alice');
        expect((await httpRequest('DELETE', port, '/she/secrets/smtp/user')).body).toEqual({ ok: true });
        expect(secrets.get('smtp/password')).toBe('hunter22');
        r = await httpRequest('DELETE', port, '/she/secrets/smtp/password');
        expect(r.body).toEqual({ ok: true });
        r = await httpRequest('DELETE', port, '/she/secrets/smtp/password');
        expect(r.status).toBe(404);
        await httpRequest('PUT', port, '/she/secrets/a/b', { value: 'v1' });
        await httpRequest('PUT', port, '/she/secrets/a/c', { value: 'v2' });
        r = await httpRequest('DELETE', port, '/she/secrets/a');
        expect(r.body).toEqual({ ok: true });
        expect(secrets.list()).toEqual([]);
    });

    test('400 on bad names / values, 409 when locked', async () => {
        let r = await httpRequest('PUT', port, '/she/secrets/bad%20name/x', { value: 'v' });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('INVALID_NAME');
        r = await httpRequest('PUT', port, '/she/secrets/a/x', { value: '' });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('INVALID_VALUE');
        r = await httpRequest('PUT', port, '/she/secrets/a/x', {});
        expect(r.status).toBe(400);
        await httpRequest('PUT', port, '/she/secrets/a/x', { value: 'value' });
        fs.unlinkSync(keyFile);
        fresh();
        r = await httpRequest('GET', port, '/she/secrets');
        expect(r.body).toMatchObject({ status: 'locked', groups: [] });
        r = await httpRequest('PUT', port, '/she/secrets/a/x', { value: 'v' });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('LOCKED');
    });
});
