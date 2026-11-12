'use strict';

/**
 * Authentication module for the she web server.
 *
 * Supports three modes (configured via config.json `auth` field):
 *   'none'     — no auth, all /she/* routes are open (default)
 *   'password' — single-password session auth with an HttpOnly cookie
 *   'proxy'    — trust a header set by nginx/authentik (e.g. X-Remote-User)
 *
 * Public endpoints (no auth required in any mode):
 *   GET  /she/auth/mode    — returns current mode
 *   POST /she/auth/login   — password mode only; sets session cookie
 *   POST /she/auth/logout  — clears session cookie
 *
 * Protected endpoint (auth required):
 *   POST /she/auth/setup   — change auth mode / password / proxyHeader
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const fs = require('fs');
const path = require('path');

const BCRYPT_ROUNDS = 10;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Session store, keyed by the SHA-256 of the token: neither the memory of the process nor the
// session file holds a value that could be sent as a cookie. The token is 32 random bytes, so a
// plain hash is enough — there is nothing to brute-force.
const _sessions = new Map(); // sha256(token) (hex64) → { createdAt: number }
const SESSION_FILE_VERSION = 1;

/** Ties the session file to the password: a new password, also one set in config.json by hand, ends every session. */
function _passwordTag() {
    return _passwordHash ? crypto.createHash('sha256').update(_passwordHash).digest('hex') : null;
}

let _mode = 'none';
let _passwordHash = null; // bcrypt hash, only used in 'password' mode
let _proxyHeader = 'x-remote-user'; // lowercase for req.headers lookup
let _proxyLogoutUrl = null; // URL to redirect to on logout in proxy mode
let _configPath = null;
let _sessionFile = null; // where the sessions outlive a restart; null keeps them in memory only

/**
 * Initialise auth state. Called once from startServer().
 *
 * `sessionFile` is the file the password-mode sessions are kept in, so that a restart of the daemon
 * does not log everybody out. Without it the sessions live in memory only.
 */
function init({ auth = 'none', password = null, proxyHeader = 'X-Remote-User', proxyLogoutUrl = null, configPath = null, sessionFile = null } = {}) {
    _mode = auth;
    _passwordHash = password || null;
    _proxyHeader = proxyHeader.toLowerCase();
    _proxyLogoutUrl = proxyLogoutUrl || null;
    _configPath = configPath;
    _sessionFile = sessionFile || null;
    _sessions.clear();
    if (_mode === 'password') _loadSessions();
    else _clearSessions(); // sessions left over from an earlier password mode must not come back with it
}

function getMode() {
    return _mode;
}

// ── Session helpers ─────────────────────────────────────────────────────────

function _getSessionToken(req) {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/(?:^|;\s*)she_session=([a-f0-9]{64})/);
    return m ? m[1] : null;
}

function _hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function _expired(createdAt, now = Date.now()) {
    return now - createdAt > SESSION_TTL_MS;
}

/** Drop the expired sessions from memory; true when there were any. */
function _pruneSessions() {
    const now = Date.now();
    let pruned = false;
    for (const [hash, s] of _sessions) {
        if (_expired(s.createdAt, now)) {
            _sessions.delete(hash);
            pruned = true;
        }
    }
    return pruned;
}

/**
 * Read the session file into memory. A missing, unreadable or malformed file — or a malformed
 * entry in it — means "no such session": the worst outcome is a login form, never a daemon that
 * does not start.
 */
function _loadSessions() {
    if (!_sessionFile) return;
    let entries;
    try {
        const data = JSON.parse(fs.readFileSync(_sessionFile, 'utf8'));
        if (
            !data ||
            data.version !== SESSION_FILE_VERSION ||
            data.password !== _passwordTag() ||
            !data.sessions ||
            typeof data.sessions !== 'object' ||
            Array.isArray(data.sessions)
        )
            return;
        entries = Object.entries(data.sessions);
    } catch {
        return;
    }
    const now = Date.now();
    let dropped = false;
    for (const [hash, createdAt] of entries) {
        if (/^[a-f0-9]{64}$/.test(hash) && Number.isFinite(createdAt) && !_expired(createdAt, now)) {
            _sessions.set(hash, { createdAt });
        } else {
            dropped = true;
        }
    }
    if (dropped) _saveSessions();
}

/**
 * Write the sessions to the session file: only the token hashes, readable by the daemon's user
 * only, through a temporary file and a rename so that a crash in between leaves the old file
 * rather than half a new one. A failure (a read-only data directory) is not an error for the
 * caller — the sessions then last as long as the process, as they did before there was a file.
 */
