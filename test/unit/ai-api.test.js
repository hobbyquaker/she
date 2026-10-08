'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const { router, init, _internal } = require('../../src/web/ai-api');
const { callAnthropic, answerText, listAnthropicModels, ANTHROPIC_FALLBACK_MODELS, providerMessages } = _internal;

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
        expect(out).toMatch(/50 of 120 matching topics shown/);
    });

    it('takes a limit up to 500', async () => {
        const out = await executeTool('search_mqtt_topics', { query: 'bath', limit: 500 }, { store });
        expect(out.split('\n').filter((l) => l.startsWith('home/')).length).toBe(120);
        expect(out).not.toMatch(/matching topics shown/);
    });
});
