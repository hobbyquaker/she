'use strict';

/**
 * she's own update: the version must be a plain release version, the install goes through the
 * helper when it has `she-update` (v16) and is refused otherwise, and the daemon restarts only
 * when npm exited 0 — 3.0.0-beta.0/1 restarted whatever
 * sudo said, which hid a refused install completely.
 */

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const su = require('../../src/lib/self-update');

/** a child_process.spawn stand-in: prints `lines` on stderr, exits with `code` (or fails to start) */
function fakeSpawn({ code = 0, signal = null, lines = [], error = null } = {}) {
    const calls = [];
    const spawn = (cmd, argv) => {
        calls.push([cmd, argv]);
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        setImmediate(() => {
            if (error) {
                child.emit('error', error);
                return;
            }
            for (const l of lines) child.stderr.write(l + '\n');
            child.stdout.end();
            child.stderr.end();
            setImmediate(() => child.emit('close', code, signal));
        });
        return child;
    };
    return { spawn, calls };
}

describe('self-update: the version', () => {
    test('accepts release versions, pre-releases included', () => {
        for (const v of ['3.0.0', '3.0.0-beta.2', '10.24.1-rc.1', '2.1.0-alpha', '1.0.0-0.3.7', '1.0.0-x-y-z.1']) expect(su.isValidVersion(v)).toBe(true);
    });

    test('rejects everything npm could read differently', () => {
        for (const v of [
            'latest',
            'next',
            '3.0',
            'v3.0.0',
            '3.0.0 foo',
            '3.0.0-beta.2 --ignore-scripts',
            '3.0.0;id',
            '',
            ' 3.0.0',
            '3.0.0\n',
            'smart-home-engine@3.0.0',
            '^3.0.0',
            '~3.0.0',
            'https://example.invalid/x.tgz',
            '3.0.0+build',
            undefined,
            null,
            3,
        ]) {
            expect(su.isValidVersion(v)).toBe(false);
        }
    });
});

describe('self-update: the helper or nothing', () => {
    const version = '3.0.0-beta.2';

    test('a helper with she-update installs the exact version', () => {
        expect(su.planUpdate({ version, helperVersion: su.HELPER_SHE_UPDATE_VERSION })).toEqual({ mode: 'helper' });
        expect(su.planUpdate({ version, helperVersion: 99 })).toEqual({ mode: 'helper' });
    });

    test('an older helper is refused, whatever npm calls latest', () => {
        expect(su.planUpdate({ version, helperVersion: 15 })).toEqual({ error: su.HELPER_NEEDED });
        expect(su.planUpdate({ version: '3.0.0', helperVersion: 15, npmLatest: '3.0.0' })).toEqual({ error: su.HELPER_NEEDED });
    });

    test('no helper at all (missing, sudo denied) is treated like an old one', () => {
        expect(su.planUpdate({ version: '3.0.0', helperVersion: null })).toEqual({ error: su.HELPER_NEEDED });
        expect(su.planUpdate({ version: '3.0.0', helperVersion: null, npmLatest: '3.0.0' })).toEqual({ error: su.HELPER_NEEDED });
    });

    test('the error names the way out', () => {
        expect(su.HELPER_NEEDED).toMatch(/Update helper/);
        expect(su.HELPER_NEEDED).toMatch(/sudo she --install/);
    });

    test('an invalid version is refused even with a current helper', () => {
        expect(su.planUpdate({ version: 'latest', helperVersion: 16 }).error).toMatch(/not a release version: latest/);
        expect(su.planUpdate({ version: '3.0.0 x', helperVersion: 15, npmLatest: '3.0.0 x' }).error).toMatch(/not a release version/);
    });

    test('the command: the helper takes the version; there is no other way to install', () => {
        expect(su.commandFor({ mode: 'helper' }, version)).toEqual(['sudo', ['-n', '/usr/local/bin/she-servicectl', 'she-update', version]]);
        expect(su.commandFor({ mode: 'helper' }, version, { helper: '/opt/x/she-servicectl' })).toEqual(['sudo', ['-n', '/opt/x/she-servicectl', 'she-update', version]]);
        expect(() => su.commandFor({ mode: 'npm-latest' }, '3.0.0')).toThrow();
        expect(() => su.commandFor({ error: 'x' }, version)).toThrow();
    });

    test('helperVersionOf reads the number the helper prints, null otherwise', async () => {
        const driver = (out, fail) => ({ exec: () => (fail ? Promise.reject(new Error(fail)) : Promise.resolve({ stdout: out, stderr: '', code: 0 })) });
        expect(await su.helperVersionOf(driver('16\n'))).toBe(16);
        expect(await su.helperVersionOf(driver('  15 '))).toBe(15);
        expect(await su.helperVersionOf(driver('she-servicectl: unknown command'))).toBeNull();
        expect(await su.helperVersionOf(driver(''))).toBeNull();
        expect(await su.helperVersionOf(driver(null, 'sudo does not allow she-servicectl'))).toBeNull();
    });
});

