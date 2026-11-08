'use strict';

/**
 * mosquitto-bridges — the pure logic behind the Broker tab's Bridges page.
 *
 * A bridge is one `connection` block of mosquitto.conf:
 *
 *   connection cloud
 *   address broker.example.net:8883
 *   topic tele/# in 0 cloud/ ""
 *   remote_username bridge
 *   remote_password ...
 *   bridge_cafile /etc/mosquitto/certs/ca.crt
 *
 * Structured form used by the API and the UI:
 *
 *   { name: 'cloud',
 *     addresses: ['broker.example.net:8883'],
 *     topics: [{ pattern: 'tele/#', direction: 'in', qos: 0, localPrefix: 'cloud/', remotePrefix: '' }],
 *     options: { remote_username: 'bridge', remote_password: '...', bridge_cafile: '/etc/…/ca.crt' } }
 *
 * Everything in here is side-effect free: parsing and serialising the block, validating it
 * against the option catalogue, the loop check across topic rules, the mapping preview, what
 * the remote broker needs (user + ACLs, as dynsec commands and plain text), a line diff for
 * the save dialog, and the rollback decision after a reload.
 *
 * Mosquitto facts this relies on (checked against Mosquitto 2.1.2, see doc/broker-management.md):
 *   - SIGHUP applies added, changed and removed connection blocks.
 *   - A config error on reload (unknown option, duplicate name, …) ends the broker process
 *     under some conditions, so a save is followed by a probe and, if needed, a rollback.
 *   - The bridge is not a client of the local broker: no local user, no ACL check, dynsec or
 *     not. Only the remote side needs a user and ACLs.
 *   - The connection state is published retained on `$SYS/broker/connection/<remote_clientid>/state`
 *     (`1` connected, `0` not), locally and — unless notifications_local_only — on the remote.
 */

// ── Option catalogue ──────────────────────────────────────────────────────────

/**
 * Every bridge option Mosquitto 2.x knows, with its value type.
 *   type: 'bool' | 'int' | 'string' | 'enum' (values) ; since: the Mosquitto version that introduced it (when > 2.0)
 */
const BRIDGE_OPTIONS = {
    remote_clientid: { type: 'string' },
    local_clientid: { type: 'string' },
    remote_username: { type: 'string' },
    remote_password: { type: 'string', secret: true },
    local_username: { type: 'string' },
    local_password: { type: 'string', secret: true },
    cleansession: { type: 'bool' },
    local_cleansession: { type: 'bool' },
    keepalive_interval: { type: 'int', min: 5 },
    restart_timeout: { type: 'string' }, // "30" or "5 30" (base and cap of the backoff)
    idle_timeout: { type: 'int', min: 1 },
    threshold: { type: 'int', min: 1 },
    try_private: { type: 'bool' },
    start_type: { type: 'enum', values: ['automatic', 'lazy', 'once'] },
    round_robin: { type: 'bool' },
    notifications: { type: 'bool' },
    notifications_local_only: { type: 'bool' },
    notification_topic: { type: 'string' },
    bridge_protocol_version: { type: 'enum', values: ['mqttv31', 'mqttv311', 'mqttv50'] },
    bridge_attempt_unsubscribe: { type: 'bool' },
    bridge_bind_address: { type: 'string' },
    bridge_outgoing_retain: { type: 'bool' },
    bridge_max_packet_size: { type: 'int', min: 0 },
    bridge_cafile: { type: 'string' },
    bridge_capath: { type: 'string' },
    bridge_certfile: { type: 'string' },
    bridge_keyfile: { type: 'string' },
    bridge_insecure: { type: 'bool' },
    bridge_require_ocsp: { type: 'bool' },
    bridge_tls_version: { type: 'enum', values: ['tlsv1.3', 'tlsv1.2', 'tlsv1.1'] },
    bridge_alpn: { type: 'string' },
    bridge_identity: { type: 'string' },
    bridge_psk: { type: 'string', secret: true },
    // Mosquitto 2.1
    bridge_reload_type: { type: 'enum', values: ['lazy', 'immediate'], since: '2.1' },
    bridge_receive_maximum: { type: 'int', min: 1, since: '2.1' },
    bridge_session_expiry_interval: { type: 'int', min: 0, since: '2.1' },
    bridge_max_topic_alias: { type: 'int', min: 0, since: '2.1' },
    bridge_tcp_keepalive: { type: 'string', since: '2.1' },
    bridge_tcp_user_timeout: { type: 'int', min: 0, since: '2.1' },
};

