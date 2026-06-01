'use strict';

/**
 * AI Assistant REST API — Express router mounted at /she/ai
 *
 * Proxies chat requests to a configured LLM provider (Ollama, LM Studio,
 * OpenAI, or Anthropic), assembling context (MQTT state, sheDB doc IDs,
 * Matter devices, she API reference) server-side based on per-request flags.
 *
 * Routes:
 *   GET  /she/ai/config        → { configured, provider, model, baseUrl }
 *   POST /she/ai/chat          → { message, usage? }           (non-streaming)
 *   POST /she/ai/chat/stream   → SSE  data: {"token":"..."}    (streaming)
 *                                     data: [DONE]
 *
 * Call init(store) once after the state store is created.
 */

const express = require('express');
const fs = require('fs');

const { buildSystemPrompt } = require('./ai-context');
const { TOOL_DEFINITIONS, TOOL_DEFINITIONS_ANTHROPIC, executeTool } = require('./ai-tools');

const router = express.Router();
let _store = null;

/**
 * @param {import('../lib/state-store')} store
 */
function init(store) {
    _store = store;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the ai config section from config.json.
 * Returns null if unavailable.
 * @param {string|undefined} configPath
 * @returns {{ provider?: string, baseUrl?: string, model?: string, apiKey?: string }|null}
 */
function readAiConfig(configPath) {
    if (!configPath) return null;
    try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return cfg.ai || null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Provider adapters — non-streaming
// ---------------------------------------------------------------------------

/**
 * @param {{ baseUrl?: string, model: string, apiKey?: string }} config
 * @param {Array<{role:string,content:string}>} messages
 * @param {Array|undefined} [tools]  — OpenAI tool definitions; omit to disable tool calling
 * @returns {{ message?: string, usage?: object, toolCalls?: Array, assistantMsg?: object }}
 */
async function callOpenAICompat(config, messages, tools) {
    const base = (config.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    const url = `${base}/v1/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    const body = { model: config.model, messages, stream: false };
    if (tools?.length) body.tools = tools;

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM API error ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = await res.json();
    const choice = json.choices?.[0];
    const usage = json.usage
        ? {
              prompt_tokens: json.usage.prompt_tokens,
              completion_tokens: json.usage.completion_tokens,
          }
        : undefined;

    // Detect tool call response
    if (choice?.finish_reason === 'tool_calls' && choice.message?.tool_calls?.length) {
        return { toolCalls: choice.message.tool_calls, assistantMsg: choice.message, usage };
    }

    const message = choice?.message?.content ?? choice?.text ?? '';
    return { message, usage };
}

/**
 * @param {{ model: string, apiKey?: string }} config
 * @param {Array<{role:string,content:string}>} messages  — first may be role:'system'
 * @param {Array|undefined} [tools]  — Anthropic tool definitions; omit to disable tool calling
 * @returns {{ message?: string, usage?: object, toolCalls?: Array, assistantMsg?: Array }}
 */
async function callAnthropic(config, messages, tools) {
    const systemMsg = messages.find((m) => m.role === 'system');
    const userMessages = messages.filter((m) => m.role !== 'system');

    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey || '',
        'anthropic-version': '2023-06-01',
    };

    const body = {
        model: config.model,
        system: systemMsg?.content || '',
        messages: userMessages,
        max_tokens: 4096,
    };
    if (tools?.length) body.tools = tools;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = await res.json();
    const usage = json.usage
        ? {
              prompt_tokens: json.usage.input_tokens,
              completion_tokens: json.usage.output_tokens,
          }
        : undefined;

    // Detect tool use response
    if (json.stop_reason === 'tool_use') {
        const toolCalls = (json.content || []).filter((b) => b.type === 'tool_use');
        return { toolCalls, assistantMsg: json.content, usage };
    }

    const message = json.content?.[0]?.text ?? '';
    return { message, usage };
}

// ---------------------------------------------------------------------------
// Tool-calling resolver
// ---------------------------------------------------------------------------

/**
 * Run the tool-calling loop: call the LLM, execute any tool calls, repeat
 * until the model produces a plain text answer (no more tool calls).
 *
 * Emits { type:'tool_call', name, args } and { type:'tool_result', name, content }
 * events via onEvent (used for SSE feedback to the client).
 *
 * @param {{ provider: string, baseUrl?: string, model: string, apiKey?: string }} ai
 * @param {Array} messages  — initial message list (system prompt already included)
 * @param {{ store: any, scriptDir: string|null }} toolContext
 * @param {((event: object) => void)|undefined} onEvent
 * @returns {Promise<{ message: string, usage?: object }>}
 */
async function resolveAndGetAnswer(ai, messages, toolContext, onEvent) {
    const isAnthropic = ai.provider === 'anthropic';
    const tools = isAnthropic ? TOOL_DEFINITIONS_ANTHROPIC : TOOL_DEFINITIONS;
    let msgs = messages;
    let toolsUsed = false;  // once the model has used tools, stop offering them

    for (let round = 0; round < 6; round++) {
        // After the first round of tool calls, don't offer tools again.
        // This forces a plain-text response rather than letting the model
        // keep calling tools indefinitely (and some models return empty
        // content when given tools but no reason to call them).
        const roundTools = toolsUsed ? undefined : tools;

        let result;
        try {
            result = isAnthropic
                ? await callAnthropic(ai, msgs, roundTools)
                : await callOpenAICompat(ai, msgs, roundTools);
        } catch (e) {
            if (round === 0 && roundTools) {
                // Model may not support tool calling — retry without tools
                result = isAnthropic
                    ? await callAnthropic(ai, msgs)
                    : await callOpenAICompat(ai, msgs);
            } else {
                throw e;
            }
        }

        // No tool calls → we have the final answer
        if (!result.toolCalls?.length) {
            // If the model returned empty content after using tools, nudge it once
            if (!result.message && toolsUsed) {
                const nudgeMsgs = [
                    ...msgs,
                    { role: 'user', content: 'Based on the information retrieved above, please now provide your complete response.' },
                ];
                const nudged = isAnthropic
                    ? await callAnthropic(ai, nudgeMsgs)
                    : await callOpenAICompat(ai, nudgeMsgs);
                return { message: nudged.message ?? '', usage: nudged.usage };
            }
            return { message: result.message ?? '', usage: result.usage };
        }

        // Execute tool calls and append results to message history
        toolsUsed = true;
        if (isAnthropic) {
            msgs = [...msgs, { role: 'assistant', content: result.assistantMsg }];
            const toolResultBlocks = [];
            for (const tc of result.toolCalls) {
                const args = tc.input || {};
                onEvent?.({ type: 'tool_call', name: tc.name, args });
                const content = await executeTool(tc.name, args, toolContext);
                onEvent?.({ type: 'tool_result', name: tc.name, content });
                toolResultBlocks.push({ type: 'tool_result', tool_use_id: tc.id, content });
            }
            msgs = [...msgs, { role: 'user', content: toolResultBlocks }];
        } else {
            msgs = [...msgs, { ...result.assistantMsg, role: 'assistant' }];
            for (const tc of result.toolCalls) {
                const name = tc.function.name;
                let args;
                try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
                onEvent?.({ type: 'tool_call', name, args });
                const content = await executeTool(name, args, toolContext);
                onEvent?.({ type: 'tool_result', name, content });
                msgs = [...msgs, { role: 'tool', tool_call_id: tc.id, content }];
            }
        }
    }

    // Fallback (should not normally be reached)
    const fallback = isAnthropic
        ? await callAnthropic(ai, msgs)
        : await callOpenAICompat(ai, msgs);
    return { message: fallback.message ?? '', usage: fallback.usage };
}

// ---------------------------------------------------------------------------
// Provider adapters — streaming
// ---------------------------------------------------------------------------

/**
 * Parse an SSE ReadableStream, calling onToken for each non-null extracted value.
 * @param {ReadableStream} body
 * @param {(json:object)=>string|null|undefined} tokenExtractor
 * @param {(token:string)=>void} onToken
 */
async function parseSseStream(body, tokenExtractor, onToken) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') return;
                try {
                    const json = JSON.parse(data);
                    const token = tokenExtractor(json);
                    if (token) onToken(token);
                } catch {
                    // skip malformed JSON lines
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * Stream tokens from an OpenAI-compatible endpoint.
 * Calls onToken(str) for each chunk, resolves when stream ends.
 */
async function streamOpenAICompat(config, messages, onToken) {
    const base = (config.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    const url = `${base}/v1/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: config.model, messages, stream: true }),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM API error ${res.status}: ${text.slice(0, 300)}`);
    }

    await parseSseStream(res.body, (json) => json.choices?.[0]?.delta?.content, onToken);
}

/**
 * Stream tokens from Anthropic Messages API.
 */
async function streamAnthropic(config, messages, onToken) {
    const systemMsg = messages.find((m) => m.role === 'system');
    const userMessages = messages.filter((m) => m.role !== 'system');

    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey || '',
        'anthropic-version': '2023-06-01',
    };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: config.model,
            system: systemMsg?.content || '',
            messages: userMessages,
            max_tokens: 4096,
            stream: true,
        }),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 300)}`);
    }

    await parseSseStream(res.body, (json) => json.delta?.text, onToken);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /she/ai/config
