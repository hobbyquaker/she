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
const readline = require('readline');
const { getLogBuffer } = require('./log-ws');
const mqttWildcard = require('../lib/mqtt-wildcards');
const { LOGS_DIR } = require('../lib/storage');

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
            description:
                'Read the daemon log: the log files on disk (every line since the last restarts, rotated at 10 MB) within a time window, or the last lines without one. ' +
                'Filter by script name to diagnose errors or trace what a script has been doing; "from"/"to" take an ISO time or a relative one ("-2h", "-1d").',
            parameters: {
                type: 'object',
                properties: {
                    script_name: {
                        type: 'string',
                        description: 'Filter lines to those mentioning this script name (file name without extension). Empty string: all lines.',
                    },
                    from: { type: 'string', description: 'Start of the time window: ISO 8601 or relative ("-30m", "-2h", "-1d"). Default: the newest lines only.' },
                    to: { type: 'string', description: 'End of the time window: ISO 8601 or relative. Default: now.' },
                    level: { type: 'string', description: 'Minimum level: debug, info, warn or error (default debug).' },
                    limit: {
                        type: 'integer',
                        description: 'Maximum number of log lines to return (1-200, default 50), the newest within the window.',
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
                'List the paired Matter devices with their endpoints and clusters, and (with_state, default true) the common state attributes per endpoint: OnOff, LevelControl, the measurement clusters. ' +
                'Use get_matter_attribute for any other attribute.',
            parameters: {
                type: 'object',
                properties: {
                    with_state: { type: 'boolean', description: 'Read the state attributes of online devices (default true).' },
                    offset: { type: 'integer', description: 'Skip this many devices (paging; default 0).' },
                    limit: { type: 'integer', description: 'Maximum devices to list (default 50).' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_matter_attribute',
            description: 'Read one attribute of a Matter device: node (id or name), endpoint (id or name), cluster name and attribute name, as she.matter.get does.',
            parameters: {
                type: 'object',
                properties: {
                    node: { type: 'string', description: 'Node id or device name.' },
                    endpoint: { type: 'string', description: 'Endpoint id or name.' },
                    cluster: { type: 'string', description: 'Cluster name, e.g. "OnOff", "LevelControl", "TemperatureMeasurement".' },
                    attribute: { type: 'string', description: 'Attribute name, e.g. "onOff", "currentLevel", "measuredValue".' },
                },
                required: ['node', 'endpoint', 'cluster', 'attribute'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_topic_history',
            description:
                'The values of an MQTT topic over time from InfluxDB (when she has an Influx integration configured), as a compact time series: change points, downsampled when long. ' +
                'Use it for every "why", "when", "how often", "since when" question about a topic; search_mqtt_topics only knows the current value.',
            parameters: {
                type: 'object',
                properties: {
                    topic: {
                        type: 'string',
                        description: 'The MQTT topic, e.g. "hm/status/Licht Bad/LEVEL" (the measurement is derived from it; a measurement name is accepted too).',
                    },
                    from: { type: 'string', description: 'Start: ISO 8601 or relative ("-2h", "-1d", "-7d"). Default "-24h".' },
                    to: { type: 'string', description: 'End: ISO 8601 or relative. Default now.' },
                    limit: { type: 'integer', description: 'Maximum points to return (1-500, default 200); longer series are reduced to change points, then thinned.' },
                },
                required: ['topic'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_topic_messages',
            description:
                'The raw MQTT messages of a topic (every publish with its payload, newest first) from Elasticsearch, when she has an Elastic integration configured. ' +
                'For values over time prefer get_topic_history; use this for the exact messages, repeated publishes and non-numeric payloads.',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: 'The exact MQTT topic.' },
                    from: { type: 'string', description: 'Start: ISO 8601 or relative ("-2h"). Default "-24h".' },
                    to: { type: 'string', description: 'End: ISO 8601 or relative. Default now.' },
                    limit: { type: 'integer', description: 'Maximum messages (1-500, default 100), the newest within the window.' },
                },
                required: ['topic'],
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
                return await toolListMatterDevices(args);
            case 'get_matter_attribute':
                return await toolGetMatterAttribute(args);
            case 'get_topic_history':
                return await toolGetTopicHistory(args, ctx);
            case 'get_topic_messages':
                return await toolGetTopicMessages(args, ctx);
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

/** ISO 8601, epoch ms, "now", or relative "-2h"/"-30m"/"-1d" → epoch ms; NaN when unreadable */
function parseTime(v, now = Date.now()) {
    if (v === undefined || v === null || v === '' || v === 'now') return now;
    if (typeof v === 'number') return v;
    const str = String(v).trim();
    if (/^-\s*\d/.test(str)) {
        const d = parseDuration(str.slice(1).trim());
        return Number.isNaN(d) ? NaN : now - d;
    }
    const t = Date.parse(str);
    return Number.isNaN(t) ? NaN : t;
}

function isoShort(ms) {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
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

const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

/** the log files on disk, oldest first: she.jsonl.N … she.jsonl.1, she.jsonl */
function logFilesOldestFirst() {
    let names;
    try {
        names = fs.readdirSync(LOGS_DIR).filter((n) => /^she\.jsonl(\.\d+)?$/.test(n));
    } catch {
        return [];
    }
    const rank = (n) => (n === 'she.jsonl' ? 0 : Number(n.slice('she.jsonl.'.length)));
    return names.sort((a, b) => rank(b) - rank(a)).map((n) => path.join(LOGS_DIR, n));
}

async function toolGetScriptLogs({ script_name = '', from, to, level = 'debug', limit = 50, offset = 0 } = {}) {
    const cap = Math.min(Math.max(1, Number(limit) || 50), 200);
    const skip = Math.max(0, Number(offset) || 0);
    const needle = String(script_name).toLowerCase();
    const minRank = LEVEL_RANK[String(level).toLowerCase()] ?? 0;
    const now = Date.now();
    const fromMs = from ? parseTime(from, now) : null;
    const toMs = parseTime(to, now);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return `from/to must be ISO 8601 or relative ("-2h"); got from=${from}, to=${to}.`;
    const keep = (e) => (fromMs === null || e.ts >= fromMs) && e.ts <= toMs && (LEVEL_RANK[e.level] ?? 0) >= minRank && (!needle || e.msg.toLowerCase().includes(needle));

    // the files on disk; the in-memory ring only when there are none (tests, a read-only data directory)
    const matches = [];
    const files = logFilesOldestFirst();
    for (const file of files) {
        if (fromMs !== null) {
            try {
                if (fs.statSync(file).mtimeMs < fromMs) continue; // nothing in this file is new enough
            } catch {
                continue;
            }
        }
        const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
        for await (const line of rl) {
            if (!line) continue;
            let e;
            try {
                e = JSON.parse(line);
            } catch {
                continue;
            }
            if (e && typeof e.msg === 'string' && keep(e)) matches.push(e);
        }
    }
    if (files.length === 0) {
        for (const e of getLogBuffer()) if (keep(e)) matches.push(e);
    }
    const end = Math.max(0, matches.length - skip);
    const recent = matches.slice(Math.max(0, end - cap), end);
    if (recent.length === 0) {
        const window = fromMs !== null ? ` between ${isoShort(fromMs)} and ${isoShort(toMs)}` : '';
        return needle ? `No log entries mentioning "${script_name}"${window}.` : `No log entries${window}.`;
    }
    const older = end - recent.length;
    const head = `${recent.length} of ${matches.length} matching lines${older > 0 ? ` (${older} older; offset ${skip + recent.length} for them)` : ''}, oldest first:\n`;
    return head + recent.map((e) => `[${isoShort(e.ts)}] ${String(e.level).toUpperCase()} ${e.msg}`).join('\n');
}

// ---------------------------------------------------------------------------
// History (roadmap I15, decision D-3): InfluxDB first, Elasticsearch for the raw messages
// ---------------------------------------------------------------------------

/**
 * The measurements influx4mqtt may have written for a topic: `<name>//<path without the status segment>`
 * (what the maintainer's instance writes), `<name>//<rest>`, and the literal topic.
 */
function measurementCandidates(topic) {
    const t = String(topic).trim();
    const parts = t.split('/');
    const out = [];
    if (parts.length >= 3 && parts[1] === 'status') out.push(parts[0] + '//' + parts.slice(2).join('/'));
    if (parts.length >= 2) out.push(parts[0] + '//' + parts.slice(1).join('/'));
    out.push(t);
    return [...new Set(out)];
}

/** change points first; when still too many, every k-th point */
function thinSeries(rows, limit) {
    const changes = rows.filter((r, i) => i === 0 || i === rows.length - 1 || r.value !== rows[i - 1].value);
    if (changes.length <= limit) return { points: changes, note: changes.length < rows.length ? `${rows.length} points reduced to ${changes.length} change points` : '' };
    const k = Math.ceil(changes.length / limit);
    const thinned = changes.filter((_, i) => i % k === 0 || i === changes.length - 1);
    return { points: thinned, note: `${rows.length} points, ${changes.length} change points, every ${k}th shown` };
}

async function toolGetTopicHistory({ topic, from = '-24h', to, limit = 200 } = {}) {
    if (!topic) return 'topic is required.';
    let influx;
    try {
        influx = require('../influx');
    } catch {
        return 'InfluxDB is not available.';
    }
    const mode = influx.getMode?.();
    if (!mode) return 'No InfluxDB integration is configured in she (config "influx"), so there is no history. The current value: get_mqtt_topic.';
    if (mode !== 'v1') return 'Topic history is implemented for InfluxDB 1.x only so far.';
    const now = Date.now();
    const fromMs = parseTime(from, now);
    const toMs = parseTime(to, now);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return `from/to must be ISO 8601 or relative ("-2h"); got from=${from}, to=${to}.`;
    const cap = Math.min(Math.max(1, Number(limit) || 200), 500);
    const tried = [];
    for (const m of measurementCandidates(topic)) {
        tried.push(m);
        let rows;
        try {
            rows = await influx.v1Query(`SELECT "value" FROM "${m.replace(/"/g, '\\"')}" WHERE time >= ${fromMs}ms AND time <= ${toMs}ms ORDER BY time ASC LIMIT 5000`);
        } catch (e) {
            return `InfluxDB query failed: ${e.message}`;
        }
        if (!rows || rows.length === 0) continue;
        const series = rows.map((r) => ({ time: r.time, value: r.value }));
        const { points, note } = thinSeries(series, cap);
        const lines = [
            `History of ${topic} (measurement "${m}") from ${isoShort(fromMs)} to ${isoShort(toMs)}${rows.length >= 5000 ? ', the first 5000 points of the window' : ''}${note ? `; ${note}` : ''}:`,
        ];
        for (const pt of points) lines.push(`${isoShort(pt.time)}  ${JSON.stringify(pt.value)}`);
        return lines.join('\n');
    }
    return `No history for ${topic} between ${isoShort(fromMs)} and ${isoShort(toMs)} (tried measurements ${tried.map((m) => `"${m}"`).join(', ')}).`;
}

async function toolGetTopicMessages({ topic, from = '-24h', to, limit = 100 } = {}, ctx = {}) {
    if (!topic) return 'topic is required.';
    let client = null;
    try {
        client = require('../elastic').getClient();
    } catch {
        /* module missing */
    }
    if (!client) return 'No Elasticsearch integration is configured in she (config "elastic"), so there is no message list. Try get_topic_history.';
    const now = Date.now();
    const fromMs = parseTime(from, now);
    const toMs = parseTime(to, now);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return `from/to must be ISO 8601 or relative ("-2h"); got from=${from}, to=${to}.`;
    const cap = Math.min(Math.max(1, Number(limit) || 100), 500);
    const index = ctx.elasticIndex || 'mqtt-*';
    let res;
    try {
        res = await client.search({
            index,
            size: cap,
            query: { bool: { filter: [{ term: { topic: String(topic) } }, { range: { '@timestamp': { gte: fromMs, lte: toMs } } }] } },
            sort: [{ '@timestamp': { order: 'desc' } }],
            _source: ['@timestamp', 'payload'],
        });
    } catch (e) {
        return `Elasticsearch query failed: ${e.message}`;
    }
    const hits = res?.hits?.hits ?? res?.body?.hits?.hits ?? [];
    const total = res?.hits?.total?.value ?? res?.body?.hits?.total?.value ?? hits.length;
    if (hits.length === 0) return `No messages for ${topic} between ${isoShort(fromMs)} and ${isoShort(toMs)} in ${index}.`;
    const lines = [`${hits.length} of ${total} messages for ${topic} from ${isoShort(fromMs)} to ${isoShort(toMs)}, newest first:`];
    for (const h of hits) {
        const src = h._source || {};
        const ts = typeof src['@timestamp'] === 'number' ? src['@timestamp'] : Date.parse(src['@timestamp']);
        lines.push(`${isoShort(ts)}  ${String(src.payload ?? '')}`);
    }
    return lines.join('\n');
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

const STATE_ATTRIBUTES = {
    OnOff: ['onOff'],
    LevelControl: ['currentLevel'],
    ColorControl: ['currentHue', 'currentSaturation', 'colorTemperatureMireds'],
    TemperatureMeasurement: ['measuredValue'],
    RelativeHumidityMeasurement: ['measuredValue'],
    IlluminanceMeasurement: ['measuredValue'],
    OccupancySensing: ['occupancy'],
    BooleanState: ['stateValue'],
    DoorLock: ['lockState'],
    WindowCovering: ['currentPositionLiftPercent100ths'],
    Thermostat: ['localTemperature', 'occupiedHeatingSetpoint', 'systemMode'],
    Switch: ['currentPosition'],
    PowerSource: ['batPercentRemaining'],
};

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
        if (timer.unref) timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function matterController() {
    try {
        const controller = require('../matter/controller');
        return typeof controller.listPaired === 'function' ? controller : null;
    } catch {
        return null;
    }
}

async function toolListMatterDevices({ with_state = true, offset = 0, limit = 50 } = {}) {
    const controller = matterController();
    if (!controller) return 'Matter controller not available.';
    const nodes = controller.listPaired();
    if (nodes.length === 0) return 'No Matter devices paired.';
    const { page, note } = pageOf(nodes, offset, limit, 200, 50);
    const lines = [`${page.length} of ${nodes.length} paired Matter device(s)${note}:`];
    for (const n of page) {
        lines.push(`\n### ${n.name || 'Unnamed'} (nodeId: "${n.nodeId}", ${n.online ? 'online' : 'offline'})`);
        let endpoints = [];
        try {
            endpoints = controller.getEndpoints(n.nodeId);
        } catch {
            /* node may be offline */
        }
        for (const ep of endpoints) {
            if (ep.endpointId === 0) continue; // skip root endpoint
            const name = ep.name || String(ep.endpointId);
            let state = '';
            if (with_state && n.online && typeof controller.getAttribute === 'function') {
                const reads = [];
                for (const cluster of ep.clusters || []) {
                    for (const attr of STATE_ATTRIBUTES[cluster] || []) {
                        reads.push(
                            withTimeout(
                                Promise.resolve().then(() => controller.getAttribute(n.nodeId, ep.endpointId, cluster, attr)),
                                3000,
                            ).then(
                                (v) => `${cluster}.${attr}=${JSON.stringify(v)}`,
                                () => null,
                            ),
                        );
                    }
                }
                const got = (await Promise.all(reads)).filter(Boolean);
                if (got.length) state = ` — ${got.join(', ')}`;
            }
            lines.push(`- endpoint "${name}" (id: ${ep.endpointId}): ${(ep.clusters || []).join(', ')}${state}`);
        }
    }
    return lines.join('\n');
}

async function toolGetMatterAttribute({ node, endpoint, cluster, attribute } = {}) {
    if (!node || endpoint === undefined || endpoint === null || endpoint === '' || !cluster || !attribute) return 'node, endpoint, cluster and attribute are required.';
    const controller = matterController();
    if (!controller || typeof controller.getAttribute !== 'function') return 'Matter controller not available.';
    try {
        const ep = Number.isNaN(Number(endpoint)) ? String(endpoint) : Number(endpoint);
        const value = await withTimeout(
            Promise.resolve().then(() => controller.getAttribute(String(node), ep, String(cluster), String(attribute))),
            5000,
        );
        return `${node} / ${endpoint} / ${cluster}.${attribute} = ${JSON.stringify(value)}`;
    } catch (e) {
        return `Could not read ${cluster}.${attribute} of ${node}/${endpoint}: ${e.message}`;
    }
}

module.exports = {
    TOOL_DEFINITIONS,
    TOOL_DEFINITIONS_ANTHROPIC,
    executeTool,
    _internal: { isPrivateAddress, isLocalName, parseDuration, valueMatcher, pageOf, parseTime, measurementCandidates, thinSeries },
};
