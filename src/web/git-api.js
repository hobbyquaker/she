'use strict';

const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const commitMessage = require('./commit-message');
const activity = require('../lib/activity');

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
        const child = execFile('git', args, { cwd, timeout }, (err, stdout, stderr) => {
            if (err) {
                const e = new Error(stderr.trim() || stdout.trim() || err.message);
                e.stderr = stderr;
                e.stdout = stdout;
                reject(e);
            } else {
                resolve({ stdout, stderr });
            }
        });
        activity.track(child, activity.commandLabel('git', args));
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

/** The paths of a commit request body: `path` (one) or `files` (several); empty = the whole script directory. */
function requestedPaths(body) {
    if (body?.path) return [String(body.path)];
    if (Array.isArray(body?.files) && body.files.length > 0) return body.files.map(String);
    return [];
}

/**
 * Stage the given paths (relative to scriptDir), or the whole script directory when none are given.
 * Resolves with the staged paths relative to the git root (empty for the whole directory) — what the
 * diff and the commit then refer to. Rejects with `.status = 400` on a path outside the script directory.
 */
async function stagePaths(gitRoot, scriptDir, relPaths) {
    const relToRoot = [];
    if (relPaths.length > 0) {
        for (const rel of relPaths) {
            const abs = safePath(scriptDir, rel);
            if (!abs) {
                const e = new Error(`Invalid path: ${rel}`);
                e.status = 400;
                throw e;
            }
            // Convert to forward slashes for git portability.
            relToRoot.push(path.relative(gitRoot, abs).replace(/\\/g, '/'));
        }
        // one add per path: a deleted file is staged as its removal, a path that git does not know fails here
        for (const p of relToRoot) await git(['add', '--', p], gitRoot);
    } else {
        // Stage the entire script directory.
        // When scriptDir === gitRoot, relative() returns '' — use '.' in that case.
        const scriptDirRel = path.relative(gitRoot, scriptDir).replace(/\\/g, '/');
        await git(['add', scriptDirRel ? scriptDirRel + '/' : '.'], gitRoot);
    }
    return relToRoot;
}

/** The staged diff of the given paths relative to the git root (all when empty). */
async function stagedDiff(gitRoot, relToRoot = []) {
    const args = ['diff', '--cached', '--no-color', '--no-ext-diff'];
    if (relToRoot.length) args.push('--', ...relToRoot);
    const { stdout } = await git(args, gitRoot);
    return stdout;
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
// Body: { path?: string, files?: string[], message: string, ai?: boolean }
// Stages the given file(s) (or the whole scriptDir when neither is provided) and commits.
// With ai: true the configured AI writes the message from the staged diff (best effort, a short timeout);
// `message` is the fallback. The response says which one was used.
router.post('/commit', async (req, res) => {
    const scriptDir = getRoot(req);
    if (!scriptDir) return res.status(500).json({ error: 'scriptDir not configured' });

    const fallback = String(req.body?.message ?? '').trim();
    if (!isValidMessage(fallback)) return res.status(400).json({ error: 'Invalid or empty commit message' });
    const relPaths = requestedPaths(req.body);

    const gitRoot = await getGitRoot(scriptDir);
    if (!gitRoot) return res.status(404).json({ error: 'Not a git repository' });

    try {
        const relToRoot = await stagePaths(gitRoot, scriptDir, relPaths);
        let message = fallback;
        let source = 'default';
        if (req.body?.ai === true) {
            const diff = await stagedDiff(gitRoot, relToRoot);
            ({ message, source } = await commitMessage.aiMessageOrFallback(req.app.locals.configPath, diff, fallback));
        }
        await git(['commit', '-m', message], gitRoot);
        res.json({ ok: true, message, source });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message, stderr: e.stderr });
    }
});

