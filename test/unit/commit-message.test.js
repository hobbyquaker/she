'use strict';

const {
    resolveCommitMode,
    defaultCommitMessage,
    truncateDiff,
    cleanCommitMessage,
    generateCommitMessage,
    aiMessageOrFallback,
    MAX_DIFF_CHARS,
} = require('../../src/web/commit-message');

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('resolveCommitMode()', () => {
    it('is off without any key', () => {
        expect(resolveCommitMode({})).toEqual({ mode: 'off', ai: false, autoPush: false });
        expect(resolveCommitMode(null)).toEqual({ mode: 'off', ai: false, autoPush: false });
        expect(resolveCommitMode(undefined).mode).toBe('off');
    });

    it('reads the old gitAutoCommit: true as auto with the default message', () => {
        expect(resolveCommitMode({ gitAutoCommit: true })).toEqual({ mode: 'auto', ai: false, autoPush: false });
        expect(resolveCommitMode({ gitAutoCommit: true, gitAutoPush: true }).autoPush).toBe(true);
        expect(resolveCommitMode({ gitAutoCommit: false }).mode).toBe('off');
    });

    it('an explicit gitCommitMode wins over the old key', () => {
        expect(resolveCommitMode({ gitCommitMode: 'off', gitAutoCommit: true }).mode).toBe('off');
        expect(resolveCommitMode({ gitCommitMode: 'ask', gitAutoCommit: true }).mode).toBe('ask');
        expect(resolveCommitMode({ gitCommitMode: 'auto' }).mode).toBe('auto');
    });

    it('falls back to the old key on an unknown mode value', () => {
        expect(resolveCommitMode({ gitCommitMode: 'always', gitAutoCommit: true }).mode).toBe('auto');
        expect(resolveCommitMode({ gitCommitMode: 42 }).mode).toBe('off');
    });

    it('gitCommitAi counts only in auto mode', () => {
        expect(resolveCommitMode({ gitCommitMode: 'auto', gitCommitAi: true }).ai).toBe(true);
        expect(resolveCommitMode({ gitCommitMode: 'ask', gitCommitAi: true }).ai).toBe(false);
        expect(resolveCommitMode({ gitAutoCommit: true, gitCommitAi: true }).ai).toBe(true);
        expect(resolveCommitMode({ gitCommitMode: 'auto', gitCommitAi: 'yes' }).ai).toBe(false);
    });
});

describe('defaultCommitMessage()', () => {
    const at = new Date(2026, 10, 8, 17, 29); // local time: 2026-11-08 17:29

    it('names the file and the date and time', () => {
        expect(defaultCommitMessage(['lights.js'], at)).toBe('update lights.js (2026-11-08 17:29)');
    });

    it('lists up to three files and counts the rest', () => {
        expect(defaultCommitMessage(['a.js', 'lib/b.js', 'c.js'], at)).toBe('update a.js, lib/b.js, c.js (2026-11-08 17:29)');
        expect(defaultCommitMessage(['a.js', 'b.js', 'c.js', 'd.js', 'e.js'], at)).toBe('update a.js, b.js, c.js and 2 more (2026-11-08 17:29)');
    });

    it('says "scripts" without a file list and pads the time', () => {
        expect(defaultCommitMessage([], new Date(2026, 0, 2, 3, 4))).toBe('update scripts (2026-01-02 03:04)');
    });
});

describe('truncateDiff()', () => {
    it('leaves a short diff alone', () => {
        expect(truncateDiff('diff --git a b')).toEqual({ text: 'diff --git a b', truncated: false });
        expect(truncateDiff('')).toEqual({ text: '', truncated: false });
    });

    it('cuts at the limit and says how much is missing', () => {
        const r = truncateDiff('x'.repeat(100), 40);
        expect(r.truncated).toBe(true);
        expect(r.text.startsWith('x'.repeat(40) + '\n…')).toBe(true);
        expect(r.text).toMatch(/60 more characters/);
    });

    it('has a sane default limit', () => {
        expect(MAX_DIFF_CHARS).toBeGreaterThanOrEqual(4000);
        expect(MAX_DIFF_CHARS).toBeLessThanOrEqual(40000);
        expect(truncateDiff('y'.repeat(MAX_DIFF_CHARS + 1)).truncated).toBe(true);
    });
});

