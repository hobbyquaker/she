'use strict';

/**
 * mosquitto-conf — parser, writer and reload helper for mosquitto.conf.
 *
 * she "owns" a single managed config file (path configured at
 * config.broker.configDir + '/mosquitto.conf'). It reads the file, merges
 * managed sections, and writes it back with a timestamped backup.
 *
 * Managed keys handled via structured API:
 *   - listener blocks (each keyed by port)
 *   - plugin (dynsec)
 *   - log_dest / log_type
 *   - persistence / persistence_location
 *   - allow_anonymous
 *
 * Everything else is preserved verbatim in the "advanced" passthrough block.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Keys that she manages — all others are treated as passthrough
// NOTE: 'plugin_opt_dynsec_config_file' is kept here only for migration —
// when read from an old conf it is normalised to 'plugin_opt_config_file' on
// the same line that recognises it (see parseText below).
const MANAGED_SINGLE_KEYS = new Set(['allow_anonymous', 'persistence', 'persistence_location', 'log_dest', 'log_type', 'plugin', 'plugin_opt_config_file', 'plugin_opt_dynsec_config_file']);

/**
 * Parse mosquitto.conf text into a structured object.
 *
 * @param {string} raw - raw mosquitto.conf content
 * @returns {{ listeners: object[], managed: object, passthrough: string[], raw: string }}
 */
function parseText(raw) {
    const lines = raw.split('\n');
    const managed = {};
    const listeners = [];
    const passthrough = [];
    let currentListener = null;

    for (const line of lines) {
        const trimmed = line.trim();
        // blank lines and comments go to passthrough
        if (!trimmed || trimmed.startsWith('#')) {
            passthrough.push(line);
            continue;
        }

        const spaceIdx = trimmed.indexOf(' ');
        if (spaceIdx === -1) {
            passthrough.push(line);
            continue;
        }

        const key = trimmed.slice(0, spaceIdx).trim();
        const value = trimmed.slice(spaceIdx + 1).trim();

        if (key === 'listener') {
            const parts = value.split(/\s+/);
            currentListener = {
                port: parseInt(parts[0], 10),
                bindAddress: parts[1] || '',
                protocol: 'mqtt',
                tls: {},
            };
            listeners.push(currentListener);
        } else if (currentListener && isListenerSubkey(key)) {
            applyListenerKey(currentListener, key, value);
        } else if (MANAGED_SINGLE_KEYS.has(key)) {
            // Normalise the old (incorrect) key name written by earlier she versions
            const managedKey = key === 'plugin_opt_dynsec_config_file' ? 'plugin_opt_config_file' : key;
            if (managed[managedKey] !== undefined) {
                managed[managedKey] = [].concat(managed[managedKey]).concat(value);
            } else {
                managed[managedKey] = value;
            }
            currentListener = null;
        } else {
            passthrough.push(line);
            currentListener = null;
        }
    }

    return { listeners, managed, passthrough, raw };
}

/**
 * Parse a mosquitto.conf file into a structured object.
 *
 * @param {string} filePath
 * @returns {{ listeners: object[], managed: object, passthrough: string[], raw: string }}
 */
function parse(filePath) {
    let raw = '';
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return { listeners: [], managed: {}, passthrough: [], raw: '' };
    }
    return parseText(raw);
}

/** Keys that belong to a listener block */
function isListenerSubkey(key) {
    return [
        'protocol',
        'socket_domain',
        'certfile',
        'keyfile',
        'cafile',
        'capath',
        'crlfile',
        'require_certificate',
        'use_identity_as_username',
        'tls_version',
        'websockets_log_level',
    ].includes(key);
}

function applyListenerKey(listener, key, value) {
    switch (key) {
        case 'protocol':
            listener.protocol = value;
            break;
        case 'certfile':
        case 'keyfile':
        case 'cafile':
        case 'capath':
        case 'crlfile':
        case 'tls_version':
            listener.tls[key] = value;
            break;
        case 'require_certificate':
            listener.tls.require_certificate = value === 'true';
            break;
        case 'use_identity_as_username':
            listener.tls.use_identity_as_username = value === 'true';
            break;
        default:
            break;
    }
}

