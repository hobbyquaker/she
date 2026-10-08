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
const { unifiedDiff } = require('../lib/text-diff');

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
    {
        type: 'function',
        function: {
            name: 'list_scripts',
            description:
                'The loaded scripts with what each one subscribes to, publishes to (as seen since the daemon started), and schedules. ' +
                'Use it to find the script behind a topic or a behaviour before reading files; filter matches the script path or a topic.',
            parameters: {
                type: 'object',
                properties: {
                    filter: { type: 'string', description: 'Substring of the script path or of a topic it uses. Empty: all scripts.' },
                    offset: { type: 'integer', description: 'Skip this many scripts (paging; default 0).' },
                    limit: { type: 'integer', description: 'Maximum scripts (1-200, default 50).' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'who_publishes',
            description: 'Which script publishes a topic (as seen since the daemon started) and which adapter instance owns it (the first topic segment is the instance name).',
            parameters: {
                type: 'object',
                properties: { topic: { type: 'string', description: 'The exact MQTT topic.' } },
                required: ['topic'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'describe_device',
            description:
                'Everything known about one device: its topics grouped into status, set and maintenance with values and change ages, and its Home Assistant discovery entities when announced. ' +
                'The name matches a topic segment (e.g. "Licht Bad", "echo_bad") or a discovery device name.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Device name as it appears in topics or in the discovery.' },
                    limit: { type: 'integer', description: 'Maximum topics per group (default 40).' },
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_services',
            description:
                'The adapter instances (xyz2mqtt services) she sees on the broker: name, adapter, version, host, connected state, uptime. Use it for "is X running" and "which adapters are there".',
            parameters: {
                type: 'object',
                properties: { filter: { type: 'string', description: 'Substring of the instance name, adapter or host. Empty: all.' } },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_health',
            description:
                'The daemon\'s own state: started, MQTT connected, scripts loaded, safe mode, topics, message rate, handlers, memory, CPU, event-loop lag, Matter and sheDB counts. Use it first for "why is nothing happening".',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_timers',
            description:
                'Pending one-shot timers, intervals, schedule jobs and sun events per script with their next fire time. Use it for "why did it switch at …" and "what is still going to happen".',
            parameters: {
                type: 'object',
                properties: { script: { type: 'string', description: 'Substring of a script path. Empty: every script with something pending.' } },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'remember',
            description:
                "Store a durable fact about this installation for every later chat (shown and editable in the chat's memory panel). One short sentence, no secrets. " +
                'Use it on your own when you learn something no topic tells — a sensor\'s blind spot ("the PIR in the bathroom cannot see the shower"), what a room or variable is for, a habit of the household, a cause found after a long search — and when the user corrects you or states a preference. Not for what a tool can look up.',
            parameters: {
                type: 'object',
                properties: { text: { type: 'string', description: 'The fact, at most 200 characters.' } },
                required: ['text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'forget',
            description: 'Remove a remembered fact by its id (the [n…] in the "This installation" section) when the user says it is wrong or outdated.',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string', description: 'The note id, e.g. "n1a2b3c4".' } },
                required: ['id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'propose_script',
            description:
                'Propose a new or changed script as a draft: the user sees the diff in the chat and applies it with a click; nothing is written without that. ' +
                'Read the current file first (read_script) and pass the complete new content. Use this instead of pasting the whole file into the answer.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Script path relative to the scripts directory, e.g. "licht/bad.js".' },
                    content: { type: 'string', description: 'The complete new file content.' },
                    note: { type: 'string', description: 'One sentence on what the change does.' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'publish_mqtt',
            description:
                'Publish an MQTT message to a command topic (<name>/set/…, var/set/…, zigbee2mqtt/<device>/set), e.g. to test a device. ' +
                'Depending on the switch in the chat the user confirms each publish first. Never publish to a status topic.',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: 'The command topic.' },
                    payload: { type: 'string', description: 'The payload as a string (JSON for objects).' },
                    retain: { type: 'boolean', description: 'Retain the message (only for state, never for commands; default false).' },
                },
                required: ['topic', 'payload'],
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
    // a tool may return { text, event }: the text goes to the model, the event to the chat
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
            case 'list_scripts':
                return toolListScripts(args, ctx);
            case 'who_publishes':
                return toolWhoPublishes(args, ctx);
            case 'describe_device':
                return toolDescribeDevice(args, ctx);
            case 'list_services':
                return toolListServices(args, ctx);
            case 'get_health':
                return toolGetHealth(ctx);
            case 'list_timers':
                return toolListTimers(args, ctx);
            case 'propose_script':
                return toolProposeScript(args, ctx);
            case 'publish_mqtt':
                return await toolPublishMqtt(args, ctx);
            case 'remember':
                return toolRemember(args, ctx);
            case 'forget':
                return toolForget(args, ctx);
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
    // influx4mqtt's measurements first, then she's own schema (measurement "mqtt", tag "topic", field "value")
    const queries = measurementCandidates(topic).map((m) => [
        m,
        `SELECT "value" FROM "${m.replace(/"/g, '\\"')}" WHERE time >= ${fromMs}ms AND time <= ${toMs}ms ORDER BY time ASC LIMIT 5000`,
    ]);
    queries.push([
        `mqtt (topic = ${topic})`,
        `SELECT "value" FROM "mqtt" WHERE "topic" = '${String(topic).replace(/'/g, "\\'")}' AND time >= ${fromMs}ms AND time <= ${toMs}ms ORDER BY time ASC LIMIT 5000`,
    ]);
    for (const [m, q] of queries) {
        tried.push(m);
        let rows;
        try {
            rows = await influx.v1Query(q);
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

// ---------------------------------------------------------------------------
// The daemon's own state (roadmap I19, I27, I28) through the introspection the daemon hands to init()
// ---------------------------------------------------------------------------

const NO_INTROSPECT = 'The daemon did not expose its state to the AI (older she, or a test).';

function inTime(ms) {
    if (!ms) return 'unknown';
    const diff = ms - Date.now();
    return diff >= 0 ? `in ${ago(diff)} (${isoShort(ms)})` : `${ago(-diff)} overdue`;
}

function toolListScripts({ filter = '', offset = 0, limit = 50 } = {}, ctx = {}) {
    if (!ctx.introspect?.scripts) return NO_INTROSPECT;
    const q = String(filter).toLowerCase();
    const all = ctx.introspect.scripts();
    const hit = (sc) => !q || sc.label.toLowerCase().includes(q) || [...sc.subscriptions, ...sc.varSubscriptions, ...sc.publishes].some((t) => String(t).toLowerCase().includes(q));
    const list = all.filter(hit).sort((a, b) => a.label.localeCompare(b.label));
    if (list.length === 0) return q ? `No script matches "${filter}".` : 'No scripts loaded.';
    const { page, note } = pageOf(list, offset, limit, 200, 50);
    const lines = [`${page.length} of ${list.length} script(s)${note}:`];
    const some = (arr, n = 12) => (arr.length <= n ? arr.join(', ') : arr.slice(0, n).join(', ') + ` … (${arr.length} total)`);
    for (const sc of page) {
        lines.push(`\n### ${sc.label}${sc.origin !== 'user' ? ` (${sc.origin})` : ''}`);
        if (sc.subscriptions.length) lines.push(`- subscribes: ${some(sc.subscriptions)}`);
        if (sc.varSubscriptions.length) lines.push(`- variable subscriptions: ${some(sc.varSubscriptions)}`);
        if (sc.publishes.length) lines.push(`- publishes (seen): ${some(sc.publishes)}`);
        const sched = [...sc.jobs.map((j) => `job ${inTime(j.next)}`), ...sc.sunEvents.map((e) => `${e.pattern} ${inTime(e.next)}`)];
        if (sched.length) lines.push(`- schedules: ${some(sched, 6)}`);
        if (sc.timers.length) lines.push(`- pending timers: ${sc.timers.length}`);
    }
    return lines.join('\n');
}

function toolWhoPublishes({ topic } = {}, ctx = {}) {
    if (!topic) return 'topic is required.';
    if (!ctx.introspect?.scripts) return NO_INTROSPECT;
    const t = String(topic);
    const lines = [];
    const scripts = ctx.introspect.scripts().filter((sc) => sc.publishes.includes(t));
    if (scripts.length) lines.push(`Scripts that published ${t} since the daemon started: ${scripts.map((sc) => sc.label).join(', ')}.`);
    else lines.push(`No loaded script has published ${t} since the daemon started (publishes are recorded as they happen).`);
    const instanceName = t.split('/')[0];
    const inst = ctx.introspect.instances ? ctx.introspect.instances().find((i) => i.instance === instanceName) : null;
    if (inst) {
        lines.push(
            `The topic's first segment "${instanceName}" is an adapter instance: ${inst.adapter || 'legacy adapter'}${inst.version ? ' ' + inst.version : ''}${inst.host ? ' on ' + inst.host : ''}, ${inst.connected === null ? 'state unknown' : inst.connected > 1 ? 'connected to its device' : inst.connected === 1 ? 'connected to the broker only' : 'offline'}${/\/status\//.test(t) ? ' — a status topic is written by the adapter from the device' : ''}.`,
        );
    } else if (ctx.introspect.instances) {
        lines.push(`"${instanceName}" is no adapter instance known on the broker.`);
    }
    return lines.join('\n');
}

function toolDescribeDevice({ name, limit = 40 } = {}, ctx = {}) {
    if (!name) return 'name is required.';
    const store = ctx.store;
    if (!store) return 'MQTT state store not available.';
    const q = String(name).trim().toLowerCase();
    const groups = { status: [], set: [], maintenance: [], other: [] };
    const now = Date.now();
    let total = 0;
    for (const [topic, obj] of store.mqttEntries()) {
        const segs = topic.split('/');
        if (!segs.some((sg) => sg.toLowerCase() === q) && !topic.toLowerCase().includes('/' + q + '/') && !topic.toLowerCase().startsWith(q + '/')) continue;
        total++;
        const kind = segs[1] === 'status' ? 'status' : segs[1] === 'set' ? 'set' : segs[1] === 'maintenance' ? 'maintenance' : 'other';
        const lc = obj.lc ?? obj.ts;
        groups[kind].push(`${topic}: ${JSON.stringify(obj.val)}${lc ? ` (changed ${ago(now - lc)} ago)` : ''}`);
    }
    const lines = [];
    if (total) {
        lines.push(`${total} topic(s) for "${name}":`);
        const cap = Math.min(Math.max(1, Number(limit) || 40), 200);
        for (const kind of ['status', 'set', 'maintenance', 'other']) {
            if (!groups[kind].length) continue;
            lines.push(`\n## ${kind} (${groups[kind].length})`);
            lines.push(...groups[kind].slice(0, cap));
            if (groups[kind].length > cap) lines.push(`… ${groups[kind].length - cap} more; search_mqtt_topics with a filter for the rest`);
        }
    }
    if (ctx.introspect?.devices) {
        const devs = ctx.introspect.devices().filter((d) =>
            String(d.name || d.id || '')
                .toLowerCase()
                .includes(q),
        );
        for (const d of devs) {
            lines.push(`\n## Home Assistant discovery: ${d.name || d.id}${d.orphaned ? ' (orphaned: no state topic alive)' : ''}`);
            for (const e of d.entities || [])
                lines.push(`- ${e.component || e.configTopic?.split('/')[1] || 'entity'}: ${e.name || e.configTopic}${e.stateTopic ? ` ← ${e.stateTopic}` : ''}`);
            if (d.refTopics?.length) lines.push(`- topics referenced: ${d.refTopics.slice(0, 20).join(', ')}${d.refTopics.length > 20 ? ' …' : ''}`);
        }
    }
    if (!lines.length) return `Nothing known under "${name}": no topic segment and no discovery device matches. Try search_mqtt_topics with a substring.`;
    return lines.join('\n');
}

function toolListServices({ filter = '' } = {}, ctx = {}) {
    if (!ctx.introspect?.instances) return NO_INTROSPECT;
    const q = String(filter).toLowerCase();
    const list = ctx.introspect.instances().filter((i) => !q || [i.instance, i.adapter, i.host].some((x) => x && String(x).toLowerCase().includes(q)));
    if (!list.length) return q ? `No adapter instance matches "${filter}".` : 'No adapter instances seen on the broker.';
    const lines = [`${list.length} adapter instance(s):`];
    for (const i of list) {
        const state = i.connected === null ? 'unknown' : i.connected > 1 ? 'connected' : i.connected === 1 ? 'broker only' : 'offline';
        lines.push(
            `- ${i.instance}: ${i.adapter || 'legacy'}${i.version ? ' ' + i.version : ''}${i.host ? ' on ' + i.host : ''}, ${state}${i.uptime ? `, up ${ago(i.uptime)}` : ''}${i.maintenance ? ', maintenance topics' : ''}`,
        );
    }
    return lines.join('\n');
}

function toolGetHealth(ctx = {}) {
    if (!ctx.introspect?.health) return NO_INTROSPECT;
    const h = ctx.introspect.health() || {};
    const st = ctx.introspect.stats ? ctx.introspect.stats() || {} : {};
    const lines = [
        `started: ${h.started}, mqtt: ${h.mqttConfigured ? (h.mqttConnected ? 'connected' : 'DISCONNECTED') : 'not configured'}, scripts loaded: ${h.scripts}, safe mode: ${h.safeMode ? 'YES' : 'no'}`,
    ];
    if (st.topics !== undefined) lines.push(`topics: ${st.topics}, messages/s: ${st.mqttMsgPerSec}, handlers: ${st.handlers}`);
    if (st.memMb !== undefined)
        lines.push(`memory: ${st.memMb} MB, cpu: ${st.cpuPercent}%, event loop: ${st.eluPercent}% utilised, lag mean ${st.elMeanMs} ms max ${st.elMaxMs} ms`);
    if (st.matterEnabled) lines.push(`matter: ${st.matterNodes} node(s), ${st.matterEndpoints} endpoint(s)`);
    if (st.dbEnabled) lines.push(`sheDB: ${st.dbDocs} document(s), ${st.dbViews} view(s)`);
    return lines.join('\n');
}

function toolListTimers({ script = '' } = {}, ctx = {}) {
    if (!ctx.introspect?.scripts) return NO_INTROSPECT;
    const q = String(script).toLowerCase();
    const lines = [];
    for (const sc of ctx.introspect.scripts()) {
        if (q && !sc.label.toLowerCase().includes(q)) continue;
        const items = [
            ...sc.timers.map((t) => (t.every ? `interval every ${ago(t.every)}, next ${inTime(t.due)}` : `timer ${inTime(t.due)}`)),
            ...sc.jobs.map((j) => `schedule job ${inTime(j.next)}`),
            ...sc.sunEvents.map((e) => `${e.pattern} ${inTime(e.next)}`),
        ];
        if (!items.length) continue;
        lines.push(`\n### ${sc.label}`);
        items.sort();
        lines.push(...items.slice(0, 30).map((x) => '- ' + x));
        if (items.length > 30) lines.push(`… ${items.length - 30} more`);
    }
    if (!lines.length) return q ? `Nothing pending for scripts matching "${script}".` : 'Nothing pending in any script.';
    return `Pending per script:` + lines.join('\n');
}

/** the same rule the scripts API applies: inside the scripts directory, a .js file, no escape */
function scriptPathOf(scriptDir, relPath) {
    if (!scriptDir || !relPath || typeof relPath !== 'string') return null;
    const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel.endsWith('.js') || rel.includes('..')) return null;
    const abs = path.resolve(scriptDir, rel);
    if (!abs.startsWith(path.resolve(scriptDir) + path.sep)) return null;
    return { rel, abs };
}

function toolProposeScript({ path: relPath, content, note = '' } = {}, ctx = {}) {
    if (!ctx.drafts || !ctx.scriptDir) return 'Drafts are not available here.';
    const p = scriptPathOf(ctx.scriptDir, relPath);
    if (!p) return `"${relPath}" is not a script path inside the scripts directory (a .js file, no "..").`;
    if (typeof content !== 'string' || !content.trim()) return 'content must be the complete new file.';
    let base = null;
    try {
        base = fs.readFileSync(p.abs, 'utf8');
    } catch {
        /* a new file */
    }
    const text = content.endsWith('\n') ? content : content + '\n';
    if (base !== null && base === text) return `The draft equals the current ${p.rel}; nothing to change.`;
    const diff = unifiedDiff(base ?? '', text, { fromName: base === null ? '/dev/null' : p.rel, toName: p.rel });
    const draft = ctx.drafts.create({ path: p.rel, content: text, base, note: String(note || '') });
    const summary = base === null ? `new file, ${diff.added} lines` : `${diff.added} added, ${diff.removed} removed`;
    return {
        text: `Draft ${draft.id} for ${p.rel} (${summary}) is shown to the user with an Apply button; it is not written yet. Say in one sentence what it changes and wait.`,
        event: { type: 'draft', id: draft.id, path: p.rel, note: draft.note, isNew: base === null, diff: diff.text, added: diff.added, removed: diff.removed },
    };
}

const PUBLISH_ALLOW = ['+/set/#', 'zigbee2mqtt/+/set', 'zigbee2mqtt/+/set/#'];

/** null when the topic may be published to, otherwise the reason */
function publishRefusal(topic, allow) {
    const t = String(topic || '').trim();
    if (!t || t.includes('#') || t.includes('+')) return 'the topic must be a concrete topic without wildcards';
    if (/^[^/]+\/status\//.test(t)) return 'a status topic is written by its adapter, not by the chat';
    const patterns = [...PUBLISH_ALLOW, ...(Array.isArray(allow) ? allow : [])];
    if (!patterns.some((p) => mqttWildcard(t, p))) return `only command topics may be published (${patterns.join(', ')}); ai.publishAllow lists more`;
    return null;
}

async function toolPublishMqtt({ topic, payload, retain = false } = {}, ctx = {}) {
    const pub = ctx.publish;
    if (!pub || pub.mode === 'off' || !pub.send) return 'Publishing is switched off in the chat.';
    const why = publishRefusal(topic, pub.allow);
    if (why) return `Refused: ${why}.`;
    const value = payload === undefined || payload === null ? '' : String(payload);
    const doRetain = retain === true;
    if (pub.mode === 'confirm') {
        const decision = await pub.confirm({ topic: String(topic), payload: value, retain: doRetain });
        if (decision === 'timeout') return 'The user did not answer the confirmation; nothing was published.';
        if (!decision) return 'The user declined; nothing was published.';
    }
    try {
        await pub.send(String(topic), value, { retain: doRetain });
    } catch (e) {
        return `Publish failed: ${e.message}`;
    }
    return `Published ${JSON.stringify(value)} to ${topic}${doRetain ? ' (retained)' : ''}.`;
}

function toolRemember({ text } = {}, ctx = {}) {
    if (!ctx.memory) return 'The memory is not available.';
    const r = ctx.memory.add(text, 'model');
    if (r.error) return `Not stored: ${r.error}.`;
    return r.duplicate ? `Already known as [${r.note.id}]: ${r.note.text}` : `Stored as [${r.note.id}]: ${r.note.text}`;
}

function toolForget({ id } = {}, ctx = {}) {
    if (!ctx.memory) return 'The memory is not available.';
    const r = ctx.memory.remove(String(id || '').replace(/^\[|\]$/g, ''));
    if (r.error) return `Not removed: ${r.error}.`;
    return `Forgotten: ${r.note.text}`;
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
    _internal: { isPrivateAddress, isLocalName, parseDuration, valueMatcher, pageOf, parseTime, measurementCandidates, thinSeries, publishRefusal, scriptPathOf },
};
