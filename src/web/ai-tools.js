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
const dns = require('dns');
const net = require('net');
const { getLogBuffer } = require('./log-ws');
const mqttWildcard = require('../lib/mqtt-wildcards');

// A tool result goes into the conversation and stays there for every later turn (roadmap I21):
// above this many characters it is cut with a note; lists page with offset/limit instead.
const DEFAULT_RESULT_CHARS = 6000;

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
                'Use this to discover real topic names before writing scripts. ' +
                'Homematic related topics (under the topic tree hm/) end with STATE for switching actuators and with LEVEL for dimmers.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description:
                            'An MQTT filter with wildcards (+ one level, # the rest: "hm/status/+/LEVEL", "zigbee2mqtt/#") or a case-insensitive substring of the topic name ("bad"). Empty string lists all topics.',
                    },
                    value: {
                        type: 'string',
                        description: 'Optional filter on the current value: a plain value for equality ("true", "on", "0"), or a comparison ("> 0", ">= 20", "!= off").',
                    },
                    changed_within: {
                        type: 'string',
                        description: 'Optional: only topics whose value changed within this time ("30m", "2h", "1d").',
                    },
                    offset: { type: 'integer', description: 'Skip this many matches (paging; default 0).' },
                    limit: {
                        type: 'integer',
                        description: 'Maximum number of topics to return (1-500, default 50). The result says how many matched in total.',
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
            description: 'Read the content of a script file from the she scripts directory. ' + 'Use this to review existing scripts before suggesting changes.',
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
            description: 'Retrieve recent log messages from the she daemon. ' + 'Filter by script name to diagnose errors or trace what a specific script has been doing.',
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
                    offset: { type: 'integer', description: 'Skip this many lines from the newest end (paging into older lines; default 0).' },
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
    {
        type: 'function',
        function: {
            name: 'get_mqtt_topic',
            description:
                'Get the current value and timestamps of a specific MQTT topic from the she state store. ' + 'Use this when you need the exact current state of a known topic.',
            parameters: {
                type: 'object',
                properties: {
                    topic: {
                        type: 'string',
                        description: 'The exact MQTT topic path, e.g. "home/livingroom/light/state".',
                    },
                },
                required: ['topic'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_shedb_docs',
            description: 'List document IDs in the sheDB document store. ' + 'Use this to discover what documents exist before fetching their content.',
            parameters: {
                type: 'object',
                properties: {
                    filter: {
                        type: 'string',
                        description: 'Optional case-insensitive substring to filter IDs. Pass empty string to list all.',
                    },
                    offset: { type: 'integer', description: 'Skip this many matching IDs (paging; default 0).' },
                    limit: { type: 'integer', description: 'Maximum IDs to return (1-500, default 200). The result says how many matched in total.' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_shedb_doc',
            description: 'Retrieve a specific document from the sheDB document store by its ID. ' + 'Use list_shedb_docs first to discover valid IDs.',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'The exact document ID to retrieve.',
                    },
                    path: {
                        type: 'string',
                        description: 'Optional dotted path into the document (e.g. "rooms.bath.lights") to read a part of a large document.',
                    },
                },
                required: ['id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_matter_devices',
            description:
                'List all paired Matter devices with their online status, endpoints and available clusters. ' +
                'Use this whenever the user asks about a Matter device or smart home hardware. ' +
                'Use node and endpoint friendly names in matter commands.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
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
    const cap = Math.max(500, Number(ctx?.resultChars) || DEFAULT_RESULT_CHARS);
    const result = await runTool(name, args || {}, ctx || {});
    if (typeof result === 'string' && result.length > cap) {
        return result.slice(0, cap) + `\n… cut after ${cap} characters (${result.length} total); narrow the query or page with offset/limit.`;
    }
    return result;
}

async function runTool(name, args, ctx) {
    try {
        switch (name) {
            case 'search_mqtt_topics':
                return toolSearchMqttTopics(args, ctx.store);
            case 'get_mqtt_topic':
                return toolGetMqttTopic(args, ctx.store);
            case 'read_script':
                return toolReadScript(args, ctx.scriptDir);
            case 'get_script_logs':
                return toolGetScriptLogs(args);
            case 'she_fetch':
                return await toolSheFetch(args, ctx);
            case 'list_shedb_docs':
                return toolListShedbDocs(args);
            case 'get_shedb_doc':
                return toolGetShedbDoc(args);
            case 'list_matter_devices':
                return toolListMatterDevices();
            default:
                return `Unknown tool: ${name}`;
        }
    } catch (e) {
        return `Tool error (${name}): ${e.message}`;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** a page of a list with the note the model needs to ask for the rest */
function pageOf(list, offset, limit, maxLimit, defaultLimit) {
    const skip = Math.max(0, Number(offset) || 0);
    const cap = Math.min(Math.max(1, Number(limit) || defaultLimit), maxLimit);
    const page = list.slice(skip, skip + cap);
    const rest = list.length - skip - page.length;
    const note = rest > 0 ? ` (offset ${skip}; ${rest} more: offset ${skip + page.length})` : skip > 0 ? ` (offset ${skip})` : '';
    return { page, note };
}

/** "30m", "2h", "1d", "90s" or a number of seconds → milliseconds; NaN when unreadable */
function parseDuration(v) {
    if (typeof v === 'number') return v * 1000;
    const m = String(v || '')
        .trim()
        .match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i);
    if (!m) return NaN;
    const n = parseFloat(m[1]);
    return n * { '': 1000, 's': 1000, 'm': 60000, 'h': 3600000, 'd': 86400000 }[m[2].toLowerCase()];
}

/** "> 0", ">= 1", "< 5", "!= off", "== true", "= on" or a plain value (equality) → predicate on a value */
function valueMatcher(spec) {
    const m = String(spec)
        .trim()
        .match(/^(>=|<=|!=|==|=|>|<)?\s*(.*)$/);
    const op = m[1] || '=';
    const rhsRaw = m[2];
    let rhs = rhsRaw;
    try {
        rhs = JSON.parse(rhsRaw);
    } catch {
        /* a bare word stays a string */
    }
    const num = (x) => (typeof x === 'boolean' ? Number(x) : typeof x === 'number' ? x : parseFloat(x));
    return (val) => {
        if (op === '=' || op === '==') return val === rhs || String(val) === String(rhs);
        if (op === '!=') return !(val === rhs || String(val) === String(rhs));
        const a = num(val);
        const b = num(rhs);
        if (Number.isNaN(a) || Number.isNaN(b)) return false;
        return op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b;
    };
}

function ago(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
}

// ---------------------------------------------------------------------------
// Individual tools
// ---------------------------------------------------------------------------

function toolSearchMqttTopics({ query = '', value, changed_within, offset = 0, limit = 50 }, store) {
    if (!store) return 'MQTT state store not available.';
    const pattern = String(query).trim();
    const isFilter = /[+#]/.test(pattern);
    const q = pattern.toLowerCase();
    const matchValue = value !== undefined && value !== null && String(value) !== '' ? valueMatcher(value) : null;
    const withinMs = changed_within ? parseDuration(changed_within) : NaN;
    if (changed_within && Number.isNaN(withinMs)) return `changed_within "${changed_within}" is not a duration; use e.g. "30m", "2h" or "1d".`;
    const now = Date.now();
    const hits = [];
    for (const [topic, obj] of store.mqttEntries()) {
        if (isFilter ? !mqttWildcard(topic, pattern) : q && !topic.toLowerCase().includes(q)) continue;
        if (matchValue && !matchValue(obj.val)) continue;
        const lc = obj.lc ?? obj.ts;
        if (!Number.isNaN(withinMs) && !(lc && now - lc <= withinMs)) continue;
        hits.push(`${topic}: ${JSON.stringify(obj.val)}${lc ? ` (changed ${ago(now - lc)} ago)` : ''}`);
    }
    if (hits.length === 0) {
        return pattern
            ? `No MQTT topics found matching "${query}"${matchValue ? ` with value ${value}` : ''}${changed_within ? ` changed within ${changed_within}` : ''}.`
            : 'No MQTT topics tracked yet.';
    }
    const { page, note } = pageOf(hits, offset, limit, 500, 50);
    const lines = [`${page.length} of ${hits.length} matching topic(s)${note}:`, ...page];
    if (hits.length > page.length) lines.push('… raise the limit (up to 500), page with offset, or narrow the query for the rest.');
    return lines.join('\n');
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

function toolGetScriptLogs({ script_name = '', limit = 50, offset = 0 }) {
    const cap = Math.min(Math.max(1, Number(limit) || 50), 200);
    const skip = Math.max(0, Number(offset) || 0);
    const buf = getLogBuffer();
    const needle = String(script_name).toLowerCase();
    const filtered = needle ? buf.filter((e) => e.msg.toLowerCase().includes(needle)) : buf;
    const end = Math.max(0, filtered.length - skip);
    const recent = filtered.slice(Math.max(0, end - cap), end);
    if (recent.length === 0) {
        return needle ? `No log entries found mentioning "${script_name}".` : 'No log entries in buffer yet.';
    }
    const older = end - recent.length;
    const head = older > 0 ? `${recent.length} of ${filtered.length} lines (${older} older; offset ${skip + recent.length} for them):\n` : '';
    return (
        head +
        recent
            .map((e) => {
                const t = new Date(e.ts).toISOString().slice(11, 19);
                return `[${t}] ${e.level.toUpperCase()} ${e.msg}`;
            })
            .join('\n')
    );
}

const MAX_FETCH_CHARS = 8000;

/**
 * Private address ranges and local names the AI may not fetch (roadmap I23, decision D-4): a URL the model
 * picked up from a page or a document must not reach the LAN. Hosts on the allow-list are exempt.
 */
function isPrivateAddress(ip) {
    const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    if (net.isIPv4(v4)) {
        const [a, b] = v4.split('.').map(Number);
        return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
    }
    const lower = ip.toLowerCase();
    return lower === '::1' || lower === '::' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

function isLocalName(host) {
    const h = host.toLowerCase().replace(/\.$/, '');
    return h === 'localhost' || /\.(local|lan|home|internal|localdomain)$/.test(h) || !h.includes('.');
}

/** null when the host may be fetched, otherwise the reason */
async function fetchRefusal(host, allow) {
    const h = host.toLowerCase();
    if (allow.some((a) => String(a).toLowerCase() === h)) return null;
    if (!net.isIP(h) && isLocalName(h)) return `"${host}" is a local name`;
    let addresses;
    if (net.isIP(h)) addresses = [h];
    else {
        try {
            addresses = (await dns.promises.lookup(h, { all: true })).map((r) => r.address);
        } catch (e) {
            return `"${host}" does not resolve (${e.code || e.message})`;
        }
    }
    const priv = addresses.find(isPrivateAddress);
    return priv ? `"${host}" is a private address (${priv})` : null;
}

async function toolSheFetch({ url }, ctx = {}) {
    if (!url || typeof url !== 'string') return 'url argument is required.';
    if (!/^https?:\/\//i.test(url)) return 'Only http and https URLs are supported.';
    const allow = Array.isArray(ctx.fetchAllow) ? ctx.fetchAllow : [];
    let current = url;
    let res;
    for (let hop = 0; hop < 5; hop++) {
        let parsed;
        try {
            parsed = new URL(current);
        } catch {
            return `"${current}" is not a valid URL.`;
        }
        const why = await fetchRefusal(parsed.hostname, allow);
        if (why) return `Refused: ${why}; the AI may not fetch private or local addresses (ai.fetchAllow lists exceptions).`;
        res = await fetch(current, {
            headers: { 'User-Agent': 'she-ai-agent/1.0' },
            signal: AbortSignal.timeout(15000),
            redirect: 'manual',
        });
        const location = res.status >= 300 && res.status < 400 && res.headers.get('location');
        if (!location) break;
        current = new URL(location, current).toString(); // every hop is checked like the first
    }
    if (!res.ok) return `HTTP error ${res.status} ${res.statusText} fetching ${current}`;
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    // Strip HTML tags for cleaner text
    const plain = ct.includes('html')
        ? text
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
        : text;
    const truncated = plain.length > MAX_FETCH_CHARS ? plain.slice(0, MAX_FETCH_CHARS) + `\n… (truncated, ${plain.length} chars total)` : plain;
    return `Content of ${url}:\n\n${truncated}`;
}

function toolGetMqttTopic({ topic }, store) {
    if (!store) return 'MQTT state store not available.';
    if (!topic || typeof topic !== 'string') return 'topic argument is required.';
    const obj = store.getObject('mqtt::' + topic);
    if (!obj) return `Topic "${topic}" not found in state store. Use search_mqtt_topics to discover topics.`;
    const ts = new Date(obj.ts).toISOString();
    const lc = new Date(obj.lc ?? obj.ts).toISOString();
    return `${topic}: ${JSON.stringify(obj.val)}\n  last updated: ${ts}\n  last changed: ${lc}`;
}

function toolListShedbDocs({ filter = '', offset = 0, limit = 200 }) {
    try {
        const core = require('./shedb').getCore();
        if (!core) return 'sheDB not initialised.';
        const ids = Object.keys(core.docs).sort();
        const q = String(filter).toLowerCase();
        const filtered = q ? ids.filter((id) => id.toLowerCase().includes(q)) : ids;
        if (filtered.length === 0) return q ? `No documents found matching "${filter}".` : 'No documents in sheDB.';
        const { page, note } = pageOf(filtered, offset, limit, 500, 200);
        return `${page.length} of ${filtered.length} document(s)${note}:\n${page.join('\n')}`;
    } catch (e) {
        return `sheDB not available: ${e.message}`;
    }
}

function toolGetShedbDoc({ id, path: dotted = '' }) {
    if (!id || typeof id !== 'string') return 'id argument is required.';
    try {
        const core = require('./shedb').getCore();
        if (!core) return 'sheDB not initialised.';
        let doc = core.docs[id];
        if (doc === undefined) return `Document "${id}" not found. Use list_shedb_docs to see available IDs.`;
        if (dotted) {
            for (const key of String(dotted).split('.')) {
                if (doc === null || typeof doc !== 'object' || !(key in doc)) return `Document "${id}" has no path "${dotted}".`;
                doc = doc[key];
            }
        }
        return `## ${id}${dotted ? ' › ' + dotted : ''}\n${JSON.stringify(doc, null, 2)}`;
    } catch (e) {
        return `sheDB not available: ${e.message}`;
    }
}

function toolListMatterDevices() {
    try {
        const controller = require('../matter/controller');
        if (typeof controller.listPaired !== 'function') return 'Matter controller not available.';
        const nodes = controller.listPaired();
        if (nodes.length === 0) return 'No Matter devices paired.';
        const lines = [`${nodes.length} paired Matter device(s):`];
        for (const n of nodes) {
            lines.push(`\n### ${n.name || 'Unnamed'} (nodeId: "${n.nodeId}", ${n.online ? 'online' : 'offline'})`);
            try {
                const endpoints = controller.getEndpoints(n.nodeId);
                for (const ep of endpoints) {
                    if (ep.endpointId === 0) continue; // skip root endpoint
                    const name = ep.name || String(ep.endpointId);
                    lines.push(`- endpoint "${name}" (id: ${ep.endpointId}): ${ep.clusters.join(', ')}`);
                }
            } catch {
                /* node may be offline */
            }
        }
        return lines.join('\n');
    } catch (e) {
        return `Matter controller not available: ${e.message}`;
    }
}

module.exports = { TOOL_DEFINITIONS, TOOL_DEFINITIONS_ANTHROPIC, executeTool, _internal: { isPrivateAddress, isLocalName, parseDuration, valueMatcher, pageOf } };
