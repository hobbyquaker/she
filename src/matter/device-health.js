'use strict';

/**
 * Matter device health (roadmap M21): per node the battery (Power Source cluster: percent, charge
 * level, charge state), when it was last heard from, its online/offline history and its Thread
 * role changes — kept in `device-health.json` in the Matter storage across restarts; alerts for a
 * low battery and for a long offline period, logged at warn, published retained on
 * `<name>/status/matter/health` as `{ val: 'ok' | 'warning', ts, lc, alerts }`, shown on the device page.
 */

const fs = require('fs');
const path = require('path');

const HISTORY_MAX = 50;
const OFFLINE_ALERT_MS = 60 * 60 * 1000;
const LOW_BATTERY_PERCENT = 20;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

let _log = null;
let _broadcast = null;
let _publish = null;
let _topic = null;
let _controller = null;
let _file = null;
let _timer = null;
let _listening = false;
let _lastVal = null;
let _lc = null;
/** nodeId → { lastSeen, online, since, offlineHistory: [{ online, ts }], battery, roles: [{ role, ts }] } */
let _nodes = new Map();
const _active = new Map();

function _ctrl() {
    return _controller ?? require('./controller');
}

function _load() {
    _nodes = new Map();
    if (!_file) return;
    try {
        const raw = JSON.parse(fs.readFileSync(_file, 'utf8'));
        for (const [k, v] of Object.entries(raw.nodes ?? {})) if (v && typeof v === 'object') _nodes.set(k, v);
    } catch (err) {
        if (err.code !== 'ENOENT') _log?.warn(`matter health: cannot read ${_file}: ${err.message}`);
    }
}

let _saveTimer = null;
function _save() {
    if (!_file || _saveTimer) return;
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        try {
            fs.writeFileSync(_file + '.tmp', JSON.stringify({ v: 1, nodes: Object.fromEntries(_nodes) }));
            fs.renameSync(_file + '.tmp', _file);
        } catch (err) {
            _log?.warn(`matter health: cannot write ${_file}: ${err.message}`);
        }
    }, 2000);
    if (typeof _saveTimer.unref === 'function') _saveTimer.unref();
}

function _entry(nodeId) {
    let e = _nodes.get(String(nodeId));
    if (!e) {
        e = { lastSeen: null, online: null, since: null, offlineHistory: [], battery: null, roles: [] };
        _nodes.set(String(nodeId), e);
    }
    return e;
}

const CHARGE_LEVELS = ['ok', 'warning', 'critical'];
const CHARGE_STATES = ['unknown', 'charging', 'full', 'not charging'];

/** Fold a Power Source attribute into the battery record (pure on the record). */
function applyBatteryAttr(battery, attrName, value) {
    const b = battery ?? { percent: null, level: null, state: null, voltageMv: null, ts: null };
    switch (attrName) {
        case 'batPercentRemaining':
            b.percent = value === null || value === undefined ? null : Math.round(Number(value) / 2); // half-percent units
            break;
        case 'batChargeLevel':
            b.level = value === null || value === undefined ? null : (CHARGE_LEVELS[Number(value)] ?? String(value));
            break;
        case 'batChargeState':
            b.state = value === null || value === undefined ? null : (CHARGE_STATES[Number(value)] ?? String(value));
            break;
        case 'batVoltage':
            b.voltageMv = value === null || value === undefined ? null : Number(value);
            break;
        default:
            return battery;
    }
    b.ts = Date.now();
    return b;
}

function _seen(nodeId, ts = Date.now()) {
    const e = _entry(nodeId);
    e.lastSeen = ts;
    _save();
}

function _onAttr(ev) {
    _seen(ev.nodeId, ev.ts);
    if (ev.clusterName === 'powerSource') {
        const e = _entry(ev.nodeId);
        const next = applyBatteryAttr(e.battery, ev.attrName, ev.value);
        if (next !== e.battery) {
            e.battery = next;
            _save();
        }
    } else if (ev.clusterName === 'threadNetworkDiagnostics' && ev.attrName === 'routingRole') {
        const e = _entry(ev.nodeId);
        const last = e.roles[e.roles.length - 1];
        if (!last || last.role !== Number(ev.value)) {
            e.roles.push({ role: Number(ev.value), ts: ev.ts ?? Date.now() });
            if (e.roles.length > HISTORY_MAX) e.roles.splice(0, e.roles.length - HISTORY_MAX);
            _save();
        }
    }
}

