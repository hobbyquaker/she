'use strict';

/**
 * The Thread mesh (roadmap M16): every Thread device in she's fabric with its routing role,
 * RLOC16, extended address, neighbour table and route table from the Thread Network Diagnostics
 * cluster (0x0035), the Wi-Fi devices with their RSSI and access point from Wi-Fi Network
 * Diagnostics, the border routers from the mDNS registry (M15) joined by extended address, the
 * bindings (M13) as arrows — as a graph of nodes and links the Thread tab draws.
 *
 * Most devices report their neighbour and route tables only when a subscription is set up, so
 * the tables are re-read on demand (the refresh button) and periodically; the rest comes from
 * the cached node state. The ideas (roles, LQI colours, external nodes) follow the Open Home
 * Foundation's matterjs-server dashboard (Apache-2.0, D-14); no code was copied.
 */

const ROLES = { 0: 'unspecified', 1: 'unassigned', 2: 'sleepy end device', 3: 'end device', 4: 'REED', 5: 'router', 6: 'leader' };
const INTERFACE_THREAD = 4;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

let _log = null;
let _broadcast = null;
let _controller = null;
let _thread = null;
let _timer = null;
/** nodeId → { neighborTable, routeTable, readAt } — the fresh tables */
const _tables = new Map();
let _lastRefresh = null;

function _ctrl() {
    return _controller ?? require('./controller');
}
function _registry() {
    return _thread ?? require('./thread');
}

function hex64(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') return v.toUpperCase().replace(/^0X/, '').padStart(16, '0');
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return Buffer.from(v).toString('hex').toUpperCase().padStart(16, '0');
    if (v && typeof v === 'object' && typeof v.$bytes === 'string') return v.$bytes.toUpperCase().padStart(16, '0');
    try {
        return BigInt(v).toString(16).toUpperCase().padStart(16, '0');
    } catch {
        return null;
    }
}

/** LQI 3 → good, 2 → fair, 1 → poor, 0 → unknown (the OHF dashboard's colours). */
function lqiQuality(lqi) {
    if (lqi >= 3) return 'good';
    if (lqi === 2) return 'fair';
    if (lqi === 1) return 'poor';
    return 'unknown';
}

/** RSSI > −70 good, −70 … −85 fair, ≤ −85 poor. */
function rssiQuality(rssi) {
    if (rssi === null || rssi === undefined) return 'unknown';
    if (rssi > -70) return 'good';
    if (rssi > -85) return 'fair';
    return 'poor';
}

/**
 * Build the graph from per-node data (pure, for the tests).
 * @param {object[]} nodes  [{ nodeId, name, online, thread?: { role, rloc16, extAddress, channel, partitionId, leaderRouterId, networkName, neighborTable, routeTable, readAt }, wifi?: { rssi, bssid } }]
 * @param {object[]} borderRouters  the Thread tab's border router views (M15)
 * @param {object[]} bindings  M13's binding list
 */
