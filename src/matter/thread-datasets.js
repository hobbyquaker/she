'use strict';

/**
 * The Thread dataset store (roadmap M17, D-13): the operational datasets — the credentials — of
 * the Thread networks she knows, one per extended PAN ID, kept encrypted at rest with the secrets
 * store's key in the Matter storage (`thread-datasets.enc`), never exposed to scripts, never
 * logged. Shown redacted (no network key, no PSKc); the full TLV only through `reveal()`.
 *
 * The TLV is decoded here (a few lines — the format is type, length, value), so the store does not
 * depend on the codec's shape in matter.js.
 */

const path = require('path');

let _log = null;
let _broadcast = null;
let _dir = null;
/** extPanIdHex → { tlv, source, added, note, meshcop } */
let _data = null;
let _error = null;

const SOURCES = ['pasted', 'qr', 'router', 'donor', 'sharing'];

function fileFor(dir) {
    return path.join(dir, 'thread-datasets.enc');
}

function _load() {
    const { readEncryptedFile } = require('../lib/secrets');
    try {
        const raw = readEncryptedFile(fileFor(_dir));
        _data = raw && typeof raw === 'object' && raw.datasets && typeof raw.datasets === 'object' ? raw.datasets : {};
        _error = null;
    } catch (err) {
        _data = null;
        _error = err.message;
        _log?.error(`matter thread: the dataset store cannot be read: ${err.message}`);
    }
}

function _save() {
    const { writeEncryptedFile } = require('../lib/secrets');
    writeEncryptedFile(fileFor(_dir), { v: 1, datasets: _data });
}

function _require() {
    if (!_data) throw new Error(`the Thread dataset store is not available: ${_error ?? 'not loaded'}`);
    return _data;
}

function init({ storageDir, log, broadcast } = {}) {
    _log = log ?? _log;
    _broadcast = broadcast ?? _broadcast;
    _dir = storageDir;
    _load();
    const n = _data ? Object.keys(_data).length : 0;
    if (n) _log?.info(`matter thread: ${n} Thread dataset(s) known`);
}

function _hex(bytes) {
    if (!bytes) return null;
    return Buffer.from(bytes).toString('hex').toUpperCase();
}

/** Clean a pasted TLV: hex with or without `0x`, spaces, colons, dashes. */
function normaliseTlv(input) {
    const s = String(input ?? '')
        .trim()
        .replace(/^0x/i, '')
        .replace(/[\s:-]/g, '');
    if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2 !== 0 || s.length < 8)
        throw new Error("the dataset must be the hex TLV string (e.g. from `ot-ctl dataset active -x` or the border router's dataset QR)");
    return s.toLowerCase();
}

/** Thread MeshCoP dataset TLV types (Thread specification, Table 8-2). */
const TLV_TYPES = {
    0: 'channel',
    1: 'panId',
    2: 'extPanId',
    3: 'networkName',
    4: 'pskc',
    5: 'networkKey',
    7: 'meshLocalPrefix',
    12: 'securityPolicy',
    14: 'activeTimestamp',
    51: 'pendingTimestamp',
    52: 'delayTimer',
    53: 'channelMask',
};

/**
 * Decode a dataset TLV hex (type, length, value — one byte each for type and length, a length of
 * 255 means an extended two-byte length). Small and self-contained so the store does not depend
 * on the codec's shape in matter.js; throws on garbage.
 * @returns {{ channel?: number, panId?: number, extPanId?: Buffer, networkName?: string, pskc?: Buffer, networkKey?: Buffer, meshLocalPrefix?: Buffer, securityPolicy?: { rotationTime: number, flags: number }, activeTimestamp?: Buffer, channelMask?: Buffer, unknownTlvs: { type: number, value: Buffer }[] }}
 */
function decode(tlvHex) {
    const buf = Buffer.from(normaliseTlv(tlvHex), 'hex');
    const ds = { unknownTlvs: [] };
    let i = 0;
    while (i < buf.length) {
        const type = buf[i++];
        if (i >= buf.length) throw new Error(`truncated TLV at offset ${i}`);
        let len = buf[i++];
        if (len === 0xff) {
            if (i + 2 > buf.length) throw new Error(`truncated TLV length at offset ${i}`);
            len = buf.readUInt16BE(i);
            i += 2;
        }
        if (i + len > buf.length) throw new Error(`truncated TLV value at offset ${i} (type ${type}, length ${len})`);
        const value = buf.subarray(i, i + len);
        i += len;
        switch (TLV_TYPES[type]) {
            case 'channel':
                ds.channel = len >= 3 ? value.readUInt16BE(1) : null;
                break;
            case 'panId':
                ds.panId = len >= 2 ? value.readUInt16BE(0) : null;
                break;
            case 'extPanId':
                ds.extPanId = Buffer.from(value);
                break;
            case 'networkName':
                ds.networkName = value.toString('utf8');
                break;
            case 'pskc':
                ds.pskc = Buffer.from(value);
                break;
            case 'networkKey':
                ds.networkKey = Buffer.from(value);
                break;
            case 'meshLocalPrefix':
                ds.meshLocalPrefix = Buffer.from(value);
                break;
            case 'securityPolicy':
                ds.securityPolicy = len >= 3 ? { rotationTime: value.readUInt16BE(0), flags: value[2] } : null;
                break;
            case 'activeTimestamp':
                ds.activeTimestamp = Buffer.from(value);
                break;
            case 'channelMask':
                ds.channelMask = Buffer.from(value);
                break;
            default:
                ds.unknownTlvs.push({ type, value: Buffer.from(value) });
        }
    }
    if (!ds.extPanId || ds.extPanId.length !== 8) throw new Error('the dataset has no extended PAN ID — not a complete active dataset');
    return ds;
}

