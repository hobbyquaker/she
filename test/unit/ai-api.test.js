'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const { router, init, _internal } = require('../../src/web/ai-api');
const {
    callAnthropic,
    answerText,
    listAnthropicModels,
    ANTHROPIC_FALLBACK_MODELS,
    providerMessages,
    anthropicSystem,
    plainMessages,
    buildSystemPromptParts,
    normalizeAiConfig,
    resolveAi,
} = _internal;

/** a fetch stub answering every call with the given status and JSON (or SSE text) body */
function fetchStub(status, body, headers = { 'content-type': 'application/json' }) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return jest.fn(async () => new Response(text, { status, headers }));
}

describe('answerText()', () => {
    it('joins every text block and ignores the other block types', () => {
        expect(
            answerText([
                { type: 'thinking', thinking: 'hmm' },
                { type: 'text', text: 'Hello' },
                { type: 'tool_use', id: 'x', name: 'y', input: {} },
                { type: 'text', text: ' world' },
            ]),
        ).toBe('Hello world');
    });

    it('is empty for no content', () => {
        expect(answerText(undefined)).toBe('');
        expect(answerText([])).toBe('');
        expect(answerText([{ type: 'thinking', thinking: 'only' }])).toBe('');
    });
});

describe('callAnthropic()', () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
    });

    it('returns the text of an answer whose first block is not text', async () => {
        global.fetch = fetchStub(200, {
            stop_reason: 'end_turn',
            content: [
                { type: 'thinking', thinking: '…' },
                { type: 'text', text: 'The script switches the light.' },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
        });
        const { message, usage } = await callAnthropic({ model: 'm', apiKey: 'k' }, [{ role: 'user', content: 'hi' }]);
        expect(message).toBe('The script switches the light.');
        expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    });

    it('reports an answer without a text block as empty with the detail', async () => {
        global.fetch = fetchStub(200, { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '…' }] });
        const r = await callAnthropic({ model: 'm', apiKey: 'k' }, [{ role: 'user', content: 'hi' }]);
        expect(r.message).toBe('');
        expect(r.detail).toMatch(/stop_reason end_turn.*thinking/);
    });

    it('throws with the status and body of an API error', async () => {
        global.fetch = fetchStub(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
        await expect(callAnthropic({ model: 'm', apiKey: 'k' }, [{ role: 'user', content: 'hi' }])).rejects.toThrow(/Anthropic API error 401.*invalid x-api-key/);
    });
});

describe('POST /she/ai/chat/stream', () => {
    const realFetch = global.fetch;
    let server, port, dir, log;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-ai-test-'));
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ai: { provider: 'anthropic', model: 'm', apiKey: 'k' } }));
        log = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
        init(null, log);
        const app = express();
        app.use(express.json());
        app.locals.configPath = path.join(dir, 'config.json');
        app.use('/she/ai', router);
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    afterEach(() => {
        global.fetch = realFetch;
        log.error.mockClear();
    });

    /** POST through node's http (the fetch stub must only see the Anthropic call) */
    function post(body) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(body);
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    path: '/she/ai/chat/stream',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
                },
                (res) => {
                    let text = '';
                    res.on('data', (c) => (text += c));
                    res.on('end', () => resolve({ status: res.statusCode, text }));
                },
            );
            req.on('error', reject);
            req.end(data);
        });
    }

    it("sends the provider role and content only, without the chat page's extra fields", async () => {
        global.fetch = fetchStub(200, 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n', { 'content-type': 'text/event-stream' });
        await post({
            messages: [
                { role: 'user', content: 'hi', toolEvents: [{ type: 'tool_call' }] },
                { role: 'assistant', content: '' },
            ],
            context: { tools: false },
        });
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
        expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('streams the text deltas and ends with [DONE]', async () => {
        const sse = [
            'data: {"type":"message_start"}',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}',
            'data: {"type":"message_stop"}',
            '',
        ].join('\n\n');
        global.fetch = fetchStub(200, sse, { 'content-type': 'text/event-stream' });
        const { status, text } = await post({ messages: [{ role: 'user', content: 'hi' }], context: { tools: false } });
        expect(status).toBe(200);
        expect(text).toContain('data: {"token":"Hel"}');
        expect(text).toContain('data: {"token":"lo"}');
        expect(text).toContain('data: [DONE]');
        expect(log.error).not.toHaveBeenCalled();
    });

    it('reports an answer without any text as an error, in the stream and in the log', async () => {
        const sse = [
            'data: {"type":"message_start"}',
            'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"…"}}',
            'data: {"type":"message_stop"}',
            '',
        ].join('\n\n');
        global.fetch = fetchStub(200, sse, { 'content-type': 'text/event-stream' });
        const { text } = await post({ messages: [{ role: 'user', content: 'hi' }], context: { tools: false } });
        expect(text).toContain('data: {"error":"The model returned an empty answer"}');
        expect(text).not.toContain('[DONE]');
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('empty answer'));
    });

    it('reports an API error in the stream and in the log', async () => {
        global.fetch = fetchStub(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
        const { text } = await post({ messages: [{ role: 'user', content: 'hi' }], context: { tools: false } });
        expect(text).toMatch(/"error":"Anthropic API error 401/);
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('401'));
    });
});