describe('self-update: the install and the restart', () => {
    const version = '3.0.0-beta.2';
    const plan = { mode: 'helper' };

    test('npm exits 0: restart', async () => {
        const { spawn, calls } = fakeSpawn({ code: 0, lines: ['added 1 package'] });
        const onRestart = jest.fn();
        const log = jest.fn();
        const r = await su.performUpdate({ plan, version, spawn, onRestart, log });
        expect(r).toEqual({ ok: true });
        expect(onRestart).toHaveBeenCalledTimes(1);
        expect(calls).toEqual([['sudo', ['-n', '/usr/local/bin/she-servicectl', 'she-update', version]]]);
        expect(log.mock.calls.some(([level, msg]) => level === 'info' && /added 1 package/.test(msg))).toBe(true);
    });

    test('npm fails: no restart, the exit code and the last lines in the error', async () => {
        const lines = ['npm warn something', 'npm error code E403', 'npm error 403 Forbidden', 'npm error A complete log of this run can be found in: /root/.npm/_logs/x.log'];
        const { spawn } = fakeSpawn({ code: 1, lines });
        const onRestart = jest.fn();
        const log = jest.fn();
        const r = await su.performUpdate({ plan, version, spawn, onRestart, log });
        expect(r.ok).toBe(false);
        expect(onRestart).not.toHaveBeenCalled();
        expect(r.error).toMatch(/^update to 3\.0\.0-beta\.2 failed: npm exited 1 — /);
        expect(r.error).toContain('npm error 403 Forbidden');
        expect(r.error).toContain('_logs/x.log');
        expect(r.error).not.toContain('npm warn something'); // only the last three lines
        const errorLog = log.mock.calls.find(([level]) => level === 'error');
        expect(errorLog[1]).toContain('npm warn something'); // the log gets the whole tail
    });

    test('sudo refuses (the bug this guards): exit 1 without a restart', async () => {
        const { spawn } = fakeSpawn({ code: 1, lines: ['sudo: a password is required'] });
        const onRestart = jest.fn();
        const r = await su.performUpdate({ plan, version, spawn, onRestart });
        expect(r.ok).toBe(false);
        expect(r.error).toContain('sudo: a password is required');
        expect(onRestart).not.toHaveBeenCalled();
    });

    test('the command cannot be started: no restart', async () => {
        const { spawn } = fakeSpawn({ error: Object.assign(new Error('spawn sudo ENOENT'), { code: 'ENOENT' }) });
        const onRestart = jest.fn();
        const r = await su.performUpdate({ plan, version, spawn, onRestart });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/could not start sudo: spawn sudo ENOENT/);
        expect(onRestart).not.toHaveBeenCalled();
    });

    test('a signal is reported as such', async () => {
        const { spawn } = fakeSpawn({ code: null, signal: 'SIGKILL' });
        const r = await su.runInstall(['sudo', ['x']], { spawn });
        expect(r).toMatchObject({ ok: false, code: null, signal: 'SIGKILL', reason: 'npm was killed by SIGKILL' });
    });

    test('runInstall keeps the last twelve lines and splits chunks on line ends', async () => {
        const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
        const { spawn } = fakeSpawn({ code: 2, lines });
        const r = await su.runInstall(['sudo', ['x']], { spawn });
        expect(r.tail).toHaveLength(12);
        expect(r.tail[0]).toBe('line 19');
        expect(r.tail[11]).toBe('line 30');
        expect(r.reason).toBe('npm exited 2');
    });
});
