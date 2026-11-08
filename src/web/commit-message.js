'use strict';

/**
 * Commits of script changes: the mode (off / ask / auto), the default message and the AI-generated one.
 *
 * Config keys (all read live from the config file, no daemon restart needed):
 *   gitCommitMode   'off' | 'ask' | 'auto'  — what happens after a save, rename or delete in the editor
 *   gitCommitAi     boolean                 — in auto mode: ask the configured AI for the message (best effort)
 *   gitAutoCommit   boolean                 — the key before gitCommitMode existed: true means 'auto' with the default message
 *   gitAutoPush     boolean                 — push after every commit
 *
 * The AI call is budgeted: the staged diff only, truncated, a short answer cap, a short timeout. Whatever goes
 * wrong — no provider configured, a timeout, an API error, an empty answer — the caller falls back to the default
 * message, so a commit never fails because of the AI.
 */

const fs = require('fs');
const { _internal: ai } = require('./ai-api');

const COMMIT_MODES = ['off', 'ask', 'auto'];

/** the staged diff is cut here before it goes to the model (about 3k tokens) */
const MAX_DIFF_CHARS = 12000;
/** the longest message accepted from the model */
const MAX_MESSAGE_CHARS = 1000;
/** the answer cap sent to the provider */
const MAX_ANSWER_TOKENS = 300;
/** auto mode waits this long for the model, then commits with the default */
const AUTO_TIMEOUT_MS = 8000;
/** the dialogs' Generate button waits this long */
const DIALOG_TIMEOUT_MS = 20000;

/**
 * The commit mode of a config object. An explicit `gitCommitMode` wins; without one the old `gitAutoCommit: true`
 * means auto with the default message, so an existing installation behaves as before.
 * @param {object|null|undefined} cfg  — the parsed config file
 * @returns {{ mode: 'off'|'ask'|'auto', ai: boolean, autoPush: boolean }}
 */
function resolveCommitMode(cfg) {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    const mode = COMMIT_MODES.includes(c.gitCommitMode) ? c.gitCommitMode : c.gitAutoCommit === true ? 'auto' : 'off';
    return { mode, ai: mode === 'auto' && c.gitCommitAi === true, autoPush: c.gitAutoPush === true };
}

function pad(n) {
    return String(n).padStart(2, '0');
}

/**
 * The default message: the changed files and the date and time (local), e.g. `update lights.js, lib/util.js (2026-11-08 17:29)`.
 * More than three files are summarised.
 * @param {string[]} files  — paths relative to the script directory
 * @param {Date} [now]
 */
function defaultCommitMessage(files, now = new Date()) {
    const list = (files || []).filter(Boolean);
    const when = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const what = list.length === 0 ? 'scripts' : list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`;
    return `update ${what} (${when})`;
}

/**
 * Cut a diff to `max` characters with a marker that says how much is missing.
 * @returns {{ text: string, truncated: boolean }}
 */
function truncateDiff(diff, max = MAX_DIFF_CHARS) {
    const text = String(diff || '');
    if (text.length <= max) return { text, truncated: false };
    const cut = text.slice(0, max);
    return { text: `${cut}\n… (diff truncated, ${text.length - max} more characters)`, truncated: true };
}

/**
 * The model's answer as a commit message: no code fences, no surrounding quotes, no "Commit message:" prefix,
 * trimmed and capped. Empty when nothing usable is left.
 */
function cleanCommitMessage(text) {
    let s = String(text || '')
        .replace(/\r\n/g, '\n')
        .trim();
    s = s
        .replace(/^```[a-z]*\n?/i, '')
        .replace(/\n?```$/, '')
        .trim();
    s = s.replace(/^commit message:\s*/i, '');
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
    s = s
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (s.length > MAX_MESSAGE_CHARS) s = s.slice(0, MAX_MESSAGE_CHARS).trim();
    return s;
}

const SYSTEM_PROMPT = [
    'You write git commit messages for a repository of home-automation scripts.',
    'Answer with the commit message only: one imperative summary line of at most 72 characters,',
    'optionally followed by a blank line and a few short lines that say what changed and why it matters.',
    'No code fences, no quotes, no preamble, no file-by-file list when the summary says it.',
].join(' ');

/**
 * Ask the configured provider for a commit message for a staged diff.
 * @param {{ provider: string, model: string, baseUrl?: string, apiKey?: string }|null} aiConfig  — resolved AI config; null = not configured
 * @param {string} diff  — the staged diff (cut to MAX_DIFF_CHARS here)
 * @param {{ timeoutMs?: number, fetchImpl?: Function }} [opts]
 * @returns {Promise<{ message: string, truncated: boolean, model: string }>}
 * @throws an Error with `code` 'ai_not_configured' | 'ai_timeout' | 'ai_empty' | 'ai_error'
 */
async function generateCommitMessage(aiConfig, diff, opts = {}) {
    if (!aiConfig || !aiConfig.provider || !aiConfig.model) throw withCode(new Error('No AI provider configured'), 'ai_not_configured');
    const { text, truncated } = truncateDiff(diff);
    if (!text.trim()) throw withCode(new Error('Nothing staged to describe'), 'ai_empty');

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Staged changes (git diff --cached${truncated ? ', truncated' : ''}):\n\n${text}` },
    ];
    const timeoutMs = opts.timeoutMs || DIALOG_TIMEOUT_MS;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const call = aiConfig.provider === 'anthropic' ? ai.callAnthropic : ai.callOpenAICompat;
        const result = await call(aiConfig, messages, undefined, { signal: ctl.signal, maxTokens: MAX_ANSWER_TOKENS });
        const message = cleanCommitMessage(result?.message);
        if (!message) throw withCode(new Error(result?.detail || 'The model returned no message'), 'ai_empty');
        return { message, truncated, model: aiConfig.model };
    } catch (e) {
        if (ctl.signal.aborted) throw withCode(new Error(`AI did not answer within ${Math.round(timeoutMs / 1000)} s`), 'ai_timeout');
        if (e.code) throw e;
        throw withCode(new Error(e.message), 'ai_error');
    } finally {
        clearTimeout(timer);
    }
}