/** The keys the structured form handles outside `options`. */
const STRUCTURAL_KEYS = new Set(['connection', 'address', 'addresses', 'topic']);

/** Keys whose value is a secret: masked in diffs, never logged, not handed to the UI. */
const SECRET_KEYS = Object.keys(BRIDGE_OPTIONS).filter((k) => BRIDGE_OPTIONS[k].secret);

/** Is `key` a line that belongs to a connection block? */
function isBridgeKey(key) {
    return STRUCTURAL_KEYS.has(key) || Object.prototype.hasOwnProperty.call(BRIDGE_OPTIONS, key);
}

/**
 * Is `key` a line that may belong to a connection block although she does not know it?
 * Mosquitto's bridge options share the `bridge_` prefix; an unknown one is kept with the
 * bridge (so the block round-trips) and reported by validate().
 */
function looksLikeBridgeKey(key) {
    return isBridgeKey(key) || key.startsWith('bridge_');
}

// ── Parsing one block ─────────────────────────────────────────────────────────

/** `topic pattern [[[out|in|both] qos] local-prefix remote-prefix]` → rule */
function parseTopicLine(value) {
    const parts = value.split(/\s+/).filter((p) => p !== '');
    const unquote = (s) => (s === '""' ? '' : s);
    const rule = { pattern: unquote(parts[0] ?? ''), direction: 'out', qos: 0, localPrefix: '', remotePrefix: '' };
    let i = 1;
    if (['in', 'out', 'both'].includes(parts[i])) {
        rule.direction = parts[i];
        i++;
    }
    if (/^[012]$/.test(parts[i] ?? '')) {
        rule.qos = Number(parts[i]);
        i++;
    }
    if (parts[i] !== undefined) rule.localPrefix = unquote(parts[i]);
    if (parts[i + 1] !== undefined) rule.remotePrefix = unquote(parts[i + 1]);
    return rule;
}

/** rule → the `topic …` value, as short as Mosquitto allows */
function serialiseTopicRule(rule) {
    const quote = (s) => (s ? s : '""');
    const parts = [quote(rule.pattern ?? ''), rule.direction || 'out', String(rule.qos ?? 0)];
    const lp = rule.localPrefix ?? '';
    const rp = rule.remotePrefix ?? '';
    // both prefixes or none: `""` is Mosquitto's empty prefix, and a lone fourth word is ambiguous
    if (lp || rp) parts.push(quote(lp), quote(rp));
    return parts.join(' ');
}

/** A fresh bridge object for `connection <name>`. */
function newBridge(name) {
    return { name, addresses: [], topics: [], options: {} };
}

/**
 * Apply one `key value` line to a bridge under construction (the parser calls this for every
 * line after `connection` that isBridgeKey()/looksLikeBridgeKey()).
 */
function applyBridgeLine(bridge, key, value) {
    if (key === 'address' || key === 'addresses') {
        bridge.addresses.push(...value.split(/\s+/).filter(Boolean));
    } else if (key === 'topic') {
        bridge.topics.push(parseTopicLine(value));
    } else if (bridge.options[key] !== undefined) {
        bridge.options[key] = [].concat(bridge.options[key], value);
    } else {
        bridge.options[key] = value;
    }
}

/** bridge → the lines of its connection block (no trailing blank line). */
function serialiseBridge(bridge) {
    const lines = [`connection ${bridge.name}`];
    if (bridge.addresses && bridge.addresses.length > 0) lines.push(`address ${bridge.addresses.join(' ')}`);
    for (const rule of bridge.topics || []) lines.push(`topic ${serialiseTopicRule(rule)}`);
    const options = bridge.options || {};
    // the options keep the order they were given in: a block read from the file is written
    // back as it was, and an untouched bridge never shows up in the diff
    const keys = Object.keys(options).filter((k) => options[k] !== undefined && options[k] !== null && options[k] !== '');
    for (const k of keys) {
        for (const v of [].concat(options[k])) lines.push(`${k} ${String(v).trim()}`);
    }
    return lines;
}

