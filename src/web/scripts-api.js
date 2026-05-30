'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

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

function walk(dir, base) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const results = [];
    for (const entry of entries) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            results.push(...walk(path.join(dir, entry.name), rel));
        } else if (entry.name.endsWith('.js')) {
            const stat = fs.statSync(path.join(dir, entry.name));
            results.push({ path: rel, size: stat.size, mtime: stat.mtimeMs });
        }
    }
    return results;
}

// All routes dispatched via router.use to avoid path-to-regexp v8 wildcard issues.
router.use((req, res) => {
    const root = getRoot(req);
    if (!root) return res.status(503).json({ error: 'scriptDir not configured' });

    const method = req.method.toUpperCase();
    const filePath = req.path.replace(/^\/+/, '');

    // GET /she/scripts  — list all .js files with metadata
    if (method === 'GET' && !filePath) {
        return res.json(walk(root, ''));
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
        if (!abs.endsWith('.js')) return res.status(400).json({ error: 'Only .js files are allowed' });
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

    // DELETE /she/scripts/<path>  — delete file
    if (method === 'DELETE') {
        const abs = safePath(root, filePath);
        if (!abs) return res.status(400).json({ error: 'Invalid path' });
        try {
            fs.unlinkSync(abs);
            return res.json({ ok: true });
        } catch (err) {
            if (err.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
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
        if (!absNew.endsWith('.js')) return res.status(400).json({ error: 'Only .js files are allowed' });
        try {
            fs.mkdirSync(path.dirname(absNew), { recursive: true });
            fs.renameSync(abs, absNew);
            return res.json({ ok: true, path: newName });
        } catch (err) {
            if (err.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
            return res.status(500).json({ error: err.message });
        }
    }

    res.status(405).json({ error: 'Method not allowed' });
});

module.exports = { router };