describe('cleanCommitMessage()', () => {
    it('strips fences, quotes and a prefix', () => {
        expect(cleanCommitMessage('```\nAdd a timer\n```')).toBe('Add a timer');
        expect(cleanCommitMessage('```text\nAdd a timer\n\nDetails.\n```\n')).toBe('Add a timer\n\nDetails.');
        expect(cleanCommitMessage('"Add a timer"')).toBe('Add a timer');
        expect(cleanCommitMessage('Commit message: Add a timer')).toBe('Add a timer');
    });

    it('collapses blank runs and trailing spaces, keeps a body', () => {
        expect(cleanCommitMessage('Subject  \r\n\r\n\r\n\r\nBody line')).toBe('Subject\n\nBody line');
    });

    it('is empty for nothing usable and caps a long answer', () => {
        expect(cleanCommitMessage('')).toBe('');
        expect(cleanCommitMessage(undefined)).toBe('');
        expect(cleanCommitMessage('   ```\n```  ')).toBe('');
        expect(cleanCommitMessage('z'.repeat(5000)).length).toBeLessThanOrEqual(1000);
    });
});

describe('generateCommitMessage()', () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
    });

    const openai = { provider: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: 'k' };
    const anthropic = { provider: 'anthropic', model: 'claude-x', apiKey: 'k' };
    const diff = 'diff --git a/lights.js b/lights.js\n+she.timeout(5000, off);\n';

    it('rejects when no AI is configured, without calling anything', async () => {
        global.fetch = jest.fn();
        await expect(generateCommitMessage(null, diff)).rejects.toMatchObject({ code: 'ai_not_configured' });
        await expect(generateCommitMessage({ provider: 'openai' }, diff)).rejects.toMatchObject({ code: 'ai_not_configured' });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('rejects an empty diff without calling the provider', async () => {
        global.fetch = jest.fn();
        await expect(generateCommitMessage(openai, '   ')).rejects.toMatchObject({ code: 'ai_empty' });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('sends the diff only, budgeted, and returns the cleaned message (OpenAI-compatible)', async () => {
        global.fetch = jest.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '```\nAdd a five second off timer\n```' } }] }), { status: 200 }));
        const r = await generateCommitMessage(openai, diff);
        expect(r).toEqual({ message: 'Add a five second off timer', truncated: false, model: 'm' });
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe('http://127.0.0.1:1/v1/chat/completions');
        const body = JSON.parse(init.body);
        expect(body.max_tokens).toBe(300);
        expect(body.tools).toBeUndefined();
        expect(body.messages).toHaveLength(2);
        expect(body.messages[1].content).toContain(diff);
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('uses the Anthropic adapter with a small answer cap and reports a truncated diff', async () => {
        global.fetch = jest.fn(async () => new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Rework the lights' }] }), { status: 200 }));
        const r = await generateCommitMessage(anthropic, 'q'.repeat(MAX_DIFF_CHARS + 500));
        expect(r).toEqual({ message: 'Rework the lights', truncated: true, model: 'claude-x' });
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe('https://api.anthropic.com/v1/messages');
        const body = JSON.parse(init.body);
        expect(body.max_tokens).toBe(300);
        expect(body.messages[0].content).toMatch(/truncated\)/);
        expect(body.messages[0].content.length).toBeLessThan(MAX_DIFF_CHARS + 200);
    });

    it('rejects with ai_error on an API error', async () => {
        global.fetch = jest.fn(async () => new Response('{"error":"rate limited"}', { status: 429 }));
        await expect(generateCommitMessage(openai, diff)).rejects.toMatchObject({ code: 'ai_error', message: expect.stringMatching(/429/) });
    });

    it('rejects with ai_empty when the model returns nothing', async () => {
        global.fetch = jest.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }));
        await expect(generateCommitMessage(openai, diff)).rejects.toMatchObject({ code: 'ai_empty' });
    });

    it('aborts after the timeout and rejects with ai_timeout', async () => {
        global.fetch = jest.fn(
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
                }),
        );
        const t0 = Date.now();
        await expect(generateCommitMessage(openai, diff, { timeoutMs: 60 })).rejects.toMatchObject({ code: 'ai_timeout' });
        expect(Date.now() - t0).toBeLessThan(2000);
    });
});

