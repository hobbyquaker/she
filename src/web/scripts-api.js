'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { git, getGitRoot, stagedDiff } = require('./git-api');
const { broadcast } = require('./log-ws');
const commitMessage = require('./commit-message');
const { resolveInside, linksOutside } = require('../lib/safe-path');

const router = express.Router();

/**
 * The commit settings from the live config file: the mode (off / ask / auto), whether auto mode asks the AI for
 * the message, and whether to push. Defaults (off) when the file cannot be read.
 * @returns {{ mode: 'off'|'ask'|'auto', ai: boolean, autoPush: boolean }}
 */
function readGitConfig(req) {
    const configPath = req.app.locals.configPath;
    if (!configPath) return commitMessage.resolveCommitMode(null);
    try {
        return commitMessage.resolveCommitMode(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    } catch {
        return commitMessage.resolveCommitMode(null);
    }
}

/**
 * Commit all changes in scriptDir when the commit mode is auto (in ask mode the editor opens its dialog, in off
 * mode nothing happens). With gitCommitAi the configured AI writes the message from the staged diff, best effort
 * with a short timeout; `message` is the default and the fallback. Optionally pushes. Silent on errors (e.g.
 * nothing to commit). Tells the web clients when a commit was made so they refresh their git status.
 */
async function maybeAutoCommit(req, message) {
    const { mode, ai, autoPush } = readGitConfig(req);
    if (mode !== 'auto') return;
    const scriptDir = getRoot(req);
    if (!scriptDir) return;
    const gitRoot = await getGitRoot(scriptDir);
    if (!gitRoot) return;
    try {
        const scriptDirRel = path.relative(gitRoot, scriptDir).replace(/\\/g, '/');
        await git(['add', scriptDirRel ? scriptDirRel + '/' : '.'], gitRoot);
        let msg = message;
        if (ai) {
            const diff = await stagedDiff(gitRoot, scriptDirRel ? [scriptDirRel] : []);
            ({ message: msg } = await commitMessage.aiMessageOrFallback(req.app.locals.configPath, diff, message));
        }
        await git(['commit', '-m', msg], gitRoot);
        broadcast({ type: 'git:changed' });
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
 * Returns null if the path escapes the root — by `../`, or through a symlink that points out of it
 * (see lib/safe-path.js; a symlink to something inside the root is fine).
 * @param {string} root - absolute script directory
 * @param {string} relPath - client-supplied relative path
 * @param {{followLeaf?: boolean}} [opts] followLeaf false for what acts on the entry itself (delete, rename)
 * @returns {string|null}
 */
function safePath(root, relPath, opts) {
    return resolveInside(root, relPath, opts);
}

/** size and mtime of an entry — of the link itself when its target is gone, so one dead link does not fail the listing */
function statOf(abs) {
    try {
        return fs.statSync(abs);
    } catch {
        return fs.lstatSync(abs);
    }
}

/** True when an absolute path is the script directory itself, which is never deleted, renamed or replaced */
function isRoot(root, abs) {
    const real = (p) => {
        try {
            return fs.realpathSync(p);
        } catch {
            return path.resolve(p);
        }
    };
    return path.resolve(abs) === path.resolve(root) || real(abs) === real(root);
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

/**
 * `{ outside: true }` for a symlink that leaves the script directory — the engine does not load it
 * and the routes here refuse to read or write it — and nothing for every other entry.
 */
function outsideFlag(root, entry, abs) {
    return entry.isSymbolicLink() && linksOutside(root, abs) ? { outside: true } : {};
}

/** Flat list of all files with metadata and lib flag. */
function walk(dir, base, parentIsLib, root = dir) {
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
            results.push(...walk(path.join(dir, entry.name), rel, lib, root));
        } else {
            const abs = path.join(dir, entry.name);
            const stat = statOf(abs);
            results.push({ path: rel, size: stat.size, mtime: stat.mtimeMs, lib, ...outsideFlag(root, entry, abs) });
        }
    }
    return results;
}

/**
 * Nested tree of all files and subdirectories.
 * Each node: { type:'file'|'dir', name, path, lib, size?, mtime?, children?, outside? }
 * A symlink is a file node, whatever it points to; `outside` marks one that leaves the script directory.
 */
function buildTree(dir, base, parentIsLib, parentIsDisabled = false, root = dir) {
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
            const children = buildTree(abs, rel, childIsLib, effectiveDisabled, root);
            result.push({ type: 'dir', name: entry.name, path: rel, lib: childIsLib, disabled: selfDisabled, children });
        } else {
            const stat = statOf(abs);
            const isJs = entry.name.endsWith('.js');
            const selfDisabled = isJs ? hasShedisableMarker(abs) : false;
            const disabled = parentIsDisabled || selfDisabled;
            result.push({ type: 'file', name: entry.name, path: rel, lib, size: stat.size, mtime: stat.mtimeMs, ...(isJs ? { disabled } : {}), ...outsideFlag(root, entry, abs) });
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

    // DELETE /she/scripts/<path>  — delete file or directory (recursive); a symlink is removed, not its target
    if (method === 'DELETE') {
        const abs = safePath(root, filePath, { followLeaf: false });
        if (!abs) return res.status(400).json({ error: 'Invalid path' });
        if (isRoot(root, abs)) return res.status(400).json({ error: 'The script directory itself cannot be deleted' });
        try {
            const stat = fs.lstatSync(abs);
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
        // a rename moves the entry itself, so a symlink is judged by where it sits, not by its target
        const abs = safePath(root, srcPath, { followLeaf: false });
        if (!abs) return res.status(400).json({ error: 'Invalid path' });
        if (isRoot(root, abs)) return res.status(400).json({ error: 'The script directory itself cannot be renamed' });
        const newName = req.body?.newPath;
        if (typeof newName !== 'string' || !newName) {
            return res.status(400).json({ error: 'Missing body.newPath string' });
        }
        const absNew = safePath(root, newName, { followLeaf: false });
        if (!absNew || isRoot(root, absNew)) return res.status(400).json({ error: 'Invalid newPath' });
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

module.exports = { router, safePath, readGitConfig, maybeAutoCommit };
