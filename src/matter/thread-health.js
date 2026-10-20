'use strict';

/**
 * Thread health alerts (roadmap M26): evaluated from the border routers (M15) and the mesh (M16)
 * once a minute and on changes — a leader change, a partitioned network (more than one partition
 * ID announced for one extended PAN ID), a border router that stopped announcing itself, a router
 * that dropped to a child or end device, a link whose quality fell from good to poor.
 *
 * Raised alerts are logged at warn (cleared ones at info), published retained on MQTT under
 * `<name>/status/thread/health` as `{ val: 'ok' | 'warning', ts, lc, alerts }` so scripts and
 * notifications can react, and shown on the Thread tab.
 */

const CHECK_INTERVAL_MS = 60 * 1000;
const ROUTER_STALE_MS = 15 * 60 * 1000;
const HISTORY_MAX = 100;

let _log = null;
let _broadcast = null;
let _publish = null;
let _topic = null;
let _timer = null;
let _controller = null;
let _thread = null;
let _mesh = null;
let _lastPublished = null;
let _lc = null;

/** What the evaluator remembers between runs. */
function emptyState() {
    return {
        leaders: new Map(), // extPanId → leader ext address
        partitions: new Map(), // extPanId → partition id set (as sorted string)
        routers: new Map(), // ext address → { lastSeen, name, network }
        roles: new Map(), // nodeId → roleCode
        links: new Map(), // link key → lqi
        active: new Map(), // alert key → alert
        history: [],
    };
}

let _state = emptyState();

const ROUTER_ROLES = new Set([4, 5, 6]);

function _alertKey(kind, subject) {
    return `${kind}:${subject}`;
}

/**
 * Evaluate a snapshot against the remembered state. Pure: returns the new state, the alerts raised
 * and cleared in this run. `snapshot` = { networks (M15 listNetworks().networks), mesh (M16 getMesh()), now }.
 */