describe('aiMessageOrFallback()', () => {
    const realFetch = global.fetch;
    let dir;
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-commit-msg-'));
    });
    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });
    afterEach(() => {
        global.fetch = realFetch;
    });

    function config(ai) {
        const p = path.join(dir, 'config.json');
        fs.writeFileSync(p, JSON.stringify(ai ? { ai } : {}));
        return p;
    }

    it('returns the fallback when no AI is configured', async () => {
        global.fetch = jest.fn();
        const r = await aiMessageOrFallback(config(null), 'diff', 'update a.js');
        expect(r).toMatchObject({ message: 'update a.js', source: 'default' });
        expect(r.error).toMatch(/No AI provider/);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns the fallback (and logs) when the AI fails or times out', async () => {
        const log = { warn: jest.fn() };
        global.fetch = jest.fn(async () => new Response('nope', { status: 500 }));
        const cfg = config({ provider: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'm' });
        expect(await aiMessageOrFallback(cfg, 'diff', 'update a.js', { log })).toMatchObject({ message: 'update a.js', source: 'default' });
        expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/ai_error.*using the default/));

        global.fetch = jest.fn((_url, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))));
        expect(await aiMessageOrFallback(cfg, 'diff', 'update a.js', { timeoutMs: 40, log })).toMatchObject({ message: 'update a.js', source: 'default' });
        expect(log.warn).toHaveBeenLastCalledWith(expect.stringMatching(/ai_timeout/));
    });

    it('returns the AI message when it answers', async () => {
        global.fetch = jest.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Shorten the hallway timer' } }] }), { status: 200 }));
        const cfg = config({ provider: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'm' });
        expect(await aiMessageOrFallback(cfg, 'diff', 'update a.js')).toEqual({ message: 'Shorten the hallway timer', source: 'ai' });
    });

    it('reads the config file at every call, so a provider added later is used without a restart', async () => {
        global.fetch = jest.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'From the new provider' } }] }), { status: 200 }));
        const cfg = config(null);
        expect((await aiMessageOrFallback(cfg, 'diff', 'fallback')).source).toBe('default');
        fs.writeFileSync(cfg, JSON.stringify({ ai: { providers: [{ id: 'x', provider: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'm' }] } }));
        expect((await aiMessageOrFallback(cfg, 'diff', 'fallback')).message).toBe('From the new provider');
    });
});

describe('readAiConfig() for commit messages', () => {
    const { readAiConfig } = require('../../src/web/commit-message');
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-commit-ai-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const ai = {
        default: 'big',
        providers: [
            { id: 'big', provider: 'anthropic', model: 'model-large', apiKey: 'k1' },
            { id: 'local', provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'small-coder' },
        ],
    };
    function write(extra) {
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, JSON.stringify({ ai, ...extra }));
        return file;
    }

    it('uses the assistant default without the keys', () => {
        const c = readAiConfig(write({}));
        expect(c.id).toBe('big');
        expect(c.model).toBe('model-large');
    });

    it('uses the chosen provider entry and its model', () => {
        const c = readAiConfig(write({ gitCommitAiProvider: 'local' }));
        expect(c.id).toBe('local');
        expect(c.provider).toBe('openai');
        expect(c.model).toBe('small-coder');
    });

    it('replaces the model when gitCommitAiModel is set, with the default provider too', () => {
        expect(readAiConfig(write({ gitCommitAiProvider: 'local', gitCommitAiModel: 'tiny' })).model).toBe('tiny');
        const c = readAiConfig(write({ gitCommitAiModel: ' tiny ' }));
        expect(c.id).toBe('big');
        expect(c.model).toBe('tiny');
    });

    it('falls back to the default when the chosen entry no longer exists', () => {
        expect(readAiConfig(write({ gitCommitAiProvider: 'gone' })).id).toBe('big');
    });

    it('is null without an ai section or a config file', () => {
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, JSON.stringify({ gitCommitAiProvider: 'local' }));
        expect(readAiConfig(file)).toBeNull();
        expect(readAiConfig(null)).toBeNull();
        expect(readAiConfig(path.join(dir, 'missing.json'))).toBeNull();
    });
});
