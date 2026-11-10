'use strict';

/**
 * Paths a request names stay inside their root — also when a symlink inside the root points out of
 * it. Each test builds a root with a neighbour directory "outside" and links between the two.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { resolveInside, linksOutside } = require('../../src/lib/safe-path');

/** tmp/root (the root), tmp/outside (must stay unreachable) */
function sandbox() {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'she-safe-path-')));
    const root = path.join(tmp, 'root');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, 'a.js'), '// a\n');
    fs.writeFileSync(path.join(root, 'lib', 'util.js'), '// util\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
    // links that leave the root
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leak.js'));
    fs.symlinkSync(outside, path.join(root, 'out'));
    fs.symlinkSync(path.join(outside, 'not-yet.js'), path.join(root, 'dead.js'));
    // links that stay inside
    fs.symlinkSync(path.join(root, 'lib', 'util.js'), path.join(root, 'util-link.js'));
    fs.symlinkSync('lib', path.join(root, 'lib-link'));
    return { tmp, root, outside };
}

function request(port, method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request(
            { host: '127.0.0.1', port, path: urlPath, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
            (res) => {
                let text = '';
                res.on('data', (c) => (text += c));
                res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
            },
        );
        req.on('error', reject);
        req.end(data);
    });
}

async function serve(mount, router, locals) {
    const app = express();
    app.use(express.json());
    Object.assign(app.locals, locals);
    app.use(mount, router);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: server.address().port };
}

describe('resolveInside()', () => {
    let box;
    beforeEach(() => {
        box = sandbox();
    });
    afterEach(() => fs.rmSync(box.tmp, { recursive: true, force: true }));

    test('plain paths, existing or not', () => {
        const { root } = box;
        expect(resolveInside(root, 'a.js')).toBe(path.join(root, 'a.js'));
        expect(resolveInside(root, '/lib/util.js')).toBe(path.join(root, 'lib', 'util.js'));
        expect(resolveInside(root, 'new/deep/file.js')).toBe(path.join(root, 'new', 'deep', 'file.js'));
        expect(resolveInside(root, '.')).toBe(root);
        expect(resolveInside(root, '../outside/secret.txt')).toBeNull();
        expect(resolveInside(root, 'lib/../../outside')).toBeNull();
        expect(resolveInside(root, 'a.js\0')).toBeNull();
        expect(resolveInside(root, undefined)).toBeNull();
        // a path through a file is nothing the root is left by; the file system refuses it later
        expect(resolveInside(root, 'a.js/x')).toBe(path.join(root, 'a.js', 'x'));
    });

    test('a root that does not exist is judged by its path alone', () => {
        const root = path.join(box.tmp, 'nowhere', 'scripts');
        expect(resolveInside(root, 'x.js')).toBe(path.join(root, 'x.js'));
        expect(resolveInside(root, '../x.js')).toBeNull();
    });

    test('a symlink that points out of the root is refused: file, directory, and what lies below it', () => {
        const { root } = box;
        expect(resolveInside(root, 'leak.js')).toBeNull();
        expect(resolveInside(root, 'out')).toBeNull();
        expect(resolveInside(root, 'out/secret.txt')).toBeNull();
        expect(resolveInside(root, 'out/new.js')).toBeNull();
        expect(resolveInside(root, 'out/new/deeper.js')).toBeNull();
    });

    test('a link to a missing target is refused — writing to it would create the target', () => {
        const { root } = box;
        expect(resolveInside(root, 'dead.js')).toBeNull();
        expect(resolveInside(root, 'dead.js/x')).toBeNull();
        fs.symlinkSync(path.join(root, 'later.js'), path.join(root, 'dead-inside.js'));
        expect(resolveInside(root, 'dead-inside.js')).toBeNull();
    });

    test('a link in a loop is refused', () => {
        const { root } = box;
        fs.symlinkSync('loop-b', path.join(root, 'loop-a'));
        fs.symlinkSync('loop-a', path.join(root, 'loop-b'));
        expect(resolveInside(root, 'loop-a')).toBeNull();
        expect(resolveInside(root, 'loop-a/x.js')).toBeNull();
    });

    test('a symlink that stays inside the root keeps working', () => {
        const { root } = box;
        expect(resolveInside(root, 'util-link.js')).toBe(path.join(root, 'util-link.js'));
        expect(resolveInside(root, 'lib-link/util.js')).toBe(path.join(root, 'lib-link', 'util.js'));
        expect(resolveInside(root, 'lib-link/new.js')).toBe(path.join(root, 'lib-link', 'new.js'));
    });

    test('a root that is itself a symlink works, and is still not left', () => {
        const { tmp, root } = box;
        const alias = path.join(tmp, 'alias');
        fs.symlinkSync(root, alias);
        expect(resolveInside(alias, 'a.js')).toBe(path.join(alias, 'a.js'));
        expect(resolveInside(alias, 'util-link.js')).toBe(path.join(alias, 'util-link.js'));
        expect(resolveInside(alias, 'leak.js')).toBeNull();
        expect(resolveInside(alias, 'out/secret.txt')).toBeNull();
    });

    test('followLeaf false judges the entry by the directory it sits in', () => {
        const { root } = box;
        const opts = { followLeaf: false };
        // the link itself may be named — to delete or rename it
        expect(resolveInside(root, 'leak.js', opts)).toBe(path.join(root, 'leak.js'));
        expect(resolveInside(root, 'out', opts)).toBe(path.join(root, 'out'));
        expect(resolveInside(root, 'dead.js', opts)).toBe(path.join(root, 'dead.js'));
        // but nothing behind a link that leaves
        expect(resolveInside(root, 'out/secret.txt', opts)).toBeNull();
        expect(resolveInside(root, '../outside/secret.txt', opts)).toBeNull();
        expect(resolveInside(root, 'lib-link/util.js', opts)).toBe(path.join(root, 'lib-link', 'util.js'));
    });
});