function buildGraph(nodes, borderRouters = [], bindings = []) {
    const out = { nodes: [], links: [], networks: [] };
    const byExt = new Map();
    const byRloc = new Map();
    const byNodeId = new Map();
    for (const n of nodes) {
        if (n.thread) {
            const g = {
                id: `node:${n.nodeId}`,
                kind: 'thread',
                nodeId: n.nodeId,
                name: n.name ?? `Node ${n.nodeId}`,
                online: !!n.online,
                role: ROLES[n.thread.role] ?? (n.thread.role === null || n.thread.role === undefined ? 'unknown' : String(n.thread.role)),
                roleCode: n.thread.role ?? null,
                rloc16: n.thread.rloc16 ?? null,
                extAddress: n.thread.extAddress ?? null,
                channel: n.thread.channel ?? null,
                partitionId: n.thread.partitionId ?? null,
                networkName: n.thread.networkName ?? null,
                neighbours: (n.thread.neighborTable ?? []).length,
                routes: (n.thread.routeTable ?? []).length,
                readAt: n.thread.readAt ?? null,
            };
            out.nodes.push(g);
            byNodeId.set(n.nodeId, g);
            if (g.extAddress) byExt.set(g.extAddress, g);
            if (g.rloc16 !== null) byRloc.set(g.rloc16, g);
        } else if (n.wifi) {
            const g = {
                id: `node:${n.nodeId}`,
                kind: 'wifi',
                nodeId: n.nodeId,
                name: n.name ?? `Node ${n.nodeId}`,
                online: !!n.online,
                rssi: n.wifi.rssi ?? null,
                bssid: n.wifi.bssid ?? null,
                quality: rssiQuality(n.wifi.rssi),
            };
            out.nodes.push(g);
            byNodeId.set(n.nodeId, g);
        } else {
            const g = { id: `node:${n.nodeId}`, kind: 'other', nodeId: n.nodeId, name: n.name ?? `Node ${n.nodeId}`, online: !!n.online };
            out.nodes.push(g);
            byNodeId.set(n.nodeId, g);
        }
    }
    // border routers: a graph node each, joined to a fabric node when the ext address matches
    for (const br of borderRouters) {
        const ext = br.extAddress ? br.extAddress.toUpperCase() : null;
        const existing = ext ? byExt.get(ext) : null;
        if (existing) {
            existing.borderRouter = { vendorName: br.vendorName, modelName: br.modelName, networkName: br.networkName };
            existing.kind = 'thread';
            continue;
        }
        const g = {
            id: `br:${br.extAddress}`,
            kind: 'border-router',
            name: `${br.vendorName ?? ''} ${br.modelName ?? ''}`.trim() || br.extAddress,
            extAddress: ext,
            networkName: br.networkName ?? null,
            extPanId: br.extPanId ?? null,
            role: br.state?.role ?? null,
            online: true,
            rloc16: br.rest?.node?.rloc16 ?? null,
        };
        out.nodes.push(g);
        if (ext) byExt.set(ext, g);
        if (g.rloc16 !== null) byRloc.set(g.rloc16, g);
    }
    // links from the neighbour tables; a neighbour nobody in the fabric knows becomes an external node
    const linkKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const links = new Map();
    for (const n of nodes) {
        if (!n.thread) continue;
        const from = byNodeId.get(n.nodeId);
        for (const nb of n.thread.neighborTable ?? []) {
            const ext = hex64(nb.extAddress);
            let to = (ext && byExt.get(ext)) || (nb.rloc16 !== undefined && byRloc.get(Number(nb.rloc16))) || null;
            if (!to) {
                const id = `ext:${ext ?? nb.rloc16}`;
                to = out.nodes.find((x) => x.id === id);
                if (!to) {
                    to = {
                        id,
                        kind: 'external',
                        name: ext ? `external ${ext.slice(-4)}` : `external 0x${Number(nb.rloc16).toString(16)}`,
                        extAddress: ext,
                        rloc16: nb.rloc16 ?? null,
                        online: true,
                        explanation:
                            "A neighbour of a device in she's fabric that is not paired with she: a device of another controller, or a border router that announces a different address.",
                    };
                    out.nodes.push(to);
                    if (ext) byExt.set(ext, to);
                }
            }
            const key = linkKey(from.id, to.id);
            const lqi = Number(nb.lqi ?? 0);
            const prev = links.get(key);
            const entry = prev ?? { kind: 'neighbour', source: from.id, target: to.id, lqi: 0, lqiBack: null, rssi: null, isChild: false, bidirectional: false };
            if (prev) {
                entry.bidirectional = true;
                entry.lqiBack = lqi;
                if (lqi > entry.lqi) entry.lqi = lqi;
            } else {
                entry.lqi = lqi;
            }
            if (nb.averageRssi !== undefined && nb.averageRssi !== null) entry.rssi = Number(nb.averageRssi);
            if (nb.isChild) entry.isChild = true;
            entry.quality = lqiQuality(entry.lqi);
            links.set(key, entry);
        }
    }
    out.links.push(...links.values());
    // bindings as arrows
    for (const b of bindings) {
        if (!b.own || b.node === null || b.node === undefined) continue;
        const from = byNodeId.get(b.sourceNodeId);
        const to = byNodeId.get(String(b.node));
        if (!from || !to) continue;
        const key = `binding|${from.id}|${to.id}`;
        if (out.links.some((l) => l.key === key)) continue;
        out.links.push({
            key,
            kind: 'binding',
            source: from.id,
            target: to.id,
            clusters: [b.clusterName ?? b.cluster],
            label: `${b.sourceEndpointName ?? 'ep ' + b.sourceEndpointId} → ${b.targetEndpointName ?? 'ep ' + b.endpoint}`,
        });
    }
    // networks seen in the fabric
    const nets = new Map();
    for (const g of out.nodes) {
        if (g.kind !== 'thread' || !g.networkName) continue;
        const n = nets.get(g.networkName) ?? { networkName: g.networkName, partitions: new Set(), channel: g.channel ?? null, nodes: 0 };
        if (g.partitionId !== null && g.partitionId !== undefined) n.partitions.add(String(g.partitionId));
        n.nodes++;
        nets.set(g.networkName, n);
    }
    out.networks = [...nets.values()].map((n) => ({ ...n, partitions: [...n.partitions] }));
    return out;
}