describe('listAnthropicModels()', () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
    });

    it('fetches every page and returns the ids newest first with their display names', async () => {
        const pages = [
            { data: [{ id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' }], has_more: true, last_id: 'claude-haiku-4-5' },
            { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-04-01T00:00:00Z' }], has_more: false, last_id: 'claude-opus-5-5' },
        ];
        const calls = [];
        global.fetch = jest.fn(async (url) => {
            calls.push(String(url));
            return new Response(JSON.stringify(pages.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        const r = await listAnthropicModels({ apiKey: 'k' });
        expect(r.models).toEqual(['claude-opus-5-5', 'claude-haiku-4-5']);
        expect(r.names['claude-opus-5-5']).toBe('Claude Opus 5.5');
        expect(r.error).toBeUndefined();
        expect(calls[1]).toContain('after_id=claude-haiku-4-5');
    });

    it('falls back to the static list with the error when the API refuses', async () => {
        global.fetch = fetchStub(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
        init(null, { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() });
        const r = await listAnthropicModels({ apiKey: 'k' });
        expect(r.models).toEqual(ANTHROPIC_FALLBACK_MODELS);
        expect(r.error).toMatch(/401/);
    });
});

describe('providerMessages()', () => {
    it('keeps role and content only and drops empty messages', () => {
        expect(
            providerMessages([
                { role: 'user', content: 'hi', ts: 1 },
                { role: 'assistant', content: '', toolEvents: [{ type: 'tool_call', name: 'x' }] },
                { role: 'assistant', content: 'Hello', toolEvents: [{ type: 'tool_call', name: 'x' }] },
                { role: 'user', content: [{ type: 'text', text: 'blocks' }] },
                { role: 'user', content: [] },
            ]),
        ).toEqual([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'Hello' },
            { role: 'user', content: [{ type: 'text', text: 'blocks' }] },
        ]);
    });

    it('is what the stream route sends to the provider', async () => {
        // the stream test above already covers the route; here: the body Anthropic receives has no extra fields
        expect(providerMessages([{ role: 'user', content: 'x', toolEvents: [] }])[0]).not.toHaveProperty('toolEvents');
    });
});

describe('POST /she/ai/chat/stream with tools (the resolver)', () => {
    const realFetch = global.fetch;
    let server, port, dir, log;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-ai-tools-test-'));
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ai: { provider: 'anthropic', model: 'm', apiKey: 'k' } }));
        log = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
        const entries = [
            ['home/status/bath/light', { val: 0.7 }],
            ['var/status/presence/bath', { val: 1 }],
            ['home/status/kitchen/light', { val: true }],
        ];
        init({ mqttEntries: () => entries[Symbol.iterator]() }, log);
        const app = express();
        app.use(express.json());
        app.locals.configPath = path.join(dir, 'config.json');
        app.use('/she/ai', router);
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    afterEach(() => {
        global.fetch = realFetch;
    });

    function post(body) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(body);
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    path: '/she/ai/chat/stream',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
                },
                (res) => {
                    let text = '';
                    res.on('data', (c) => (text += c));
                    res.on('end', () => resolve({ status: res.statusCode, text }));
                },
            );
            req.on('error', reject);
            req.end(data);
        });
    }

    /** a fetch stub answering the Anthropic calls in sequence; returns the request bodies */
    function sequence(answers) {
        const bodies = [];
        global.fetch = jest.fn(async (url, opts) => {
            bodies.push(JSON.parse(opts.body));
            const a = answers.shift();
            return new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        return bodies;
    }

    it('keeps the tools on offer after a tool round, replays the assistant turn unchanged, and streams the answer', async () => {
        const bodies = sequence([
            {
                stop_reason: 'tool_use',
                content: [
                    { type: 'thinking', thinking: 't' },
                    { type: 'text', text: 'Searching.' },
                    { type: 'tool_use', id: 'tu1', name: 'search_mqtt_topics', input: { query: 'bath' } },
                ],
            },
            { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Two topics mention the bathroom.' }] },
        ]);
        const { text } = await post({ messages: [{ role: 'user', content: 'bath topics?' }], context: { tools: true } });
        expect(text).toContain('"type":"tool_call"');
        expect(text).toContain('data: {"token":"Two topics mention the bathroom."}');
        expect(text).toContain('[DONE]');
        expect(bodies).toHaveLength(2);
        expect(bodies[1].tools.length).toBeGreaterThan(0); // tools still defined in round 2
        const assistantTurn = bodies[1].messages.find((m) => m.role === 'assistant');
        expect(assistantTurn.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']); // unchanged
        const toolResult = bodies[1].messages.at(-1).content[0];
        expect(toolResult.type).toBe('tool_result');
        expect(toolResult.content).toContain('home/status/bath/light');
        expect(toolResult.content).not.toContain('kitchen');
    });

    it('nudges once when the final answer has no text, and reports the detail when that fails too', async () => {
        const bodies = sequence([
            { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'only' }] },
            { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here it is.' }] },
        ]);
        let r = await post({ messages: [{ role: 'user', content: 'hi' }], context: { tools: true } });
        expect(r.text).toContain('data: {"token":"Here it is."}');
        expect(bodies[1].messages.at(-1).content).toMatch(/complete response/);

        sequence([
            { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'only' }] },
            { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'still' }] },
        ]);
        r = await post({ messages: [{ role: 'user', content: 'hi' }], context: { tools: true } });
        expect(r.text).toContain('"error":"The model returned an empty answer (stop_reason end_turn, content blocks: thinking)"');
    });
});

