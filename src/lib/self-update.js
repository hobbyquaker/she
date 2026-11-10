'use strict';
/**
 * she's own update: how the version the update check offers gets installed, and when the daemon
 * may restart afterwards.
 *
 * The daemon runs as the `she` user without a general sudo. Since 3.0.0-beta.2 the install goes
 * through the privileged helper — `she-servicectl she-update <version>` (helper v16) — which checks
 * the version strictly and runs `npm install -g smart-home-engine@<version>` as root through the one
 * sudoers rule every installation has. A host whose helper is older than that is asked to update
 * the helper first. (Up to 3.0.0-beta.1 the update ran `sudo npm install -g smart-home-engine`
 * through a sudoers rule of its own; that rule could only ever install npm's `latest`, is no longer
 * written by `she --install` and is not used any more.)
 *
 * The restart happens only after npm exited 0. A failure keeps the daemon running and reports npm's
 * exit code and the last lines of its output.
 */

const activity = require('./activity');

const VERSION_RX = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
/** the first helper version with the `she-update` command */
const HELPER_SHE_UPDATE_VERSION = 16;
const PACKAGE = 'smart-home-engine';
const HELPER = '/usr/local/bin/she-servicectl';
const HELPER_NEEDED = 'update needs the current she-servicectl helper — Update helper on the Services → Hosts tab, or run `sudo she --install` once';
/** output lines kept for the log and the error message */
const TAIL_LINES = 12;
const TAIL_LINES_IN_ERROR = 3;

/** A release version as npm publishes it: `3.0.0`, `3.0.0-beta.2` — no ranges, tags, URLs or spaces. */
function isValidVersion(v) {
    return typeof v === 'string' && VERSION_RX.test(v);
}

/** The helper version a driver reports, or null when the helper is missing, denied or unreadable. */
async function helperVersionOf(driver) {
    try {
        const { stdout } = await driver.exec(['version'], { timeout: 20000 });
        const n = Number(String(stdout).trim());
        return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
        return null;
    }
}

/**
 * How to install `version`: through the helper when it has `she-update`, otherwise not at all.
 * @param {{version: string, helperVersion: number|null}} ctx
 * @returns {{mode: 'helper'}|{error: string}}
 */
function planUpdate({ version, helperVersion }) {
    if (!isValidVersion(version)) return { error: `not a release version: ${version}` };
    if (Number.isInteger(helperVersion) && helperVersion >= HELPER_SHE_UPDATE_VERSION) return { mode: 'helper' };
    return { error: HELPER_NEEDED };
}

/** The command a plan runs: `[cmd, argv]`. */
function commandFor(plan, version, { helper = HELPER } = {}) {
    if (plan.mode === 'helper') return ['sudo', ['-n', helper, 'she-update', version]];
    throw new Error('no command for this plan');
}

/**
 * Run the install and wait for it. Never rejects.
 * @param {[string, string[]]} command
 * @param {{spawn: Function, onLine?: (line: string) => void}} opts spawn: child_process.spawn or a stub
 * @returns {Promise<{ok: boolean, code: number|null, signal: string|null, tail: string[], reason: string}>}
 */
function runInstall([cmd, argv], { spawn, onLine } = {}) {
    return new Promise((resolve) => {
        const tail = [];
        let partial = '';
        const take = (chunk) => {
            partial += String(chunk);
            const lines = partial.split(/\r?\n/);
            partial = lines.pop();
            for (const raw of lines) {
                const line = raw.replace(/\r/g, '').trimEnd();
                if (!line.trim()) continue;
                tail.push(line);
                if (tail.length > TAIL_LINES) tail.shift();
                if (onLine) onLine(line);
            }
        };
        const finish = (ok, code, signal, reason) => {
            if (partial.trim()) take('\n');
            resolve({ ok, code, signal, tail: tail.slice(), reason });
        };
        let child;
        try {
            child = activity.track(spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] }), activity.commandLabel(cmd, argv));
        } catch (err) {
            finish(false, null, null, `could not start ${cmd}: ${err.message}`);
            return;
        }
        if (child.stdout) child.stdout.on('data', take);
        if (child.stderr) child.stderr.on('data', take);
        let done = false;
        child.on('error', (err) => {
            if (done) return;
            done = true;
            finish(false, null, null, `could not start ${cmd}: ${err.message}`);
        });
        child.on('close', (code, signal) => {
            if (done) return;
            done = true;
            if (code === 0) finish(true, 0, null, 'ok');
            else finish(false, code, signal, signal ? `npm was killed by ${signal}` : `npm exited ${code}`);
        });
    });
}

/**
 * Install `version` as planned and restart only when npm succeeded.
 * @param {{plan: {mode: string}, version: string, spawn: Function, onRestart: Function, log?: (level: string, msg: string) => void, helper?: string}} opts
 * @returns {Promise<{ok: true}|{ok: false, error: string}>} `error` is what the UI shows
 */
async function performUpdate({ plan, version, spawn, onRestart, log = () => {}, helper }) {
    const command = commandFor(plan, version, { helper });
    log('info', `update: installing ${PACKAGE}@${version} through she-servicectl`);
    const r = await runInstall(command, { spawn, onLine: (line) => log('info', `update: ${line}`) });
    if (r.ok) {
        log('info', `update: ${version} installed, restarting`);
        onRestart();
        return { ok: true };
    }
    const tail = r.tail.slice(-TAIL_LINES_IN_ERROR).join(' | ');
    const error = `update to ${version} failed: ${r.reason}${tail ? ' — ' + tail : ''}`;
    log('error', `${error}${r.tail.length ? '\n' + r.tail.join('\n') : ''}`);
    return { ok: false, error };
}

module.exports = { HELPER_SHE_UPDATE_VERSION, HELPER_NEEDED, PACKAGE, VERSION_RX, isValidVersion, helperVersionOf, planUpdate, commandFor, runInstall, performUpdate };
