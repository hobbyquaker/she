'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { git, getGitRoot } = require('./git-api');

const router = express.Router();

/**
 * Read gitAutoCommit / gitAutoPush from the live config file.
 * Returns defaults when the file cannot be read.
 */
function readGitConfig(req) {
    const configPath = req.app.locals.configPath;
    if (!configPath) return { autoCommit: false, autoPush: false };
    try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return { autoCommit: !!cfg.gitAutoCommit, autoPush: !!cfg.gitAutoPush };
    } catch {
        return { autoCommit: false, autoPush: false };
    }
}

/**
 * Auto-commit all changes in scriptDir if gitAutoCommit is enabled.
 * Optionally pushes. Silent on errors (e.g. nothing to commit).
 */
async function maybeAutoCommit(req, message) {
    const { autoCommit, autoPush } = readGitConfig(req);
    if (!autoCommit) return;
    const scriptDir = getRoot(req);
    if (!scriptDir) return;
    const gitRoot = await getGitRoot(scriptDir);
    if (!gitRoot) return;
    try {
        const scriptDirRel = path.relative(gitRoot, scriptDir).replace(/\\/g, '/');
        await git(['add', scriptDirRel + '/'], gitRoot);
        await git(['commit', '-m', message], gitRoot);
        if (autoPush) {
            try {
                await git(['push', 'origin'], gitRoot, 60000);
            } catch {
                /* ignore push errors */
            }
        }
    } catch {
        /* nothing to commit or other transient error — ignore */
    }
}

/**
 * Resolve a safe absolute path within the script root.
 * Returns null if the resolved path escapes the root (traversal attempt).
 * @param {string} root - absolute script directory
 * @param {string} relPath - client-supplied relative path
 * @returns {string|null}
 */
function safePath(root, relPath) {
    const abs = path.resolve(root, relPath.replace(/^\/+/, ''));
    if (!abs.startsWith(root + path.sep) && abs !== root) return null;
    return abs;
}

function getRoot(req) {
    return req.app.locals.scriptDir || null;
}

/** True if the directory itself contains a .shelib marker. */
function hasShelibMarker(absDir) {
    return fs.existsSync(path.join(absDir, '.shelib'));
}

/** True if a .shedisable-<name> sibling exists for the given file or directory. */
function hasShedisableMarker(abs) {
    return fs.existsSync(path.join(path.dirname(abs), `.shedisable-${path.basename(abs)}`));
}

/** Flat list of all files with metadata and lib flag. */
function walk(dir, base, parentIsLib) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const lib = parentIsLib || (base !== '' && hasShelibMarker(dir));
    const results = [];
    for (const entry of entries) {
        if (entry.name === '.shelib') continue;
        if (entry.name.startsWith('.shedisable-')) continue;
        if (entry.isDirectory() && entry.name.startsWith('.')) continue;
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            results.push(...walk(path.join(dir, entry.name), rel, lib));
        } else {
            const abs = path.join(dir, entry.name);
            const stat = fs.statSync(abs);
            results.push({ path: rel, size: stat.size, mtime: stat.mtimeMs, lib });
        }
    }
    return results;
}

/**
 * Nested tree of all files and subdirectories.
 * Each node: { type:'file'|'dir', name, path, lib, size?, mtime?, children? }
 */