function evaluate(state, { networks = [], mesh = { nodes: [], links: [] }, now = Date.now() }) {
    const next = {
        ...state,
        leaders: new Map(state.leaders),
        partitions: new Map(state.partitions),
        routers: new Map(state.routers),
        roles: new Map(state.roles),
        links: new Map(state.links),
        active: new Map(state.active),
        history: [...state.history],
    };
    const raised = [];
    const cleared = [];
    const seen = new Set();

    const raise = (kind, subject, message, extra = {}) => {
        const key = _alertKey(kind, subject);
        seen.add(key);
        if (next.active.has(key)) return;
        const alert = { key, kind, subject, message, since: now, ...extra };
        next.active.set(key, alert);
        next.history.unshift({ ...alert, event: 'raised', at: now });
        raised.push(alert);
    };
    const note = (kind, subject, message, extra = {}) => {
        // a one-off event: it goes into the history and is raised, and clears on the next run
        const key = _alertKey(kind, subject);
        const alert = { key, kind, subject, message, since: now, transient: true, ...extra };
        next.history.unshift({ ...alert, event: 'raised', at: now });
        raised.push(alert);
    };

    // networks: leader, partitions, border routers
    for (const net of networks) {
        const name = net.networkName ?? net.extPanId;
        const leaderBr = net.borderRouters.find((b) => b.state?.role === 'leader') ?? null;
        const leaderExt = leaderBr?.extAddress ?? null;
        const prevLeader = next.leaders.get(net.extPanId);
        if (leaderExt && prevLeader && prevLeader !== leaderExt) {
            const prevName = next.routers.get(prevLeader)?.name ?? prevLeader;
            note('leader_changed', net.extPanId, `${name}: the leader changed from ${prevName} to ${leaderBr.vendorName ?? ''} ${leaderBr.modelName ?? ''}`.trim(), {
                network: name,
            });
        }
        if (leaderExt) next.leaders.set(net.extPanId, leaderExt);

        const parts = [...new Set(net.partitions ?? [])].sort().join(',');
        if ((net.partitions ?? []).length > 1)
            raise('partition', net.extPanId, `${name}: ${net.partitions.length} partition IDs announced (${parts}) — the network is split`, { network: name });
        next.partitions.set(net.extPanId, parts);

        for (const br of net.borderRouters) {
            const label = `${br.vendorName ?? ''} ${br.modelName ?? ''}`.trim() || br.extAddress;
            next.routers.set(br.extAddress, { lastSeen: br.lastSeen ?? now, name: label, network: name });
            if (br.lastSeen && now - br.lastSeen > ROUTER_STALE_MS)
                raise('border_router_offline', br.extAddress, `${name}: border router ${label} not seen for ${Math.round((now - br.lastSeen) / 60000)} min`, { network: name });
            else {
                // seen fresh: an offline alert for it (stale or vanished) is over
                const key = _alertKey('border_router_offline', br.extAddress);
                if (next.active.has(key)) {
                    cleared.push(next.active.get(key));
                    next.history.unshift({ ...next.active.get(key), event: 'cleared', at: now });
                    next.active.delete(key);
                }
            }
        }
    }
    // border routers that vanished from the registry
    const present = new Set(networks.flatMap((n) => n.borderRouters.map((b) => b.extAddress)));
    for (const [ext, r] of next.routers) {
        if (present.has(ext)) continue;
        raise('border_router_offline', ext, `${r.network}: border router ${r.name} disappeared from mDNS`, { network: r.network });
    }
    // the mesh: partitions among fabric nodes, roles, link quality
    const byNet = new Map();
    for (const n of mesh.nodes ?? []) {
        if (n.kind !== 'thread') continue;
        if (n.networkName && n.partitionId !== null && n.partitionId !== undefined) {
            const s = byNet.get(n.networkName) ?? new Set();
            s.add(String(n.partitionId));
            byNet.set(n.networkName, s);
        }
        if (n.nodeId && n.roleCode !== null && n.roleCode !== undefined) {
            const prev = next.roles.get(n.nodeId);
            if (prev !== undefined && ROUTER_ROLES.has(prev) && !ROUTER_ROLES.has(n.roleCode) && n.online) {
                raise('role_dropped', n.nodeId, `${n.name}: was a ${ROLE_NAMES[prev] ?? 'router'}, is now a ${n.role}`, { network: n.networkName ?? null });
            } else if (ROUTER_ROLES.has(n.roleCode)) {
                const key = _alertKey('role_dropped', n.nodeId);
                if (next.active.has(key)) {
                    cleared.push(next.active.get(key));
                    next.history.unshift({ ...next.active.get(key), event: 'cleared', at: now });
                    next.active.delete(key);
                }
            }
            next.roles.set(n.nodeId, n.roleCode);
            if (next.active.has(_alertKey('role_dropped', n.nodeId))) seen.add(_alertKey('role_dropped', n.nodeId));
        }
    }
    for (const [name, parts] of byNet) {
        if (parts.size > 1)
            raise('partition', `nodes:${name}`, `${name}: devices report ${parts.size} partition IDs (${[...parts].sort().join(', ')}) — the mesh is split`, { network: name });
    }
    const nodeName = (id) => mesh.nodes?.find((x) => x.id === id)?.name ?? id;
    for (const l of mesh.links ?? []) {
        if (l.kind !== 'neighbour') continue;
        const key = `${l.source}|${l.target}`;
        const prev = next.links.get(key);
        if (prev !== undefined && prev >= 3 && l.lqi <= 1) {
            raise('link_degraded', key, `link ${nodeName(l.source)} ↔ ${nodeName(l.target)}: quality fell from good to poor (LQI ${l.lqi})`);
        } else if (l.lqi >= 2 && next.active.has(_alertKey('link_degraded', key))) {
            cleared.push(next.active.get(_alertKey('link_degraded', key)));
            next.history.unshift({ ...next.active.get(_alertKey('link_degraded', key)), event: 'cleared', at: now });
            next.active.delete(_alertKey('link_degraded', key));
        }
        if (next.active.has(_alertKey('link_degraded', key))) seen.add(_alertKey('link_degraded', key));
        next.links.set(key, l.lqi);
    }
    // everything active that this run did not confirm is cleared (partitions healed, routers back)
    for (const [key, alert] of next.active) {
        if (seen.has(key) || alert.transient) continue;
        if (key.startsWith('role_dropped:') || key.startsWith('link_degraded:')) continue; // cleared explicitly above
        cleared.push(alert);
        next.history.unshift({ ...alert, event: 'cleared', at: now });
        next.active.delete(key);
    }
    for (const a of raised) if (a.transient) next.active.delete(a.key);
    if (next.history.length > HISTORY_MAX) next.history.length = HISTORY_MAX;
    return { state: next, raised, cleared };
}

