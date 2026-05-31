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

// In-memory session store — intentionally cleared on restart
const _sessions = new Map(); // token (hex64) → { createdAt: number }

let _mode = 'none';
let _passwordHash = null; // bcrypt hash, only used in 'password' mode
let _proxyHeader = 'x-remote-user'; // lowercase for req.headers lookup
let _configPath = null;

/**
 * Initialise auth state. Called once from startServer().
 */
function init({ auth = 'none', password = null, proxyHeader = 'X-Remote-User', configPath = null } = {}) {
    _mode = auth;
    _passwordHash = password || null;
    _proxyHeader = proxyHeader.toLowerCase();
    _configPath = configPath;
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

function _validateSession(token) {
    if (!token) return false;
    const s = _sessions.get(token);
    if (!s) return false;
    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
        _sessions.delete(token);
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
    res.json({ mode: _mode });
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
        _sessions.set(token, { createdAt: Date.now() });
        res.setHeader('Set-Cookie', `she_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.json({ ok: true });
    } catch {
        res.status(500).json({ error: 'Internal error' });
    }
});

/** POST /she/auth/logout — always public; clears cookie */
router.post('/logout', (req, res) => {
    const token = _getSessionToken(req);
    if (token) _sessions.delete(token);
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

    const { mode, password, proxyHeader } = req.body || {};

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

        if (mode === 'password') {
            cfg.password = await bcrypt.hash(password, BCRYPT_ROUNDS);
        }
        if (mode === 'proxy') {
            cfg.proxyHeader = proxyHeader || 'X-Remote-User';
        }

        // Write back
        fs.mkdirSync(path.dirname(_configPath), { recursive: true });
        fs.writeFileSync(_configPath, JSON.stringify(cfg, null, 2), 'utf8');

        // Apply in-memory (no restart needed)
        _mode = mode;
        _passwordHash = cfg.password || null;
        _proxyHeader = (cfg.proxyHeader || 'X-Remote-User').toLowerCase();

        // Invalidate all existing sessions when switching away from password mode
        if (mode !== 'password') _sessions.clear();

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = { init, authMiddleware, checkAuth, getMode, router };
