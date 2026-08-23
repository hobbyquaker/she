'use strict';

/**
 * Host drivers for xyz2mqtt service management (roadmap I4/I5).
 *
 * A driver runs the privileged helper `she-servicectl` on one host and is the
 * only thing that differs between the she host itself (local: sudo + execFile)
 * and remote hosts (ssh, I5). Everything above this layer — the API, the
 * inventory correlation — only sees:
 *
 *   driver.name                       host label
 *   driver.exec(args, {stdin})        → {stdout, stderr, code}   (rejects HostError)
 *   driver.spawn(args)                → ChildProcess              (long-running: logs --follow)
 *
 * Errors carry `code`:
 *   HELPER_MISSING  the helper is not installed on the host
 *   SUDO_DENIED     sudoers does not allow the helper for this user
 *   HELPER_FAILED   the helper rejected the call (exit 2, message in stderr)
 *   SSH_FAILED      the ssh connection itself failed (exit 255: auth, host key, unreachable)
 *   EXEC_FAILED     the underlying command failed (non-zero exit)
 */

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const sshDeploy = require('./ssh-deploy');

const HELPER = '/usr/local/bin/she-servicectl';
const HELPER_VERSION = 9; // must match VERSION in service/she-servicectl
/** Default identity for services.hosts[].ssh — one key for all managed hosts (I5). */
const DEFAULT_SERVICES_IDENTITY = '~/.she/ssh/services_id_ed25519';
/** The helper as shipped with this she version (copied to remote hosts by the deploy route). */
const HELPER_SOURCE = path.join(__dirname, '..', '..', 'service', 'she-servicectl');

class HostError extends Error {
    constructor(code, message, extra = {}) {
        super(message);
        this.code = code;
        Object.assign(this, extra);
    }
}

function classify(err, stdout, stderr, code, { ssh = false } = {}) {
    const text = String(stderr || '').trim();
    if (ssh && code === 255) return new HostError('SSH_FAILED', text || 'ssh connection failed');
    if ((err && err.code === 'ENOENT') || code === 127 || /she-servicectl: (command )?not found|she-servicectl: No such file/i.test(text)) {
        return new HostError('HELPER_MISSING', 'she-servicectl is not installed on this host');
    }
    if (/a password is required|not allowed to execute|not in the sudoers/i.test(text)) {
        return new HostError('SUDO_DENIED', 'sudo does not allow she-servicectl for this user: ' + text);
    }
    if (/^she-servicectl: /.test(text) || code === 2) {
        return new HostError('HELPER_FAILED', text.replace(/^she-servicectl: /, '') || 'helper rejected the call', { stdout, stderr: text, exitCode: code });
    }
    return new HostError('EXEC_FAILED', text || (err && err.message) || `exit ${code}`, { stdout, stderr: text, exitCode: code });
}

/**
 * Driver for the host she runs on: `sudo -n she-servicectl …`.
 * @param {{helper?: string, sudo?: boolean, name?: string, env?: object}} [opts]
 */