router.get('/config', (req, res) => {
    const ai = readAiConfig(req.app.locals.configPath);
    res.json({
        configured: !!(ai?.provider && ai?.model),
        provider: ai?.provider || '',
        model: ai?.model || '',
        baseUrl: ai?.baseUrl || '',
    });
});

// GET /she/ai/models — list available models for the configured provider
router.get('/models', async (req, res) => {
    const ai = readAiConfig(req.app.locals.configPath);
    if (!ai?.provider) return res.json({ models: [] });

    const base = (ai.baseUrl || 'http://localhost:11434').replace(/\/$/, '');

    try {
        if (ai.provider === 'ollama') {
            const r = await fetch(`${base}/api/tags`);
            if (!r.ok) throw new Error(`Ollama /api/tags returned ${r.status}`);
            const json = await r.json();
            const models = (json.models || []).map((m) => m.name || m.model).filter(Boolean).sort();
            return res.json({ models });
        } else if (ai.provider === 'anthropic') {
            return res.json({ models: [] }); // no public list endpoint
        } else {
            // OpenAI / LM Studio / etc. — try /v1/models
            const h = { 'Content-Type': 'application/json' };
            if (ai.apiKey) h['Authorization'] = `Bearer ${ai.apiKey}`;
            const r = await fetch(`${base}/v1/models`, { headers: h });
            if (!r.ok) throw new Error(`/v1/models returned ${r.status}`);
            const json = await r.json();
            const models = (json.data || []).map((m) => m.id).filter(Boolean).sort();
            return res.json({ models });
        }
    } catch (e) {
        res.status(500).json({ error: e.message, models: [] });
    }
});