// POST /she/git/commit-message
// Body: { path?: string, files?: string[] }
// Stages the given file(s) (or the whole scriptDir) like /commit does, and asks the configured AI for a commit
// message for the staged diff. Nothing is committed. 503 when no AI provider is configured; 502 with the default
// message as `fallback` when the AI fails or does not answer in time.
router.post('/commit-message', async (req, res) => {
    const scriptDir = getRoot(req);
    if (!scriptDir) return res.status(500).json({ error: 'scriptDir not configured' });

    const relPaths = requestedPaths(req.body);
    const fallback = commitMessage.defaultCommitMessage(relPaths);
    const aiConfig = commitMessage.readAiConfig(req.app.locals.configPath);
    if (!aiConfig || !aiConfig.provider || !aiConfig.model) {
        return res.status(503).json({ error: 'No AI provider configured', code: 'ai_not_configured', fallback });
    }

    const gitRoot = await getGitRoot(scriptDir);
    if (!gitRoot) return res.status(404).json({ error: 'Not a git repository' });

    try {
        const relToRoot = await stagePaths(gitRoot, scriptDir, relPaths);
        const diff = await stagedDiff(gitRoot, relToRoot);
        const { message, truncated, model } = await commitMessage.generateCommitMessage(aiConfig, diff, { timeoutMs: commitMessage.DIALOG_TIMEOUT_MS });
        res.json({ message, source: 'ai', model, truncated });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message });
        if (e.code && String(e.code).startsWith('ai_')) return res.status(502).json({ error: e.message, code: e.code, fallback });
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

// GET /she/git/log?path=<relPath>&limit=<n>
// Returns commits touching the given file (relative to scriptDir), up to limit.
router.get('/log', async (req, res) => {
    const scriptDir = getRoot(req);
    if (!scriptDir) return res.status(500).json({ error: 'scriptDir not configured' });

    const relPath = String(req.query.path ?? '').trim();
    if (!relPath) return res.status(400).json({ error: 'Missing path parameter' });

    const limit = Math.min(parseInt(String(req.query.limit ?? '30'), 10) || 30, 200);

    const gitRoot = await getGitRoot(scriptDir);
    if (!gitRoot) return res.status(404).json({ error: 'Not a git repository' });

    const abs = safePath(scriptDir, relPath);
    if (!abs) return res.status(400).json({ error: 'Invalid path' });

    const relToRoot = path.relative(gitRoot, abs).replace(/\\/g, '/');

    try {
        const { stdout } = await git(['log', '--follow', '--format=%H%x1f%s%x1f%an%x1f%ai', `-n`, String(limit), '--', relToRoot], gitRoot);
        const commits = stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [hash, subject, author, date] = line.split('\x1f');
                return { hash, subject, author, date };
            });
        res.json(commits);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Resolve the path a file had at a specific commit, following renames.
 * Falls back to relToRoot when the commit is not found in the log.
 */
async function getHistoricPath(gitRoot, relToRoot, hash) {
    try {
        const { stdout } = await git(['log', '--follow', '--format=COMMIT:%H', '--name-only', '--', relToRoot], gitRoot);
        let currentHash = null;
        for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('COMMIT:')) {
                currentHash = trimmed.slice(7);
            } else if (trimmed && currentHash === hash) {
                return trimmed;
            }
        }
    } catch {
        // ignore — fall through to relToRoot
    }
    return relToRoot;
}

// GET /she/git/show?hash=<hash>&path=<relPath>
// Returns { content: string, binary: false } or { content: null, binary: true }.
// Follows renames: resolves the historic filename at <hash> via git log --follow.
router.get('/show', async (req, res) => {
    const scriptDir = getRoot(req);
    if (!scriptDir) return res.status(500).json({ error: 'scriptDir not configured' });

    const hash = String(req.query.hash ?? '').trim();
    if (!/^[0-9a-f]{4,64}$/i.test(hash)) return res.status(400).json({ error: 'Invalid hash' });

    const relPath = String(req.query.path ?? '').trim();
    if (!relPath) return res.status(400).json({ error: 'Missing path parameter' });

    const gitRoot = await getGitRoot(scriptDir);
    if (!gitRoot) return res.status(404).json({ error: 'Not a git repository' });

    const abs = safePath(scriptDir, relPath);
    if (!abs) return res.status(400).json({ error: 'Invalid path' });

    const relToRoot = path.relative(gitRoot, abs).replace(/\\/g, '/');
    const historicPath = await getHistoricPath(gitRoot, relToRoot, hash);

    try {
        const { stdout } = await git(['show', `${hash}:${historicPath}`], gitRoot);
        const binary = stdout.includes('\0');
        res.json({ content: binary ? null : stdout, binary });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = { router, git, getGitRoot, stagePaths, stagedDiff };