describe('linksOutside()', () => {
    let box;
    beforeEach(() => {
        box = sandbox();
    });
    afterEach(() => fs.rmSync(box.tmp, { recursive: true, force: true }));

    test('a link that leaves the root, and what lies below one', () => {
        const { root } = box;
        expect(linksOutside(root, path.join(root, 'leak.js'))).toBe(true);
        expect(linksOutside(root, path.join(root, 'out'))).toBe(true);
        expect(linksOutside(root, path.join(root, 'out', 'secret.txt'))).toBe(true);
    });

    test('plain entries and links that stay inside', () => {
        const { root } = box;
        expect(linksOutside(root, root)).toBe(false);
        expect(linksOutside(root, path.join(root, 'a.js'))).toBe(false);
        expect(linksOutside(root, path.join(root, 'util-link.js'))).toBe(false);
        expect(linksOutside(root, path.join(root, 'lib-link'))).toBe(false);
        expect(linksOutside(root, path.join(root, 'lib-link', 'util.js'))).toBe(false);
    });

    test('a dead link, a missing file and a path that is not below the root by name are not "linked outside"', () => {
        const { root, outside } = box;
        expect(linksOutside(root, path.join(root, 'dead.js'))).toBe(false);
        expect(linksOutside(root, path.join(root, 'nothing.js'))).toBe(false);
        expect(linksOutside(root, path.join(outside, 'secret.txt'))).toBe(false);
    });

    test('a root that is itself a link', () => {
        const { tmp, root } = box;
        const linked = path.join(tmp, 'root-link');
        fs.symlinkSync(root, linked);
        expect(linksOutside(linked, path.join(linked, 'a.js'))).toBe(false);
        expect(linksOutside(linked, path.join(linked, 'util-link.js'))).toBe(false);
        expect(linksOutside(linked, path.join(linked, 'leak.js'))).toBe(true);
    });

    test('with the real path handed in', () => {
        const { root, outside } = box;
        expect(linksOutside(root, path.join(root, 'x'), path.join(outside, 'secret.txt'))).toBe(true);
        expect(linksOutside(root, path.join(root, 'x'), path.join(root, 'a.js'))).toBe(false);
    });
});