function withCode(err, code) {
    err.code = code;
    return err;
}

/**
 * The AI message for a staged diff, or the fallback when the AI is not configured, fails or times out.
 * @param {string|null} configPath  — the config file the AI provider is read from
 * @param {string} diff  — the staged diff
 * @param {string} fallback  — the default message
 * @param {{ timeoutMs?: number, log?: { warn: Function } }} [opts]
 * @returns {Promise<{ message: string, source: 'ai'|'default', error?: string }>}
 */
async function aiMessageOrFallback(configPath, diff, fallback, opts = {}) {
    try {
        const { message } = await generateCommitMessage(readAiConfig(configPath), diff, { timeoutMs: opts.timeoutMs || AUTO_TIMEOUT_MS });
        return { message, source: 'ai' };
    } catch (e) {
        opts.log?.warn?.(`git: AI commit message failed (${e.code || 'error'}): ${e.message} — using the default`);
        return { message: fallback, source: 'default', error: e.message };
    }
}

/**
 * The AI config used for commit messages: the provider entry named by `gitCommitAiProvider` (empty or missing = the
 * assistant's default entry; an entry that no longer exists also falls back to the default), with the model replaced
 * by `gitCommitAiModel` when that is set. null when no AI is configured.
 * @param {string|null} configPath
 */
function readAiConfig(configPath) {
    if (!configPath) return null;
    let cfg = {};
    try {
        cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
    } catch {
        return null;
    }
    return resolveCommitAi(cfg, (id) => ai.readAiConfig(configPath, id));
}

/**
 * @param {object} cfg  — the parsed config file
 * @param {(providerId?: string) => object|null} resolve  — the assistant's resolver (entry by id, default without one)
 */
function resolveCommitAi(cfg, resolve) {
    const providerId = typeof cfg.gitCommitAiProvider === 'string' ? cfg.gitCommitAiProvider.trim() : '';
    const model = typeof cfg.gitCommitAiModel === 'string' ? cfg.gitCommitAiModel.trim() : '';
    let entry = providerId ? resolve(providerId) : resolve();
    if (entry && entry.unknown) entry = resolve();
    if (!entry || entry.unknown) return null;
    return model ? { ...entry, model } : entry;
}

module.exports = {
    COMMIT_MODES,
    MAX_DIFF_CHARS,
    AUTO_TIMEOUT_MS,
    DIALOG_TIMEOUT_MS,
    resolveCommitMode,
    defaultCommitMessage,
    truncateDiff,
    cleanCommitMessage,
    generateCommitMessage,
    aiMessageOrFallback,
    readAiConfig,
    resolveCommitAi,
};
