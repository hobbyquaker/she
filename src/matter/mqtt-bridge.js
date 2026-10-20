'use strict';

/**
 * The Matter ↔ MQTT bridge (roadmap M19): every commissioned node's application attributes and
 * events published to MQTT, commands and writes accepted on `set`, reads on `get` — by default
 * under the mqtt-smarthome convention (`matter/status/…` as `{ val, ts, lc }`, `matter/set/…`,
 * `matter/connected`). Topics and payload format are templates (D-26), the device names are stable
 * MQTT names assigned when a node first appears (D-21), each node can be switched off (D-24).
 *
 * Fed by the controller's event stream; publishes through she's own MQTT connection. Settings in
 * `<matter storage>/mqtt-bridge.json`. Off until switched on in the Matter page's MQTT tab.
 */

const fs = require('fs');
const path = require('path');
const t = require('./bridge-templates');

let _publish = null;
let _isConnected = () => false;
let _store = null;
let _log = null;
let _broadcast = null;
let _controller = null;
let _file = null;
let _settings = defaults();
let _started = false;
let _listening = false;
/** topic → { json, ts, lc } of the attribute topics published this run (for `lc`) */
let _last = new Map();
/** the retained topics published this run */
let _published = new Set();
let _lastWarn = new Map();

function defaults() {
    return { enabled: false, format: 'basic', templates: { ...t.DEFAULT_TEMPLATES }, devices: {} };
}

function _load() {
    _settings = defaults();
    if (!_file) return;
    try {
        const raw = JSON.parse(fs.readFileSync(_file, 'utf8'));
        if (raw && typeof raw === 'object') {
            _settings.enabled = raw.enabled === true;
            _settings.format = t.FORMATS.includes(raw.format) ? raw.format : 'basic';
            _settings.templates = { ...t.DEFAULT_TEMPLATES, ...(raw.templates && typeof raw.templates === 'object' ? raw.templates : {}) };
            _settings.devices = raw.devices && typeof raw.devices === 'object' ? raw.devices : {};
        }
    } catch (err) {
        if (err.code !== 'ENOENT') _log?.warn(`matter bridge: cannot read ${_file}: ${err.message}`);
    }
}

function _save() {
    if (!_file) return;
    try {
        fs.writeFileSync(_file + '.tmp', JSON.stringify(_settings, null, 1));
        fs.renameSync(_file + '.tmp', _file);
    } catch (err) {
        _log?.warn(`matter bridge: cannot write ${_file}: ${err.message}`);
    }
}

function _ctrl() {
    return _controller ?? require('./controller');
}

function _warnOnce(key, msg) {
    const now = Date.now();
    if (now - (_lastWarn.get(key) ?? 0) < 60000) return;
    _lastWarn.set(key, now);
    _log?.warn(msg);
}

/**
 * @param {{ publish: Function, isConnected: Function, store: object, log: object, storageDir: string, broadcast?: Function, controller?: object }} opts
 */
function init({ publish, isConnected, store, log, storageDir, broadcast, controller }) {
    _publish = publish;
    _isConnected = isConnected ?? (() => true);
    _store = store;
    _log = log;
    _broadcast = broadcast ?? null;
    _controller = controller ?? null;
    _file = storageDir ? path.join(storageDir, 'mqtt-bridge.json') : null;
    _started = false;
    _last = new Map();
    _published = new Set();
    _load();
}

// ── Names ─────────────────────────────────────────────────────────────────────

function _deviceEntry(nodeId) {
    return _settings.devices[String(nodeId)];
}

/** Every paired node has an MQTT name (D-21): from its name when it first appears, kept. */
function _ensureNames() {
    let changed = false;
    const taken = new Set(Object.values(_settings.devices).map((d) => d.name));
    for (const dev of _ctrl().listPaired()) {
        if (_deviceEntry(dev.nodeId)) continue;
        const name = t.uniqueName(t.mqttName(dev.name ?? `node_${dev.nodeId}`), taken);
        taken.add(name);
        _settings.devices[dev.nodeId] = { name, publish: true, deviceName: dev.name ?? null };
        changed = true;
        _log?.info(`matter bridge: node ${dev.nodeId} is "${name}" on MQTT`);
    }
    if (changed) _save();
}