describe('the scripts routes and symlinks', () => {
    const { router } = require('../../src/web/scripts-api');
    let box, server, port;

    beforeEach(async () => {
        box = sandbox();
        ({ server, port } = await serve('/she/scripts', router, { scriptDir: box.root }));
    });
    afterEach(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(box.tmp, { recursive: true, force: true });
    });

    const secret = () => fs.readFileSync(path.join(box.outside, 'secret.txt'), 'utf8');

    test('GET does not read through a link that leaves the script directory', async () => {
        expect((await request(port, 'GET', '/she/scripts/leak.js')).status).toBe(400);
        expect((await request(port, 'GET', '/she/scripts/out/secret.txt')).status).toBe(400);
        const ok = await request(port, 'GET', '/she/scripts/a.js');
        expect(ok.status).toBe(200);
        expect(ok.body.content).toBe('// a\n');
    });

    test('GET and PUT work through links that stay inside', async () => {
        const r = await request(port, 'GET', '/she/scripts/util-link.js');
        expect(r.status).toBe(200);
        expect(r.body.content).toBe('// util\n');
        expect((await request(port, 'GET', '/she/scripts/lib-link/util.js')).body.content).toBe('// util\n');
        expect((await request(port, 'PUT', '/she/scripts/util-link.js', { content: '// changed\n' })).status).toBe(200);
        expect(fs.readFileSync(path.join(box.root, 'lib', 'util.js'), 'utf8')).toBe('// changed\n');
        expect(fs.lstatSync(path.join(box.root, 'util-link.js')).isSymbolicLink()).toBe(true);
        expect((await request(port, 'PUT', '/she/scripts/lib-link/new.js', { content: '// new\n' })).status).toBe(200);
        expect(fs.readFileSync(path.join(box.root, 'lib', 'new.js'), 'utf8')).toBe('// new\n');
    });

    test('PUT does not write through a link that leaves — existing target, new file, missing target', async () => {
        expect((await request(port, 'PUT', '/she/scripts/leak.js', { content: 'x' })).status).toBe(400);
        expect((await request(port, 'PUT', '/she/scripts/out/new.js', { content: 'x' })).status).toBe(400);
        expect((await request(port, 'PUT', '/she/scripts/out/sub/new.js', { content: 'x' })).status).toBe(400);
        expect((await request(port, 'PUT', '/she/scripts/dead.js', { content: 'x' })).status).toBe(400);
        expect(secret()).toBe('secret\n');
        expect(fs.readdirSync(box.outside)).toEqual(['secret.txt']);
    });

    test('mkdir does not create a directory outside', async () => {
        expect((await request(port, 'POST', '/she/scripts/mkdir', { path: 'out/dir' })).status).toBe(400);
        expect((await request(port, 'POST', '/she/scripts/mkdir', { path: 'lib-link/dir' })).status).toBe(200);
        expect(fs.readdirSync(box.outside)).toEqual(['secret.txt']);
        expect(fs.statSync(path.join(box.root, 'lib', 'dir')).isDirectory()).toBe(true);
    });

    test('the text search skips what a link brings in from outside', async () => {
        const r = await request(port, 'GET', '/she/scripts/search?q=secret');
        expect(r.status).toBe(200);
        expect(r.body.results).toEqual([]);
        const inside = await request(port, 'GET', '/she/scripts/search?q=util');
        expect(inside.body.results.map((x) => x.path).sort()).toEqual(['lib/util.js', 'util-link.js']);
    });

    test('the listing survives a dead link', async () => {
        const list = await request(port, 'GET', '/she/scripts');
        expect(list.status).toBe(200);
        expect(list.body.map((f) => f.path)).toContain('dead.js');
        expect((await request(port, 'GET', '/she/scripts/tree')).status).toBe(200);
    });

    test('the listing and the tree mark the links that leave the script directory, and only those', async () => {
        const marked = (entries) =>
            entries
                .filter((e) => e.outside)
                .map((e) => e.path)
                .sort();
        const list = await request(port, 'GET', '/she/scripts');
        expect(marked(list.body)).toEqual(['leak.js', 'out']);
        const tree = await request(port, 'GET', '/she/scripts/tree');
        expect(marked(tree.body)).toEqual(['leak.js', 'out']);
        // a link is a file node, and the entries without the mark do not carry the key at all
        expect(tree.body.find((e) => e.path === 'out').type).toBe('file');
        expect(tree.body.find((e) => e.path === 'util-link.js')).not.toHaveProperty('outside');
        expect(tree.body.find((e) => e.path === 'a.js')).not.toHaveProperty('outside');
    });

    test('DELETE removes the link, never what it points to', async () => {
        expect((await request(port, 'DELETE', '/she/scripts/leak.js')).status).toBe(200);
        expect(secret()).toBe('secret\n');
        expect((await request(port, 'DELETE', '/she/scripts/out')).status).toBe(200);
        expect(fs.readdirSync(box.outside)).toEqual(['secret.txt']);
        expect((await request(port, 'DELETE', '/she/scripts/dead.js')).status).toBe(200);
        expect((await request(port, 'DELETE', '/she/scripts/lib-link')).status).toBe(200);
        expect(fs.existsSync(path.join(box.root, 'lib', 'util.js'))).toBe(true);
        expect(fs.readdirSync(box.root).sort()).toEqual(['a.js', 'lib', 'util-link.js']);
    });

    test('DELETE does not reach below a link that leaves', async () => {
        expect((await request(port, 'DELETE', '/she/scripts/out/secret.txt')).status).toBe(400);
        expect(secret()).toBe('secret\n');
    });

    test('rename moves a link as a link, and nothing into or out of the outside', async () => {
        expect((await request(port, 'POST', '/she/scripts/a.js/rename', { newPath: 'out/a.js' })).status).toBe(400);
        expect((await request(port, 'POST', '/she/scripts/out/secret.txt/rename', { newPath: 'stolen.txt' })).status).toBe(400);
        expect(fs.readdirSync(box.outside)).toEqual(['secret.txt']);
        expect(fs.existsSync(path.join(box.root, 'a.js'))).toBe(true);
        expect((await request(port, 'POST', '/she/scripts/leak.js/rename', { newPath: 'lib/leak2.js' })).status).toBe(200);
        expect(fs.lstatSync(path.join(box.root, 'lib', 'leak2.js')).isSymbolicLink()).toBe(true);
        expect((await request(port, 'GET', '/she/scripts/lib/leak2.js')).status).toBe(400);
        expect(secret()).toBe('secret\n');
    });
});

