'use strict';

/**
 * The Matter ↔ MQTT bridge's pure parts (roadmap M19): topic templates with `${placeholders}`
 * (filled outbound, turned into subscription patterns and matched inbound — node-red-contrib-ccu's
 * mqtt node is the model), the payload formats, the MQTT device names, the cluster deny-list and
 * the resolution of a `set` into a Matter command or an attribute write.
 *
 * The defaults are mqtt-smarthome (SPEC.md 2.0): `{ val, ts, lc }`, `matter/status/#`, `matter/set/#`.
 */

const mqttWildcard = require('../lib/mqtt-wildcards');

const DEFAULT_TEMPLATES = Object.freeze({
    connected: 'matter/connected',
    attribute: 'matter/status/${device}/${endpoint}/${cluster}/${attribute}',
    event: 'matter/status/${device}/${endpoint}/${cluster}/${event}',
    online: 'matter/status/${device}/online',
    set: 'matter/set/${device}/${endpoint}/${cluster}/${attributeOrCommand}',
    get: 'matter/get/${device}/${endpoint}/${cluster}/${attribute}',
});

const OUTBOUND = ['connected', 'attribute', 'event', 'online'];
const INBOUND = ['set', 'get'];
const PLACEHOLDERS = ['device', 'nodeId', 'endpoint', 'cluster', 'attribute', 'event', 'attributeOrCommand'];
const FORMATS = ['plain', 'basic', 'extended'];

/** Clusters never bridged (D-24): diagnostics, commissioning, the data model's plumbing. */
const DENY_CLUSTERS = new Set([
    'descriptor',
    'binding',
    'accessControl',
    'groups',
    'groupKeyManagement',
    'generalDiagnostics',
    'softwareDiagnostics',
    'threadNetworkDiagnostics',
    'wiFiNetworkDiagnostics',
    'ethernetNetworkDiagnostics',
    'otaSoftwareUpdateRequestor',
    'otaSoftwareUpdateProvider',
    'identify',
    'fixedLabel',
    'userLabel',
    'basicInformation',
    'generalCommissioning',
    'networkCommissioning',
    'administratorCommissioning',
    'operationalCredentials',
    'timeSynchronization',
    'icdManagement',
    'powerSourceConfiguration',
    'localizationConfiguration',
    'timeFormatLocalization',
    'unitLocalization',
    'diagnosticLogs',
    'scenesManagement',
    'proxyConfiguration',
    'proxyDiscovery',
    'proxyValid',
]);

/** Global attributes every cluster has — plumbing, not state. */
const DENY_ATTRIBUTES = new Set(['generatedCommandList', 'acceptedCommandList', 'eventList', 'attributeList', 'featureMap', 'clusterRevision']);

/** camelCase → snake_case (`levelControl` → `level_control`, `currentPositionLiftPercent100ths` → `current_position_lift_percent100ths`). */
function snake(name) {
    return String(name)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase();
}

/** snake_case → camelCase (`on_off` → `onOff`). */
function camel(name) {
    return String(name).replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());
}

/** An MQTT device name from a device name: lower snake_case, nothing MQTT minds (`/`, `+`, `#`, spaces). */
function mqttName(name) {
    const s = String(name ?? '')
        .trim()
        .toLowerCase()
        .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c])
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return s || 'device';
}

/** Make a name unique among the taken ones: `name`, `name_2`, `name_3`, … */
function uniqueName(name, taken) {
    const set = new Set(taken);
    if (!set.has(name)) return name;
    for (let i = 2; ; i++) if (!set.has(`${name}_${i}`)) return `${name}_${i}`;
}

function placeholdersOf(template) {
    return [...String(template).matchAll(/\$\{([a-zA-Z]+)\}/g)].map((m) => m[1]);
}