function _nodeData(node, nodeId) {
    const dev = { nodeId, name: null, online: node.lifecycle?.isOnline ?? false };
    let root = null;
    for (const ep of node.endpoints) if ((ep.number ?? 0) === 0) root = ep;
    if (!root?.state) return dev;
    const bi = root.state.basicInformation;
    dev.name = bi?.nodeLabel || bi?.productName || null;
    const tnd = root.state.threadNetworkDiagnostics;
    const gd = root.state.generalDiagnostics;
    const ifs = Array.isArray(gd?.networkInterfaces) ? gd.networkInterfaces : [];
    const threadIf = ifs.find((i) => Number(i.type) === INTERFACE_THREAD);
    if (tnd) {
        const fresh = _tables.get(nodeId);
        dev.thread = {
            role: tnd.routingRole === undefined || tnd.routingRole === null ? null : Number(tnd.routingRole),
            rloc16: tnd.rloc16 === undefined || tnd.rloc16 === null ? null : Number(tnd.rloc16),
            extAddress: hex64(tnd.extAddress ?? threadIf?.hardwareAddress),
            channel: tnd.channel ?? null,
            partitionId: tnd.partitionId === undefined || tnd.partitionId === null ? null : Number(tnd.partitionId),
            leaderRouterId: tnd.leaderRouterId ?? null,
            networkName: tnd.networkName ?? null,
            neighborTable: fresh?.neighborTable ?? (Array.isArray(tnd.neighborTable) ? tnd.neighborTable : []),
            routeTable: fresh?.routeTable ?? (Array.isArray(tnd.routeTable) ? tnd.routeTable : []),
            readAt: fresh?.readAt ?? null,
        };
        return dev;
    }
    const wnd = root.state.wiFiNetworkDiagnostics;
    if (wnd) {
        dev.wifi = {
            rssi: wnd.rssi === undefined || wnd.rssi === null ? null : Number(wnd.rssi),
            bssid: wnd.bssid ? (wnd.bssid.$bytes ?? Buffer.from(wnd.bssid).toString('hex')) : null,
        };
    }
    return dev;
}

/** The graph from the cached state, the fresh tables, the border routers and the bindings. */
async function getMesh({ withBindings = true } = {}) {
    const ctrl = _ctrl();
    const nodes = [];
    for (const node of ctrl._peers?.() ?? []) {
        const addr = node.peerAddress;
        if (!addr) continue;
        nodes.push(_nodeData(node, String(addr.nodeId)));
    }
    let bindings = [];
    if (withBindings) {
        try {
            bindings = await ctrl.listBindings();
        } catch {
            /* optional */
        }
    }
    const brs = _registry().listNetworks();
    const routers = [...brs.networks.flatMap((n) => n.borderRouters), ...brs.unknown];
    const graph = buildGraph(nodes, routers, bindings);
    return { ...graph, lastRefresh: _lastRefresh, nodeCount: nodes.length };
}

/**
 * Re-read the neighbour and route tables of one node or every online Thread node (a fresh read;
 * sleepy devices answer slowly — the per-node timeout is the interaction's).
 */
async function refresh(nodeId) {
    const ctrl = _ctrl();
    const targets = [];
    for (const node of ctrl._peers?.() ?? []) {
        const addr = node.peerAddress;
        if (!addr) continue;
        const id = String(addr.nodeId);
        if (nodeId !== undefined && id !== String(nodeId)) continue;
        if (!node.lifecycle?.isOnline) continue;
        let root = null;
        for (const ep of node.endpoints) if ((ep.number ?? 0) === 0) root = ep;
        if (!root?.state?.threadNetworkDiagnostics) continue;
        targets.push({ node, id });
    }
    let ok = 0;
    for (const { node, id } of targets) {
        try {
            const neighborTable = (await ctrl._readAttribute(node, 0, 'threadNetworkDiagnostics', 'neighborTable')) ?? [];
            const routeTable = (await ctrl._readAttribute(node, 0, 'threadNetworkDiagnostics', 'routeTable')) ?? [];
            _tables.set(id, { neighborTable, routeTable, readAt: Date.now() });
            ok++;
        } catch (err) {
            _log?.debug(`matter thread: tables of node ${id} not read: ${err.message}`);
        }
    }
    _lastRefresh = Date.now();
    _log?.info(`matter thread: neighbour and route tables read from ${ok} of ${targets.length} Thread node(s)`);
    _broadcast?.({ type: 'matter:thread' });
    return getMesh();
}

function start({ log, broadcast, controller, thread } = {}) {
    _log = log ?? _log;
    _broadcast = broadcast ?? _broadcast;
    _controller = controller ?? null;
    _thread = thread ?? null;
    if (_timer) clearInterval(_timer);
    _timer = setInterval(() => refresh().catch(() => {}), REFRESH_INTERVAL_MS);
    if (typeof _timer.unref === 'function') _timer.unref();
}

function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
    _tables.clear();
    _lastRefresh = null;
}

module.exports = { buildGraph, getMesh, refresh, start, stop, hex64, lqiQuality, rssiQuality, ROLES, _tables };
