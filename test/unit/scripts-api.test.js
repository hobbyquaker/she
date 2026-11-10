'use strict';

const os = require('os');
const path = require('path');
const { safePath } = require('../../src/web/scripts-api');

// Use an OS temp path as root so the test works on both Windows and Linux.
const root = path.join(os.tmpdir(), 'she-test-scripts');

describe('safePath()', () => {
    it('resolves a simple relative path inside the root', () => {
        expect(safePath(root, 'test.js')).toBe(path.join(root, 'test.js'));
    });

    it('resolves a nested relative path inside the root', () => {
        expect(safePath(root, 'sub/dir/file.js')).toBe(path.join(root, 'sub', 'dir', 'file.js'));
    });

    it('strips a leading slash and resolves safely', () => {
        expect(safePath(root, '/test.js')).toBe(path.join(root, 'test.js'));
    });

    it('strips multiple leading slashes', () => {
        expect(safePath(root, '///test.js')).toBe(path.join(root, 'test.js'));
    });

    it('accepts a path that resolves exactly to the root', () => {
        expect(safePath(root, '.')).toBe(root);
    });

    it('rejects ../ traversal to parent directory', () => {
        expect(safePath(root, '../passwd')).toBeNull();
    });

    it('rejects deep traversal that escapes root', () => {
        expect(safePath(root, 'sub/../../passwd')).toBeNull();
    });

    it('rejects traversal that passes through subdirectory before escaping', () => {
        expect(safePath(root, 'a/b/../../../secret')).toBeNull();
    });
});

// ── the commit mode after a delete or rename ────────────────────────────────────────────────────────────────────

const http = require('http');
const fs = require('fs');
const { execFileSync } = require('child_process');
const express = require('express');
const { router } = require('../../src/web/scripts-api');

function initRepo(dir) {
    execFileSync('git', ['init', '-q', dir]);
    for (const [k, v] of [
        ['user.email', 'test@example.com'],
        ['user.name', 'test'],
        ['commit.gpgsign', 'false'],
    ]) {
        execFileSync('git', ['-C', dir, 'config', k, v]);
    }
}

const gitOut = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const commitCount = (dir) => parseInt(gitOut(dir, ['rev-list', '--count', 'HEAD']), 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** wait until the repository has `n` commits (the daemon commits after it has answered) */
async function waitForCommits(dir, n, ms = 4000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (commitCount(dir) >= n) return true;
        await sleep(50);
    }
    return false;
}

