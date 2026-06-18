'use strict';

const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { STORAGE_ROOT } = require('../lib/storage');

/** Cache of outdated packages: { [name]: { current, latest } } or null while unchecked. */
let _outdated = null;
/** In-flight promise for the current outdated check, to avoid duplicate runs. */
let _outdatedPromise = null;

function _checkOutdated() {
    if (_outdatedPromise) return _outdatedPromise;
    const pkg = readPackageJson();
    if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) {
        _outdated = {};
        return Promise.resolve({});
    }
    _outdatedPromise = new Promise((resolve) => {
        execFile('npm', ['outdated', '--json'], { cwd: STORAGE_ROOT, timeout: 60_000 }, (err, stdout) => {
            _outdatedPromise = null;
            // npm exits with code 1 when packages are outdated — not a real error
            if (err && err.code !== 1) {
                resolve(_outdated ?? {});
                return;
            }
            try {
                const data = JSON.parse(stdout || '{}');
                _outdated = {};
                for (const [name, info] of Object.entries(data)) {
                    _outdated[name] = { current: info.current, latest: info.latest };
                }
            } catch {
                /* ignore parse errors */
            }
            resolve(_outdated ?? {});
        });
    });
    return _outdatedPromise;
}

const router = express.Router();

/** Ensure ~/.she/package.json exists so npm commands work. */
function ensurePackageJson() {
    const pkgPath = path.join(STORAGE_ROOT, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        fs.writeFileSync(
            pkgPath,
            JSON.stringify(
                {
                    name: 'she-user-scripts',
                    version: '1.0.0',
                    private: true,
                    description: 'User-installed npm packages for she scripts',
                    dependencies: {},
                },
                null,
                2,
            ) + '\n',
            'utf8',
        );
    }
}

function readPackageJson() {
    try {
        return JSON.parse(fs.readFileSync(path.join(STORAGE_ROOT, 'package.json'), 'utf8'));
    } catch {
        return { dependencies: {} };
    }
}

/**
 * Strict npm package-name validation.
 * Allows scoped (@scope/name) and plain names; lowercase; no path traversal.
 */
function isValidPkgName(name) {
    return typeof name === 'string' && name.length > 0 && name.length <= 214 && /^(@[a-z0-9][a-z0-9_\-.]*\/)?[a-z0-9][a-z0-9_\-.]*$/.test(name);
}

/** Allow semver ranges, tags, and dist-tags (no shell-special chars). */
function isValidVersion(v) {
    return typeof v === 'string' && v.length > 0 && v.length <= 50 && /^[a-z0-9_\-.*^~>=<|]+$/i.test(v);
}

// Start background outdated check on module load + refresh every 24 h
_checkOutdated();
setInterval(_checkOutdated, 24 * 60 * 60 * 1000);

// GET /she/deps  — list installed packages from ~/.she/package.json
router.get('/', (req, res) => {
    const pkg = readPackageJson();
    const deps = pkg.dependencies || {};
    res.json(
        Object.entries(deps).map(([name, version]) => {
            let url = `https://www.npmjs.com/package/${encodeURIComponent(name)}`;
            let installedVersion;
            try {
                const meta = JSON.parse(fs.readFileSync(path.join(STORAGE_ROOT, 'node_modules', name, 'package.json'), 'utf8'));
                installedVersion = meta.version;
                if (meta.homepage && /^https?:\/\//.test(meta.homepage)) {
                    url = meta.homepage;
                } else {
                    let repo = typeof meta.repository === 'object' ? meta.repository.url : meta.repository;
                    if (typeof repo === 'string' && repo) {
                        repo = repo
                            .replace(/^git\+/, '')
                            .replace(/\.git$/, '')
                            .replace(/^git:\/\//, 'https://');
                        if (/^https?:\/\//.test(repo)) url = repo;
                        else {
                            const m = repo.match(/^(?:github:|github\.com[:/])?([\w.-]+\/[\w.-]+)$/);
                            if (m) url = `https://github.com/${m[1]}`;
                        }
                    }
                }
            } catch {
                /* not installed or no metadata */
            }
            return { name, version, installedVersion, url };
        }),
    );
});

// GET /she/deps/outdated  — return cached outdated map { [name]: { current, latest } }
router.get('/outdated', (req, res) => {
    res.json(_outdated ?? {});
});

// POST /she/deps/check-outdated  — force a fresh check and return result
router.post('/check-outdated', async (req, res) => {
    _outdated = null;
    _outdatedPromise = null;
    try {
        const result = await _checkOutdated();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /she/deps/search?q=term  — search the npm registry
router.get('/search', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.status(400).json({ error: 'Missing q parameter' });

    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=20`;
    const npmReq = https.get(url, { timeout: 10000 }, (npmRes) => {
        let data = '';
        npmRes.on('data', (chunk) => {
            data += chunk;
        });
        npmRes.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                const results = (parsed.objects ?? []).map((obj) => ({
                    name: obj.package.name,
                    version: obj.package.version,
                    description: obj.package.description ?? '',
                    url:
                        obj.package.links?.repository ||
                        obj.package.links?.homepage ||
                        obj.package.links?.npm ||
                        `https://www.npmjs.com/package/${encodeURIComponent(obj.package.name)}`,
                    author: obj.package.publisher?.username || obj.package.author?.name || (obj.package.maintainers?.[0]?.username ?? null),
                    date: obj.package.date ?? null,
                }));
                res.json(results);
            } catch {
                if (!res.headersSent) res.status(502).json({ error: 'Failed to parse npm registry response' });
            }
        });
    });
    npmReq.on('error', (err) => {
        if (!res.headersSent) res.status(502).json({ error: err.message });
    });
    npmReq.on('timeout', () => {
        npmReq.destroy();
        if (!res.headersSent) res.status(504).json({ error: 'npm registry timeout' });
    });
});

// POST /she/deps/install  — { name, version? }
router.post('/install', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const version = req.body?.version ? String(req.body.version).trim() : null;

    if (!isValidPkgName(name)) return res.status(400).json({ error: 'Invalid package name' });
    if (version !== null && !isValidVersion(version)) return res.status(400).json({ error: 'Invalid version specifier' });

    ensurePackageJson();
    const spec = version ? `${name}@${version}` : name;
    execFile('npm', ['install', '--save', spec], { cwd: STORAGE_ROOT, timeout: 120000 }, (err, stdout, stderr) => {
        if (err) return res.status(500).json({ error: stderr || err.message, stdout });
        res.json({ ok: true, stdout, stderr });
    });
});

// POST /she/deps/remove  — { name }
router.post('/remove', (req, res) => {
    const name = String(req.body?.name ?? '').trim();

    if (!isValidPkgName(name)) return res.status(400).json({ error: 'Invalid package name' });

    ensurePackageJson();
    execFile('npm', ['uninstall', '--save', name], { cwd: STORAGE_ROOT, timeout: 60000 }, (err, stdout, stderr) => {
        if (err) return res.status(500).json({ error: stderr || err.message, stdout });
        res.json({ ok: true, stdout, stderr });
    });
});

// POST /she/deps/update  — { name }
router.post('/update', (req, res) => {
    const name = String(req.body?.name ?? '').trim();

    if (!isValidPkgName(name)) return res.status(400).json({ error: 'Invalid package name' });

    ensurePackageJson();
    execFile('npm', ['install', '--save', `${name}@latest`], { cwd: STORAGE_ROOT, timeout: 120000 }, (err, stdout, stderr) => {
        if (err) return res.status(500).json({ error: stderr || err.message, stdout });
        res.json({ ok: true, stdout, stderr });
    });
});

module.exports = { router };