describe('search_mqtt_topics limit', () => {
    const { executeTool } = require('../../src/web/ai-tools');
    const entries = Array.from({ length: 120 }, (_, i) => [`home/status/bath-${i}/light`, { val: i }]);
    const store = { mqttEntries: () => entries[Symbol.iterator]() };

    it('shows 50 by default and says how many matched', async () => {
        const out = await executeTool('search_mqtt_topics', { query: 'bath' }, { store });
        expect(out.split('\n').filter((l) => l.startsWith('home/')).length).toBe(50);
        expect(out).toMatch(/^50 of 120 matching topic\(s\)/);
    });

    it('takes a limit up to 500', async () => {
        const out = await executeTool('search_mqtt_topics', { query: 'bath', limit: 500 }, { store });
        expect(out.split('\n').filter((l) => l.startsWith('home/')).length).toBe(120);
        expect(out).toMatch(/^120 of 120 matching topic\(s\):/);
    });
});

describe('prompt caching (I22)', () => {
    it('splits the prompt into a static and a dynamic part', () => {
        const parts = buildSystemPromptParts({ apiref: true }, { path: 'x.js', content: 'let a = 1;' }, null, null, null, [{ name: 'notes.md', content: 'hello' }]);
        expect(parts.staticText).toMatch(/You are the she assistant/);
        expect(parts.staticText).toMatch(/she sandbox API/);
        expect(parts.staticText).not.toContain('let a = 1;');
        expect(parts.dynamicText).toContain('## Current script: x.js');
        expect(parts.dynamicText).toContain('## Attached file: notes.md');
    });

    it('sends Anthropic the static part as a cached block and the dynamic part after it', () => {
        expect(anthropicSystem({ role: 'system', content: 's\n\nd', staticText: 's', dynamicText: 'd' })).toEqual([
            { type: 'text', text: 's', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'd' },
        ]);
        expect(anthropicSystem({ role: 'system', content: 'plain' })).toBe('plain');
    });

    it('gives OpenAI-compatible endpoints role and content only', () => {
        expect(
            plainMessages([
                { role: 'system', content: 'c', staticText: 's', dynamicText: 'd' },
                { role: 'user', content: 'u' },
            ]),
        ).toEqual([
            { role: 'system', content: 'c' },
            { role: 'user', content: 'u' },
        ]);
    });
});