function _onEvent(ev) {
    _seen(ev.nodeId, ev.ts);
}

function _onStatus({ nodeId, online }) {
    const e = _entry(nodeId);
    const now = Date.now();
    if (e.online !== online) {
        e.online = online;
        e.since = now;
        e.offlineHistory.push({ online, ts: now });
        if (e.offlineHistory.length > HISTORY_MAX) e.offlineHistory.splice(0, e.offlineHistory.length - HISTORY_MAX);
        if (online) e.lastSeen = now;
        _save();
        _broadcast?.({ type: 'matter:health', nodeId });
    }
}

/** Read what the cached state already knows (battery, role) for every paired node. */
function _scan() {
    const ctrl = _ctrl();
    for (const dev of ctrl.listPaired()) {
        const e = _entry(dev.nodeId);
        if (e.online === null) {
            e.online = dev.online;
            e.since = Date.now();
        }
        let endpoints;
        try {
            endpoints = ctrl.getEndpoints(dev.nodeId);
        } catch {
            continue;
        }
        for (const ep of endpoints) {
            const ps = ep.clusters.find((c) => c.name === 'powerSource');
            // the cached state fills in what the file does not know; a report updates it anyway
            if (ps && !e.battery)
                for (const k of ['batPercentRemaining', 'batChargeLevel', 'batChargeState', 'batVoltage'])
                    if (ps.attrs[k] !== undefined) e.battery = applyBatteryAttr(e.battery, k, ps.attrs[k]);
            const tnd = ep.endpointId === 0 ? ep.clusters.find((c) => c.name === 'threadNetworkDiagnostics') : null;
            if (tnd && tnd.attrs.routingRole !== undefined && tnd.attrs.routingRole !== null && !e.roles.length)
                e.roles.push({ role: Number(tnd.attrs.routingRole), ts: Date.now() });
        }
    }
    _save();
}

/** The view of one node. */
function nodeHealth(nodeId, { now = Date.now() } = {}) {
    const e = _nodes.get(String(nodeId)) ?? null;
    if (!e) return null;
    const offlinePeriods = [];
    let start = null;
    for (const h of e.offlineHistory) {
        if (!h.online) start = h.ts;
        else if (start !== null) {
            offlinePeriods.push({ from: start, to: h.ts, ms: h.ts - start });
            start = null;
        }
    }
    const week = now - 7 * 24 * 60 * 60 * 1000;
    const offlineWeek = offlinePeriods.filter((p) => p.to >= week);
    return {
        nodeId: String(nodeId),
        lastSeen: e.lastSeen,
        online: e.online,
        since: e.since,
        battery: e.battery,
        offlineNow: e.online === false ? now - (e.since ?? now) : 0,
        offlineCount7d: offlineWeek.length + (e.online === false && start !== null && start >= week ? 1 : 0),
        offlineMs7d: offlineWeek.reduce((a, p) => a + p.ms, 0) + (e.online === false && start !== null ? now - Math.max(start, week) : 0),
        lastOffline: offlinePeriods.length ? offlinePeriods[offlinePeriods.length - 1] : null,
        roles: e.roles.slice(-10),
        alerts: [..._active.values()].filter((a) => a.nodeId === String(nodeId)),
    };
}

/** Every paired node's health, with the alerts. */
function listHealth({ now = Date.now() } = {}) {
    const nodes = [];
    for (const dev of _ctrl().listPaired())
        nodes.push({ ...(nodeHealth(dev.nodeId, { now }) ?? { nodeId: dev.nodeId, lastSeen: null, online: dev.online, battery: null, alerts: [] }), name: dev.name });
    return {
        val: _active.size ? 'warning' : 'ok',
        nodes,
        alerts: [..._active.values()],
        topic: _topic,
        thresholds: { offlineAlertMs: OFFLINE_ALERT_MS, lowBatteryPercent: LOW_BATTERY_PERCENT },
    };
}

