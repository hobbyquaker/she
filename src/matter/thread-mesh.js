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
/** an IPv6 address from 16 bytes (a Uint8Array or `{ $bytes }`) in the usual short form */
function _ipv6(v) {
    const buf = v?.$bytes ? Buffer.from(v.$bytes, 'hex') : ArrayBuffer.isView(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : null;
    if (!buf || buf.length !== 16) return null;
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(buf.readUInt16BE(i).toString(16));
    // the longest run of two or more zero groups becomes "::"
    let best = { at: -1, len: 0 };
    for (let i = 0; i < 8; ) {
        if (groups[i] !== '0') {
            i++;
            continue;
        }
        let j = i;
        while (j < 8 && groups[j] === '0') j++;
        if (j - i > best.len && j - i > 1) best = { at: i, len: j - i };
        i = j;
    }
    if (best.at < 0) return groups.join(':');
    return `${groups.slice(0, best.at).join(':')}::${groups.slice(best.at + best.len).join(':')}`;
}

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
function buildGraph(nodes, borderRouters = [], bindings = [], meshcop = []) {
    const out = { nodes: [], links: [], networks: [], hidden: { wifi: 0, other: 0 }, meshcop: { nodes: 0, networks: [] } };
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
                extPanId: n.thread.extPanId ?? null,
                ipv6: n.thread.ipv6 ?? [],
                neighbours: (n.thread.neighborTable ?? []).length,
                routes: (n.thread.routeTable ?? []).length,
                readAt: n.thread.readAt ?? null,
            };
            out.nodes.push(g);
            byNodeId.set(n.nodeId, g);
            if (g.extAddress) byExt.set(g.extAddress, g);
            if (g.rloc16 !== null) byRloc.set(g.rloc16, g);
        } else {
            // Wi-Fi, Ethernet and devices without diagnostics (offline, bridges) are not part of a Thread
            // mesh: counted for the caption, not drawn
            out.hidden[n.wifi ? 'wifi' : 'other']++;
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
            partitionId: br.partitionId ?? null,
            addresses: br.addresses ?? [],
            hostname: br.hostname ?? null,
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
                        networkName: from.networkName ?? null,
                        extPanId: from.extPanId ?? null,
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
    // what a border router told us through MeshCoP (M17's dataset): nodes the fabric does not know, and
    // their links — the mesh from the router's side, non-Matter nodes included
    for (const m of meshcop) {
        const ext = m.extAddress ? m.extAddress.toUpperCase() : null;
        let g = (ext && byExt.get(ext)) || (m.rloc16 !== null && m.rloc16 !== undefined && byRloc.get(Number(m.rloc16))) || null;
        if (g) {
            if (g.kind === 'external') {
                g.kind = 'meshcop';
                g.name = m.vendorName || m.vendorModel ? `${m.vendorName ?? ''} ${m.vendorModel ?? ''}`.trim() : g.name;
                g.explanation = 'Seen through the border router (MeshCoP): a node of this network that is not paired with she.';
            }
            if (g.role === undefined || g.role === null || g.kind === 'border-router') g.role = m.role ?? g.role ?? null;
            if (g.rloc16 === null || g.rloc16 === undefined) g.rloc16 = m.rloc16 ?? null;
            g.meshcop = { vendorName: m.vendorName ?? null, vendorModel: m.vendorModel ?? null, version: m.version ?? null, children: (m.children ?? []).length };
        } else {
            g = {
                id: `mc:${ext ?? m.rloc16}`,
                kind: 'meshcop',
                name:
                    m.vendorName || m.vendorModel
                        ? `${m.vendorName ?? ''} ${m.vendorModel ?? ''}`.trim()
                        : ext
                          ? `node ${ext.slice(-4)}`
                          : `node 0x${Number(m.rloc16).toString(16)}`,
                extAddress: ext,
                rloc16: m.rloc16 ?? null,
                role: m.role ?? null,
                online: true,
                networkName: m.networkName ?? null,
                explanation: 'Seen through the border router (MeshCoP): a node of this network that is not paired with she.',
                meshcop: { vendorName: m.vendorName ?? null, vendorModel: m.vendorModel ?? null, version: m.version ?? null, children: (m.children ?? []).length },
            };
            out.nodes.push(g);
            if (ext) byExt.set(ext, g);
            if (g.rloc16 !== null) byRloc.set(g.rloc16, g);
        }
        out.meshcop.nodes++;
    }
    for (const m of meshcop) {
        const ext = m.extAddress ? m.extAddress.toUpperCase() : null;
        const from = (ext && byExt.get(ext)) || (m.rloc16 !== null && m.rloc16 !== undefined && byRloc.get(Number(m.rloc16))) || null;
        if (!from) continue;
        for (const nb of m.neighbours ?? []) {
            const nbExt = nb.extAddress ? nb.extAddress.toUpperCase() : null;
            const to = (nbExt && byExt.get(nbExt)) || (nb.rloc16 !== null && nb.rloc16 !== undefined && byRloc.get(Number(nb.rloc16))) || null;
            if (!to || to === from) continue;
            const key = linkKey(from.id, to.id);
            if (links.has(key)) continue;
            const lqi = nb.lqi ?? (nb.linkMargin !== undefined ? (nb.linkMargin > 20 ? 3 : nb.linkMargin > 10 ? 2 : 1) : 0);
            links.set(key, {
                kind: 'neighbour',
                source: from.id,
                target: to.id,
                lqi,
                lqiBack: null,
                rssi: nb.averageRssi ?? null,
                isChild: !!nb.isChild,
                bidirectional: false,
                quality: lqiQuality(lqi),
                via: 'meshcop',
            });
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
    // the Thread networks: every drawn node belongs to one (by extended PAN ID, else by name), so the graph
    // can group them — border routers of the same network included, whether in she's fabric or not
    const nets = new Map();
    for (const g of out.nodes) {
        if (!g.extPanId && g.networkName) {
            const byName = out.nodes.find((x) => x.extPanId && x.networkName === g.networkName);
            if (byName) g.extPanId = byName.extPanId;
        }
        const key = g.extPanId || (g.networkName ? `name:${g.networkName}` : null);
        if (!key) continue;
        g.network = key;
        const n = nets.get(key) ?? { key, extPanId: g.extPanId ?? null, networkName: g.networkName ?? null, partitions: new Set(), channel: null, nodes: 0, borderRouters: 0 };
        if (!n.networkName && g.networkName) n.networkName = g.networkName;
        if (g.partitionId !== null && g.partitionId !== undefined) n.partitions.add(String(g.partitionId));
        if (n.channel === null && g.channel !== null && g.channel !== undefined) n.channel = g.channel;
        n.nodes++;
        if (g.kind === 'border-router' || g.borderRouter) n.borderRouters++;
        nets.set(key, n);
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
            extPanId: hex64(tnd.extendedPanId),
            ipv6: (threadIf?.iPv6Addresses ?? []).map(_ipv6).filter(Boolean),
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

// ── MeshCoP through a border router (M17's dataset, opt-in per network) ────────

/** extPanId → { nodes, readAt, error } */
const _meshcop = new Map();
const MESHCOP_WINDOW_MS = 12000;

function _datasets() {
    return require('./thread-datasets');
}

/**
 * Ask the network's nodes for their diagnostics through a border router, as the network's
 * commissioner (CoAP over DTLS with the PSKc) — only for networks whose dataset is known and whose
 * MeshCoP switch is on. One commissioner per network at a time: the petition fails when another
 * app holds it. Returns the nodes seen.
 */
async function meshcopQuery(extPanId, { entry } = {}) {
    const creds = _datasets().credentialsFor(extPanId);
    if (!creds) throw new Error('MeshCoP is off for this network, or its dataset has no PSKc');
    const reg = _registry();
    const nets = reg.listNetworks();
    const net = nets.networks.find((n) => n.extPanId.toUpperCase() === String(extPanId).toUpperCase());
    if (!net) throw new Error('no border router of this network is on the LAN');
    const brs = net.borderRouters.filter((b) => b.meshcopPort && b.addresses.some((a) => !/^fe80:/i.test(a)));
    if (!brs.length) throw new Error('no border router of this network announces a MeshCoP port with a routable address');
    const br = entry ?? brs[0];
    const raw = reg._registryEntry ? reg._registryEntry(br.extAddress) : null;
    const { connectMeshcop, DefaultTlvSet } = require('@matter/thread-br-client');
    const env = reg._env ? reg._env() : null;
    const brEntry = raw ?? {
        extAddressHex: br.extAddress,
        addresses: br.addresses,
        meshcopPort: br.meshcopPort,
        networkName: br.networkName,
        extendedPanIdHex: br.extPanId,
        sources: ['meshcop'],
        lastSeen: Date.now(),
    };
    const handle = await connectMeshcop({ creds, br: brEntry, environment: env });
    const seen = [];
    try {
        const q = handle.source.queryMulticast('ff03::2', { tlvTypes: [...DefaultTlvSet], windowMs: MESHCOP_WINDOW_MS });
        q.onNode.on((r) => seen.push(_meshcopNode(r)));
        q.onError.on((err) => _log?.debug(`matter thread: MeshCoP: ${err.message}`));
        await q.done;
    } finally {
        await handle.close().catch(() => {});
    }
    _meshcop.set(String(extPanId).toUpperCase(), { nodes: seen, readAt: Date.now(), error: null, via: br.extAddress });
    _log?.info(`matter thread: MeshCoP through ${br.vendorName ?? br.extAddress}: ${seen.length} node(s) answered`);
    _broadcast?.({ type: 'matter:thread' });
    return seen;
}

function _meshcopNode(r) {
    const rloc16 = r.rloc16 === undefined ? null : Number(r.rloc16);
    const isRouter = rloc16 !== null && (rloc16 & 0x3ff) === 0;
    const leader = r.leaderData && rloc16 !== null && r.leaderData.leaderRouterId === rloc16 >> 10;
    const role = leader ? 'leader' : isRouter ? 'router' : r.mode ? (r.mode.rxOnWhenIdle ? 'end device' : 'sleepy end device') : null;
    const neighbours = [];
    for (const n of r.routerNeighbors ?? [])
        neighbours.push({ extAddress: hex64(n.extAddress), rloc16: n.rloc16, averageRssi: n.averageRssi ?? null, linkMargin: n.linkMargin ?? null });
    for (const c of r.childTable ?? []) {
        if (rloc16 === null) continue;
        neighbours.push({ rloc16: (rloc16 & 0xfc00) | Number(c.childId), lqi: Number(c.incomingLinkQuality ?? 0), isChild: true, timeout: c.timeoutSeconds ?? null });
    }
    return {
        extAddress: hex64(r.extMacAddress),
        rloc16,
        role,
        vendorName: r.vendorName ?? null,
        vendorModel: r.vendorModel ?? null,
        version: r.vendorSwVersion ?? r.threadStackVersion ?? null,
        batteryLevel: r.batteryLevel ?? null,
        children: (r.childTable ?? []).map((c) => Number(c.childId)),
        neighbours,
    };
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
    const meshcopNodes = [];
    const meshcopNets = [];
    for (const [extPanId, m] of _meshcop) {
        meshcopNodes.push(...m.nodes.map((n) => ({ ...n, networkName: brs.networks.find((x) => x.extPanId === extPanId)?.networkName ?? null })));
        meshcopNets.push({ extPanId, nodes: m.nodes.length, readAt: m.readAt, via: m.via, error: m.error });
    }
    const graph = buildGraph(nodes, routers, bindings, meshcopNodes);
    graph.meshcop.networks = meshcopNets;
    graph.meshcop.enabled = brs.networks.filter((n) => n.datasetKnown && _datasets().credentialsFor(n.extPanId)).map((n) => n.extPanId);
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
    // the networks with MeshCoP on: ask through their border router too
    try {
        for (const n of _registry().listNetworks().networks) {
            if (!n.datasetKnown || !_datasets().credentialsFor(n.extPanId)) continue;
            await meshcopQuery(n.extPanId).catch((err) => {
                _meshcop.set(n.extPanId.toUpperCase(), {
                    nodes: _meshcop.get(n.extPanId.toUpperCase())?.nodes ?? [],
                    readAt: _meshcop.get(n.extPanId.toUpperCase())?.readAt ?? null,
                    error: err.message,
                    via: null,
                });
                _log?.warn(`matter thread: MeshCoP query of ${n.networkName ?? n.extPanId} failed: ${err.message}`);
            });
        }
    } catch {
        /* the registry is optional */
    }
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
    _meshcop.clear();
    _lastRefresh = null;
}

module.exports = { _ipv6, buildGraph, getMesh, refresh, meshcopQuery, start, stop, hex64, lqiQuality, rssiQuality, ROLES, _tables, _meshcop, _meshcopNode };