function buildTree(dir, base, parentIsLib, parentIsDisabled = false) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const selfIsLib = base !== '' && hasShelibMarker(dir);
    const lib = parentIsLib || selfIsLib;
    const result = [];
    for (const entry of entries) {
        if (entry.name === '.shelib') continue;
        if (entry.name.startsWith('.shedisable-')) continue;
        if (entry.isDirectory() && entry.name.startsWith('.')) continue;
        const rel = base ? `${base}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const childIsLib = lib || hasShelibMarker(abs);
            const selfDisabled = hasShedisableMarker(abs);
            const effectiveDisabled = parentIsDisabled || selfDisabled;
            const children = buildTree(abs, rel, childIsLib, effectiveDisabled);
            result.push({ type: 'dir', name: entry.name, path: rel, lib: childIsLib, disabled: selfDisabled, children });
        } else {
            const stat = fs.statSync(abs);
            const isJs = entry.name.endsWith('.js');
            const selfDisabled = isJs ? hasShedisableMarker(abs) : false;
            const disabled = parentIsDisabled || selfDisabled;
            result.push({ type: 'file', name: entry.name, path: rel, lib, size: stat.size, mtime: stat.mtimeMs, ...(isJs ? { disabled } : {}) });
        }
    }
    result.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return result;
}

// All routes dispatched via router.use to avoid path-to-regexp v8 wildcard issues.
router.use((req, res) => {
    const root = getRoot(req);
    if (!root) return res.status(503).json({ error: 'scriptDir not configured' });

    const method = req.method.toUpperCase();
    const filePath = req.path.replace(/^\/+/, '');

    // GET /she/scripts  — flat list of all .js files with metadata
    if (method === 'GET' && !filePath) {
        return res.json(walk(root, '', false));
    }

    // GET /she/scripts/tree  — nested tree structure
    if (method === 'GET' && filePath === 'tree') {
        return res.json(buildTree(root, '', false));
    }

    // GET /she/scripts/search?q=&regex=false&caseSensitive=false&mode=text|files
    if (method === 'GET' && filePath === 'search') {
        const q = String(req.query.q || '').trim();
        const isRegex = req.query.regex === 'true';
        const caseSensitive = req.query.caseSensitive === 'true';
        const mode = req.query.mode === 'files' ? 'files' : 'text';
        if (!q) return res.json({ results: [], truncated: false });

        const allFiles = walk(root, '', false);

        if (mode === 'files') {
            const lq = q.toLowerCase();
            const all = allFiles.map((f) => f.path).filter((p) => p.toLowerCase().includes(lq));
            return res.json({ results: all.slice(0, 200), truncated: all.length > 200 });
        }

        // text search
        const MAX = 500;
        let pattern = null;
        if (isRegex) {
            try {
                pattern = new RegExp(q, caseSensitive ? '' : 'i');
            } catch (e) {
                return res.status(400).json({ error: 'Invalid regex: ' + e.message });
            }
        }
        const results = [];
        let total = 0;
        let truncated = false;

        outer: for (const file of allFiles) {
            const abs = safePath(root, file.path);
            if (!abs) continue;
            let buf;
            try {
                buf = fs.readFileSync(abs);
            } catch {
                continue;
            }
            if (buf.slice(0, 8192).indexOf(0) !== -1) continue; // binary
            const lines = buf.toString('utf8').split('\n');
            const fileMatches = [];
            for (let i = 0; i < lines.length; i++) {
                if (total >= MAX) {
                    truncated = true;
                    break outer;
                }
                const line = lines[i];
                let col = -1;
                if (pattern) {
                    pattern.lastIndex = 0;
                    const m = pattern.exec(line);
                    if (m) col = m.index;
                } else {
                    const h = caseSensitive ? line : line.toLowerCase();
                    const n = caseSensitive ? q : q.toLowerCase();
                    col = h.indexOf(n);
                }
                if (col >= 0) {
                    fileMatches.push({ line: i + 1, col: col + 1, preview: line.trim().slice(0, 200) });
                    total++;
                }
            }
            if (fileMatches.length) results.push({ path: file.path, matches: fileMatches });
        }
        return res.json({ results, truncated });
    }

    // GET /she/scripts/<path>  — read file content
    if (method === 'GET') {
        const abs = safePath(root, filePath);
        if (!abs) return res.status(400).json({ error: 'Invalid path' });
        try {
            const content = fs.readFileSync(abs, 'utf8');
            return res.json({ path: filePath, content });
        } catch (err) {
            if (err.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
            return res.status(500).json({ error: err.message });
        }
    }

    // PUT /she/scripts/<path>  — create or overwrite file
    if (method === 'PUT') {
        const abs = safePath(root, filePath);
        if (!abs) return res.status(400).json({ error: 'Invalid path' });
        const content = typeof req.body?.content === 'string' ? req.body.content : null;
        if (content === null) return res.status(400).json({ error: 'Missing body.content string' });
        try {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content, 'utf8');
            const stat = fs.statSync(abs);
            return res.json({ ok: true, path: filePath, size: stat.size, mtime: stat.mtimeMs });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // DELETE /she/scripts/<path>  — delete file or directory (recursive)
    if (method === 'DELETE') {
        const abs = safePath(root, filePath);
        if (!abs) return res.status(400).json({ error: 'Invalid path' });
        try {
            const stat = fs.statSync(abs);
            if (stat.isDirectory()) {
                fs.rmSync(abs, { recursive: true });
            } else {
                fs.unlinkSync(abs);
            }
            maybeAutoCommit(req, `delete ${filePath}`).catch(() => {});
            return res.json({ ok: true });
        } catch (err) {
            if (err.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
            return res.status(500).json({ error: err.message });
        }
    }

    // POST /she/scripts/mkdir  — create a directory
    if (method === 'POST' && filePath === 'mkdir') {
        const dirPath = typeof req.body?.path === 'string' ? req.body.path : null;
        if (!dirPath) return res.status(400).json({ error: 'Missing body.path string' });
        const abs = safePath(root, dirPath);
        if (!abs) return res.status(400).json({ error: 'Invalid path' });
        try {
            fs.mkdirSync(abs, { recursive: true });
            return res.json({ ok: true, path: dirPath });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // POST /she/scripts/<path>/rename  — rename / move file
    if (method === 'POST') {
        if (!filePath.endsWith('/rename')) return res.status(404).json({ error: 'Not found' });
        const srcPath = filePath.slice(0, -'/rename'.length);
        const abs = safePath(root, srcPath);
        if (!abs) return res.status(400).json({ error: 'Invalid path' });
        const newName = req.body?.newPath;
        if (typeof newName !== 'string' || !newName) {
            return res.status(400).json({ error: 'Missing body.newPath string' });
        }
        const absNew = safePath(root, newName);
        if (!absNew) return res.status(400).json({ error: 'Invalid newPath' });
        try {
            fs.mkdirSync(path.dirname(absNew), { recursive: true });
            fs.renameSync(abs, absNew);
            maybeAutoCommit(req, `rename ${srcPath} \u2192 ${newName}`).catch(() => {});
            return res.json({ ok: true, path: newName });
        } catch (err) {
            if (err.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
            return res.status(500).json({ error: err.message });
        }
    }

    res.status(405).json({ error: 'Method not allowed' });
});

module.exports = { router };
