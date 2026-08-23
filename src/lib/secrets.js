'use strict';

/**
 * Secrets store (roadmap A5): named groups of string fields, kept in an AES-256-GCM encrypted
 * file under the config dir. Values never leave the daemon — the HTTP API is write-only, the only
 * reader is script code via she.secrets. The key comes from SHE_SECRETS_KEY (hex or base64,
 * 32 bytes) or from a key file next to the data, generated 0600 on first write.
 *
 * The point of the encryption is that a backup or a copied ~/.she holds no plaintext; the key
 * file next to the data protects nothing against a local reader — see doc/security.md.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG_ROOT } = require('./storage');

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_VALUE = 64 * 1024;
const MIN_REDACT = 6;
const ALG = 'aes-256-gcm';

let _file = path.join(CONFIG_ROOT, 'secrets.enc');
let _keyFile = path.join(CONFIG_ROOT, 'secrets.key');
let _env = process.env;

/** @type {Record<string, Record<string, {value: string, changed: number}>>} */
let _data = {};
let _status = 'empty'; // empty | ok | locked | error
let _error = null;
let _keySource = null; // env | file | null
let _redactList = [];

/** Test hook: point the store at other files / another environment and forget everything. */
function init({ file, keyFile, env } = {}) {
    if (file) _file = file;
    if (keyFile) _keyFile = keyFile;
    if (env) _env = env;
    _data = {};
    _status = 'empty';
    _error = null;
    _keySource = null;
    _redactList = [];
}

function validName(n) {
    return typeof n === 'string' && NAME_RE.test(n);
}

function parseKey(str, what) {
    const s = String(str).trim();
    let buf;
    if (/^[0-9a-fA-F]{64}$/.test(s)) buf = Buffer.from(s, 'hex');
    else buf = Buffer.from(s, 'base64');
    if (buf.length !== 32) throw new Error(`${what} must be a 32-byte key as hex (64 chars) or base64`);
    return buf;
}

/** The encryption key, or null when there is none and `create` is false. */
function loadKey({ create = false } = {}) {
    if (_env.SHE_SECRETS_KEY) {
        _keySource = 'env';
        return parseKey(_env.SHE_SECRETS_KEY, 'SHE_SECRETS_KEY');
    }
    try {
        const key = parseKey(fs.readFileSync(_keyFile, 'utf8'), _keyFile);
        _keySource = 'file';
        return key;
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    if (!create) {
        _keySource = null;
        return null;
    }
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(_keyFile), { recursive: true });
    fs.writeFileSync(_keyFile, key.toString('hex') + '\n', { mode: 0o600 });
    _keySource = 'file';
    return key;
}

function encrypt(key, plaintext) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv(ALG, key, iv);
    const data = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return { v: 1, alg: ALG, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(key, obj) {
    const d = crypto.createDecipheriv(ALG, key, Buffer.from(obj.iv, 'base64'));
    d.setAuthTag(Buffer.from(obj.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(obj.data, 'base64')), d.final()]).toString('utf8');
}

function rebuildRedact() {
    const vals = new Set();
    for (const g of Object.values(_data)) for (const f of Object.values(g)) if (f.value.length >= MIN_REDACT) vals.add(f.value);
    _redactList = [...vals].sort((a, b) => b.length - a.length);
}

/**
 * Read the file. Never creates anything. Returns the status.
 * @returns {{status: string, error: string|null, groups: number}}
 */
function load() {
    _data = {};
    _error = null;
    let raw;
    try {
        raw = fs.readFileSync(_file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            _status = 'empty';
            try {
                loadKey();
            } catch (e) {
                _status = 'error';
                _error = e.message;
            }
            rebuildRedact();
            return status();
        }
        _status = 'error';
        _error = err.message;
        return status();
    }
    let key;
    try {
        key = loadKey();
    } catch (err) {
        _status = 'error';
        _error = err.message;
        return status();
    }
    if (!key) {
        _status = 'locked';
        _error = `no key: set SHE_SECRETS_KEY or restore ${_keyFile}`;
        return status();
    }
    try {
        const obj = JSON.parse(raw);
        if (!obj || obj.alg !== ALG) throw new Error('unknown file format');
        const parsed = JSON.parse(decrypt(key, obj));
        _data = parsed && typeof parsed === 'object' ? parsed : {};
        _status = 'ok';
    } catch (err) {
        _status = 'locked';
        _error = /unable to authenticate|auth/i.test(err.message) ? 'wrong key: the file was encrypted with another key' : 'cannot read the file: ' + err.message;
    }
    rebuildRedact();
    return status();
}

function save() {
    const key = loadKey({ create: true });
    fs.mkdirSync(path.dirname(_file), { recursive: true });
    const tmp = _file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(encrypt(key, JSON.stringify(_data))) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, _file);
    _status = 'ok';
    _error = null;
    rebuildRedact();
}