function _nameOf(nodeId) {
    return _deviceEntry(nodeId)?.name ?? `node_${nodeId}`;
}

function _nodeIdForDevice(device) {
    for (const [nodeId, d] of Object.entries(_settings.devices)) if (d.name === device) return nodeId;
    if (/^\d+$/.test(String(device)) && _settings.devices[String(device)]) return String(device);
    return null;
}

function _publishesNode(nodeId) {
    const d = _deviceEntry(nodeId);
    return !d || d.publish !== false;
}

// ── Publishing ────────────────────────────────────────────────────────────────

function _out(topic, payload, retain) {
    if (!_publish || !_isConnected()) return false;
    try {
        _publish(topic, payload, { retain });
        if (retain) {
            if (payload === '') _published.delete(topic);
            else _published.add(topic);
        }
        return true;
    } catch (err) {
        _warnOnce('publish', `matter bridge: publish failed: ${err.message}`);
        return false;
    }
}

function _vars(nodeId, endpointId, clusterName, name) {
    return {
        device: _nameOf(nodeId),
        nodeId: String(nodeId),
        endpoint: String(endpointId),
        cluster: t.snake(clusterName),
        attribute: t.snake(name),
        event: t.snake(name),
        attributeOrCommand: t.snake(name),
    };
}

function _allowed(endpointId, clusterName, attrName) {
    if (Number(endpointId) === 0) return false;
    if (t.DENY_CLUSTERS.has(clusterName)) return false;
    if (attrName !== undefined && t.DENY_ATTRIBUTES.has(attrName)) return false;
    return true;
}

function _publishAttr(nodeId, endpointId, clusterName, attrName, value, ts = Date.now()) {
    if (!_settings.enabled || !_settings.templates.attribute) return;
    if (!_publishesNode(nodeId) || !_allowed(endpointId, clusterName, attrName) || value === undefined) return;
    const vars = _vars(nodeId, endpointId, clusterName, attrName);
    const topic = t.fill(_settings.templates.attribute, vars);
    const json = JSON.stringify(value);
    const prev = _last.get(topic);
    const lc = prev && prev.json === json ? prev.lc : ts;
    _last.set(topic, { json, ts, lc });
    _out(
        topic,
        t.formatPayload(_settings.format, value, {
            ts,
            lc,
            matter: { nodeId: String(nodeId), device: vars.device, endpoint: Number(endpointId), cluster: clusterName, attribute: attrName },
        }),
        true,
    );
}

function _publishEvent(nodeId, endpointId, clusterName, eventName, value, ts = Date.now()) {
    if (!_settings.enabled || !_settings.templates.event) return;
    if (!_publishesNode(nodeId) || !_allowed(endpointId, clusterName)) return;
    const vars = _vars(nodeId, endpointId, clusterName, eventName);
    _out(
        t.fill(_settings.templates.event, vars),
        t.formatPayload(_settings.format, value, {
            ts,
            lc: ts,
            matter: { nodeId: String(nodeId), device: vars.device, endpoint: Number(endpointId), cluster: clusterName, event: eventName },
        }),
        false,
    );
}

function _publishOnline(nodeId, online, ts = Date.now()) {
    if (!_settings.enabled || !_settings.templates.online || !_publishesNode(nodeId)) return;
    const vars = _vars(nodeId, 0, '', '');
    const topic = t.fill(_settings.templates.online, vars);
    const json = JSON.stringify(!!online);
    const prev = _last.get(topic);
    const lc = prev && prev.json === json ? prev.lc : ts;
    _last.set(topic, { json, ts, lc });
    _out(topic, t.formatPayload(_settings.format, !!online, { ts, lc, matter: { nodeId: String(nodeId), device: vars.device } }), true);
}

function _publishConnected(value) {
    if (!_settings.templates.connected) return;
    _out(_settings.templates.connected, String(value), true);
}