/** Evaluate the alerts: low battery, long offline. Returns raised and cleared. */
function check({ now = Date.now() } = {}) {
    const raised = [];
    const cleared = [];
    const wanted = new Map();
    for (const dev of _ctrl().listPaired()) {
        const e = _nodes.get(dev.nodeId);
        if (!e) continue;
        const name = dev.name ?? `node ${dev.nodeId}`;
        if (e.battery && (e.battery.level === 'warning' || e.battery.level === 'critical' || (e.battery.percent !== null && e.battery.percent <= LOW_BATTERY_PERCENT))) {
            wanted.set(`battery:${dev.nodeId}`, {
                key: `battery:${dev.nodeId}`,
                kind: 'low_battery',
                nodeId: dev.nodeId,
                name,
                message: `${name}: battery ${e.battery.percent !== null ? e.battery.percent + ' %' : e.battery.level}`,
                since: now,
            });
        }
        if (e.online === false && e.since && now - e.since > OFFLINE_ALERT_MS) {
            wanted.set(`offline:${dev.nodeId}`, {
                key: `offline:${dev.nodeId}`,
                kind: 'offline',
                nodeId: dev.nodeId,
                name,
                message: `${name}: offline for ${Math.round((now - e.since) / 3600000)} h`,
                since: e.since,
            });
        }
    }
    for (const [key, a] of wanted) {
        if (_active.has(key)) continue;
        _active.set(key, a);
        raised.push(a);
    }
    for (const [key, a] of _active) {
        if (wanted.has(key)) continue;
        _active.delete(key);
        cleared.push(a);
    }
    for (const a of raised) _log?.warn(`matter health: ${a.message}`);
    for (const a of cleared) _log?.info(`matter health: cleared — ${a.message}`);
    const val = _active.size ? 'warning' : 'ok';
    if (raised.length || cleared.length || _lastVal === null) {
        if (_lc === null || val !== _lastVal) _lc = now;
        _lastVal = val;
        if (_publish && _topic) {
            try {
                _publish(
                    _topic,
                    JSON.stringify({
                        val,
                        ts: now,
                        lc: _lc,
                        alerts: [..._active.values()].map((a) => ({ kind: a.kind, nodeId: a.nodeId, name: a.name, message: a.message, since: a.since })),
                    }),
                    { retain: true },
                );
            } catch (err) {
                _log?.debug(`matter health: publish failed: ${err.message}`);
            }
        }
        _broadcast?.({ type: 'matter:health' });
    }
    return { raised, cleared, val };
}

function start({ publish, name, log, broadcast, controller, storageDir } = {}) {
    _publish = publish ?? _publish;
    _topic = name ? `${name}/status/matter/health` : _topic;
    _log = log ?? _log;
    _broadcast = broadcast ?? _broadcast;
    _controller = controller ?? null;
    _file = storageDir ? path.join(storageDir, 'device-health.json') : _file;
    _load();
    if (!_listening) {
        const ev = _ctrl().events;
        if (ev) {
            ev.on('attr', _onAttr);
            ev.on('event', _onEvent);
            ev.on('status', _onStatus);
            _listening = true;
        }
    }
    try {
        _scan();
    } catch (err) {
        _log?.debug(`matter health: initial scan: ${err.message}`);
    }
    if (_timer) clearInterval(_timer);
    _timer = setInterval(() => {
        try {
            check();
        } catch (err) {
            _log?.debug(`matter health: ${err.message}`);
        }
    }, CHECK_INTERVAL_MS);
    if (typeof _timer.unref === 'function') _timer.unref();
    setTimeout(() => {
        try {
            check();
        } catch {
            /* later */
        }
    }, 30 * 1000).unref?.();
}

function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
}

/** Test hook. */
function _reset() {
    _nodes = new Map();
    _active.clear();
    _lastVal = null;
    _lc = null;
    _listening = false;
    _file = null;
}

module.exports = { start, stop, check, listHealth, nodeHealth, applyBatteryAttr, _onAttr, _onEvent, _onStatus, _reset, OFFLINE_ALERT_MS, LOW_BATTERY_PERCENT };
