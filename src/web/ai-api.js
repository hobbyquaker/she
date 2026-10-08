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
const path = require('path');

const { buildSystemPrompt } = require('./ai-context');
const { TOOL_DEFINITIONS, TOOL_DEFINITIONS_ANTHROPIC, executeTool } = require('./ai-tools');
const { STORAGE_ROOT } = require('../lib/storage');

const router = express.Router();
let _store = null;

/**
 * @param {import('../lib/state-store')} store
 */
let _log = console;

/**
 * @param {object} store
 * @param {{ error: Function, warn: Function }} [log] — the daemon's logger; console until init
 */
function init(store, log) {
    if (log) _log = log;
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

    // Detect tool call response — some models return finish_reason 'stop' even with tool calls
    if (choice?.message?.tool_calls?.length) {
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
        // thinking tokens count against this on the current models; 4096 cut answers short
        max_tokens: 16384,
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

    // an answer without any text block (e.g. only a thinking block) is reported, not shown as nothing:
    // the caller nudges once and otherwise turns `detail` into the error
    const message = answerText(json.content);
    const detail = message ? undefined : `stop_reason ${json.stop_reason}, content blocks: ${(json.content || []).map((b) => b.type).join(',') || 'none'}`;
    return { message, usage, detail, assistantMsg: json.content };
}

/**
 * What a provider may see of a conversation: role and content only. The chat page stores more on its messages
 * (tool events, timestamps) and Anthropic rejects unknown fields; empty messages are left out too (Anthropic
 * rejects empty text, and the chat saved empty answers before B-13).
 * @param {Array<{role:string,content:any}>} messages
 */
function providerMessages(messages) {
    return messages
        .filter((m) => m && typeof m.role === 'string')
        .map((m) => ({ role: m.role, content: m.content }))
        .filter((m) => (typeof m.content === 'string' ? m.content.trim() !== '' : Array.isArray(m.content) ? m.content.length > 0 : m.content != null));
}

/**
 * The text of an Anthropic answer: every text block joined, other block types (thinking, tool_use) ignored.
 * @param {Array<{type:string,text?:string}>|undefined} content
 */
function answerText(content) {
    if (!Array.isArray(content)) return '';
    return content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
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
    let toolsUsed = false;
    // The tools stay on offer in every round (up to MAX_TOOL_ROUNDS): a search that was cut short can be refined,
    // and a history with tool_use blocks is only valid when the tools are defined. The round cap ends a model that
    // keeps calling tools; an empty final answer is nudged once below.
    const MAX_TOOL_ROUNDS = 8;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        let result;
        try {
            result = isAnthropic ? await callAnthropic(ai, msgs, tools) : await callOpenAICompat(ai, msgs, tools);
        } catch (e) {
            if (round === 0) {
                // Model may not support tool calling — retry without tools
                result = isAnthropic ? await callAnthropic(ai, msgs) : await callOpenAICompat(ai, msgs);
            } else {
                throw e;
            }
        }

        // No tool calls → we have the final answer
        if (!result.toolCalls?.length) {
            if (!result.message) {
                // An answer without text (a thinking block only, or nothing): ask once for the answer itself.
                const nudgeMsgs = [
                    ...msgs,
                    {
                        role: 'user',
                        content: toolsUsed
                            ? 'Based on the information retrieved above, please now provide your complete response.'
                            : 'Please provide your complete response as text.',
                    },
                ];
                const nudged = isAnthropic
                    ? await callAnthropic(ai, nudgeMsgs, toolsUsed ? tools : undefined)
                    : await callOpenAICompat(ai, nudgeMsgs, toolsUsed ? tools : undefined);
                return { message: nudged.message ?? '', usage: nudged.usage, detail: nudged.message ? undefined : nudged.detail || result.detail };
            }
            return { message: result.message ?? '', usage: result.usage };
        }

        // Execute tool calls and append results to message history
        toolsUsed = true;
        if (isAnthropic) {
            // the assistant turn goes back unchanged: the current models bind their thinking blocks to the turn
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
            // Strip any draft content alongside tool_calls — if kept, the model reproduces
            // the (hallucinated) draft in round 1 instead of using the tool results.
            const assistantEntry = { ...result.assistantMsg, role: 'assistant' };
            if (assistantEntry.content && assistantEntry.tool_calls?.length) assistantEntry.content = null;
            msgs = [...msgs, assistantEntry];
            for (const tc of result.toolCalls) {
                const name = tc.function.name;
                let args;
                try {
                    args = JSON.parse(tc.function.arguments || '{}');
                } catch {
                    args = {};
                }
                onEvent?.({ type: 'tool_call', name, args });
                const content = await executeTool(name, args, toolContext);
                onEvent?.({ type: 'tool_result', name, content });
                msgs = [...msgs, { role: 'tool', tool_call_id: tc.id, content }];
            }
        }
    }

    // The round cap was reached: ask for the answer with what was gathered (the tools stay defined - the history
    // holds tool_use blocks - but the request asks for text).
    const finalMsgs = [...msgs, { role: 'user', content: 'Please answer now with the information gathered so far; do not call any more tools.' }];
    const fallback = isAnthropic ? await callAnthropic(ai, finalMsgs, tools) : await callOpenAICompat(ai, finalMsgs, tools);
    return { message: fallback.message ?? '', usage: fallback.usage, detail: fallback.message ? undefined : fallback.detail };
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

// Shown when the Anthropic models endpoint cannot be reached (no key, offline, 401): the current families.
const ANTHROPIC_FALLBACK_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5'];

/**
 * The models the configured Anthropic key may use: GET /v1/models, every page, newest first.
 * On failure the static fallback list with the error, so the chat still offers a choice.
 * @param {{ apiKey?: string }} ai
 * @returns {Promise<{ models: string[], names: Record<string,string>, error?: string }>}
 */
async function listAnthropicModels(ai) {
    const headers = { 'x-api-key': ai.apiKey || '', 'anthropic-version': '2023-06-01' };
    const all = [];
    try {
        let after = null;
        for (let page = 0; page < 20; page++) {
            const url = 'https://api.anthropic.com/v1/models?limit=100' + (after ? '&after_id=' + encodeURIComponent(after) : '');
            const r = await fetch(url, { headers });
            if (!r.ok) {
                const text = await r.text().catch(() => '');
                throw new Error(`Anthropic API error ${r.status}: ${text.slice(0, 200)}`);
            }
            const json = await r.json();
            for (const m of json.data || []) if (m && m.id) all.push(m);
            if (!json.has_more || !json.last_id) break;
            after = json.last_id;
        }
    } catch (e) {
        _log.warn('ai models: ' + e.message);
        return { models: ANTHROPIC_FALLBACK_MODELS.slice(), names: {}, error: e.message };
    }
    all.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const names = {};
    for (const m of all) if (m.display_name) names[m.id] = m.display_name;
    return { models: all.map((m) => m.id), names };
}

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
            const models = (json.models || [])
                .map((m) => m.name || m.model)
                .filter(Boolean)
                .sort();
            return res.json({ models });
        } else if (ai.provider === 'anthropic') {
            return res.json(await listAnthropicModels(ai));
        } else {
            // OpenAI / LM Studio / etc. — try /v1/models
            const h = { 'Content-Type': 'application/json' };
            if (ai.apiKey) h['Authorization'] = `Bearer ${ai.apiKey}`;
            const r = await fetch(`${base}/v1/models`, { headers: h });
            if (!r.ok) throw new Error(`/v1/models returned ${r.status}`);
            const json = await r.json();
            const models = (json.data || [])
                .map((m) => m.id)
                .filter(Boolean)
                .sort();
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
    const model = typeof req.query.model === 'string' && req.query.model ? req.query.model : ai.model;

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
        running: psRes.status === 'fulfilled' ? psRes.value.models || [] : null,
        contextLength: (() => {
            if (showRes.status !== 'fulfilled') return null;
            const info = showRes.value.model_info;
            if (!info || typeof info !== 'object') return null;
            const key = Object.keys(info).find((k) => k.endsWith('.context_length'));
            return key ? (info[key] ?? null) : null;
        })(),
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
    const { messages = [], currentScript, currentView, currentDoc, context = {}, modelOverride, extraFiles } = req.body || {};
    const effectiveModel = modelOverride && typeof modelOverride === 'string' ? modelOverride : ai?.model;
    if (!ai?.provider || !effectiveModel) {
        return res.status(400).json({ error: 'AI provider not configured. Set ai.provider and ai.model in Config.' });
    }

    if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be an array' });

    const aiWithModel = { ...ai, model: effectiveModel };
    _log.debug(`ai chat: ${ai.provider} ${effectiveModel}${modelOverride ? ' (chosen in the chat)' : ' (config)'}`);
    const systemPrompt = buildSystemPrompt(context, currentScript ?? null, currentView ?? null, currentDoc ?? null, _store, extraFiles || []);
    const fullMessages = [{ role: 'system', content: systemPrompt }, ...providerMessages(messages)];

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
        if (!result.message || !String(result.message).trim()) throw new Error('The model returned an empty answer' + (result.detail ? ` (${result.detail})` : ''));
        res.json({ message: result.message, usage: result.usage });
    } catch (e) {
        _log.error('ai chat: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /she/ai/chat/stream — SSE streaming
router.post('/chat/stream', async (req, res) => {
    const ai = readAiConfig(req.app.locals.configPath);
    const { messages = [], currentScript, currentView, currentDoc, context = {}, modelOverride, extraFiles } = req.body || {};
    const effectiveModel = modelOverride && typeof modelOverride === 'string' ? modelOverride : ai?.model;
    if (!ai?.provider || !effectiveModel) {
        return res.status(400).json({ error: 'AI provider not configured. Set ai.provider and ai.model in Config.' });
    }

    if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be an array' });

    const aiWithModel = { ...ai, model: effectiveModel };
    _log.debug(`ai chat: ${ai.provider} ${effectiveModel}${modelOverride ? ' (chosen in the chat)' : ' (config)'}`);

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

    const fullMessages = [{ role: 'system', content: systemPrompt }, ...providerMessages(messages)];

    try {
        if (context.tools) {
            // Tool-calling mode: resolve tools non-streaming (emitting events), then
            // send the final answer as a single token so the client sees it immediately.
            const toolContext = { store: _store, scriptDir: req.app.locals.scriptDir || null };
            const { message, detail } = await resolveAndGetAnswer(aiWithModel, fullMessages, toolContext, send);
            if (!message || !message.trim()) throw new Error('The model returned an empty answer' + (detail ? ` (${detail})` : ''));
            send({ token: message });
        } else {
            let tokens = 0;
            const onToken = (t) => {
                tokens++;
                send({ token: t });
            };
            if (ai.provider === 'anthropic') {
                await streamAnthropic(aiWithModel, fullMessages, onToken);
            } else {
                await streamOpenAICompat(aiWithModel, fullMessages, onToken);
            }
            if (tokens === 0) throw new Error('The model returned an empty answer');
        }

        res.write('data: [DONE]\n\n');
        res.end();
    } catch (e) {
        _log.error('ai chat: ' + e.message);
        send({ error: e.message });
        res.end();
    }
});

// ---------------------------------------------------------------------------
// Conversation persistence — GET/PUT/DELETE /she/ai/conversations[/:id]
// ---------------------------------------------------------------------------

const AI_DIR = path.join(STORAGE_ROOT, 'ai');

function ensureAiDir() {
    fs.mkdirSync(AI_DIR, { recursive: true });
}

function convPath(id) {
    // Sanitize: only allow alphanumerics, hyphens, underscores
    if (!/^[a-z0-9_-]{1,64}$/i.test(id)) return null;
    return path.join(AI_DIR, `${id}.json`);
}

// GET /she/ai/conversations — list conversations sorted by updatedAt desc
router.get('/conversations', (req, res) => {
    ensureAiDir();
    let list = [];
    try {
        const files = fs.readdirSync(AI_DIR).filter((f) => f.endsWith('.json'));
        list = files
            .map((f) => {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(AI_DIR, f), 'utf8'));
                    return { id: data.id, title: data.title || data.id, updatedAt: data.updatedAt || 0 };
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
        list.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
        /* empty dir */
    }
    res.json(list);
});

// GET /she/ai/conversations/:id
router.get('/conversations/:id', (req, res) => {
    const p = convPath(req.params.id);
    if (!p) return res.status(400).json({ error: 'invalid id' });
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        res.json(data);
    } catch {
        res.status(404).json({ error: 'not found' });
    }
});

// PUT /she/ai/conversations/:id — { title, messages }
router.put('/conversations/:id', (req, res) => {
    const p = convPath(req.params.id);
    if (!p) return res.status(400).json({ error: 'invalid id' });
    const { title, messages } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be an array' });
    ensureAiDir();
    const data = { id: req.params.id, title: String(title || req.params.id).slice(0, 200), updatedAt: Date.now(), messages };
    fs.writeFileSync(p, JSON.stringify(data), 'utf8');
    res.json({ ok: true });
});

// DELETE /she/ai/conversations/:id
router.delete('/conversations/:id', (req, res) => {
    const p = convPath(req.params.id);
    if (!p) return res.status(400).json({ error: 'invalid id' });
    try {
        fs.unlinkSync(p);
    } catch {
        /* already gone */
    }
    res.json({ ok: true });
});

module.exports = { router, init, _internal: { callAnthropic, answerText, readAiConfig, listAnthropicModels, ANTHROPIC_FALLBACK_MODELS, providerMessages } };
