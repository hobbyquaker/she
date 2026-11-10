/**
 * `she-servicectl she-update <version>` is how the daemon installs its own update as root. Like the
 * adapter detection, it is a shell function, so it is sliced out of the script and run with a fake
 * npm: the version pattern has to let nothing through that npm would read as a range, a dist-tag,
 * a URL or a second argument, and npm's exit code has to come back unchanged — the daemon restarts
 * only on 0.
 *
 * After a successful install the command takes the npm rule of earlier versions out of she's
 * sudoers file. That edit runs here against files in a temp directory only: the script's own path
 * (`SHE_SUDOERS`) is not part of what is sliced out, every run sets it to a temp file.
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

const HAS_VISUDO = spawnSync('sh', ['-c', 'command -v visudo || test -x /usr/sbin/visudo']).status === 0;
const withVisudo = HAS_VISUDO ? test : test.skip;

const RULES = ['she ALL=(root) NOPASSWD: /usr/bin/systemctl restart smart-home-engine', 'she ALL=(root) NOPASSWD: /usr/local/bin/she-servicectl'];
const NPM_RULE = 'she ALL=(root) NOPASSWD: /usr/local/bin/npm install -g smart-home-engine';

let dir, out, sudoers;
beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-servicectl-update-'));
    out = path.join(dir, 'npm-args');
    // a fake node/npm pair: npm records its arguments and exits with FAKE_EXIT
    fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\nprintf 'npm said something\\n' >&2\nexit "\${FAKE_EXIT:-0}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'she'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.mkdirSync(path.join(dir, 'sudoers.d'));
    sudoers = path.join(dir, 'sudoers.d', 'she');
    // a visudo that rejects everything, and a PATH without any visudo
    fs.mkdirSync(path.join(dir, 'rejecting'));
    fs.writeFileSync(path.join(dir, 'rejecting', 'visudo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
});
beforeEach(() => fs.rmSync(sudoers, { force: true }));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** run cmd_she_update with the fixture standing in for the host (no she when sheInstalled is false) */
function sheUpdate(args, { exit = 0, sheInstalled = true, pathPrefix = null } = {}) {
    fs.rmSync(out, { force: true });
    const script = `set -eu
${helperFunctions()}
SHE_SUDOERS='${sudoers}'
${commandFunction('remove_npm_sudoers_rule')}
${commandFunction('cmd_she_update')}
adapter_cmd() { [ "$1" = she ] && [ -n "$FAKE_SHE" ] && printf '%s' "$FAKE_SHE"; }
adapter_npm() { printf '%s' "${path.join(dir, 'npm')}"; }
adapter_node() { printf '%s' "${path.join(dir, 'node')}"; }
cmd_she_update "$@"
`;
    const r = spawnSync('sh', ['-c', script, 'sh', ...args], {
        encoding: 'utf8',
        env: { ...process.env, FAKE_EXIT: String(exit), FAKE_SHE: sheInstalled ? path.join(dir, 'she') : '', ...(pathPrefix ? { PATH: `${pathPrefix}:${process.env.PATH}` } : {}) },
    });
    const npmArgs = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n') : null;
    return { status: r.status, stderr: r.stderr, npmArgs };
}

