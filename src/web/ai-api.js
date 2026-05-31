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

const router = express.Router();
let _store = null;

/**
 * @param {import('../lib/state-store')} store
 */
function init(store) {
    _store = store;
}

// ---------------------------------------------------------------------------
// she API reference — injected into the system prompt when requested
// ---------------------------------------------------------------------------
const SHE_API_REF = `## she sandbox API

Scripts run in a sandboxed VM. The \`she\` object is injected automatically.

### Script conventions
- First lines: /* global she */ then 'use strict';
- No require() — the module system is not available
- All subscriptions and schedules persist across reconnects

### MQTT
she.mqtt.sub(topic, [opts], cb)        Subscribe; wildcards: + (1 level) # (multi)
                                         +//sensor  →  +/status/sensor shorthand
                                         opts.change: true = only fire when value changes
she.mqtt.pub(topic, payload, [opts])   Publish; opts: { qos, retain }
she.mqtt.get(topic)                    Current retained value (sync)
she.mqtt.set(topic, val)               Publish as retained
she.mqtt.link(src, target, [fn])       Forward src changes to target; optional transform
she.mqtt.age(topic)                    Seconds since topic last received a message
she.mqtt.on('connect'|'disconnect', cb) MQTT lifecycle events

### Scheduling
she.schedule(pattern, [opts], cb)
  pattern: cron string | Date | suncalc event name
  suncalc events: 'sunrise' 'sunset' 'dawn' 'dusk'
                  'nauticalDawn' 'nauticalDusk' 'solarNoon' 'night'
  opts.shift:  seconds offset (e.g. -1800 = 30 min before event)
  opts.random: max random delay in seconds added to the trigger time

### Universal key-value API
she.on(key, cb)        Subscribe. Key prefixes: mqtt::  var::  matter::
she.set(key, val)      Set value (mqtt:: or var:: namespaces)
she.get(key)           Current value
she.getObject(key)     Current { val, ts, lc } state object

### Variable system (var:: namespace)
Topics prefixed with "var" (default) are persisted as retained MQTT messages
and available across scripts via she.get('var::name') / she.set('var::name', v).

### sheDB
she.db.get(id)                      Get document (undefined if not found)
she.db.set(id, doc)                 Create or overwrite document
she.db.extend(id, partial)          Deep-merge partial into existing document
she.db.delete(id)                   Delete document
she.db.sub(pattern, cb)             Subscribe to document changes (MQTT wildcard)
she.db.query(filter, mapFn, [reduceFn])  Synchronous ad-hoc query → Array

### Matter
she.matter.sub(nodeId, endpointId, cluster, attr, cb)    Subscribe to attribute
she.matter.unsub(listenerId)
she.matter.get(nodeId, endpointId, cluster, attr)         → Promise<value>
she.matter.send(nodeId, endpointId, cluster, cmd, [args]) → Promise<result>

### Helpers
she.timer(src, target, ms)           Pulse target=1 for ms after src goes truthy
she.combineBool(srcs[], target)      Publish OR of source values to target
she.combineMax(srcs[], target)       Publish maximum of source values to target
she.link(src, target, [fn])          Alias for she.mqtt.link
she.age(topic)                       Alias for she.mqtt.age
she.now()                            Current timestamp in ms
she.debug / .info / .warn / .error   Structured logging (prefixed with script name)
she.global                           Shared mutable object across all scripts`;

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

/**
 * Build the full system prompt, including optional context sections.
 *
 * @param {object} requestCtx   { apiref, mqtt, shedb, matter, sampleDocs }
 * @param {{ path?: string, content?: string }|null} currentScript
 * @param {{ id?: string, filter?: string, map?: string, reduce?: string }|null} currentView
 * @param {import('../lib/state-store')|null} store
 * @returns {string}
 */