describe('several AI providers (I14)', () => {
    const list = {
        providers: [
            { id: 'claude', label: 'Anthropic', provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k1' },
            { id: 'local', label: 'Ollama', provider: 'ollama', baseUrl: 'http://ollama:11434', model: 'qwen3:30b' },
        ],
        default: 'local',
        toolResultChars: 4000,
        fetchAllow: ['nas.lan'],
    };

    it('reads the old single-object shape as one entry', () => {
        const n = normalizeAiConfig({ provider: 'anthropic', model: 'm', apiKey: 'k', elasticIndex: 'mqtt-*' });
        expect(n.providers).toEqual([{ id: 'anthropic', label: 'anthropic', provider: 'anthropic', baseUrl: '', model: 'm', apiKey: 'k' }]);
        expect(n.defaultId).toBe('anthropic');
        expect(n.settings).toEqual({ elasticIndex: 'mqtt-*' });
        expect(normalizeAiConfig(null)).toEqual({ providers: [], defaultId: null, settings: {} });
    });

    it('resolves the default, a named entry, and an unknown id', () => {
        const d = resolveAi(list);
        expect(d.id).toBe('local');
        expect(d.provider).toBe('ollama');
        expect(d.toolResultChars).toBe(4000);
        expect(d.fetchAllow).toEqual(['nas.lan']);
        expect(d.providers.map((p) => p.id)).toEqual(['claude', 'local']);
        expect(d.providers.find((p) => p.id === 'claude').apiKey).toBeUndefined(); // never listed
        expect(resolveAi(list, 'claude').apiKey).toBe('k1');
        expect(resolveAi(list, 'nope')).toEqual({ unknown: 'nope' });
        expect(resolveAi(list, '').id).toBe('local');
    });

    it('the config route lists the entries without keys; the chat route takes a providerOverride', async () => {
        const http = require('http');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-ai-providers-'));
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ai: list }));
        const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
        init(null, log);
        const app = express();
        app.use(express.json());
        app.locals.configPath = path.join(dir, 'config.json');
        app.use('/she/ai', router);
        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        const call = (method, p, body) =>
            new Promise((resolve, reject) => {
                const data = body ? JSON.stringify(body) : null;
                const req = http.request(
                    { host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
                    (res) => {
                        let text = '';
                        res.on('data', (c) => (text += c));
                        res.on('end', () => resolve({ status: res.statusCode, text }));
                    },
                );
                req.on('error', reject);
                req.end(data);
            });
        const realFetch = global.fetch;
        try {
            const cfg = JSON.parse((await call('GET', '/she/ai/config')).text);
            expect(cfg.default).toBe('local');
            expect(cfg.provider).toBe('ollama');
            expect(cfg.providers).toEqual([
                { id: 'claude', label: 'Anthropic', provider: 'anthropic', baseUrl: '', model: 'claude-opus-5-5' },
                { id: 'local', label: 'Ollama', provider: 'ollama', baseUrl: 'http://ollama:11434', model: 'qwen3:30b' },
            ]);
            expect(JSON.stringify(cfg)).not.toContain('k1');

            global.fetch = jest.fn(
                async () =>
                    new Response('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n', {
                        status: 200,
                        headers: { 'content-type': 'text/event-stream' },
                    }),
            );
            const r = await call('POST', '/she/ai/chat/stream', { messages: [{ role: 'user', content: 'x' }], context: { tools: false }, providerOverride: 'claude' });
            expect(r.text).toContain('{"token":"hi"}');
            expect(String(global.fetch.mock.calls[0][0])).toContain('api.anthropic.com');
            expect(global.fetch.mock.calls[0][1].headers['x-api-key']).toBe('k1');
            expect(JSON.parse(global.fetch.mock.calls[0][1].body).model).toBe('claude-opus-5-5');
            expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('ai chat: claude/anthropic claude-opus-5-5 (chosen in the chat)'));

            const bad = await call('POST', '/she/ai/chat/stream', { messages: [], context: {}, providerOverride: 'nope' });
            expect(bad.status).toBe(400);
            expect(JSON.parse(bad.text).error).toBe('unknown AI provider entry "nope"');
        } finally {
            global.fetch = realFetch;
            await new Promise((resolve) => server.close(resolve));
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('prompt profiles and the house section (I25)', () => {
    const { houseSection, profileFor, stripThinking, thinkFilter } = require('../../src/web/ai-context');

    it('the reference no longer teaches the wrong age and variable forms', () => {
        const { staticText } = buildSystemPromptParts({ apiref: true, tools: true }, null, null, null, null, []);
        expect(staticText).not.toMatch(/last received a message/);
        expect(staticText).not.toMatch(/var::/);
        expect(staticText).not.toMatch(/she\.mqtt\.set\(/);
        expect(staticText).not.toMatch(/No require/);
        expect(staticText).toMatch(/age\(topic, \['message'\]\)/);
        expect(staticText).toMatch(/var\/set\/<name>/);
        expect(staticText).toContain('## Tools');
        expect(staticText).toContain('@new-file');
    });

    it('the compact profile uses the short reference, the steps, no tools section without support, and a budget', () => {
        const withTools = buildSystemPromptParts({ apiref: true, tools: true }, null, null, null, null, [], { profile: 'compact', toolsOffered: true });
        expect(withTools.staticText).toContain('## she sandbox API (the common part)');
        expect(withTools.staticText).toContain('## How to work (step by step)');
        expect(withTools.staticText).toContain('## Tools');
        const noTools = buildSystemPromptParts({ apiref: true, tools: true }, null, null, null, null, [], { profile: 'compact', toolsOffered: false });
        expect(noTools.staticText).not.toContain('## Tools');

        const big = 'x'.repeat(5000);
        const r = buildSystemPromptParts(
            { apiref: true },
            { path: 's.js', content: 'let a;' },
            null,
            null,
            null,
            [
                { name: 'a.md', content: big },
                { name: 'b.md', content: big },
            ],
            { profile: 'compact', budgetChars: 9000 },
        );
        expect(r.dropped).toEqual(['file:b.md']); // the newest attachment goes first and that already fits; the script stays
        expect(r.dynamicText).toContain('## Attached file: a.md');
        expect(r.dynamicText).toContain('## Current script: s.js');
        expect(r.dynamicText).toContain('Left out to fit');
    });

    it('derives the house section from the daemon, with stable numbers', () => {
        const entries = [];
        for (let i = 0; i < 8702; i++) entries.push([`${i % 3 === 0 ? 'hm' : i % 3 === 1 ? 'zigbee2mqtt' : 'var'}/status/t${i}`, { val: i }]);
        const text = houseSection(
            { name: 'she', variablePrefix: 'var', version: '1.52.0' },
            entries,
            [
                { instance: 'hm', adapter: 'hm2mqtt', connected: 2 },
                { instance: 'cul', adapter: 'cul2mqtt', connected: 0 },
            ],
            [{ id: 'n1', text: 'the bathroom PIR cannot see the shower' }],
        );
        expect(text).toContain("the daemon's MQTT name is `she` (she 1.52.0)");
        expect(text).toMatch(/about 8700 topics/);
        expect(text).toMatch(/`hm\/` \(2900\)/);
        expect(text).toContain('`hm/` hm2mqtt, `cul/` cul2mqtt (offline)');
        expect(text).toContain('- [n1] the bathroom PIR cannot see the shower');
        expect(houseSection(null, null, [], [])).toBe('');
    });

    it('picks the profile by provider and strips thinking from local answers', () => {
        expect(profileFor({ provider: 'anthropic' })).toBe('capable');
        expect(profileFor({ provider: 'ollama' })).toBe('compact');
        expect(profileFor({ provider: 'openai', baseUrl: 'http://localhost:1234' })).toBe('compact');
        expect(profileFor({ provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1' })).toBe('capable');
        expect(profileFor({ provider: 'ollama', profile: 'capable' })).toBe('capable');
        expect(stripThinking('<think>\nhmm\n</think>\n\nThe answer.')).toBe('The answer.');
        const out = [];
        const f = thinkFilter((t) => out.push(t));
        for (const t of ['Hel', 'lo <th', 'ink>secret', ' stuff</th', 'ink> world', '!']) f(t);
        expect(out.join('')).toBe('Hello world!');
    });
});

describe('tool availability and the publish round trip (I16, I20)', () => {
    const { toolsFor } = require('../../src/web/ai-api')._tools;

    it('offers the write tools only with their backing', () => {
        const names = (ctx) => toolsFor({ provider: 'anthropic' }, ctx).map((t) => t.name);
        expect(names({})).not.toContain('publish_mqtt');
        expect(names({})).not.toContain('propose_script');
        expect(names({})).not.toContain('remember');
        expect(names({ memory: {}, drafts: {}, scriptDir: '/s', publish: { mode: 'confirm', send: () => {} } })).toEqual(
            expect.arrayContaining(['publish_mqtt', 'propose_script', 'remember', 'forget', 'search_mqtt_topics']),
        );
        expect(names({ publish: { mode: 'off', send: () => {} } })).not.toContain('publish_mqtt');
    });

    it('the stream route asks for confirmation and publishes through the daemon after the click', async () => {
        const http = require('http');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-ai-publish-'));
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ai: { provider: 'anthropic', model: 'm', apiKey: 'k' } }));
        const published = [];
        const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
        init(null, log, { publish: async (t, p, o) => published.push([t, p, o]) });
        const app = express();
        app.use(express.json());
        app.locals.configPath = path.join(dir, 'config.json');
        app.use('/she/ai', router);
        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        const realFetch = global.fetch;
        const answers = [
            { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'publish_mqtt', input: { topic: 'hm/set/x/STATE', payload: 'true' } }] },
            { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
        ];
        global.fetch = jest.fn(async () => new Response(JSON.stringify(answers.shift()), { status: 200, headers: { 'content-type': 'application/json' } }));
        try {
            const text = await new Promise((resolve, reject) => {
                const data = JSON.stringify({ messages: [{ role: 'user', content: 'switch it on' }], context: { tools: true, publish: 'confirm' } });
                const req = http.request(
                    {
                        host: '127.0.0.1',
                        port,
                        path: '/she/ai/chat/stream',
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
                    },
                    (res) => {
                        let buf = '';
                        let decided = false;
                        res.on('data', (c) => {
                            buf += c;
                            const m = buf.match(/"type":"publish_request","id":"(p[0-9a-f]{8})"/);
                            if (m && !decided) {
                                decided = true;
                                const body = JSON.stringify({ ok: true }); // the user's click
                                const r2 = http.request({
                                    host: '127.0.0.1',
                                    port,
                                    path: '/she/ai/publish/' + m[1],
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                                });
                                r2.end(body);
                            }
                        });
                        res.on('end', () => resolve(buf));
                    },
                );
                req.on('error', reject);
                req.end(data);
            });
            expect(text).toContain('"type":"publish_request"');
            expect(text).toContain('"topic":"hm/set/x/STATE"');
            expect(text).toContain('{"token":"Done."}');
            expect(text).toContain('"type":"publish_decided"');
            expect(text).toContain('"decided":"published"');
            expect(published).toEqual([['hm/set/x/STATE', 'true', { retain: false }]]);
            expect(log.info).toHaveBeenCalledWith(expect.stringContaining('published "true" to hm/set/x/STATE'));
        } finally {
            global.fetch = realFetch;
            await new Promise((resolve) => server.close(resolve));
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('parallel tool calls (I31)', () => {
    it('runs the calls of one round concurrently and keeps their order in the results', async () => {
        const http = require('http');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-ai-parallel-'));
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ai: { provider: 'anthropic', model: 'm', apiKey: 'k' } }));
        const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
        // the publish takes 300 ms; get_health is immediate
        init(null, log, { publish: () => new Promise((resolve) => setTimeout(resolve, 300)), health: () => ({ started: true }) });
        const app = express();
        app.use(express.json());
        app.locals.configPath = path.join(dir, 'config.json');
        app.use('/she/ai', router);
        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        const realFetch = global.fetch;
        const bodies = [];
        const answers = [
            {
                stop_reason: 'tool_use',
                content: [
                    { type: 'tool_use', id: 't1', name: 'publish_mqtt', input: { topic: 'hm/set/x/STATE', payload: 'true' } },
                    { type: 'tool_use', id: 't2', name: 'get_health', input: {} },
                ],
            },
            { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
        ];
        global.fetch = jest.fn(async (url, opts) => {
            bodies.push(JSON.parse(opts.body));
            return new Response(JSON.stringify(answers.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        try {
            const started = Date.now();
            const text = await new Promise((resolve, reject) => {
                const data = JSON.stringify({ messages: [{ role: 'user', content: 'go' }], context: { tools: true, publish: 'all' } });
                const req = http.request(
                    {
                        host: '127.0.0.1',
                        port,
                        path: '/she/ai/chat/stream',
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
                    },
                    (res) => {
                        let buf = '';
                        res.on('data', (c) => (buf += c));
                        res.on('end', () => resolve(buf));
                    },
                );
                req.on('error', reject);
                req.end(data);
            });
            expect(Date.now() - started).toBeLessThan(1000);
            const events = text
                .split('\n')
                .filter((l) => l.startsWith('data: {'))
                .map((l) => JSON.parse(l.slice(6)));
            const kinds = events.filter((e) => e.type).map((e) => e.type + ':' + e.name);
            // both calls announced first; the quick tool's result comes before the slow one's
            expect(kinds.slice(0, 2)).toEqual(['tool_call:publish_mqtt', 'tool_call:get_health']);
            expect(kinds.indexOf('tool_result:get_health')).toBeLessThan(kinds.indexOf('tool_result:publish_mqtt'));
            // the results go back in the model's order, with their ids
            const results = bodies[1].messages.at(-1).content;
            expect(results.map((b) => b.tool_use_id)).toEqual(['t1', 't2']);
            expect(results[0].content).toMatch(/^Published/);
            expect(results[1].content).toMatch(/started: true/);
            expect(text).toContain('{"token":"Done."}');
        } finally {
            global.fetch = realFetch;
            await new Promise((resolve) => server.close(resolve));
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