// GET /she/ai/model-info — Ollama-specific: version, model details, running models
// Query param: ?model=<name>  (defaults to configured model)
router.get('/model-info', async (req, res) => {
    const ai = readAiConfig(req.app.locals.configPath);
    if (!ai?.provider || !ai?.model) return res.status(400).json({ error: 'Not configured' });
    if (ai.provider !== 'ollama') return res.status(400).json({ error: 'Model info is only available for Ollama' });

    const base = (ai.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    const model = (typeof req.query.model === 'string' && req.query.model) ? req.query.model : ai.model;

    const [versionRes, showRes, psRes] = await Promise.allSettled([
        fetch(`${base}/api/version`).then((r) => r.json()),
        fetch(`${base}/api/show`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: model, model }),
        }).then((r) => r.json()),
        fetch(`${base}/api/ps`).then((r) => r.json()),
    ]);

    res.json({
        version: versionRes.status === 'fulfilled' ? versionRes.value.version : null,
        details: showRes.status === 'fulfilled' ? showRes.value.details : null,
        running: psRes.status === 'fulfilled' ? (psRes.value.models || []) : null,
    });
});

// POST /she/ai/prompt — return the current system prompt for preview
router.post('/prompt', (req, res) => {
    const { context = {}, currentScript, currentView, currentDoc, extraFiles } = req.body || {};
    try {
        const prompt = buildSystemPrompt(context, currentScript ?? null, currentView ?? null, currentDoc ?? null, _store, extraFiles || []);
        res.json({ prompt });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /she/ai/chat — non-streaming
router.post('/chat', async (req, res) => {
    const ai = readAiConfig(req.app.locals.configPath);
    if (!ai?.provider || !ai?.model) {
        return res.status(400).json({ error: 'AI provider not configured. Set ai.provider and ai.model in Config.' });
    }

    const { messages = [], currentScript, currentView, currentDoc, context = {}, modelOverride, extraFiles } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be an array' });

    const aiWithModel = (modelOverride && typeof modelOverride === 'string') ? { ...ai, model: modelOverride } : ai;
    const systemPrompt = buildSystemPrompt(context, currentScript ?? null, currentView ?? null, currentDoc ?? null, _store, extraFiles || []);
    const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];

    try {
        let result;
        if (context.tools) {
            const toolContext = { store: _store, scriptDir: req.app.locals.scriptDir || null };
            result = await resolveAndGetAnswer(aiWithModel, fullMessages, toolContext, undefined);
        } else if (ai.provider === 'anthropic') {
            result = await callAnthropic(aiWithModel, fullMessages);
        } else {
            result = await callOpenAICompat(aiWithModel, fullMessages);
        }
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /she/ai/chat/stream — SSE streaming
router.post('/chat/stream', async (req, res) => {
    const ai = readAiConfig(req.app.locals.configPath);
    if (!ai?.provider || !ai?.model) {
        return res.status(400).json({ error: 'AI provider not configured. Set ai.provider and ai.model in Config.' });
    }

    const { messages = [], currentScript, currentView, currentDoc, context = {}, modelOverride, extraFiles } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be an array' });

    const aiWithModel = (modelOverride && typeof modelOverride === 'string') ? { ...ai, model: modelOverride } : ai;

    // Build system prompt BEFORE flushing headers so errors can still return a proper HTTP status
    let systemPrompt;
    try {
        systemPrompt = buildSystemPrompt(context, currentScript ?? null, currentView ?? null, currentDoc ?? null, _store, extraFiles || []);
    } catch (e) {
        return res.status(500).json({ error: `Failed to build system prompt: ${e.message}` });
    }

    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];

    try {
        if (context.tools) {
            // Tool-calling mode: resolve tools non-streaming (emitting events), then
            // send the final answer as a single token so the client sees it immediately.
            const toolContext = { store: _store, scriptDir: req.app.locals.scriptDir || null };
            const { message } = await resolveAndGetAnswer(aiWithModel, fullMessages, toolContext, send);
            send({ token: message });
        } else {
            const onToken = (t) => send({ token: t });
            if (ai.provider === 'anthropic') {
                await streamAnthropic(aiWithModel, fullMessages, onToken);
            } else {
                await streamOpenAICompat(aiWithModel, fullMessages, onToken);
            }
        }

        res.write('data: [DONE]\n\n');
        res.end();
    } catch (e) {
        send({ error: e.message });
        res.end();
    }
});

module.exports = { router, init };
