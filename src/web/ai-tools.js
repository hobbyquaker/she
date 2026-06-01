'use strict';

/**
 * AI tool definitions and executor for the she AI assistant.
 *
 * Available tools:
 *   search_mqtt_topics  — fuzzy-search known MQTT topics in the state store
 *   read_script         — read a script file from the scripts directory
 *   get_script_logs     — retrieve recent log entries, optionally filtered by script name
 *   she_fetch           — fetch a URL and return its text content
 */

const fs = require('fs');
const path = require('path');
const { getLogBuffer } = require('./log-ws');

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

/** Tool definitions in OpenAI function-calling format. */
const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'search_mqtt_topics',
            description:
                'Search for MQTT topics currently tracked by the she daemon. ' +
                'Returns matching topic names and their current values. ' +
                'Use this to discover real topic names before writing scripts.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Case-insensitive substring to match against topic names. Pass empty string to list all topics (capped at 50).',
                    },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_script',
            description:
                'Read the content of a script file from the she scripts directory. ' +
                'Use this to review existing scripts before suggesting changes.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Script file path relative to the scripts directory, e.g. "lights.js" or "lib/utils.js".',
                    },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_script_logs',
            description:
                'Retrieve recent log messages from the she daemon. ' +
                'Filter by script name to diagnose errors or trace what a specific script has been doing.',
            parameters: {
                type: 'object',
                properties: {
                    script_name: {
                        type: 'string',
                        description: 'Filter log lines to those mentioning this script name (file name without extension). Pass empty string to get all recent logs.',
                    },
                    limit: {
                        type: 'integer',
                        description: 'Maximum number of log lines to return (1-200, default 50).',
                    },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'she_fetch',
            description:
                'Fetch the content of a URL and return it as plain text. ' +
                'Use this to retrieve documentation, data sheets, or any web resource relevant to the user request. ' +
                'HTML is stripped to plain text automatically.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The URL to fetch (http or https).',
                    },
                },
                required: ['url'],
            },
        },
    },
];

/** Same definitions in Anthropic tool format. */
const TOOL_DEFINITIONS_ANTHROPIC = TOOL_DEFINITIONS.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
}));

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute a named tool and return its result as a plain string.
 * @param {string} name  — tool function name
 * @param {object} args  — parsed arguments from LLM
 * @param {{ store: import('../lib/state-store')|null, scriptDir: string|null }} ctx
 * @returns {string}
 */
async function executeTool(name, args, ctx) {
    try {
        switch (name) {
            case 'search_mqtt_topics': return toolSearchMqttTopics(args, ctx.store);
            case 'read_script':        return toolReadScript(args, ctx.scriptDir);
            case 'get_script_logs':    return toolGetScriptLogs(args);
            case 'she_fetch':          return await toolSheFetch(args);
            default:                   return `Unknown tool: ${name}`;
        }
    } catch (e) {
        return `Tool error (${name}): ${e.message}`;
    }
}

// ---------------------------------------------------------------------------
// Individual tools
// ---------------------------------------------------------------------------

function toolSearchMqttTopics({ query = '' }, store) {
    if (!store) return 'MQTT state store not available.';
    const q = query.toLowerCase();
    const results = [];
    for (const [topic, obj] of store.mqttEntries()) {
        if (!q || topic.toLowerCase().includes(q)) {
            results.push(`${topic}: ${JSON.stringify(obj.val)}`);
            if (results.length >= 50) {
                results.push('… (truncated to 50 results, use a more specific query)');
                break;
            }
        }
    }
    if (results.length === 0) {
        return q ? `No MQTT topics found matching "${query}".` : 'No MQTT topics tracked yet.';
    }
    return `Found ${results.length} topic(s):\n${results.join('\n')}`;
}

function toolReadScript({ path: relPath }, scriptDir) {
    if (!scriptDir) return 'Scripts directory not configured.';
    if (!relPath || typeof relPath !== 'string') return 'path argument is required.';
    const abs = path.resolve(scriptDir, relPath.replace(/^\/+/, ''));
    // Path traversal guard
    if (!abs.startsWith(scriptDir + path.sep) && abs !== scriptDir) {
        return 'Access denied: path escapes the scripts directory.';
    }
    if (!fs.existsSync(abs)) return `File not found: ${relPath}`;
    const content = fs.readFileSync(abs, 'utf8');
    return `## ${relPath}\n\`\`\`javascript\n${content}\n\`\`\``;
}

function toolGetScriptLogs({ script_name = '', limit = 50 }) {
    const cap = Math.min(Math.max(1, Number(limit) || 50), 200);
    const buf = getLogBuffer();
    const needle = String(script_name).toLowerCase();
    const filtered = needle ? buf.filter((e) => e.msg.toLowerCase().includes(needle)) : buf;
    const recent = filtered.slice(-cap);
    if (recent.length === 0) {
        return needle ? `No log entries found mentioning "${script_name}".` : 'No log entries in buffer yet.';
    }
    return recent
        .map((e) => {
            const t = new Date(e.ts).toISOString().slice(11, 19);
            return `[${t}] ${e.level.toUpperCase()} ${e.msg}`;
        })
        .join('\n');
}

const MAX_FETCH_CHARS = 8000;

async function toolSheFetch({ url }) {
    if (!url || typeof url !== 'string') return 'url argument is required.';
    if (!/^https?:\/\//i.test(url)) return 'Only http and https URLs are supported.';
    const res = await fetch(url, {
        headers: { 'User-Agent': 'she-ai-agent/1.0' },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return `HTTP error ${res.status} ${res.statusText} fetching ${url}`;
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    // Strip HTML tags for cleaner text
    const plain = ct.includes('html') ? text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : text;
    const truncated = plain.length > MAX_FETCH_CHARS ? plain.slice(0, MAX_FETCH_CHARS) + `\n… (truncated, ${plain.length} chars total)` : plain;
    return `Content of ${url}:\n\n${truncated}`;
}

module.exports = { TOOL_DEFINITIONS, TOOL_DEFINITIONS_ANTHROPIC, executeTool };