/**
 * Parse free-form `key value` lines (the form's Advanced field) into an options object.
 * Blank lines and comments are skipped; a line without a value gets ''.
 */
function parseOptionLines(text) {
    const options = {};
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const sp = line.indexOf(' ');
        const key = sp === -1 ? line : line.slice(0, sp);
        const value = sp === -1 ? '' : line.slice(sp + 1).trim();
        if (options[key] !== undefined) options[key] = [].concat(options[key], value);
        else options[key] = value;
    }
    return options;
}

// ── Validation ────────────────────────────────────────────────────────────────

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const ADDRESS_RE = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)(:(\d{1,5}))?$/;

/** Compare "2.1.2" with "2.1": -1, 0 or 1 on the shared depth. */
function compareVersion(a, b) {
    const pa = String(a)
        .split('.')
        .map((n) => parseInt(n, 10) || 0);
    const pb = String(b)
        .split('.')
        .map((n) => parseInt(n, 10) || 0);
    const n = Math.min(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    }
    return 0;
}

/** Pull "2.1.2" out of `$SYS/broker/version` ("mosquitto version 2.1.2"). */
function brokerVersionFromSys(val) {
    const m = String(val ?? '').match(/(\d+\.\d+(?:\.\d+)?)/);
    return m ? m[1] : null;
}

/**
 * Validate one bridge. Returns { errors: string[], warnings: string[] }.
 * Errors block the save (Mosquitto would refuse the block, or the block is self-contradictory);
 * warnings are shown in the save dialog and need the user's go.
 *
 * @param {object} bridge
 * @param {{ brokerVersion?: string|null }} [ctx]  the managed broker's version, for the `since` checks
 */