/** The dataset without its secrets. */
function redact(ds) {
    const { pskc: _p, networkKey: _k, ...rest } = ds;
    return rest;
}

/** The redacted view of one entry: everything but the network key and the PSKc. */
function _view(extPanId, entry) {
    let ds = null;
    try {
        ds = redact(decode(entry.tlv));
    } catch {
        /* an undecodable entry still lists */
    }
    return {
        extPanId,
        networkName: ds?.networkName ?? null,
        channel: ds?.channel ?? null,
        panId: ds?.panId === undefined ? null : Number(ds.panId),
        meshLocalPrefix: _hex(ds?.meshLocalPrefix),
        activeTimestamp: _hex(ds?.activeTimestamp),
        channelMask: _hex(ds?.channelMask),
        securityPolicy: ds?.securityPolicy ?? null,
        hasNetworkKey: !!decodeSafe(entry.tlv)?.networkKey,
        hasPskc: !!decodeSafe(entry.tlv)?.pskc,
        source: entry.source ?? null,
        note: entry.note ?? null,
        added: entry.added ?? null,
        meshcop: entry.meshcop === true,
    };
}

function decodeSafe(tlv) {
    try {
        return decode(tlv);
    } catch {
        return null;
    }
}

/** The known datasets, redacted. */
function list() {
    if (!_data) return { available: false, error: _error, datasets: [] };
    return { available: true, error: null, datasets: Object.entries(_data).map(([k, v]) => _view(k, v)) };
}

function has(extPanId) {
    return !!(_data && extPanId && _data[String(extPanId).toUpperCase()]);
}

/**
 * Import a dataset from its TLV hex.
 * @param {{ tlv: string, source?: string, note?: string }} opts
 */
function add({ tlv, source = 'pasted', note = '' } = {}) {
    const data = _require();
    const clean = normaliseTlv(tlv);
    const ds = decode(clean);
    const key = _hex(ds.extPanId);
    const existed = !!data[key];
    data[key] = {
        tlv: clean,
        source: SOURCES.includes(source) ? source : 'pasted',
        note: String(note ?? '').slice(0, 200),
        added: Date.now(),
        meshcop: data[key]?.meshcop === true,
    };
    _save();
    _log?.info(`matter thread: dataset for "${ds.networkName ?? key}" ${existed ? 'replaced' : 'added'} (${source})`);
    _broadcast?.({ type: 'matter:thread' });
    return _view(key, data[key]);
}

function remove(extPanId) {
    const data = _require();
    const key = String(extPanId).toUpperCase();
    if (!data[key]) throw new Error(`no dataset for ${key}`);
    delete data[key];
    _save();
    _log?.info(`matter thread: dataset ${key} removed`);
    _broadcast?.({ type: 'matter:thread' });
    return { ok: true };
}

/** Switch the MeshCoP diagnostics through a border router on or off for a network (off by default). */
function setMeshcop(extPanId, enabled) {
    const data = _require();
    const key = String(extPanId).toUpperCase();
    if (!data[key]) throw new Error(`no dataset for ${key}`);
    data[key].meshcop = enabled === true;
    _save();
    _broadcast?.({ type: 'matter:thread' });
    return _view(key, data[key]);
}

/** The full TLV — behind the UI's explicit reveal with a confirmation. Never logged. */
function reveal(extPanId) {
    const data = _require();
    const key = String(extPanId).toUpperCase();
    if (!data[key]) throw new Error(`no dataset for ${key}`);
    return { extPanId: key, tlv: data[key].tlv };
}

/** The decoded dataset for internal use (MeshCoP, a border router push later); null when unknown. */
function dataset(extPanId) {
    if (!_data) return null;
    const e = _data[String(extPanId).toUpperCase()];
    return e ? decodeSafe(e.tlv) : null;
}

/** `ThreadNetworkCredentials` for `@matter/thread-br-client`'s MeshCoP path, when the dataset has a PSKc and MeshCoP is on. */
function credentialsFor(extPanId) {
    const e = _data?.[String(extPanId).toUpperCase()];
    if (!e || e.meshcop !== true) return null;
    const ds = decodeSafe(e.tlv);
    if (!ds?.pskc) return null;
    return {
        extPanId: ds.extPanId,
        networkName: ds.networkName ?? '',
        pskc: ds.pskc,
        meshLocalPrefix: ds.meshLocalPrefix,
        activeTimestamp: ds.activeTimestamp ? BigInt('0x' + _hex(ds.activeTimestamp)) : undefined,
    };
}

/** Test hook. */
function _reset() {
    _data = null;
    _error = null;
    _dir = null;
}

module.exports = { init, list, has, add, remove, setMeshcop, reveal, dataset, credentialsFor, normaliseTlv, decode, redact, fileFor, SOURCES, TLV_TYPES, _reset };