function request(port, method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request(
            { host: '127.0.0.1', port, path: urlPath, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
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

describe('DELETE and rename commit per the configured mode', () => {
    const realFetch = global.fetch;
    let server, port, dir, configPath;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-scripts-commit-'));
        initRepo(dir);
        configPath = path.join(dir, 'config.json');
        const app = express();
        app.use(express.json());
        app.locals.configPath = configPath;
        app.locals.scriptDir = dir; // the script directory is the git root here
        app.use('/she/scripts', router);
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    afterEach(() => {
        global.fetch = realFetch;
    });

    /** a committed script, so that deleting it is a change */
    function committedScript(name) {
        fs.writeFileSync(path.join(dir, name), `// ${name}\n`);
        execFileSync('git', ['-C', dir, 'add', name]);
        execFileSync('git', ['-C', dir, 'commit', '-q', '-m', `add ${name}`]);
    }

    it('off (no key): deletes without committing', async () => {
        fs.writeFileSync(configPath, '{}');
        committedScript('one.js');
        const n = commitCount(dir);
        expect((await request(port, 'DELETE', '/she/scripts/one.js')).status).toBe(200);
        await sleep(300);
        expect(commitCount(dir)).toBe(n);
        expect(gitOut(dir, ['status', '--porcelain'])).toMatch(/^ ?D one\.js/m);
    });

    it('ask: deletes without committing — the editor opens its dialog', async () => {
        fs.writeFileSync(configPath, JSON.stringify({ gitCommitMode: 'ask', gitAutoCommit: true }));
        committedScript('two.js');
        const n = commitCount(dir);
        await request(port, 'DELETE', '/she/scripts/two.js');
        await sleep(300);
        expect(commitCount(dir)).toBe(n);
    });

    it('the old gitAutoCommit: true commits with the generic message, without asking any AI', async () => {
        fs.writeFileSync(configPath, JSON.stringify({ gitAutoCommit: true, ai: { provider: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'm' } }));
        global.fetch = jest.fn();
        committedScript('three.js');
        const n = commitCount(dir);
        await request(port, 'DELETE', '/she/scripts/three.js');
        expect(await waitForCommits(dir, n + 1)).toBe(true);
        expect(gitOut(dir, ['log', '-1', '--format=%s'])).toBe('delete three.js');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('auto with AI: commits the AI message for the staged diff', async () => {
        fs.writeFileSync(configPath, JSON.stringify({ gitCommitMode: 'auto', gitCommitAi: true, ai: { provider: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'm' } }));
        global.fetch = jest.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Remove the four script' } }] }), { status: 200 }));
        committedScript('four.js');
        const n = commitCount(dir);
        await request(port, 'DELETE', '/she/scripts/four.js');
        expect(await waitForCommits(dir, n + 1)).toBe(true);
        expect(gitOut(dir, ['log', '-1', '--format=%s'])).toBe('Remove the four script');
        const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(sent.messages[1].content).toContain('-// four.js');
    });

    it('auto with AI: falls back to the generic message when the AI fails', async () => {
        fs.writeFileSync(configPath, JSON.stringify({ gitCommitMode: 'auto', gitCommitAi: true, ai: { provider: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'm' } }));
        global.fetch = jest.fn(async () => new Response('down', { status: 502 }));
        committedScript('five.js');
        const n = commitCount(dir);
        await request(port, 'POST', '/she/scripts/five.js/rename', { newPath: 'six.js' });
        expect(await waitForCommits(dir, n + 1)).toBe(true);
        expect(gitOut(dir, ['log', '-1', '--format=%s'])).toBe('rename five.js → six.js');
        expect(gitOut(dir, ['ls-files', 'six.js'])).toBe('six.js');
    });
});

describe('the script directory itself', () => {
    let server, port, dir;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-scripts-root-'));
        fs.mkdirSync(path.join(dir, 'lights'));
        fs.writeFileSync(path.join(dir, 'lights', 'hall.js'), '// hall\n');
        const app = express();
        app.use(express.json());
        app.locals.scriptDir = dir;
        app.use('/she/scripts', router);
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it.each(['/she/scripts/', '/she/scripts/.', '/she/scripts/lights/..', '/she/scripts/%2E'])('DELETE %s is refused and deletes nothing', async (url) => {
        const res = await request(port, 'DELETE', url);
        // 400 for the root itself; an encoded dot is not decoded and names a file that does not exist (404)
        expect([400, 404]).toContain(res.status);
        expect(fs.existsSync(path.join(dir, 'lights', 'hall.js'))).toBe(true);
    });

    it('the root cannot be renamed, and nothing can be renamed onto it', async () => {
        expect((await request(port, 'POST', '/she/scripts/./rename', { newPath: 'elsewhere' })).status).toBe(400);
        expect((await request(port, 'POST', '/she/scripts/lights/rename', { newPath: '.' })).status).toBe(400);
        expect(fs.existsSync(path.join(dir, 'lights', 'hall.js'))).toBe(true);
    });

    it('a directory inside the root can still be deleted', async () => {
        fs.mkdirSync(path.join(dir, 'old'));
        fs.writeFileSync(path.join(dir, 'old', 'x.js'), '');
        expect((await request(port, 'DELETE', '/she/scripts/old')).status).toBe(200);
        expect(fs.existsSync(path.join(dir, 'old'))).toBe(false);
    });
});