function validateBridge(bridge, ctx = {}) {
    const errors = [];
    const warnings = [];
    const name = String(bridge.name ?? '').trim();
    if (!name) errors.push('The bridge needs a name (the `connection` name).');
    else if (!NAME_RE.test(name)) errors.push(`Name "${name}": letters, digits, "_", ".", ":" and "-" only — it becomes part of a topic and a client id.`);

    const addresses = Array.isArray(bridge.addresses) ? bridge.addresses.map((a) => String(a).trim()).filter(Boolean) : [];
    if (addresses.length === 0) errors.push('At least one remote address is required (`host` or `host:port`).');
    for (const a of addresses) {
        const m = a.match(ADDRESS_RE);
        if (!m) errors.push(`Address "${a}" is not host or host:port.`);
        else if (m[3] !== undefined && (Number(m[3]) < 1 || Number(m[3]) > 65535)) errors.push(`Address "${a}": the port must be 1–65535.`);
    }

    const topics = Array.isArray(bridge.topics) ? bridge.topics : [];
    if (topics.length === 0) warnings.push('No topic rule: the bridge connects but carries nothing.');
    topics.forEach((t, i) => {
        const where = `Rule ${i + 1}`;
        if (!['in', 'out', 'both'].includes(t.direction)) errors.push(`${where}: direction must be in, out or both.`);
        if (![0, 1, 2].includes(Number(t.qos))) errors.push(`${where}: QoS must be 0, 1 or 2.`);
        const pattern = String(t.pattern ?? '');
        if (!pattern && !t.localPrefix && !t.remotePrefix) errors.push(`${where}: an empty pattern needs a local or a remote prefix.`);
        if (/\s/.test(pattern) || /\s/.test(t.localPrefix ?? '') || /\s/.test(t.remotePrefix ?? '')) errors.push(`${where}: patterns and prefixes cannot contain spaces.`);
        const pe = patternError(pattern);
        if (pe) errors.push(`${where}: ${pe}`);
        for (const [label, p] of [
            ['local prefix', t.localPrefix],
            ['remote prefix', t.remotePrefix],
        ]) {
            if (p && /[#+]/.test(p)) errors.push(`${where}: the ${label} cannot contain wildcards.`);
        }
        if (t.localPrefix && t.localPrefix === t.remotePrefix) warnings.push(`${where}: local and remote prefix are the same — the prefix changes nothing.`);
    });

    const options = bridge.options || {};
    for (const [key, raw] of Object.entries(options)) {
        const spec = BRIDGE_OPTIONS[key];
        const values = [].concat(raw);
        if (STRUCTURAL_KEYS.has(key)) {
            errors.push(`"${key}" belongs in the form, not in the advanced options.`);
            continue;
        }
        if (!spec) {
            warnings.push(
                `Unknown option "${key}": not in she's list of Mosquitto bridge options. A Mosquitto that does not know it refuses the config on reload — she would roll back.`,
            );
            continue;
        }
        if (spec.since && ctx.brokerVersion && compareVersion(ctx.brokerVersion, spec.since) < 0) {
            warnings.push(`"${key}" needs Mosquitto ${spec.since} or newer; the broker reports ${ctx.brokerVersion}.`);
        }
        if (values.length > 1) errors.push(`"${key}" is given ${values.length} times.`);
        for (const v of values) {
            const value = String(v).trim();
            if (value === '') {
                errors.push(`"${key}" has no value.`);
                continue;
            }
            if (spec.type === 'bool' && !/^(true|false)$/.test(value)) errors.push(`"${key}" must be true or false (is "${value}").`);
            if (spec.type === 'int') {
                if (!/^-?\d+$/.test(value)) errors.push(`"${key}" must be an integer (is "${value}").`);
                else if (spec.min !== undefined && Number(value) < spec.min) errors.push(`"${key}" must be at least ${spec.min}.`);
            }
            if (spec.type === 'enum' && !spec.values.includes(value)) errors.push(`"${key}" must be one of ${spec.values.join(', ')} (is "${value}").`);
            if (key === 'restart_timeout' && !/^\d+( \d+)?$/.test(value)) errors.push('"restart_timeout" is seconds, or "base cap" in seconds.');
        }
    }
    if (options.remote_password && !options.remote_username) errors.push('A remote password needs a remote username.');
    if (options.local_password && !options.local_username) errors.push('A local password needs a local username.');
    if ((options.bridge_certfile && !options.bridge_keyfile) || (!options.bridge_certfile && options.bridge_keyfile)) {
        errors.push('A client certificate needs both bridge_certfile and bridge_keyfile.');
    }
    if (options.bridge_insecure === 'true') warnings.push('bridge_insecure true: the remote certificate is not checked against its hostname — only for testing.');
    if (options.remote_username && !options.bridge_cafile && !options.bridge_capath && !options.bridge_psk && !options.bridge_certfile) {
        warnings.push('Username and password without TLS go over the wire in clear text.');
    }
    if (options.notifications === 'false') warnings.push('notifications false: she cannot show this bridge’s connection state.');

    return { errors, warnings };
}

/** The reason an MQTT filter is invalid, or null. */
function patternError(pattern) {
    if (pattern === '') return null;
    const segs = pattern.split('/');
    for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (s === '#') {
            if (i !== segs.length - 1) return '"#" is only allowed as the last segment.';
        } else if (s.includes('#')) return '"#" must stand alone in its segment.';
        else if (s.includes('+') && s !== '+') return '"+" must stand alone in its segment.';
    }
    return null;
}

// ── Loop check ────────────────────────────────────────────────────────────────

/** Do two MQTT filters share at least one topic? */
function patternsOverlap(a, b) {
    const sa = a.split('/');
    const sb = b.split('/');
    let i = 0;
    for (;;) {
        const x = sa[i];
        const y = sb[i];
        if (x === '#' || y === '#') return true;
        if (x === undefined || y === undefined) return x === y;
        if (x !== '+' && y !== '+' && x !== y) return false;
        i++;
    }
}

/** The pattern a rule matches on the local broker. */
function localPattern(rule) {
    return (rule.localPrefix || '') + (rule.pattern || '');
}

/** The pattern a rule matches / produces on the remote broker. */
function remotePattern(rule) {
    return (rule.remotePrefix || '') + (rule.pattern || '');
}

/**
 * Find loops in a set of topic rules (one bridge, or every bridge to the same remote).
 *
 * A message that enters the local broker through an `in` rule A (local topic = A's local
 * pattern) and leaves again through an `out` rule B (B's local pattern overlaps) lands on the
 * remote as B's remote pattern — if that overlaps A's remote pattern, it comes back through A.
 *
 * Returns { errors, warnings }: the same rule bridged `both` without a prefix change is a
 * warning (Mosquitto's try_private stops the echo when the remote is a Mosquitto too); a loop
 * through two different rules is an error.
 */
function findLoops(rules) {
    const errors = [];
    const warnings = [];
    const label = (r) => (r.bridge ? `${r.bridge}: rule ${r.index + 1}` : `rule ${r.index + 1}`);
    const list = rules.map((r, i) => ({ ...r, index: r.index ?? i }));
    const ins = list.filter((r) => r.direction === 'in' || r.direction === 'both');
    const outs = list.filter((r) => r.direction === 'out' || r.direction === 'both');
    const seen = new Set();
    for (const a of ins) {
        for (const b of outs) {
            if (!patternsOverlap(localPattern(a), localPattern(b))) continue;
            if (!patternsOverlap(remotePattern(a), remotePattern(b))) continue;
            if (a === b) {
                if ((a.localPrefix || '') === (a.remotePrefix || '')) {
                    warnings.push(`${label(a)} ("${a.pattern}" both ways with the same prefixes) echoes unless the remote is a Mosquitto with try_private.`);
                }
                continue;
            }
            const key = [a.bridge, a.index, b.bridge, b.index].join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            errors.push(`Loop: ${label(a)} brings "${remotePattern(a)}" in as "${localPattern(a)}", ${label(b)} sends "${localPattern(b)}" back out as "${remotePattern(b)}".`);
        }
    }
    return { errors, warnings };
}

/**
 * Validate a whole bridge list as it would be written: each bridge, duplicate names, loops within
 * a bridge and across bridges that share a remote address.
 */
function validateBridges(bridges, ctx = {}) {
    const errors = [];
    const warnings = [];
    const names = new Map();
    for (const b of bridges) {
        const r = validateBridge(b, ctx);
        errors.push(...r.errors.map((e) => `${b.name || '(unnamed)'}: ${e}`));
        warnings.push(...r.warnings.map((w) => `${b.name || '(unnamed)'}: ${w}`));
        const n = String(b.name ?? '').trim();
        if (n) names.set(n, (names.get(n) || 0) + 1);
    }
    for (const [n, count] of names) if (count > 1) errors.push(`Duplicate bridge name "${n}" — Mosquitto refuses the config.`);

    // loops: group the rules by remote address set
    const groups = new Map();
    for (const b of bridges) {
        const key = [...(b.addresses || [])]
            .map((a) => String(a).trim())
            .sort()
            .join(' ');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(...(b.topics || []).map((t, i) => ({ ...t, bridge: bridges.length > 1 ? b.name : '', index: i })));
    }
    for (const rules of groups.values()) {
        const r = findLoops(rules);
        errors.push(...r.errors);
        warnings.push(...r.warnings);
    }
    return { errors, warnings };
}

// ── Mapping preview ───────────────────────────────────────────────────────────

/** An example topic for a filter: `+` becomes a sample segment, `#` a two-segment tail. */
function exampleTopic(pattern) {
    const samples = ['kitchen', 'light', 'sensor1', 'room2'];
    let n = 0;
    return pattern
        .split('/')
        .map((s) => (s === '+' ? samples[n++ % samples.length] : s === '#' ? 'a/b' : s))
        .join('/');
}

/**
 * What one rule does, in words and with an example — the UI's live preview.
 * @returns {{ direction: string, local: string, remote: string, lines: string[] }}
 */
function previewRule(rule) {
    const pattern = String(rule.pattern ?? '');
    const ex = pattern ? exampleTopic(pattern) : '';
    const lp = rule.localPrefix || '';
    const rp = rule.remotePrefix || '';
    const local = lp + (pattern || '#');
    const remote = rp + (pattern || '#');
    const exLocal = lp + (ex || 'a/b');
    const exRemote = rp + (ex || 'a/b');
    const lines = [];
    if (rule.direction === 'in' || rule.direction === 'both') {
        lines.push(`remote ${exRemote} → local ${exLocal}`);
    }
    if (rule.direction === 'out' || rule.direction === 'both') {
        lines.push(`local ${exLocal} → remote ${exRemote}`);
    }
    return { direction: rule.direction, local, remote, lines };
}

/** The topic rule presets offered by the UI. */
const PRESETS = [
    {
        id: 'mirror-prefix',
        title: 'Mirror everything under a prefix',
        description: 'Everything the remote publishes shows up here under a prefix; nothing goes out.',
        params: [{ key: 'prefix', label: 'Local prefix', default: 'remote/' }],
        rules: ({ prefix }) => [{ pattern: '#', direction: 'in', qos: 0, localPrefix: prefix, remotePrefix: '' }],
    },
    {
        id: 'mqtt-smarthome-adapter',
        title: 'mqtt-smarthome adapter on the remote',
        description: 'An adapter that runs on the remote broker: its status/ and connected come in, set/ commands go out.',
        params: [{ key: 'name', label: 'Adapter name (topic prefix)', default: 'hm' }],
        rules: ({ name }) => [
            { pattern: `${name}/status/#`, direction: 'in', qos: 0, localPrefix: '', remotePrefix: '' },
            { pattern: `${name}/connected`, direction: 'in', qos: 0, localPrefix: '', remotePrefix: '' },
            { pattern: `${name}/set/#`, direction: 'out', qos: 0, localPrefix: '', remotePrefix: '' },
        ],
    },
    {
        id: 'publish-prefix',
        title: 'Publish a branch to the remote',
        description: 'Everything under a local branch goes out, optionally under another name there.',
        params: [
            { key: 'local', label: 'Local branch', default: 'home/' },
            { key: 'remote', label: 'Remote prefix', default: 'site1/' },
        ],
        rules: ({ local, remote }) => [{ pattern: '#', direction: 'out', qos: 0, localPrefix: local, remotePrefix: remote }],
    },
];

// ── The remote side ───────────────────────────────────────────────────────────

/** The client id the remote sees (and the state topic's segment). */
function remoteClientId(bridge, brokerHostname = null) {
    const o = bridge.options || {};
    if (o.remote_clientid) return String(o.remote_clientid);
    return brokerHostname ? `${brokerHostname}.${bridge.name}` : null;
}

/** The topic the bridge's state is published on, locally. */
function stateTopic(bridge, brokerHostname = null) {
    const o = bridge.options || {};
    if (o.notification_topic) return String(o.notification_topic);
    const id = remoteClientId(bridge, brokerHostname);
    return id ? `$SYS/broker/connection/${id}/state` : null;
}

/**
 * What the remote broker needs so the bridge can do its job: a user and these ACLs.
 * Returned as a structured list, as dynsec commands (mosquitto_ctrl) and as plain text.
 */
function remoteRequirements(bridge) {
    const o = bridge.options || {};
    const username = o.remote_username || null;
    const role = `bridge-${bridge.name}`;
    const acls = [];
    const add = (acltype, topic, why) => {
        if (!acls.some((a) => a.acltype === acltype && a.topic === topic)) acls.push({ acltype, topic, why });
    };
    for (const t of bridge.topics || []) {
        const rp = remotePattern(t);
        if (t.direction === 'out' || t.direction === 'both') add('publishClientSend', rp, `rule "${t.pattern}" ${t.direction}: the bridge publishes here`);
        if (t.direction === 'in' || t.direction === 'both') {
            add('subscribePattern', rp, `rule "${t.pattern}" ${t.direction}: the bridge subscribes here`);
            add('publishClientReceive', rp, `rule "${t.pattern}" ${t.direction}: the bridge receives these`);
        }
    }
    if (o.notifications !== 'false' && o.notifications_local_only !== 'true') {
        const id = remoteClientId(bridge) || `<hostname>.${bridge.name}`;
        add('publishClientSend', o.notification_topic || `$SYS/broker/connection/${id}/state`, 'the connection state notification');
    }
    const u = username || '<bridge user>';
    const dynsec = [
        `mosquitto_ctrl dynsec createClient ${u}`,
        `mosquitto_ctrl dynsec createRole ${role}`,
        ...acls.map((a) => `mosquitto_ctrl dynsec addRoleACL ${role} ${a.acltype} '${a.topic}' allow`),
        `mosquitto_ctrl dynsec addClientRole ${u} ${role}`,
    ];
    const plain = [
        `User "${u}"${o.remote_clientid ? ` with client id "${o.remote_clientid}"` : ''}, allowed to:`,
        ...acls.map((a) => `  ${a.acltype === 'publishClientSend' ? 'publish' : a.acltype === 'subscribePattern' ? 'subscribe' : 'receive'}  ${a.topic}   (${a.why})`),
    ];
    return { username, clientid: o.remote_clientid || null, role, acls, dynsec, plain: plain.join('\n') };
}

// ── Diff ──────────────────────────────────────────────────────────────────────

/** Hide secret values in conf text. */
function maskSecrets(text) {
    const re = new RegExp(`^(\\s*(?:${SECRET_KEYS.join('|')})\\s+)(.*)$`, 'gm');
    return String(text).replace(re, (_, k) => `${k}********`);
}

/**
 * A unified line diff of two texts (LCS; conf files are small). Secrets are masked.
 * @returns {string} '' when equal
 */
function unifiedDiff(before, after, { context = 3, fromName = 'mosquitto.conf', toName = 'mosquitto.conf (new)' } = {}) {
    // diff the real lines (so a changed password shows as a change), mask on the way out
    const a = String(before).split('\n');
    const b = String(after).split('\n');
    if (a.length === b.length && a.every((l, i) => l === b[i])) return '';
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const ops = []; // { t: ' '|'-'|'+', line, ai, bi }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) {
            ops.push({ t: ' ', line: a[i], ai: i, bi: j });
            i++;
            j++;
        } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
            ops.push({ t: '+', line: b[j], ai: i, bi: j });
            j++;
        } else {
            ops.push({ t: '-', line: a[i], ai: i, bi: j });
            i++;
        }
    }
    // hunks: changes closer than 2*context lines share one hunk; no line is shown twice
    const out = [`--- ${fromName}`, `+++ ${toName}`];
    let k = 0;
    let prevEnd = 0;
    while (k < ops.length) {
        if (ops[k].t === ' ') {
            k++;
            continue;
        }
        const start = Math.max(k - context, prevEnd);
        let lastChange = k;
        let end = k + 1;
        while (end < ops.length && (ops[end].t !== ' ' || end - lastChange <= 2 * context)) {
            if (ops[end].t !== ' ') lastChange = end;
            end++;
        }
        end = Math.min(ops.length, lastChange + context + 1);
        const hunk = ops.slice(start, end);
        const aStart = (hunk.find((o) => o.t !== '+') || hunk[0]).ai + 1;
        const bStart = (hunk.find((o) => o.t !== '-') || hunk[0]).bi + 1;
        const aLen = hunk.filter((o) => o.t !== '+').length;
        const bLen = hunk.filter((o) => o.t !== '-').length;
        out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
        for (const o of hunk) out.push(o.t + maskSecrets(o.line));
        prevEnd = end;
        k = end;
    }
    return out.join('\n');
}