/**
 * Serialise the structured config back to mosquitto.conf text.
 *
 * @param {{ listeners: object[], managed: object, passthrough: string[] }} conf
 * @returns {string}
 */
function serialise(conf) {
    const lines = [];

    // Managed single-key entries first
    const { managed = {}, listeners = [], passthrough = [] } = conf;

    const keyOrder = ['allow_anonymous', 'persistence', 'persistence_location', 'log_dest', 'log_type', 'plugin', 'plugin_opt_config_file'];
    for (const key of keyOrder) {
        if (managed[key] === undefined) continue;
        const val = managed[key];
        if (Array.isArray(val)) {
            for (const v of val) lines.push(`${key} ${v}`);
        } else {
            lines.push(`${key} ${val}`);
        }
    }

    if (lines.length > 0) lines.push('');

    // Listener blocks
    for (const l of listeners) {
        const addr = l.bindAddress ? ` ${l.bindAddress}` : '';
        lines.push(`listener ${l.port}${addr}`);
        if (l.protocol && l.protocol !== 'mqtt') lines.push(`protocol ${l.protocol}`);
        const tls = l.tls || {};
        for (const tlsKey of ['certfile', 'keyfile', 'cafile', 'capath', 'crlfile', 'tls_version']) {
            if (tls[tlsKey]) lines.push(`${tlsKey} ${tls[tlsKey]}`);
        }
        if (tls.require_certificate !== undefined) {
            lines.push(`require_certificate ${tls.require_certificate ? 'true' : 'false'}`);
        }
        if (tls.use_identity_as_username !== undefined) {
            lines.push(`use_identity_as_username ${tls.use_identity_as_username ? 'true' : 'false'}`);
        }
        lines.push('');
    }

    // Passthrough (comments, blanks, unmanaged keys)
    for (const l of passthrough) lines.push(l);

    return lines.join('\n');
}

/**
 * SHA-256 checksum of a file path. Returns null if file does not exist.
 */
function checksum(filePath) {
    try {
        const data = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(data).digest('hex');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

/**
 * Write config to disk with a timestamped backup.
 * If knownChecksum is provided and the file has been modified externally,
 * returns { ok: false, reason: 'external_modify' } instead of writing.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {string|null} [knownChecksum]
 * @returns {{ ok: boolean, backupPath?: string, reason?: string }}
 */
function write(filePath, content, knownChecksum = null) {
    if (knownChecksum !== null) {
        const current = checksum(filePath);
        if (current !== null && current !== knownChecksum) {
            return { ok: false, reason: 'external_modify' };
        }
    }

    // Create backup
    let backupPath = null;
    if (fs.existsSync(filePath)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = `${filePath}.bak-${ts}`;
        fs.copyFileSync(filePath, backupPath);
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');

    return { ok: true, backupPath };
}

/**
 * List backup files for a given config path.
 * @param {string} filePath
 * @returns {string[]} sorted newest-first
 */
function listBackups(filePath) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return entries
        .filter((e) => e.startsWith(`${base}.bak-`))
        .sort()
        .reverse()
        .map((e) => path.join(dir, e));
}

/**
 * Restore a backup file over the live config.
 * @param {string} backupPath
 * @param {string} destPath
 */
function restoreBackup(backupPath, destPath) {
    fs.copyFileSync(backupPath, destPath);
}

/**
 * Send SIGHUP to mosquitto (for local mode where she can signal the process).
 * Falls back to running the configured reloadCmd.
 *
 * @param {object} brokerConfig  - config.broker
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function reload(brokerConfig) {
    const cmd = brokerConfig.reloadCmd || 'sudo systemctl reload mosquitto';
    const [bin, ...args] = cmd.split(/\s+/);
    const result = await execFileAsync(bin, args, { timeout: 10000 });
    return result;
}

/**
 * Full restart of the mosquitto service.
 * @param {object} brokerConfig
 */
async function restart(brokerConfig) {
    const cmd = brokerConfig.restartCmd || 'sudo systemctl restart mosquitto';
    const [bin, ...args] = cmd.split(/\s+/);
    const result = await execFileAsync(bin, args, { timeout: 15000 });
    return result;
}

module.exports = { parse, parseText, serialise, checksum, write, listBackups, restoreBackup, reload, restart };
