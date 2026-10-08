'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const { router, init, _internal } = require('../../src/web/ai-api');
const { callAnthropic, answerText } = _internal;

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

    it('throws when the answer has no text block instead of returning an empty message', async () => {
        global.fetch = fetchStub(200, { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '…' }] });
        await expect(callAnthropic({ model: 'm', apiKey: 'k' }, [{ role: 'user', content: 'hi' }])).rejects.toThrow(/no text .*stop_reason end_turn.*thinking/);
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