test('the script parses and dispatches she-update', () => {
    expect(spawnSync('sh', ['-n', SCRIPT]).status).toBe(0);
    expect(src).toMatch(/^\s+she-update\) cmd_she_update "\$@" ;;$/m);
    expect(Number(/^VERSION=(\d+)$/m.exec(src)[1])).toBeGreaterThanOrEqual(16); // the daemon asks for v16 before it uses the command
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

describe('the npm rule of earlier versions in the sudoers file', () => {
    const write = (lines, mode = 0o440) => {
        fs.writeFileSync(sudoers, lines.join('\n') + '\n');
        fs.chmodSync(sudoers, mode);
    };
    const read = () => fs.readFileSync(sudoers, 'utf8');
    const leftovers = () => fs.readdirSync(path.dirname(sudoers)).filter((f) => f !== 'she');

    test('the script edits /etc/sudoers.d/she and nothing else, and only after npm', () => {
        expect(src).toMatch(/^SHE_SUDOERS=\/etc\/sudoers\.d\/she$/m);
        const body = commandFunction('cmd_she_update');
        expect(body).toMatch(/remove_npm_sudoers_rule "\$SHE_SUDOERS"/);
        expect(body.indexOf('remove_npm_sudoers_rule')).toBeGreaterThan(body.indexOf('install -g'));
        // the checked copy replaces the file; nothing writes into it directly
        const fn = commandFunction('remove_npm_sudoers_rule');
        expect(fn).toMatch(/-c -q -f "\$tmp"[^\n]*&& mv -f "\$tmp" "\$file"/);
        expect(fn).not.toMatch(/>\s*"\$file"/);
    });

    withVisudo('a successful update removes the npm rule and keeps every other line', () => {
        const others = ['# written by she --install', RULES[0], 'Defaults:she !requiretty', RULES[1], 'she ALL=(root) NOPASSWD: /usr/bin/npm install -g something-else'];
        write([others[0], others[1], NPM_RULE, others[2], others[3], others[4]]);
        const r = sheUpdate(['3.0.0']);
        expect(r.status).toBe(0);
        expect(r.stderr).toMatch(/removed the npm rule of earlier versions/);
        expect(read()).toBe(others.join('\n') + '\n');
        expect(fs.statSync(sudoers).mode & 0o777).toBe(0o440);
        expect(leftovers()).toEqual([]);
    });

    withVisudo('whatever path npm had, and a second run changes nothing', () => {
        write([RULES[0], 'she ALL=(root) NOPASSWD: /opt/node-v22/bin/npm install -g smart-home-engine', RULES[1]]);
        expect(sheUpdate(['3.0.0']).status).toBe(0);
        expect(read()).toBe(RULES.join('\n') + '\n');
        const before = fs.statSync(sudoers).mtimeMs;
        const again = sheUpdate(['3.0.1']);
        expect(again.status).toBe(0);
        expect(again.stderr).not.toMatch(/npm rule/);
        expect(read()).toBe(RULES.join('\n') + '\n');
        expect(fs.statSync(sudoers).mtimeMs).toBe(before);
    });

    withVisudo('lines that only resemble the rule stay', () => {
        const lookalikes = [
            '# she ALL=(root) NOPASSWD: /usr/bin/npm install -g smart-home-engine',
            'she ALL=(root) NOPASSWD: /usr/bin/npm install -g smart-home-engine-extra',
            'she ALL=(root) NOPASSWD: /usr/bin/npm install -g smart-home-engine, /usr/bin/id',
            'she ALL=(root) NOPASSWD: /usr/bin/pnpm-wrapper install -g smart-home-engine',
        ];
        write([...RULES, ...lookalikes]);
        const r = sheUpdate(['3.0.0']);
        expect(r.status).toBe(0);
        expect(read()).toBe([...RULES, ...lookalikes].join('\n') + '\n');
    });

    withVisudo('a file that is broken elsewhere is left alone, and the update still succeeds', () => {
        const broken = [RULES[0], NPM_RULE, 'this is not a sudoers line ((('];
        write(broken);
        const r = sheUpdate(['3.0.0']);
        expect(r.status).toBe(0);
        expect(r.stderr).toMatch(/visudo rejects the file without it, file left as it is/);
        expect(read()).toBe(broken.join('\n') + '\n');
        expect(leftovers()).toEqual([]);
    });

    test('when the check fails the file is left alone', () => {
        write([RULES[0], NPM_RULE, RULES[1]]);
        const r = sheUpdate(['3.0.0'], { pathPrefix: path.join(dir, 'rejecting') });
        expect(r.status).toBe(0);
        expect(r.stderr).toMatch(/file left as it is/);
        expect(read()).toBe([RULES[0], NPM_RULE, RULES[1]].join('\n') + '\n');
        expect(leftovers()).toEqual([]);
    });

    test('a failed npm leaves the file alone', () => {
        write([RULES[0], NPM_RULE, RULES[1]]);
        const r = sheUpdate(['3.0.0'], { exit: 7 });
        expect(r.status).toBe(7);
        expect(read()).toBe([RULES[0], NPM_RULE, RULES[1]].join('\n') + '\n');
        expect(leftovers()).toEqual([]);
    });

    test('no sudoers file, or one without the rule: nothing happens', () => {
        expect(sheUpdate(['3.0.0']).status).toBe(0);
        expect(fs.existsSync(sudoers)).toBe(false);
        write(RULES);
        const r = sheUpdate(['3.0.0'], { pathPrefix: path.join(dir, 'rejecting') });
        expect(r.status).toBe(0);
        expect(r.stderr).not.toMatch(/npm rule/);
        expect(read()).toBe(RULES.join('\n') + '\n');
    });

    test('a symlink in place of the file is not followed', () => {
        const target = path.join(dir, 'elsewhere');
        fs.writeFileSync(target, [RULES[0], NPM_RULE].join('\n') + '\n');
        fs.symlinkSync(target, sudoers);
        expect(sheUpdate(['3.0.0']).status).toBe(0);
        expect(fs.readFileSync(target, 'utf8')).toBe([RULES[0], NPM_RULE].join('\n') + '\n');
        expect(fs.lstatSync(sudoers).isSymbolicLink()).toBe(true);
    });
});