function _saveSessions() {
    if (!_sessionFile) return;
    _pruneSessions();
    const sessions = {};
    for (const [hash, s] of _sessions) sessions[hash] = s.createdAt;
    const tmp = `${_sessionFile}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(path.dirname(_sessionFile), { recursive: true });
        fs.rmSync(tmp, { force: true }); // a leftover would keep its own permissions
        fs.writeFileSync(tmp, JSON.stringify({ version: SESSION_FILE_VERSION, password: _passwordTag(), sessions }) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, _sessionFile);
    } catch {
        try {
            fs.rmSync(tmp, { force: true });
        } catch {
            // nothing to clean up
        }
    }
}

/** Forget every session, in memory and on disk. */
function _clearSessions() {
    _sessions.clear();
    if (!_sessionFile) return;
    try {
        fs.rmSync(_sessionFile, { force: true });
    } catch {
        // not removable: the next write replaces it, and init() ignores it outside password mode
    }
}

function _validateSession(token) {
    if (!token) return false;
    const hash = _hashToken(token);
    const s = _sessions.get(hash);
    if (!s) return false;
    if (_expired(s.createdAt)) {
        _sessions.delete(hash);
        _saveSessions();
        return false;
    }
    return true;
}

// ── Auth check (used by middleware and WS gate) ─────────────────────────────

/**
 * Returns true if the request is authenticated according to the current mode.
 * @param {import('http').IncomingMessage} req
 */
function checkAuth(req) {
    if (_mode === 'none') return true;
    if (_mode === 'proxy') return !!req.headers[_proxyHeader];
    if (_mode === 'password') return _validateSession(_getSessionToken(req));
    return true;
}

/**
 * Express middleware that enforces auth on /she/* routes.
 * Mount this AFTER the public auth router so login/mode/logout bypass it.
 */
function authMiddleware(req, res, next) {
    if (checkAuth(req)) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ── Auth API router ─────────────────────────────────────────────────────────

const router = express.Router();

/** GET /she/auth/mode — always public */
router.get('/mode', (req, res) => {
    const r = { mode: _mode };
    if (_mode === 'proxy' && _proxyLogoutUrl) r.proxyLogoutUrl = _proxyLogoutUrl;
    res.json(r);
});

/** POST /she/auth/login — always public; only meaningful in password mode */
router.post('/login', async (req, res) => {
    if (_mode !== 'password') return res.status(400).json({ error: 'Not in password mode' });
    const { password } = req.body || {};
    if (!password || !_passwordHash) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const ok = await bcrypt.compare(password, _passwordHash);
        if (!ok) return res.status(401).json({ error: 'Invalid password' });
        const token = crypto.randomBytes(32).toString('hex');
        _sessions.set(_hashToken(token), { createdAt: Date.now() });
        _saveSessions();
        res.setHeader('Set-Cookie', `she_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.json({ ok: true });
    } catch {
        res.status(500).json({ error: 'Internal error' });
    }
});

/** POST /she/auth/logout — always public; clears cookie */
router.post('/logout', (req, res) => {
    const token = _getSessionToken(req);
    if (token && _sessions.delete(_hashToken(token))) _saveSessions();
    res.setHeader('Set-Cookie', 'she_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ ok: true });
});

/**
 * POST /she/auth/setup — protected; change auth mode / password / proxyHeader.
 * Body: { mode: 'none'|'password'|'proxy', password?: string, proxyHeader?: string }
 *
 * Self-guards when in password mode (requires valid session).
 */
router.post('/setup', async (req, res) => {
    // Self-guard: in password mode the caller must be authenticated
    if (_mode === 'password' && !_validateSession(_getSessionToken(req))) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { mode, password, proxyHeader, proxyLogoutUrl } = req.body || {};

    if (!['none', 'password', 'proxy'].includes(mode)) {
        return res.status(400).json({ error: 'Invalid auth mode. Must be none, password, or proxy.' });
    }
    if (mode === 'password' && !password) {
        return res.status(400).json({ error: 'A non-empty password is required for password mode.' });
    }

    try {
        // Read existing config
        let cfg = {};
        try {
            cfg = JSON.parse(fs.readFileSync(_configPath, 'utf8'));
        } catch {
            // config file does not exist yet — start from empty
        }

        // Update auth fields, remove stale ones
        cfg.auth = mode;
        delete cfg.password;
        delete cfg.proxyHeader;
        delete cfg.proxyLogoutUrl;

        if (mode === 'password') {
            cfg.password = await bcrypt.hash(password, BCRYPT_ROUNDS);
        }
        if (mode === 'proxy') {
            cfg.proxyHeader = proxyHeader || 'X-Remote-User';
            if (proxyLogoutUrl) cfg.proxyLogoutUrl = proxyLogoutUrl;
        }

        // Write back
        fs.mkdirSync(path.dirname(_configPath), { recursive: true });
        fs.writeFileSync(_configPath, JSON.stringify(cfg, null, 2), 'utf8');

        // Apply in-memory (no restart needed)
        _mode = mode;
        _passwordHash = cfg.password || null;
        _proxyHeader = (cfg.proxyHeader || 'X-Remote-User').toLowerCase();
        _proxyLogoutUrl = cfg.proxyLogoutUrl || null;

        // Leaving password mode ends every session; a new password ends every session but the caller's
        if (mode !== 'password') {
            _clearSessions();
        } else {
            const own = _getSessionToken(req);
            const keep = own && _sessions.get(_hashToken(own));
            _sessions.clear();
            if (keep) _sessions.set(_hashToken(own), keep);
            _saveSessions();
        }

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = { init, authMiddleware, checkAuth, getMode, router };