/** Fill a template with values; a missing value becomes an empty segment. */
function fill(template, vars) {
    return String(template).replace(/\$\{([a-zA-Z]+)\}/g, (_m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

/**
 * The subscription pattern of an inbound template: every placeholder `+`, a placeholder at the
 * very end `#` (it may span several segments — node-red-contrib-ccu does the same).
 */
function toPattern(template) {
    const t = String(template);
    const parts = t.split('/');
    return parts
        .map((seg, i) => {
            if (!/\$\{[a-zA-Z]+\}/.test(seg)) return seg;
            return i === parts.length - 1 && /^\$\{[a-zA-Z]+\}$/.test(seg) ? '#' : '+';
        })
        .join('/');
}

/**
 * Match a topic against a template: the placeholder values, or null. A segment with text around
 * a placeholder (`${device}_x`) matches the pattern but cannot be split — it is returned whole.
 */
function match(template, topic) {
    const parts = String(template).split('/');
    const pattern = toPattern(template);
    const captured = mqttWildcard(topic, pattern);
    if (captured === null) return null;
    const vars = {};
    let c = 0;
    parts.forEach((seg) => {
        const ph = placeholdersOf(seg);
        if (!ph.length) return;
        vars[ph[0]] = captured[c++];
    });
    return vars;
}

/**
 * Validate a template set: every template a non-empty string of known placeholders (an empty
 * one disables that topic), no MQTT wildcards, and an inbound template must not match what an
 * outbound one publishes (she would answer its own status). Returns a list of problems.
 */
function validate(templates) {
    const problems = [];
    const t = { ...DEFAULT_TEMPLATES, ...(templates ?? {}) };
    for (const [key, value] of Object.entries(t)) {
        if (!(key in DEFAULT_TEMPLATES)) {
            problems.push(`unknown template "${key}"`);
            continue;
        }
        if (typeof value !== 'string') {
            problems.push(`${key}: must be a string`);
            continue;
        }
        if (value === '') continue;
        if (/[+#]/.test(value)) problems.push(`${key}: no MQTT wildcards in a template`);
        if (/^\/|\/\/|\/$/.test(value)) problems.push(`${key}: empty topic segment`);
        for (const ph of placeholdersOf(value)) if (!PLACEHOLDERS.includes(ph)) problems.push(`${key}: unknown placeholder \${${ph}}`);
        if (INBOUND.includes(key) && !placeholdersOf(value).includes('device') && !placeholdersOf(value).includes('nodeId'))
            problems.push(`${key}: needs \${device} or \${nodeId}`);
    }
    const flagged = new Set(problems.map((p) => p.split(':')[0]));
    const sample = { device: 'sample_device', nodeId: '7', endpoint: '1', cluster: 'on_off', attribute: 'on_off', event: 'initial_press', attributeOrCommand: 'on_off' };
    for (const inKey of INBOUND) {
        if (!t[inKey] || flagged.has(inKey)) continue;
        for (const outKey of OUTBOUND) {
            if (!t[outKey] || flagged.has(outKey)) continue;
            if (mqttWildcard(fill(t[outKey], sample), toPattern(t[inKey])) !== null) problems.push(`${inKey} overlaps ${outKey}: she would answer its own ${outKey} topics`);
        }
    }
    if (t.set && t.get && t.set === t.get) problems.push('set and get are the same template');
    return problems;
}

/** The outbound payload for a value in the chosen format. */
function formatPayload(format, val, { ts, lc, matter } = {}) {
    const v = val;
    switch (format) {
        case 'plain':
            return typeof v === 'string' ? v : JSON.stringify(v);
        case 'extended':
            return JSON.stringify({ val: v, ts, lc, matter });
        case 'basic':
        default:
            return JSON.stringify({ val: v, ts, lc });
    }
}

/** An inbound payload: `{"val": …}` or a plain value (JSON when it parses, else the string). */
function parseInbound(payload) {
    const s = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
    if (s === '') return '';
    try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'val' in parsed) return parsed.val;
        return parsed;
    } catch {
        return s;
    }
}

/** Commands behind an attribute `set` (D: on/off, level, blinds, colour temperature). */
const MAPPED = {
    'onOff/onOff': (val) => {
        if (val === 'toggle') return { command: 'toggle' };
        return { command: truthy(val) ? 'on' : 'off' };
    },
    'levelControl/currentLevel': (val) => ({ command: 'moveToLevel', args: { level: Number(val), transitionTime: 0 } }),
    'windowCovering/currentPositionLiftPercent100ths': (val) => ({ command: 'goToLiftPercentage', args: { liftPercent100thsValue: Number(val) } }),
    'windowCovering/currentPositionTiltPercent100ths': (val) => ({ command: 'goToTiltPercentage', args: { tiltPercent100thsValue: Number(val) } }),
    'colorControl/colorTemperatureMireds': (val) => ({ command: 'moveToColorTemperature', args: { colorTemperatureMireds: Number(val), transitionTime: 0 } }),
};

function truthy(val) {
    if (typeof val === 'string') return !['', '0', 'false', 'off', 'no'].includes(val.trim().toLowerCase());
    return !!val;
}

/**
 * What a `set` on `<cluster>/<attributeOrCommand>` does: a mapped command, the command of that
 * name with the payload object as its fields, or an attribute write.
 * @param {string} cluster   camelCase
 * @param {string} name      camelCase attribute or command name
 * @param {*} val            the parsed payload
 * @param {{ commands?: object, attributes?: object }} clusterDef  the matter.js cluster definition (Complete)
 * @returns {{ kind: 'command', command: string, args?: object } | { kind: 'write', attribute: string, value: * }}
 */
function resolveSet(cluster, name, val, clusterDef) {
    const mapped = MAPPED[`${cluster}/${name}`];
    if (mapped) return { kind: 'command', ...mapped(val) };
    const commands = clusterDef?.commands ?? {};
    const attributes = clusterDef?.attributes ?? {};
    if (commands[name]) return { kind: 'command', command: name, args: val && typeof val === 'object' && !Array.isArray(val) ? val : {} };
    if (attributes[name]) return { kind: 'write', attribute: name, value: val };
    throw new Error(`"${name}" is neither a command nor an attribute of cluster "${cluster}"`);
}

module.exports = {
    DEFAULT_TEMPLATES,
    OUTBOUND,
    INBOUND,
    PLACEHOLDERS,
    FORMATS,
    DENY_CLUSTERS,
    DENY_ATTRIBUTES,
    snake,
    camel,
    mqttName,
    uniqueName,
    placeholdersOf,
    fill,
    toPattern,
    match,
    validate,
    formatPayload,
    parseInbound,
    resolveSet,
    truthy,
};