function createLocalDriver(opts = {}) {
    const helper = opts.helper || HELPER;
    const useSudo = opts.sudo !== false;
    const name = opts.name || 'local';
    // LC_ALL=C keeps systemctl/journalctl output parseable; sudo keeps only a few variables anyway
    const env = { ...(opts.env || process.env), LC_ALL: 'C' };

    function command(args) {
        return useSudo ? ['sudo', ['-n', helper, ...args]] : [helper, [...args]];
    }

    function exec(args, { stdin, timeout = 30000 } = {}) {
        if (!fs.existsSync(helper)) return Promise.reject(new HostError('HELPER_MISSING', 'she-servicectl is not installed on this host'));
        const [cmd, argv] = command(args);
        return new Promise((resolve, reject) => {
            const child = execFile(cmd, argv, { timeout, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
                const code = err && typeof err.code === 'number' ? err.code : err ? null : 0;
                if (err) return reject(classify(err, stdout, stderr, code));
                resolve({ stdout, stderr, code: 0 });
            });
            if (stdin !== undefined) {
                child.stdin.on('error', () => {});
                child.stdin.end(stdin);
            } else {
                child.stdin.end();
            }
        });
    }

    function spawnHelper(args) {
        const [cmd, argv] = command(args);
        return spawn(cmd, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    }

    return { name, local: true, helperPath: helper, exec, spawn: spawnHelper };
}

/** Quote a word for a POSIX shell (the remote side runs the helper through the login shell). */
function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Driver for a remote host: `ssh <host> sudo -n she-servicectl …` with the system ssh/scp
 * clients (BatchMode, accept-new — like the broker deploy). stdin is passed through.
 * @param {{name: string, ssh: {host: string, port?: number, user?: string, identityFile?: string}}} hostCfg
 * @param {{helper?: string, sudo?: boolean, defaultIdentity?: string, sshBin?: string, scpBin?: string, env?: object}} [opts]
 */
function createSshDriver(hostCfg, opts = {}) {
    const helper = opts.helper || HELPER;
    const useSudo = opts.sudo !== false;
    const sshCfg = hostCfg.ssh || {};
    const defaultIdentity = opts.defaultIdentity || DEFAULT_SERVICES_IDENTITY;
    const sshBin = opts.sshBin || 'ssh';
    const scpBin = opts.scpBin || 'scp';
    const env = { ...(opts.env || process.env), LC_ALL: 'C' };
    const name = hostCfg.name;

    function remoteCommand(args) {
        return [...(useSudo ? ['sudo', '-n'] : []), helper, ...args].map(shellQuote).join(' ');
    }
    function sshArgv(command) {
        return [...sshDeploy.sshArgs(sshCfg, defaultIdentity), sshDeploy.sshTarget(sshCfg), command];
    }
    function runSsh(command, { stdin, timeout = 45000, maxBuffer = 16 * 1024 * 1024 } = {}) {
        return new Promise((resolve, reject) => {
            const child = execFile(sshBin, sshArgv(command), { timeout, env, maxBuffer }, (err, stdout, stderr) => {
                const code = err && typeof err.code === 'number' ? err.code : err ? null : 0;
                if (err) return reject(classify(err, stdout, stderr, code, { ssh: true }));
                resolve({ stdout, stderr, code: 0 });
            });
            child.stdin.on('error', () => {});
            child.stdin.end(stdin === undefined ? '' : stdin);
        });
    }

    /** helper call */
    function exec(args, options) {
        return runSsh(remoteCommand(args), options);
    }
    /** long-running helper call (logs --follow) */
    function spawnHelper(args) {
        return spawn(sshBin, sshArgv(remoteCommand(args)), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    /** arbitrary command on the host — only used by the helper deploy */
    function run(command, options) {
        return runSsh(command, options);
    }
    /** scp a local file to `remotePath` (relative to the SSH user's home unless absolute) */
    function upload(localPath, remotePath) {
        return new Promise((resolve, reject) => {
            // scp needs IPv6 literals in brackets: user@[fe80::1]:path
            const target = sshDeploy.sshTarget(sshCfg);
            const at = target.indexOf('@');
            const hostPart = target.slice(at + 1);
            const bracketed = hostPart.includes(':') && !hostPart.startsWith('[') ? target.slice(0, at + 1) + '[' + hostPart + ']' : target;
            const argv = [...sshDeploy.scpArgs(sshCfg, defaultIdentity), localPath, bracketed + ':' + remotePath];
            execFile(scpBin, argv, { timeout: 60000, env }, (err, stdout, stderr) => {
                if (err) return reject(new HostError('SSH_FAILED', String(stderr || err.message).trim()));
                resolve();
            });
        });
    }

    return { name, local: false, helperPath: helper, target: sshDeploy.sshTarget(sshCfg), exec, spawn: spawnHelper, run, upload };
}

/** Parse the JSON of `she-servicectl list`. */
function parseList(stdout) {
    let data;
    try {
        data = JSON.parse(stdout);
    } catch {
        throw new HostError('EXEC_FAILED', 'unexpected helper output: ' + String(stdout).slice(0, 200));
    }
    return {
        helper: Number(data.helper) || 0,
        helperOutdated: (Number(data.helper) || 0) < HELPER_VERSION,
        hostname: data.hostname || null,
        node: data.node || null,
        brokerEnv: data.brokerEnv === true,
        adapters: Array.isArray(data.adapters) ? data.adapters : [],
        instances: Array.isArray(data.instances) ? data.instances : [],
        /** pre-core single-instance units (<adapter>.service), helper v5+ */
        legacy: Array.isArray(data.legacy) ? data.legacy : [],
    };
}

/** Parse `journalctl -o json` lines into {ts, level, msg, pid}. */
function parseJournal(text) {
    const out = [];
    for (const line of String(text).split('\n')) {
        if (!line.trim()) continue;
        let j;
        try {
            j = JSON.parse(line);
        } catch {
            continue;
        }
        const usec = Number(j.__REALTIME_TIMESTAMP);
        const prio = Number(j.PRIORITY);
        let msg = j.MESSAGE;
        if (Array.isArray(msg)) msg = Buffer.from(msg).toString('utf8'); // journald encodes non-UTF8 as byte arrays
        out.push({
            ts: Number.isFinite(usec) ? Math.round(usec / 1000) : Date.now(),
            level: prio <= 3 ? 'error' : prio === 4 ? 'warn' : prio <= 6 ? 'info' : 'debug',
            msg: typeof msg === 'string' ? msg : String(msg ?? ''),
            pid: j._PID ? Number(j._PID) : null,
        });
    }
    return out;
}

/**
 * Parse an env file into {entries: [{key, value, line}], comments} keeping order.
 * @param {string} text
 */
function parseEnvFile(text) {
    const env = {};
    for (const line of String(text).split('\n')) {
        const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
        if (m) env[m[1]] = m[2];
    }
    return env;
}

/** Serialize an env object to the file format the core writes (header comments + KEY=VALUE). */
function formatEnvFile(env, header = []) {
    const lines = header.map((h) => (h.startsWith('#') ? h : '# ' + h));
    for (const [k, v] of Object.entries(env)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new HostError('HELPER_FAILED', 'invalid env variable name: ' + k);
        if (v === undefined || v === null || v === '') continue;
        lines.push(`${k}=${String(v).replace(/[\r\n]+/g, ' ')}`);
    }
    return lines.join('\n') + '\n';
}

const SECRET_NAME_RE = /(password|passwd|token|secret|cookie|api[-_]?key|private[-_]?key)/i;

/**
 * Environment variable names whose values must be masked: `x-secret` properties
 * of the schema plus the name heuristic (SV-10).
 * @param {object|null} schema `--config-schema` output
 * @param {string[]} [envNames] additional names to test with the heuristic
 * @returns {Set<string>}
 */
function secretEnvVars(schema, envNames = []) {
    const set = new Set();
    const props = schema && schema.properties ? schema.properties : {};
    for (const [key, p] of Object.entries(props)) {
        const envName = p && typeof p['x-env'] === 'string' ? p['x-env'] : null;
        if (!envName) continue;
        if ((p && p['x-secret'] === true) || SECRET_NAME_RE.test(key)) set.add(envName);
    }
    for (const n of envNames) if (SECRET_NAME_RE.test(n)) set.add(n);
    return set;
}

module.exports = {
    HELPER,
    HELPER_VERSION,
    HELPER_SOURCE,
    DEFAULT_SERVICES_IDENTITY,
    HostError,
    createLocalDriver,
    createSshDriver,
    shellQuote,
    parseList,
    parseJournal,
    parseEnvFile,
    formatEnvFile,
    secretEnvVars,
    SECRET_NAME_RE,
};