function assertWritable() {
    if (_status === 'locked' || _status === 'error') {
        const err = new Error('secrets store is locked: ' + _error);
        err.code = 'LOCKED';
        throw err;
    }
}

/** Status for the UI / CLI: no values. */
function status() {
    return { status: _status, error: _error, keySource: _keySource, file: _file, keyFile: _keyFile, groups: Object.keys(_data).length };
}

/** Names and change times only. */
function list() {
    return Object.keys(_data)
        .sort()
        .map((name) => {
            const fields = Object.keys(_data[name])
                .sort()
                .map((f) => ({ name: f, changed: _data[name][f].changed }));
            return { name, changed: Math.max(0, ...fields.map((f) => f.changed)), fields };
        });
}

function splitPath(p) {
    if (typeof p !== 'string') return null;
    const parts = p.split('/');
    if (parts.length > 2 || !parts.every(validName)) return null;
    return parts;
}

/** 'group/field' → string, 'group' → frozen {field: value}; undefined when absent or locked. */
function get(p) {
    const parts = splitPath(p);
    if (!parts) return undefined;
    const g = _data[parts[0]];
    if (!g) return undefined;
    if (parts.length === 1) {
        const out = {};
        for (const [f, v] of Object.entries(g)) out[f] = v.value;
        return Object.freeze(out);
    }
    return g[parts[1]] ? g[parts[1]].value : undefined;
}

function has(p) {
    return get(p) !== undefined;
}

function set(group, field, value, now = Date.now()) {
    assertWritable();
    if (!validName(group) || !validName(field)) throw Object.assign(new Error('names: letters, digits, _ . - (max 64)'), { code: 'INVALID_NAME' });
    if (typeof value !== 'string' || value.length === 0) throw Object.assign(new Error('value must be a non-empty string'), { code: 'INVALID_VALUE' });
    if (Buffer.byteLength(value) > MAX_VALUE) throw Object.assign(new Error(`value exceeds ${MAX_VALUE} bytes`), { code: 'INVALID_VALUE' });
    if (!_data[group]) _data[group] = {};
    _data[group][field] = { value, changed: now };
    save();
    return { group, field, changed: now };
}

/** Remove a field, or a whole group when `field` is omitted. Returns false when nothing was there. */
function remove(group, field) {
    assertWritable();
    if (!validName(group) || (field !== undefined && !validName(field))) throw Object.assign(new Error('names: letters, digits, _ . - (max 64)'), { code: 'INVALID_NAME' });
    const g = _data[group];
    if (!g) return false;
    if (field === undefined) delete _data[group];
    else {
        if (!g[field]) return false;
        delete g[field];
        if (Object.keys(g).length === 0) delete _data[group];
    }
    save();
    return true;
}

/** Replace every known secret value (6+ chars) in a log line with ***. */
function redact(str) {
    if (_redactList.length === 0 || typeof str !== 'string') return str;
    let out = str;
    for (const v of _redactList) if (out.includes(v)) out = out.split(v).join('***');
    return out;
}

/**
 * CLI: she --secret-set group/field (value on stdin) | --secret-delete group[/field] | --secret-list.
 * Returns the exit code.
 */
function cli(argv, io = { stdout: process.stdout, stderr: process.stderr, stdin: () => fs.readFileSync(0, 'utf8') }) {
    const [cmd, arg] = argv;
    const st = load();
    const fail = (m) => {
        io.stderr.write('she: ' + m + '\n');
        return 1;
    };
    try {
        if (cmd === '--secret-list') {
            if (st.status === 'locked' || st.status === 'error') return fail('secrets store is locked: ' + st.error);
            for (const g of list()) for (const f of g.fields) io.stdout.write(`${g.name}/${f.name}\t${new Date(f.changed).toISOString()}\n`);
            return 0;
        }
        if (cmd === '--secret-set') {
            const parts = arg && splitPath(arg);
            if (!parts || parts.length !== 2) return fail('usage: she --secret-set <group>/<field>  (value on stdin)');
            const value = String(io.stdin()).replace(/\r?\n$/, '');
            const r = set(parts[0], parts[1], value);
            io.stdout.write(`set ${r.group}/${r.field}\n`);
            return 0;
        }
        if (cmd === '--secret-delete') {
            const parts = arg && splitPath(arg);
            if (!parts) return fail('usage: she --secret-delete <group>[/<field>]');
            if (!remove(parts[0], parts[1])) return fail(`no such secret: ${arg}`);
            io.stdout.write(`deleted ${arg}\n`);
            return 0;
        }
        return fail('unknown secrets command: ' + cmd);
    } catch (err) {
        return fail(err.message);
    }
}

module.exports = { init, load, status, list, get, has, set, remove, redact, cli, validName, NAME_RE, MAX_VALUE, MIN_REDACT };