// ── Rollback ──────────────────────────────────────────────────────────────────

/**
 * Decide what to do after the new config was written and the reload command ran.
 *
 * @param {{ reloadOk: boolean, probeOk: boolean }} r
 *   reloadOk — the reload command exited 0; probeOk — the broker accepted an MQTT connection
 *   within the grace period afterwards.
 * @returns {{ rollback: boolean, restart: boolean, reason: string|null }}
 *   rollback — restore the previous mosquitto.conf; restart — the broker is gone, a reload
 *   cannot bring it back: run the restart command after restoring.
 */
function decideRollback({ reloadOk, probeOk }) {
    if (reloadOk && probeOk) return { rollback: false, restart: false, reason: null };
    if (!reloadOk && probeOk) return { rollback: true, restart: false, reason: 'the reload command failed; the broker still runs on the previous config' };
    if (reloadOk && !probeOk) return { rollback: true, restart: true, reason: 'the broker did not answer after the reload' };
    return { rollback: true, restart: true, reason: 'the reload command failed and the broker does not answer' };
}

module.exports = {
    BRIDGE_OPTIONS,
    SECRET_KEYS,
    PRESETS,
    isBridgeKey,
    looksLikeBridgeKey,
    newBridge,
    applyBridgeLine,
    parseTopicLine,
    serialiseTopicRule,
    serialiseBridge,
    parseOptionLines,
    validateBridge,
    validateBridges,
    findLoops,
    patternsOverlap,
    previewRule,
    exampleTopic,
    remoteClientId,
    stateTopic,
    remoteRequirements,
    maskSecrets,
    unifiedDiff,
    decideRollback,
    brokerVersionFromSys,
    compareVersion,
};