describe('the AI tools and symlinks', () => {
    const { executeTool, _internal } = require('../../src/web/ai-tools');
    let box;
    beforeEach(() => {
        box = sandbox();
    });
    afterEach(() => fs.rmSync(box.tmp, { recursive: true, force: true }));

    test('read_script does not read through a link that leaves', async () => {
        const ctx = { scriptDir: box.root };
        expect(await executeTool('read_script', { path: 'leak.js' }, ctx)).toMatch(/Access denied/);
        expect(await executeTool('read_script', { path: 'out/secret.txt' }, ctx)).toMatch(/Access denied/);
        expect(await executeTool('read_script', { path: '../outside/secret.txt' }, ctx)).toMatch(/Access denied/);
        expect(await executeTool('read_script', { path: 'util-link.js' }, ctx)).toContain('// util');
        expect(await executeTool('read_script', { path: 'a.js' }, ctx)).toContain('// a');
    });

    test('a proposed script path is refused the same way', () => {
        expect(_internal.scriptPathOf(box.root, 'leak.js')).toBeNull();
        expect(_internal.scriptPathOf(box.root, 'out/new.js')).toBeNull();
        expect(_internal.scriptPathOf(box.root, 'dead.js')).toBeNull();
        expect(_internal.scriptPathOf(box.root, 'util-link.js')).toEqual({ rel: 'util-link.js', abs: path.join(box.root, 'util-link.js') });
        expect(_internal.scriptPathOf(box.root, 'new.js')).toEqual({ rel: 'new.js', abs: path.join(box.root, 'new.js') });
    });
});

describe('restoring a broker config backup', () => {
    const { router } = require('../../src/web/broker-api');
    let box, server, port, conf;

    beforeEach(async () => {
        box = sandbox();
        conf = path.join(box.root, 'mosquitto.conf');
        fs.writeFileSync(conf, 'listener 1883\n');
        fs.writeFileSync(conf + '.bak-2026-01-01', 'listener 1884\n');
        fs.symlinkSync(path.join(box.outside, 'secret.txt'), conf + '.bak-2026-01-02');
        const configPath = path.join(box.tmp, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({ broker: { configDir: box.root } }));
        ({ server, port } = await serve('/she/broker', router, { configPath }));
    });
    afterEach(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(box.tmp, { recursive: true, force: true });
    });

    test('a backup that is a symlink is not copied over the config', async () => {
        const r = await request(port, 'POST', '/she/broker/config/restore', { backup: 'mosquitto.conf.bak-2026-01-02' });
        expect(r.status).toBe(400);
        expect(fs.readFileSync(conf, 'utf8')).toBe('listener 1883\n');
    });

    test('a real backup is restored', async () => {
        const r = await request(port, 'POST', '/she/broker/config/restore', { backup: 'mosquitto.conf.bak-2026-01-01' });
        expect(r.status).toBe(200);
        expect(fs.readFileSync(conf, 'utf8')).toBe('listener 1884\n');
    });
});
