/**
 * `she-servicectl she-update <version>` is how the daemon installs its own update as root. Like the
 * adapter detection, it is a shell function, so it is sliced out of the script and run with a fake
 * npm: the version pattern has to let nothing through that npm would read as a range, a dist-tag,
 * a URL or a second argument, and npm's exit code has to come back unchanged — the daemon restarts
 * only on 0.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'service', 'she-servicectl');
const src = fs.readFileSync(SCRIPT, 'utf8');

/** the script's die() plus its validation + helper block, without its command dispatch */
function helperFunctions() {
    const die = /^die\(\) \{.*$/m.exec(src);
    const from = src.indexOf('# ── validation');
    const to = src.indexOf('# ── commands');
    expect(die).not.toBeNull();
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return die[0] + '\n' + src.slice(from, to);
}

/** one cmd_* function of the script */
function commandFunction(name) {
    const from = src.indexOf(`${name}() {`);
    expect(from).toBeGreaterThan(-1);
    const to = src.indexOf('\n}\n', from);
    return src.slice(from, to + 3);
}

let dir, out;
beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-servicectl-update-'));
    out = path.join(dir, 'npm-args');
    // a fake node/npm pair: npm records its arguments and exits with FAKE_EXIT
    fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\nprintf 'npm said something\\n' >&2\nexit "\${FAKE_EXIT:-0}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'she'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** run cmd_she_update with the fixture standing in for the host (no she when sheInstalled is false) */
function sheUpdate(args, { exit = 0, sheInstalled = true } = {}) {
    fs.rmSync(out, { force: true });
    const script = `set -u
${helperFunctions()}
${commandFunction('cmd_she_update')}
adapter_cmd() { [ "$1" = she ] && [ -n "$FAKE_SHE" ] && printf '%s' "$FAKE_SHE"; }
adapter_npm() { printf '%s' "${path.join(dir, 'npm')}"; }
adapter_node() { printf '%s' "${path.join(dir, 'node')}"; }
cmd_she_update "$@"
`;
    const r = spawnSync('sh', ['-c', script, 'sh', ...args], {
        encoding: 'utf8',
        env: { ...process.env, FAKE_EXIT: String(exit), FAKE_SHE: sheInstalled ? path.join(dir, 'she') : '' },
    });
    const npmArgs = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n') : null;
    return { status: r.status, stderr: r.stderr, npmArgs };
}

test('the script parses and dispatches she-update', () => {
    expect(spawnSync('sh', ['-n', SCRIPT]).status).toBe(0);
    expect(src).toMatch(/^\s+she-update\) cmd_she_update "\$@" ;;$/m);
    expect(src).toMatch(/^VERSION=16$/m); // the daemon asks for v16 before it uses the command
});

test('valid_she_version accepts release versions and nothing else', () => {
    const good = ['3.0.0', '3.0.0-beta.2', '10.24.1-rc.1', '1.0.0-x-y-z.1'];
    const bad = ['latest', 'next', '3.0', 'v3.0.0', '3.0.0 foo', '3.0.0;id', 'smart-home-engine@3.0.0', '^3.0.0', 'https://example.invalid/x.tgz', '3.0.0+build', '--help', ''];
    const script = `${helperFunctions()}
for v in "$@"; do if valid_she_version "$v"; then echo "yes"; else echo "no"; fi; done
`;
    const r = spawnSync('sh', ['-c', script, 'sh', ...good, ...bad], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual([...good.map(() => 'yes'), ...bad.map(() => 'no')]);
});

test('installs exactly smart-home-engine@<version> with the npm next to the node, exit 0', () => {
    const r = sheUpdate(['3.0.0-beta.2']);
    expect(r.status).toBe(0);
    expect(r.npmArgs).toEqual(['install', '-g', 'smart-home-engine@3.0.0-beta.2', '--no-audit', '--no-fund']);
});

test("npm's exit code is the command's", () => {
    const r = sheUpdate(['3.0.0'], { exit: 7 });
    expect(r.status).toBe(7);
    expect(r.npmArgs).toEqual(['install', '-g', 'smart-home-engine@3.0.0', '--no-audit', '--no-fund']);
    expect(r.stderr).toContain('npm said something');
});

test('refuses a version npm could read differently, before npm runs', () => {
    for (const v of ['latest', '3.0.0 --ignore-scripts', 'smart-home-engine@3.0.0', '^3.0.0']) {
        const r = sheUpdate([v]);
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/she-servicectl: invalid version: /);
        expect(r.npmArgs).toBeNull();
    }
});

test('refuses without exactly one argument', () => {
    expect(sheUpdate([]).status).toBe(2);
    expect(sheUpdate(['3.0.0', '3.0.1']).status).toBe(2);
    expect(sheUpdate(['3.0.0', '3.0.1']).npmArgs).toBeNull();
});

test('refuses on a host without she (an adapter host)', () => {
    const r = sheUpdate(['3.0.0'], { sheInstalled: false });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/she is not installed on this host/);
    expect(r.npmArgs).toBeNull();
});
