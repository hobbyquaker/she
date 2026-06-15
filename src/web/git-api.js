'use strict';

const express = require('express');
const { execFile } = require('child_process');
const path = require('path');

const router = express.Router();

function getRoot(req) {
    return req.app.locals.scriptDir || null;
}

/**
 * Run a git command in the given cwd.
 * Resolves with { stdout, stderr }; rejects with an error that carries .stderr and .stdout.
 */
function git(args, cwd, timeout = 30000) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, timeout }, (err, stdout, stderr) => {
            if (err) {
                const e = new Error(stderr.trim() || err.message);
                e.stderr = stderr;
                e.stdout = stdout;
                reject(e);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

/**
 * Find the git root for the given directory.
 * Returns null when the directory is not inside a git repository.
 */
async function getGitRoot(dir) {
    try {
        const { stdout } = await git(['rev-parse', '--show-toplevel'], dir);
        return stdout.trim().replace(/\//g, path.sep);
    } catch {
        return null;
    }
}

/**
 * Resolve a safe absolute path within the script root.
 * Returns null when the path escapes the root (traversal attempt).
 */
function safePath(root, relPath) {
    const abs = path.resolve(root, relPath.replace(/^\/+/, ''));
    if (!abs.startsWith(root + path.sep) && abs !== root) return null;
    return abs;
}

/** Validate commit message: non-empty, no null bytes. */
function isValidMessage(msg) {
    return typeof msg === 'string' && msg.trim().length > 0 && !msg.includes('\0');
}

// GET /she/git/status
// Returns branch name, changed files, and ahead/behind counts vs. upstream.
router.get('/status', async (req, res) => {
    const scriptDir = getRoot(req);
    if (!scriptDir) return res.status(500).json({ error: 'scriptDir not configured' });

    const gitRoot = await getGitRoot(scriptDir);
    if (!gitRoot) return res.status(404).json({ error: 'Not a git repository' });

    try {
        const [statusOut, branchOut] = await Promise.all([git(['status', '--porcelain', '-u'], gitRoot), git(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot)]);

        const branch = branchOut.stdout.trim();

        // Compute the path of scriptDir relative to gitRoot (forward slashes)
        // so returned file paths are relative to scriptDir, matching the frontend tree.
        const scriptRelToRoot = path.relative(gitRoot, scriptDir).replace(/\\/g, '/');

        const changes = statusOut.stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                let file = line.slice(3);
                if (scriptRelToRoot) {
                    if (file.startsWith(scriptRelToRoot + '/')) {
                        file = file.slice(scriptRelToRoot.length + 1);
                    } else {
                        return null; // outside scriptDir
                    }
                }
                return { status: line.slice(0, 2).trim(), file };
            })
            .filter(Boolean);

        let ahead = 0;
        let behind = 0;
        try {
            const { stdout } = await git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], gitRoot);
            const parts = stdout.trim().split(/\s+/);
            ahead = parseInt(parts[0], 10) || 0;
            behind = parseInt(parts[1], 10) || 0;
        } catch {
            // No upstream configured — leave as 0.
        }

        res.json({ branch, changes, ahead, behind });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /she/git/remotes
// Returns the configured git remotes: [{ name, fetch, push }].
router.get('/remotes', async (req, res) => {
    const scriptDir = getRoot(req);
    if (!scriptDir) return res.status(500).json({ error: 'scriptDir not configured' });

    const gitRoot = await getGitRoot(scriptDir);
    if (!gitRoot) return res.status(404).json({ error: 'Not a git repository' });

    try {
        const { stdout } = await git(['remote', '-v'], gitRoot);
        const remotes = {};
        for (const line of stdout.split('\n').filter(Boolean)) {
            const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
            if (!m) continue;
            const [, name, url, type] = m;
            if (!remotes[name]) remotes[name] = { name, fetch: '', push: '' };
            remotes[name][type] = url;
        }
        res.json(Object.values(remotes));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /she/git/commit
// Body: { path?: string, files?: string[], message: string }
// Stages the given file(s) (or the whole scriptDir when neither is provided) and commits.
router.post('/commit', async (req, res) => {
    const scriptDir = getRoot(req);
    if (!scriptDir) return res.status(500).json({ error: 'scriptDir not configured' });

    const message = String(req.body?.message ?? '').trim();
    if (!isValidMessage(message)) return res.status(400).json({ error: 'Invalid or empty commit message' });

    // Accept a single path or an array of paths.
    let relPaths;
    if (req.body?.path) {
        relPaths = [String(req.body.path)];
    } else if (Array.isArray(req.body?.files) && req.body.files.length > 0) {
        relPaths = req.body.files.map(String);
    } else {
        relPaths = [];
    }

    const gitRoot = await getGitRoot(scriptDir);
    if (!gitRoot) return res.status(404).json({ error: 'Not a git repository' });

    try {
        if (relPaths.length > 0) {
            for (const rel of relPaths) {
                const abs = safePath(scriptDir, rel);
                if (!abs) return res.status(400).json({ error: `Invalid path: ${rel}` });
                // Convert to forward slashes for git portability.
                const relToRoot = path.relative(gitRoot, abs).replace(/\\/g, '/');
                await git(['add', relToRoot], gitRoot);
            }
        } else {
            // Stage the entire script directory.
            const scriptDirRel = path.relative(gitRoot, scriptDir).replace(/\\/g, '/');
            await git(['add', scriptDirRel + '/'], gitRoot);
        }

        await git(['commit', '-m', message], gitRoot);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message, stderr: e.stderr });
    }
});

// POST /she/git/push
// Body: { remote?: string }  — defaults to "origin".
router.post('/push', async (req, res) => {
    const scriptDir = getRoot(req);
    if (!scriptDir) return res.status(500).json({ error: 'scriptDir not configured' });

    const remote = String(req.body?.remote ?? 'origin').trim();
    if (!/^[a-zA-Z0-9_./-]+$/.test(remote)) return res.status(400).json({ error: 'Invalid remote name' });

    const gitRoot = await getGitRoot(scriptDir);
    if (!gitRoot) return res.status(404).json({ error: 'Not a git repository' });

    try {
        const { stdout, stderr } = await git(['push', remote], gitRoot, 60000);
        res.json({ ok: true, stdout, stderr });
    } catch (e) {
        res.status(500).json({ error: e.message, stderr: e.stderr });
    }
});

module.exports = { router };
