'use strict';

/**
 * Symbolic links in the script directory: a script, a directory or a required file that a link
 * brings in from outside the directory is not loaded, and the log says why. Links that stay inside
 * the directory work. The daemon runs against its own temporary script directory.
 */

const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const Aedes = require('aedes');

const NOT_LOADED = 'not loaded — the link points outside the script directory';

let tmp, scripts, outside, daemon, broker, brokerServer;
const lines = [];
const waiters = [];

function onLine(line) {
    lines.push(line);
    for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].test(line)) waiters.splice(i, 1)[0].resolve(line);
    }
}

/** resolves with the first log line (already seen or still to come) that contains `text` */
function logged(text) {
    const test = (line) => line.includes(text);
    const seen = lines.find(test);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => waiters.push({ test, resolve }));
}

const seen = (text) => lines.some((line) => line.includes(text));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'she-script-links-')));
    scripts = path.join(tmp, 'scripts');
    outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(scripts, 'real'));
    fs.mkdirSync(path.join(outside, 'dir'), { recursive: true });

    // outside the script directory
    fs.writeFileSync(path.join(outside, 'foreign.js'), "she.info('MARK foreign ran');\n");
    fs.writeFileSync(path.join(outside, 'dir', 'nested.js'), "she.info('MARK nested ran');\n");
    fs.writeFileSync(path.join(outside, 'helper.js'), "module.exports = 'MARK outside helper';\n");
    fs.writeFileSync(path.join(outside, 'later.js'), "she.info('MARK later ran');\n");

    // inside
    fs.writeFileSync(path.join(scripts, 'plain.js'), "she.info('MARK plain ran');\n");
    fs.writeFileSync(path.join(scripts, 'real', 'target.js'), "she.info('MARK target ran');\n");
    fs.writeFileSync(path.join(scripts, 'lib', '.shelib'), '');
    fs.writeFileSync(path.join(scripts, 'lib', 'inside-helper.js'), "module.exports = 'MARK inside helper';\n");
    fs.writeFileSync(
        path.join(scripts, 'requires.js'),
        [
            "she.info(require('./lib/inside-helper-link'));",
            'try {',
            "    she.info(require('./lib/outside-helper'));",
            '} catch (err) {',
            "    she.info('MARK refused: ' + err.message);",
            '}',
            '',
        ].join('\n'),
    );

    // links that leave: a script, a directory, a library file
    fs.symlinkSync(path.join(outside, 'foreign.js'), path.join(scripts, 'foreign-link.js'));
    fs.symlinkSync(path.join(outside, 'dir'), path.join(scripts, 'foreign-dir'));
    fs.symlinkSync(path.join(outside, 'helper.js'), path.join(scripts, 'lib', 'outside-helper.js'));
    // links that stay inside: a script and a library file
    fs.symlinkSync(path.join('real', 'target.js'), path.join(scripts, 'inside-link.js'));
    fs.symlinkSync('inside-helper.js', path.join(scripts, 'lib', 'inside-helper-link.js'));

    broker = new Aedes();
    brokerServer = net.createServer(broker.handle);
    await new Promise((resolve) => brokerServer.listen(0, '127.0.0.1', resolve));
    const config = path.join(tmp, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ url: `mqtt://127.0.0.1:${brokerServer.address().port}`, verbosity: 'debug' }));

    daemon = cp.spawn(process.execPath, [path.join(__dirname, '../../src/index.js'), '-d', scripts, '--config', config, '--data-dir', path.join(tmp, 'data')]);
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
    for (const stream of [daemon.stdout, daemon.stderr]) {
        readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', (data) => onLine(stripAnsi(data.toString())));
    }
    await logged('initialized'); // the watcher is up, so the directory has been loaded
}, 30000);

afterAll(async () => {
    if (daemon) {
        const gone = new Promise((resolve) => daemon.once('exit', resolve));
        daemon.kill();
        await gone;
    }
    await new Promise((resolve) => brokerServer.close(resolve));
    await new Promise((resolve) => broker.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
}, 30000);

describe('at start', () => {
    test('a plain script and a link to a script inside the directory are loaded', async () => {
        await logged('MARK plain ran');
        await logged('inside-link.js: loading');
        await logged('real/target.js: loading');
    }, 20000);

    test('a link to a script outside is not loaded, and the log says why', async () => {
        await logged(`foreign-link.js: ${NOT_LOADED}`);
    }, 20000);

    test('a link to a directory outside is not loaded, and the log says why', async () => {
        await logged(`foreign-dir: ${NOT_LOADED}`);
    }, 20000);

    test('require() follows a link inside the directory and refuses one that leaves', async () => {
        await logged('MARK inside helper');
        await logged(`MARK refused: require('./lib/outside-helper'): ${NOT_LOADED}`);
    }, 20000);

    test('nothing from outside ran', async () => {
        await sleep(500);
        expect(seen('MARK foreign ran')).toBe(false);
        expect(seen('MARK nested ran')).toBe(false);
        expect(seen('MARK outside helper')).toBe(false);
        expect(seen('foreign-link.js: loading')).toBe(false);
    }, 20000);
});

describe('while the directory is watched', () => {
    test('a new link to a script outside is warned about and not loaded', async () => {
        fs.symlinkSync(path.join(outside, 'later.js'), path.join(scripts, 'later-link.js'));
        await logged(`later-link.js: ${NOT_LOADED}`);
        expect(seen('MARK later ran')).toBe(false);
    }, 20000);

    test('a new link to a directory outside is warned about, and nothing below it is loaded', async () => {
        fs.symlinkSync(path.join(outside, 'dir'), path.join(scripts, 'later-dir'));
        await logged(`later-dir: ${NOT_LOADED}`);
        // a change below the link reaches nobody
        fs.appendFileSync(path.join(outside, 'dir', 'nested.js'), '// touched\n');
        await sleep(1500);
        expect(seen('MARK nested ran')).toBe(false);
    }, 20000);

    test('a new link to a script inside is loaded', async () => {
        fs.symlinkSync('plain.js', path.join(scripts, 'plain-link.js'));
        await logged('plain-link.js: added. loading.');
        await logged('plain-link.js: loading');
    }, 20000);

    test('a script that is replaced by a link to outside is unloaded', async () => {
        const file = path.join(scripts, 'swap.js');
        fs.writeFileSync(file, "she.info('MARK swap ran');\n");
        await logged('MARK swap ran');
        fs.rmSync(file);
        fs.symlinkSync(path.join(outside, 'later.js'), file);
        await logged(`swap.js: ${NOT_LOADED}`);
        await logged('swap.js: unloading');
        expect(seen('MARK later ran')).toBe(false);
    }, 20000);
});