/** Publish the cached state of a node (every allowed attribute) and its online flag. */
function _publishNode(dev) {
    if (!_settings.enabled || !_publishesNode(dev.nodeId)) return;
    _publishOnline(dev.nodeId, dev.online);
    if (!dev.online) return;
    let endpoints;
    try {
        endpoints = _ctrl().getEndpoints(dev.nodeId);
    } catch {
        return;
    }
    const ts = Date.now();
    for (const ep of endpoints) {
        for (const cluster of ep.clusters) {
            if (!_allowed(ep.endpointId, cluster.name)) continue;
            for (const [attr, value] of Object.entries(cluster.attrs ?? {})) _publishAttr(dev.nodeId, ep.endpointId, cluster.name, attr, value, ts);
        }
    }
}

function _publishAll() {
    if (!_settings.enabled) return;
    _ensureNames();
    for (const dev of _ctrl().listPaired()) _publishNode(dev);
}

// ── Start-up cleanup (SPEC: read back the retained topics, drop the stale ones) ──

/** The retained topics of ours in the state store that match the (given) templates, with the device each names. */
function _retainedOfOurs(templates) {
    const out = [];
    if (!_store || typeof _store.mqttEntries !== 'function') return out;
    for (const key of ['attribute', 'online']) {
        const tpl = templates[key];
        if (!tpl) continue;
        for (const [topic] of _store.mqttEntries()) {
            const vars = t.match(tpl, topic);
            if (vars) out.push({ topic, key, device: vars.device ?? vars.nodeId ?? null });
        }
    }
    return out;
}

/** Clear retained topics: all of ours, or those of devices that are gone or switched off. */
function _cleanup({ all = false, templates = _settings.templates, device = null } = {}) {
    let n = 0;
    const live = new Set(
        Object.entries(_settings.devices)
            .filter(([, d]) => d.publish !== false)
            .map(([, d]) => d.name),
    );
    const paired = new Set(
        _ctrl()
            .listPaired()
            .map((d) => d.nodeId),
    );
    for (const [nodeId, d] of Object.entries(_settings.devices)) if (!paired.has(nodeId)) live.delete(d.name);
    for (const r of _retainedOfOurs(templates)) {
        const stale = all || (device !== null && r.device === device) || (r.device !== null && !live.has(r.device) && !paired.has(r.device));
        if (!stale) continue;
        if (_out(r.topic, '', true)) n++;
        _last.delete(r.topic);
    }
    if (n) _log?.info(`matter bridge: cleared ${n} retained topic(s)`);
    return n;
}

// ── Inbound ───────────────────────────────────────────────────────────────────

/**
 * An MQTT message from she's connection. Returns true when the bridge handled it.
 * @param {string} topic
 * @param {Buffer|string} payload
 */
function onMessage(topic, payload) {
    if (!_settings.enabled) return false;
    const set = _settings.templates.set ? t.match(_settings.templates.set, topic) : null;
    if (set) {
        _handleSet(set, payload).catch((err) => _warnOnce(`set:${topic}`, `matter bridge: ${topic}: ${err.message}`));
        return true;
    }
    const get = _settings.templates.get ? t.match(_settings.templates.get, topic) : null;
    if (get) {
        _handleGet(get).catch((err) => _warnOnce(`get:${topic}`, `matter bridge: ${topic}: ${err.message}`));
        return true;
    }
    return false;
}

function _resolveTarget(vars) {
    const nodeId = _nodeIdForDevice(vars.device ?? vars.nodeId);
    if (!nodeId) throw new Error(`unknown device "${vars.device ?? vars.nodeId}"`);
    const endpointId = Number(vars.endpoint);
    if (!Number.isInteger(endpointId)) throw new Error(`endpoint "${vars.endpoint}" is not a number`);
    const clusterName = t.camel(vars.cluster ?? '');
    if (!clusterName) throw new Error('no cluster in the topic');
    return { nodeId, endpointId, clusterName };
}

