'use strict';

/**
 * The AI chat's memory (roadmap I29, decision D-8): facts the user confirmed, one store per instance in the data
 * directory — `<data-dir>/ai/memory.json`, next to the conversations. Never in the scripts directory (the git
 * auto-commit) and never in a repository. Shown and editable on the AI page; the model may add and remove notes.
 * Every note runs through the secrets redaction, and anything that looks like a key or password is refused.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_NOTES = 300;
const MAX_CHARS = 200;
const SECRET_LIKE =
    /(sk-[a-z0-9]{2,}-?[A-Za-z0-9_-]{8,}|password\s*[:=]|passwort\s*[:=]|api[_ -]?key\s*[:=]|token\s*[:=]|bearer\s+[A-Za-z0-9._-]{16,}|\b[A-Za-z0-9+/]{32,}={0,2}\b)/i;

let _file = null;
let _redact = (s) => s;
let _notes = null;

/**
 * @param {string} dir  the ai directory in the data root
 * @param {(s: string) => string} [redact]
 */
function init(dir, redact) {
    _file = path.join(dir, 'memory.json');
    if (redact) _redact = redact;
    _notes = null;
}

function load() {
    if (_notes) return _notes;
    try {
        const json = JSON.parse(fs.readFileSync(_file, 'utf8'));
        _notes = Array.isArray(json.notes) ? json.notes.filter((n) => n && typeof n.id === 'string' && typeof n.text === 'string') : [];
    } catch {
        _notes = [];
    }
    return _notes;
}

function persist() {
    if (!_file) throw new Error('memory not initialised');
    fs.mkdirSync(path.dirname(_file), { recursive: true });
    const tmp = _file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ notes: _notes }, null, 2));
    fs.renameSync(tmp, _file);
}

/** null when the text may be stored, otherwise the reason */
function refusal(text) {
    const t = String(text || '').trim();
    if (!t) return 'empty note';
    if (t.length > MAX_CHARS) return `a note has at most ${MAX_CHARS} characters (${t.length} given); split it or shorten it`;
    if (SECRET_LIKE.test(t)) return 'this looks like a key, a token or a password; secrets belong in the Secrets tab, not in the memory';
    return null;
}

function list() {
    if (!_file) return [];
    return load().map((n) => ({ ...n }));
}

/** @returns {{ note?: object, error?: string }} */
function add(text, source = 'user') {
    if (!_file) return { error: 'memory not initialised' };
    const why = refusal(text);
    if (why) return { error: why };
    const notes = load();
    const clean = _redact(String(text).trim().replace(/\s+/g, ' '));
    const dup = notes.find((n) => n.text.toLowerCase() === clean.toLowerCase());
    if (dup) return { note: { ...dup }, duplicate: true };
    if (notes.length >= MAX_NOTES) return { error: `the memory holds at most ${MAX_NOTES} notes; forget one first` };
    const note = { id: 'n' + crypto.randomBytes(4).toString('hex'), text: clean, createdAt: Date.now(), source: source === 'model' ? 'model' : 'user' };
    notes.push(note);
    persist();
    return { note: { ...note } };
}

function update(id, text) {
    if (!_file) return { error: 'memory not initialised' };
    const why = refusal(text);
    if (why) return { error: why };
    const notes = load();
    const note = notes.find((n) => n.id === id);
    if (!note) return { error: `no note ${id}` };
    note.text = _redact(String(text).trim().replace(/\s+/g, ' '));
    note.source = 'user'; // edited by hand
    note.updatedAt = Date.now();
    persist();
    return { note: { ...note } };
}

function remove(id) {
    if (!_file) return { error: 'memory not initialised' };
    const notes = load();
    const idx = notes.findIndex((n) => n.id === id);
    if (idx === -1) return { error: `no note ${id}` };
    const [note] = notes.splice(idx, 1);
    persist();
    return { note };
}

module.exports = { init, list, add, update, remove, refusal, MAX_NOTES, MAX_CHARS };
