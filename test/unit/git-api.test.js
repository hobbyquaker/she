'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const express = require('express');

const { router } = require('../../src/web/git-api');

/** a fresh git repository with an identity and one commit, so every test starts from a clean HEAD */
function initRepo(dir) {
    execFileSync('git', ['init', '-q', dir]);
    for (const [k, v] of [
        ['user.email', 'test@example.com'],
        ['user.name', 'test'],
        ['commit.gpgsign', 'false'],
    ]) {
        execFileSync('git', ['-C', dir, 'config', k, v]);
    }
    execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'init']);
}

function lastSubject(dir) {
    return execFileSync('git', ['-C', dir, 'log', '-1', '--format=%B'], { encoding: 'utf8' }).trim();
}

function commitCount(dir) {
    return parseInt(execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }), 10);
}

function post(port, urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request(
            { host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
            (res) => {
                let text = '';
                res.on('data', (c) => (text += c));
                res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
            },
        );
        req.on('error', reject);
        req.end(data);
    });
}

const openaiAnswer = (text) => jest.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 }));

describe('POST /she/git/commit-message and the ai flag of /commit', () => {
    const realFetch = global.fetch;
    let server, port, dir, scriptDir, configPath;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-git-api-'));
        scriptDir = path.join(dir, 'scripts');
        fs.mkdirSync(scriptDir);
        initRepo(dir);
        configPath = path.join(dir, 'config.json');
        const app = express();
        app.use(express.json());
        app.locals.configPath = configPath;
        app.locals.scriptDir = scriptDir;
        app.use('/she/git', router);
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
        fs.writeFileSync(configPath, JSON.stringify({ ai: { provider: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: 'k' } }));
    });

    afterEach(() => {
        global.fetch = realFetch;
    });

    it('answers 503 with the default message when no AI is configured, and stages nothing', async () => {
        fs.writeFileSync(configPath, '{}');
        fs.writeFileSync(path.join(scriptDir, 'a.js'), 'she.log(1);\n');
        global.fetch = jest.fn();
        const r = await post(port, '/she/git/commit-message', { files: ['a.js'] });
        expect(r.status).toBe(503);
        expect(r.body).toMatchObject({ code: 'ai_not_configured', error: expect.stringMatching(/No AI provider/) });
        expect(r.body.fallback).toMatch(/^update a\.js \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(execFileSync('git', ['-C', dir, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })).toBe('');
    });

    it('stages the files, sends their diff and returns the AI message without committing', async () => {
        fs.writeFileSync(path.join(scriptDir, 'a.js'), 'she.log(2);\n');
        global.fetch = openaiAnswer('Log a two instead of a one');
        const before = commitCount(dir);
        const r = await post(port, '/she/git/commit-message', { files: ['a.js'] });
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ message: 'Log a two instead of a one', source: 'ai', model: 'm', truncated: false });
        const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(sent.messages[1].content).toContain('+she.log(2);');
        expect(commitCount(dir)).toBe(before);
        expect(execFileSync('git', ['-C', dir, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim()).toBe('scripts/a.js');
    });

    it('answers 502 with the default as fallback when the AI fails', async () => {
        global.fetch = jest.fn(async () => new Response('boom', { status: 500 }));
        const r = await post(port, '/she/git/commit-message', { path: 'a.js' });
        expect(r.status).toBe(502);
        expect(r.body).toMatchObject({ code: 'ai_error', fallback: expect.stringMatching(/^update a\.js/) });
    });

    it('rejects a path outside the script directory', async () => {
        const r = await post(port, '/she/git/commit-message', { files: ['../config.json'] });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/Invalid path/);
    });

    it('/commit without the ai flag commits the given message as before', async () => {
        fs.writeFileSync(path.join(scriptDir, 'b.js'), 'b\n');
        global.fetch = jest.fn();
        const r = await post(port, '/she/git/commit', { path: 'b.js', message: 'update b.js' });
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ok: true, message: 'update b.js', source: 'default' });
        expect(lastSubject(dir)).toBe('update b.js');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('/commit with ai: true commits the AI message', async () => {
        fs.writeFileSync(path.join(scriptDir, 'b.js'), 'bb\n');
        global.fetch = openaiAnswer('Double the b');
        const r = await post(port, '/she/git/commit', { files: ['b.js'], message: 'update b.js', ai: true });
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ok: true, message: 'Double the b', source: 'ai' });
        expect(lastSubject(dir)).toBe('Double the b');
    });

    it('/commit with ai: true falls back to the given message when the AI fails or is not configured', async () => {
        fs.writeFileSync(path.join(scriptDir, 'b.js'), 'bbb\n');
        global.fetch = jest.fn(async () => new Response('down', { status: 503 }));
        let r = await post(port, '/she/git/commit', { message: 'update scripts', ai: true });
        expect(r.body).toEqual({ ok: true, message: 'update scripts', source: 'default' });
        expect(lastSubject(dir)).toBe('update scripts');

        fs.writeFileSync(configPath, '{}');
        fs.writeFileSync(path.join(scriptDir, 'b.js'), 'bbbb\n');
        global.fetch = jest.fn();
        r = await post(port, '/she/git/commit', { path: 'b.js', message: 'update b.js', ai: true });
        expect(r.body).toEqual({ ok: true, message: 'update b.js', source: 'default' });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('/commit stages a deleted file as its removal', async () => {
        fs.unlinkSync(path.join(scriptDir, 'b.js'));
        const r = await post(port, '/she/git/commit', { files: ['b.js'], message: 'delete b.js' });
        expect(r.status).toBe(200);
        expect(lastSubject(dir)).toBe('delete b.js');
        expect(execFileSync('git', ['-C', dir, 'ls-files', 'scripts/b.js'], { encoding: 'utf8' })).toBe('');
    });
});