async function _handleSet(vars, payload) {
    const { nodeId, endpointId, clusterName } = _resolveTarget(vars);
    const name = t.camel(vars.attributeOrCommand ?? '');
    if (!name) throw new Error('no attribute or command in the topic');
    const val = t.parseInbound(payload);
    const clusters = require('@matter/main/clusters');
    const def = clusters[clusterName.charAt(0).toUpperCase() + clusterName.slice(1)]?.Complete;
    if (!def) throw new Error(`unknown cluster "${clusterName}"`);
    const action = t.resolveSet(clusterName, name, val, def);
    const ctrl = _ctrl();
    if (action.kind === 'command') {
        _log?.debug(`matter bridge: ${_nameOf(nodeId)}/${endpointId} ${clusterName}.${action.command}(${JSON.stringify(action.args ?? {})})`);
        await ctrl.sendCommand(nodeId, endpointId, clusterName, action.command, action.args ?? {});
    } else {
        _log?.debug(`matter bridge: ${_nameOf(nodeId)}/${endpointId} write ${clusterName}.${action.attribute} = ${JSON.stringify(action.value)}`);
        await ctrl.setAttribute(nodeId, endpointId, clusterName, action.attribute, action.value);
    }
}

async function _handleGet(vars) {
    const { nodeId, endpointId, clusterName } = _resolveTarget(vars);
    const attr = t.camel(vars.attribute ?? '');
    if (!attr) throw new Error('no attribute in the topic');
    const value = await _ctrl().getAttribute(nodeId, endpointId, clusterName, attr);
    _publishAttr(nodeId, endpointId, clusterName, attr, _ctrl()._attrValue ? _ctrl()._attrValue(clusterName, attr, value) : value);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function _onAttr(e) {
    _publishAttr(e.nodeId, e.endpointId, e.clusterName, e.attrName, e.value, e.ts);
}
function _onEvent(e) {
    _publishEvent(e.nodeId, e.endpointId, e.clusterName, e.eventName, e.value, e.ts);
}
function _onStatus(e) {
    if (!_settings.enabled) return;
    const dev = _ctrl()
        .listPaired()
        .find((d) => d.nodeId === e.nodeId);
    if (e.online && dev) _publishNode({ ...dev, online: true });
    else _publishOnline(e.nodeId, e.online);
}
function _onDeviceList() {
    if (!_settings.enabled) return;
    _ensureNames();
    _cleanup();
    _publishAll();
}

function _listen() {
    if (_listening) return;
    const ev = _ctrl().events;
    if (!ev) return;
    ev.on('attr', _onAttr);
    ev.on('event', _onEvent);
    ev.on('status', _onStatus);
    ev.on('deviceList', _onDeviceList);
    _listening = true;
}

/** Start the bridge: names, connected, the stale-topic cleanup, the current state. Call once MQTT's retained state is in. */
function start() {
    _started = true;
    _listen();
    if (!_settings.enabled) return;
    _ensureNames();
    _publishConnected(2);
    _cleanup();
    _publishAll();
    _log?.info(`matter bridge: on — ${_published.size} topic(s) published under the ${_settings.format} format`);
    _broadcast?.({ type: 'matter:bridge' });
}

/** On shutdown: connected 0 (she's last will covers only her own connected topic). */
function stop() {
    if (_settings.enabled) _publishConnected(0);
}

// ── Settings ──────────────────────────────────────────────────────────────────

function getSettings() {
    const paired = _ctrl().listPaired();
    const known = new Set(paired.map((d) => d.nodeId));
    const devices = paired.map((d) => {
        const e = _deviceEntry(d.nodeId);
        return {
            nodeId: d.nodeId,
            deviceName: d.name,
            online: d.online,
            name: e?.name ?? t.mqttName(d.name ?? `node_${d.nodeId}`),
            publish: e ? e.publish !== false : true,
            assigned: !!e,
        };
    });
    for (const [nodeId, e] of Object.entries(_settings.devices))
        if (!known.has(nodeId)) devices.push({ nodeId, deviceName: e.deviceName ?? null, online: false, name: e.name, publish: e.publish !== false, assigned: true, gone: true });
    return {
        enabled: _settings.enabled,
        format: _settings.format,
        templates: { ..._settings.templates },
        defaults: { ...t.DEFAULT_TEMPLATES },
        placeholders: [...t.PLACEHOLDERS],
        formats: [...t.FORMATS],
        devices,
        status: { started: _started, connected: _isConnected(), published: _published.size },
    };
}

/**
 * Change bridge on/off, the format or the templates. A changed template or format clears the
 * old retained topics and republishes under the new ones.
 */
function updateSettings({ enabled, format, templates } = {}) {
    const next = { ..._settings, templates: { ..._settings.templates } };
    if (enabled !== undefined) next.enabled = enabled === true;
    if (format !== undefined) {
        if (!t.FORMATS.includes(format)) throw new Error(`format must be one of ${t.FORMATS.join(', ')}`);
        next.format = format;
    }
    if (templates !== undefined) {
        if (!templates || typeof templates !== 'object') throw new Error('templates must be an object');
        for (const [k, v] of Object.entries(templates)) {
            if (!(k in t.DEFAULT_TEMPLATES)) throw new Error(`unknown template "${k}"`);
            next.templates[k] = typeof v === 'string' ? v.trim() : v;
        }
        const problems = t.validate(next.templates);
        if (problems.length) throw new Error(problems.join('; '));
    }
    const wasEnabled = _settings.enabled;
    const topicsChanged = JSON.stringify(next.templates) !== JSON.stringify(_settings.templates) || next.format !== _settings.format;
    const old = _settings;
    if (wasEnabled && (topicsChanged || !next.enabled)) {
        // under the old templates: everything of ours goes
        _cleanup({ all: true, templates: old.templates });
        if (old.templates.connected && old.templates.connected !== next.templates.connected) _out(old.templates.connected, '', true);
        if (!next.enabled && old.templates.connected) _out(old.templates.connected, '0', true);
        _last = new Map();
    }
    _settings = next;
    _save();
    if (_started && next.enabled && (!wasEnabled || topicsChanged)) {
        _ensureNames();
        _publishConnected(2);
        _cleanup();
        _publishAll();
        _log?.info(`matter bridge: ${wasEnabled ? 'republished' : 'switched on'} — ${_published.size} topic(s)`);
    } else if (wasEnabled && !next.enabled) {
        _log?.info('matter bridge: switched off');
    }
    _broadcast?.({ type: 'matter:bridge' });
    return getSettings();
}

/** Rename a node on MQTT or switch its publishing; a rename moves its topics and clears the old ones. */
function setDevice(nodeId, { name, publish } = {}) {
    nodeId = String(nodeId);
    _ensureNames();
    const entry = _deviceEntry(nodeId);
    if (!entry) throw new Error(`Matter node not found: ${nodeId}`);
    const old = { ...entry };
    if (name !== undefined) {
        const clean = t.mqttName(name);
        if (!clean || clean !== String(name).trim()) throw new Error(`"${name}" is not a valid MQTT name — use lower-case letters, digits and underscores (like "${clean}")`);
        const taken = Object.entries(_settings.devices)
            .filter(([id]) => id !== nodeId)
            .map(([, d]) => d.name);
        if (taken.includes(clean)) throw new Error(`"${clean}" is already used by another device`);
        entry.name = clean;
    }
    if (publish !== undefined) entry.publish = publish !== false;
    const changed = old.name !== entry.name || old.publish !== entry.publish;
    _save();
    if (changed && _settings.enabled && _started) {
        if (old.name !== entry.name || entry.publish === false) {
            // the old topics of this device go (its name identifies them in the store)
            _cleanup({ device: old.name });
        }
        if (entry.publish !== false) {
            const dev = _ctrl()
                .listPaired()
                .find((d) => d.nodeId === nodeId);
            if (dev) _publishNode(dev);
        }
    }
    _broadcast?.({ type: 'matter:bridge' });
    return getSettings();
}

/** Test hook. */
function _reset() {
    _settings = defaults();
    _started = false;
    _listening = false;
    _last = new Map();
    _published = new Set();
    _lastWarn = new Map();
}

module.exports = { init, start, stop, onMessage, getSettings, updateSettings, setDevice, _reset, _publishAttr, _publishEvent, _cleanup };
