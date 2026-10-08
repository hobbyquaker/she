'use strict';

/**
 * Script drafts the AI proposes (roadmap I16, decision D-1): written to `<data-dir>/ai/drafts/<id>.json`, shown in
 * the chat as a diff with an Apply button; nothing lands in the scripts directory without that click. Drafts older
 * than a week are pruned at daemon start.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEEP_MS = 7 * 24 * 3600 * 1000;
let _dir = null;

function init(dir) {
    _dir = dir;
    try {
        fs.mkdirSync(_dir, { recursive: true });
        const now = Date.now();
        for (const n of fs.readdirSync(_dir)) {
            if (!n.endsWith('.json')) continue;
            const f = path.join(_dir, n);
            try {
                if (now - fs.statSync(f).mtimeMs > KEEP_MS) fs.rmSync(f, { force: true });
            } catch {
                /* ignore */
            }
        }
    } catch {
        /* the directory is created on the first draft */
    }
}

function file(id) {
    if (!/^d[0-9a-f]{8}$/.test(id)) return null;
    return path.join(_dir, id + '.json');
}

/** @returns {object} the draft */
function create({ path: scriptPath, content, base, note }) {
    if (!_dir) throw new Error('drafts not initialised');
    fs.mkdirSync(_dir, { recursive: true });
    const draft = { id: 'd' + crypto.randomBytes(4).toString('hex'), path: scriptPath, content, base: base ?? null, note: note || '', createdAt: Date.now(), status: 'open' };
    fs.writeFileSync(file(draft.id), JSON.stringify(draft));
    return draft;
}

function get(id) {
    const f = _dir && file(id);
    if (!f) return null;
    try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
        return null;
    }
}

function setStatus(id, status) {
    const d = get(id);
    if (!d) return null;
    d.status = status;
    d.updatedAt = Date.now();
    fs.writeFileSync(file(id), JSON.stringify(d));
    return d;
}

module.exports = { init, create, get, setStatus };