function get(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
            let text = '';
            res.on('data', (c) => (text += c));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        }).on('error', reject);
    });
}

describe('GET /she/git/diff', () => {
    let server, port, dir, scriptDir, outside;
    const diff = (p) => get(port, '/she/git/diff?path=' + encodeURIComponent(p));

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-git-diff-'));
        outside = fs.mkdtempSync(path.join(os.tmpdir(), 'she-git-diff-out-'));
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside the script directory\n');
        scriptDir = path.join(dir, 'scripts');
        fs.mkdirSync(path.join(scriptDir, 'sub'), { recursive: true });
        initRepo(dir);
        fs.writeFileSync(path.join(dir, 'config.json'), '{"secret":true}\n');
        fs.writeFileSync(path.join(scriptDir, 'changed.js'), 'she.log(1);\n');
        fs.writeFileSync(path.join(scriptDir, 'gone.js'), 'she.log("gone");\n');
        fs.writeFileSync(path.join(scriptDir, 'sub', 'same.js'), 'same\n');
        fs.writeFileSync(path.join(scriptDir, 'blob.bin'), Buffer.from([1, 2, 3]));
        execFileSync('git', ['-C', dir, 'add', '.']);
        execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'files']);
        fs.writeFileSync(path.join(scriptDir, 'changed.js'), 'she.log(2);\n');
        fs.rmSync(path.join(scriptDir, 'gone.js'));
        fs.writeFileSync(path.join(scriptDir, 'new file.js'), 'she.log("new");\n');
        fs.writeFileSync(path.join(scriptDir, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
        fs.writeFileSync(path.join(scriptDir, 'big.txt'), 'x'.repeat(600 * 1024));
        fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(scriptDir, 'link.txt'));
        fs.symlinkSync(outside, path.join(scriptDir, 'linkdir'));
        const app = express();
        app.locals.scriptDir = scriptDir;
        app.use('/she/git', router);
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });

    it('answers HEAD and the working tree for a changed file', async () => {
        const r = await diff('changed.js');
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ path: 'changed.js', head: 'she.log(1);\n', work: 'she.log(2);\n', added: false, deleted: false, binary: false, tooLarge: false });
    });

    it('answers the same text twice for an unchanged file in a subdirectory', async () => {
        const r = await diff('sub/same.js');
        expect(r.body).toMatchObject({ head: 'same\n', work: 'same\n', added: false, deleted: false });
    });

    it('has no HEAD side for a new file, also with a space in its name', async () => {
        const r = await diff('new file.js');
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ head: null, work: 'she.log("new");\n', added: true, deleted: false });
    });

    it('has no working side for a deleted file', async () => {
        const r = await diff('gone.js');
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ head: 'she.log("gone");\n', work: null, added: false, deleted: true });
    });

    it('sends no content of a binary file', async () => {
        const r = await diff('blob.bin');
        expect(r.body).toMatchObject({ head: null, work: null, binary: true, added: false, deleted: false });
    });

    it('sends no content of a file over the size limit', async () => {
        const r = await diff('big.txt');
        expect(r.body).toMatchObject({ head: null, work: null, tooLarge: true, added: true });
    });

    it('answers 404 for a file neither HEAD nor the working tree has', async () => {
        expect((await diff('nope.js')).status).toBe(404);
    });

    it('refuses a missing path, the directory itself and a path that leaves the script directory', async () => {
        expect((await get(port, '/she/git/diff')).status).toBe(400);
        expect((await diff('.')).status).toBe(400);
        for (const p of ['../config.json', 'sub/../../config.json', '/../config.json']) {
            const r = await diff(p);
            expect(r.status).toBe(400);
            expect(r.body).toEqual({ error: 'Invalid path' });
        }
    });

    it('refuses a path through a symlinked directory that points out of the script directory', async () => {
        const r = await diff('linkdir/secret.txt');
        expect(r.status).toBe(400);
        expect(JSON.stringify(r.body)).not.toContain('outside the script directory');
    });

    it('shows a symlink as its target, never the file it points to', async () => {
        const r = await diff('link.txt');
        expect(r.status).toBe(200);
        expect(r.body.work).toBe(path.join(outside, 'secret.txt'));
        expect(JSON.stringify(r.body)).not.toContain('outside the script directory');
    });

    it('treats every file as new in a repository without a commit', async () => {
        const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'she-git-diff-fresh-'));
        execFileSync('git', ['init', '-q', fresh]);
        fs.writeFileSync(path.join(fresh, 'a.js'), 'a\n');
        const app = express();
        app.locals.scriptDir = fresh;
        app.use('/she/git', router);
        const srv = http.createServer(app);
        await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
        try {
            const r = await get(srv.address().port, '/she/git/diff?path=a.js');
            expect(r.body).toMatchObject({ head: null, work: 'a\n', added: true });
        } finally {
            await new Promise((resolve) => srv.close(resolve));
            fs.rmSync(fresh, { recursive: true, force: true });
        }
    });
});