const ROLE_NAMES = { 4: 'REED', 5: 'router', 6: 'leader' };

function status() {
    const active = [..._state.active.values()];
    return { val: active.length ? 'warning' : 'ok', active, history: _state.history, checkedAt: _lastPublished, topic: _topic };
}

function _publishStatus(now) {
    if (!_publish || !_topic) return;
    const active = [..._state.active.values()];
    const val = active.length ? 'warning' : 'ok';
    if (_lc === null || val !== _lastVal) _lc = now;
    _lastVal = val;
    try {
        _publish(
            _topic,
            JSON.stringify({
                val,
                ts: now,
                lc: _lc,
                alerts: active.map((a) => ({ kind: a.kind, subject: a.subject, message: a.message, since: a.since, network: a.network ?? null })),
            }),
            { retain: true },
        );
    } catch (err) {
        _log?.debug(`matter thread health: publish failed: ${err.message}`);
    }
}
let _lastVal = null;

/** Run one evaluation: gather the snapshot, log and publish what changed. */
async function check({ now = Date.now() } = {}) {
    let networks = [];
    let mesh = { nodes: [], links: [] };
    try {
        networks = (_thread ?? require('./thread')).listNetworks().networks;
    } catch {
        /* discovery off */
    }
    try {
        mesh = await (_mesh ?? require('./thread-mesh')).getMesh({ withBindings: false });
    } catch {
        /* no controller */
    }
    const r = evaluate(_state, { networks, mesh, now });
    _state = r.state;
    for (const a of r.raised) _log?.warn(`matter thread: ${a.message}`);
    for (const a of r.cleared) _log?.info(`matter thread: cleared — ${a.message}`);
    _lastPublished = now;
    if (r.raised.length || r.cleared.length || _lastVal === null) {
        _publishStatus(now);
        _broadcast?.({ type: 'matter:thread-health' });
    }
    return status();
}

/**
 * @param {{ publish?: Function, name?: string, log?: object, broadcast?: Function, controller?: object, thread?: object, mesh?: object }} opts
 */
function start({ publish, name, log, broadcast, controller, thread, mesh } = {}) {
    _publish = publish ?? _publish;
    _topic = name ? `${name}/status/thread/health` : _topic;
    _log = log ?? _log;
    _broadcast = broadcast ?? _broadcast;
    _controller = controller ?? null;
    _thread = thread ?? null;
    _mesh = mesh ?? null;
    if (_timer) clearInterval(_timer);
    _timer = setInterval(() => check().catch((err) => _log?.debug(`matter thread health: ${err.message}`)), CHECK_INTERVAL_MS);
    if (typeof _timer.unref === 'function') _timer.unref();
    // the first run a little after start, when discovery has had its minute
    setTimeout(() => check().catch(() => {}), 90 * 1000).unref?.();
}

function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
}

/** Forget the history (the UI's clear button). */
function clearHistory() {
    _state.history = [];
    _broadcast?.({ type: 'matter:thread-health' });
    return status();
}

/** Test hook. */
function _reset() {
    _state = emptyState();
    _lastPublished = null;
    _lc = null;
    _lastVal = null;
}

module.exports = { evaluate, emptyState, check, status, start, stop, clearHistory, _reset, CHECK_INTERVAL_MS, ROUTER_STALE_MS };