function buildSystemPrompt(requestCtx, currentScript, currentView, store) {
    const isViewMode = !!(currentView?.id);

    const basePrompt = isViewMode
        ? `You are SHE Assistant, helping write sheDB MapReduce view definitions for she (smart-home-engine).

A view has three optional parts:
1. **Filter** — an MQTT-style topic wildcard (e.g. \`devices/#\`) that selects which document IDs enter the view. Plain string, no code.
2. **Map** — a JavaScript function body. \`this\` is the current document. Call \`emit(value)\` to include a value in the result array. No \`return\`.
3. **Reduce** — a JavaScript function body that receives \`result\` (the array from map) and must \`return\` a transformed value.

When proposing view parts, use these exact formats (include only the parts that change):

\`\`\`filter
devices/#
\`\`\`

\`\`\`javascript
// @view-map
if (this.temperature !== undefined) emit(this.temperature);
\`\`\`

\`\`\`javascript
// @view-reduce
return result.reduce((a, b) => a + b, 0) / result.length;
\`\`\`

Keep the \`// @view-map\` / \`// @view-reduce\` comment as the very first line of each block — the UI uses it to detect which field to fill in.`
        : `You are SHE Assistant, an expert AI pair programmer for she (smart-home-engine).
she is a Node.js daemon that runs user JavaScript scripts in a sandboxed VM for home automation.
When proposing changes to a script, always output the COMPLETE new file content in a single fenced \`\`\`javascript code block. Never output partial diffs or fragments — the user applies the full file at once.
Keep any existing header comments and the 'use strict'; directive.
When the user asks you to CREATE a new script (not modify the current one), place a special hint as the very first line INSIDE the code block (right after the opening \`\`\`javascript fence line), like this:
\`\`\`javascript
// @new-file: descriptive-name.js
/* global she */
'use strict';
// ... rest of script
\`\`\`
Use a short kebab-case filename. Do NOT put the hint outside or before the code block. The UI will detect it and offer to save the file.`;

    const parts = [basePrompt];

    if (requestCtx.apiref) {
        parts.push(SHE_API_REF);
    }

    if (currentScript?.path && typeof currentScript.content === 'string') {
        parts.push(`## Current script: ${currentScript.path}\n\`\`\`javascript\n${currentScript.content}\n\`\`\``);
    }

    if (currentView?.id) {
        const filterStr = (currentView.filter || '').trim();
        const mapBody   = (currentView.map    || '').trim();
        const reduceBody = (currentView.reduce || '').trim();
        const viewLines = [`## Current view: ${currentView.id}`];
        viewLines.push(`Filter: ${filterStr || '(none)'}`);
        viewLines.push(`Map:\n\`\`\`javascript\n${mapBody || '// (empty)'}\n\`\`\``);
        if (reduceBody) {
            viewLines.push(`Reduce:\n\`\`\`javascript\n${reduceBody}\n\`\`\``);
        } else {
            viewLines.push('Reduce: (none)');
        }
        parts.push(viewLines.join('\n'));
    }

    if (requestCtx.mqtt && store) {
        const topics = [];
        for (const [topic, obj] of store.mqttEntries()) {
            topics.push(`${topic}: ${JSON.stringify(obj.val)}`);
            if (topics.length >= 100) {
                topics.push('… (truncated)');
                break;
            }
        }
        if (topics.length > 0) {
            parts.push(`## Current MQTT state\n${topics.join('\n')}`);
        }
    }

    if (requestCtx.shedb) {
        try {
            const core = require('./shedb').getCore();
            if (core) {
                const ids = Object.keys(core.docs).sort();
                if (ids.length > 0) {
                    parts.push(`## sheDB document IDs (${ids.length} total)\n${ids.slice(0, 200).join('\n')}`);
                }
            }
        } catch {
            // shedb not initialised — skip silently
        }
    }

    if (requestCtx.sampleDocs) {
        try {
            const core = require('./shedb').getCore();
            if (core) {
                const ids = Object.keys(core.docs).sort().slice(0, 10);
                if (ids.length > 0) {
                    const sample = ids.map((id) => `### ${id}\n${JSON.stringify(core.docs[id], null, 2)}`).join('\n\n');
                    parts.push(`## Sample sheDB documents (${ids.length} shown)\n${sample}`);
                }
            }
        } catch {
            // shedb not initialised — skip silently
        }
    }

    if (requestCtx.matter) {
        try {
            const controller = require('../matter/controller');
            if (typeof controller.listPaired === 'function') {
                const nodes = controller.listPaired();
                if (nodes.length > 0) {
                    const list = nodes.map((n) => `  nodeId ${n.nodeId}: ${n.label || 'unnamed'}`).join('\n');
                    parts.push(`## Paired Matter devices\n${list}`);
                }
            }
        } catch {
            // matter not initialised — skip silently
        }
    }

    return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Provider adapters — non-streaming
// ---------------------------------------------------------------------------

/**
 * @param {{ baseUrl?: string, model: string, apiKey?: string }} config
 * @param {Array<{role:string,content:string}>} messages
 */
async function callOpenAICompat(config, messages) {
    const base = (config.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    const url = `${base}/v1/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: config.model, messages, stream: false }),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM API error ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = await res.json();
    const choice = json.choices?.[0];
    const message = choice?.message?.content ?? choice?.text ?? '';
    const usage = json.usage
        ? {
              prompt_tokens: json.usage.prompt_tokens,
              completion_tokens: json.usage.completion_tokens,
          }
        : undefined;
    return { message, usage };
}

/**
 * @param {{ model: string, apiKey?: string }} config
 * @param {Array<{role:string,content:string}>} messages  — first may be role:'system'
 */
async function callAnthropic(config, messages) {
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
        }),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = await res.json();
    const message = json.content?.[0]?.text ?? '';
    const usage = json.usage
        ? {
              prompt_tokens: json.usage.input_tokens,
              completion_tokens: json.usage.output_tokens,
          }
        : undefined;
    return { message, usage };
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

// POST /she/ai/chat — non-streaming
router.post('/chat', async (req, res) => {
    const ai = readAiConfig(req.app.locals.configPath);
    if (!ai?.provider || !ai?.model) {
        return res.status(400).json({ error: 'AI provider not configured. Set ai.provider and ai.model in Config.' });
    }

    const { messages = [], currentScript, currentView, context = {}, modelOverride } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be an array' });

    const aiWithModel = (modelOverride && typeof modelOverride === 'string') ? { ...ai, model: modelOverride } : ai;
    const systemPrompt = buildSystemPrompt(context, currentScript ?? null, currentView ?? null, _store);
    const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];

    try {
        let result;
        if (ai.provider === 'anthropic') {
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

    const { messages = [], currentScript, currentView, context = {}, modelOverride } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be an array' });

    const aiWithModel = (modelOverride && typeof modelOverride === 'string') ? { ...ai, model: modelOverride } : ai;

    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    const systemPrompt = buildSystemPrompt(context, currentScript ?? null, currentView ?? null, _store);
    const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];

    try {
        const onToken = (t) => send({ token: t });

        if (ai.provider === 'anthropic') {
            await streamAnthropic(aiWithModel, fullMessages, onToken);
        } else {
            await streamOpenAICompat(aiWithModel, fullMessages, onToken);
        }

        res.write('data: [DONE]\n\n');
        res.end();
    } catch (e) {
        send({ error: e.message });
        res.end();
    }
});

module.exports = { router, init };
