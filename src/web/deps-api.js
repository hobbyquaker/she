'use strict';

const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { STORAGE_ROOT } = require('../lib/storage');

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

// GET /she/deps  — list installed packages from ~/.she/package.json
router.get('/', (req, res) => {
    const pkg = readPackageJson();
    const deps = pkg.dependencies || {};
    res.json(
        Object.entries(deps).map(([name, version]) => {
            let url = `https://www.npmjs.com/package/${encodeURIComponent(name)}`;
            try {
                const meta = JSON.parse(fs.readFileSync(path.join(STORAGE_ROOT, 'node_modules', name, 'package.json'), 'utf8'));
                if (meta.homepage && /^https?:\/\//.test(meta.homepage)) {
                    url = meta.homepage;
                } else {
                    let repo = typeof meta.repository === 'object' ? meta.repository.url : meta.repository;
                    if (typeof repo === 'string' && repo) {
                        repo = repo.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://');
                        if (/^https?:\/\//.test(repo)) url = repo;
                        else {
                            const m = repo.match(/^(?:github:|github\.com[:/])?([\w.-]+\/[\w.-]+)$/);
                            if (m) url = `https://github.com/${m[1]}`;
                        }
                    }
                }
            } catch { /* not installed or no metadata */ }
            return { name, version, url };
        }),
    );
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
                    url: obj.package.links?.repository || obj.package.links?.homepage || obj.package.links?.npm || `https://www.npmjs.com/package/${encodeURIComponent(obj.package.name)}`,
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
