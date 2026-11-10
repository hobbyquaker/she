'use strict';

/**
 * The sudoers rules `she --install` writes: the Restart button and the helper, nothing else — in
 * particular no rule that lets the daemon user run npm as root. A re-install has to remove the npm
 * rule earlier versions wrote. The installer writes them through `--sudoers-only <file>`, so this
 * runs on a file in a temp directory and never near /etc.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'service', 'install.sh');
const RULES = ['she ALL=(root) NOPASSWD: /usr/bin/systemctl restart smart-home-engine', 'she ALL=(root) NOPASSWD: /usr/local/bin/she-servicectl'];

describe('install.sh: the sudoers rules', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-sudoers-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
    const linesOf = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

    test('a fresh install writes the restart rule and the helper rule, no npm rule', () => {
        const file = path.join(dir, 'she');
        const r = run('--sudoers-only', file);
        expect(r.status).toBe(0);
        expect(linesOf(file)).toEqual(RULES);
        expect(fs.readFileSync(file, 'utf8')).not.toMatch(/npm/);
        expect(fs.statSync(file).mode & 0o777).toBe(0o440);
        expect(r.stdout).not.toMatch(/removing/);
    });

    test('a re-install removes the npm rule of an earlier version', () => {
        const file = path.join(dir, 'she');
        fs.writeFileSync(file, [RULES[0], 'she ALL=(root) NOPASSWD: /usr/local/bin/npm install -g smart-home-engine', RULES[1], ''].join('\n'), { mode: 0o440 });
        const r = run('--sudoers-only', file);
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/removing the npm rule/);
        expect(linesOf(file)).toEqual(RULES);
        expect(fs.statSync(file).mode & 0o777).toBe(0o440);
        // nothing left behind that sudo could pick up
        expect(fs.readdirSync(dir)).toEqual(['she']);
    });

    test('running it again changes nothing', () => {
        const file = path.join(dir, 'she');
        run('--sudoers-only', file);
        const r = run('--sudoers-only', file);
        expect(r.status).toBe(0);
        expect(r.stdout).not.toMatch(/removing/);
        expect(linesOf(file)).toEqual(RULES);
    });

    test('the script has no other place that writes a sudoers rule', () => {
        const src = fs.readFileSync(SCRIPT, 'utf8');
        expect(src.match(/NOPASSWD/g)).toHaveLength(2);
        expect(src).not.toMatch(/NOPASSWD:.*npm/);
        expect(run('--sudoers-only').status).toBe(2);
    });
});
