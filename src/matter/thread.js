'use strict';

/**
 * Thread networks and border routers (roadmap M15): what matter.js's `@matter/thread-br-client`
 * sees on the LAN — every `_meshcop._udp` border agent (Apple TV, HomePod, OTBRs, our ESP router)
 * with its network name, extended PAN ID, vendor and model, Thread version, state bitmap and
 * addresses — grouped by network, plus a probe of the classic OpenThread REST API (OTBR on 8081,
 * esp-thread-br on 80) per border router so a manageable one shows its role, RLOC16 and leader data.
 *
 * Read-only: nothing is written to any border router here.
 *
 * Reuse per D-14: the registry, the REST probe and client are the library's (Apache-2.0, used as a
 * dependency, nothing copied).
 */

let _log = null;
let _broadcast = null;
let _registry = null;
let _env = null;
/** extAddressHex → { capability, node, probedAt, error, port } */
const _probes = new Map();
const PROBE_TTL_MS = 10 * 60 * 1000;
const PROBE_PORTS = [8081, 80];

// ── The border agent state bitmap (Thread MeshCoP, `_meshcop` TXT "sb", 4 bytes big-endian) ──

const CONNECTION_MODES = ['not allowed', 'PSKc', 'PSKd', 'vendor', 'X.509'];
const IF_STATUS = ['not initialised', 'initialised, not active', 'active'];
const AVAILABILITY = ['infrequent', 'high'];
const ROLES = ['disabled or detached', 'child', 'router', 'leader'];

/**
 * Decode the state bitmap: connection mode (bits 0–2), Thread interface status (3–4),
 * availability (5–6), BBR active (7), BBR primary (8), Thread role (9–10), ePSKc supported (11).
 * @param {string|undefined} hex
 */
function decodeStateBitmap(hex) {
    if (!hex || !/^[0-9a-fA-F]{1,8}$/.test(hex)) return null;
    const v = parseInt(hex, 16);
    return {
        connectionMode: CONNECTION_MODES[v & 0x7] ?? `mode ${v & 0x7}`,
        interfaceStatus: IF_STATUS[(v >> 3) & 0x3] ?? `status ${(v >> 3) & 0x3}`,
        availability: AVAILABILITY[(v >> 5) & 0x3] ?? `availability ${(v >> 5) & 0x3}`,
        bbrActive: !!(v & (1 << 7)),
        bbrPrimary: !!(v & (1 << 8)),
        role: ROLES[(v >> 9) & 0x3] ?? `role ${(v >> 9) & 0x3}`,
        epskcSupported: !!(v & (1 << 11)),
        threadActive: ((v >> 3) & 0x3) === 2,
    };
}

function _entryView(e) {
    const probe = _probes.get(e.extAddressHex) ?? null;
    return {
        extAddress: e.extAddressHex,
        extPanId: e.extendedPanIdHex ?? null,
        networkName: e.networkName ?? null,
        vendorName: e.vendorName ?? null,
        modelName: e.modelName ?? null,
        hostname: e.hostname ?? null,
        addresses: e.addresses ?? [],
        meshcopPort: e.meshcopPort ?? null,
        trelPort: e.trelPort ?? null,
        threadVersion: e.threadVersion ?? null,
        swVersion: e.swVersion ?? null,
        borderAgentId: e.borderAgentIdHex ?? null,
        partitionId: e.partitionIdHex ?? null,
        activeTimestamp: e.activeTimestampHex ?? null,
        domainName: e.domainName ?? null,
        state: decodeStateBitmap(e.stateBitmapHex),
        sources: e.sources ?? [],
        lastSeen: e.lastSeen ?? null,
        rest: probe
            ? {
                  manageable: !!probe.capability,
                  port: probe.port ?? null,
                  baseUrl: probe.capability?.baseUrl ?? null,
                  diagnosticsApi: probe.capability?.diagnosticsApi ?? null,
                  node: probe.node ?? null,
                  probedAt: probe.probedAt,
                  error: probe.error ?? null,
              }
            : null,
    };
}

/**
 * The networks on the LAN, grouped by extended PAN ID, each with its border routers; border
 * routers that name no PAN ID go into `unknown`.
 * @param {object[]} [entries]  the registry's entries (for tests)
 */
function listNetworks(entries) {
    const list = entries ?? (_registry ? _registry.list() : []);
    const byPan = new Map();
    const unknown = [];
    for (const e of list) {
        const view = _entryView(e);
        if (!view.extPanId) {
            unknown.push(view);
            continue;
        }
        let net = byPan.get(view.extPanId);
        if (!net) {
            net = { extPanId: view.extPanId, networkName: view.networkName, borderRouters: [], partitions: new Set(), datasetKnown: false };
            byPan.set(view.extPanId, net);
        }
        if (!net.networkName && view.networkName) net.networkName = view.networkName;
        if (view.partitionId) net.partitions.add(view.partitionId);
        net.borderRouters.push(view);
    }
    const networks = [...byPan.values()].map((n) => ({
        ...n,
        partitions: [...n.partitions],
        routerCount: n.borderRouters.length,
        borderRouters: n.borderRouters.sort((a, b) => (a.vendorName ?? '').localeCompare(b.vendorName ?? '') || a.extAddress.localeCompare(b.extAddress)),
    }));
    networks.sort((a, b) => (a.networkName ?? '').localeCompare(b.networkName ?? ''));
    return { running: !!_registry, networks, unknown };
}

function _ipForProbe(e) {
    // prefer IPv4, then a global IPv6, then anything (a link-local needs a scope we do not have)
    const addrs = e.addresses ?? [];
    return addrs.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? addrs.find((a) => a.includes(':') && !/^fe80:/i.test(a)) ?? addrs[0] ?? null;
}

/**
 * Probe a border router's classic REST API (OTBR: 8081, esp-thread-br: 80) and, when found, read
 * its node info. Cached for ten minutes; `force` probes again.
 */
async function probeRouter(extAddressHex, { force = false } = {}) {
    const e = _registry?.get(extAddressHex);
    if (!e) throw new Error(`border router not found: ${extAddressHex}`);
    const cached = _probes.get(extAddressHex);
    if (cached && !force && Date.now() - cached.probedAt < PROBE_TTL_MS) return _entryView(e);
    const { OtbrRestProbe, OtbrRestClient } = require('@matter/thread-br-client');
    const host = _ipForProbe(e);
    const result = { capability: null, node: null, probedAt: Date.now(), error: null, port: null };
    if (!host) {
        result.error = 'no address';
    } else {
        for (const port of PROBE_PORTS) {
            try {
                const cap = await OtbrRestProbe.probe(host, port, 1500);
                if (!cap) continue;
                result.capability = cap;
                result.port = port;
                try {
                    const client = new OtbrRestClient({ host, port });
                    const node = await client.getNode();
                    result.node = {
                        state: node.state ?? null,
                        role: node.state ?? null,
                        rloc16: node.rloc16 === undefined ? null : Number(node.rloc16),
                        rlocAddress: node.rlocAddress ?? null,
                        numOfRouter: node.numOfRouter ?? null,
                        networkName: node.networkName ?? null,
                        extAddress: node.extAddress ? Buffer.from(node.extAddress).toString('hex').toUpperCase() : null,
                        extPanId: node.extPanId ? Buffer.from(node.extPanId).toString('hex').toUpperCase() : null,
                        leaderData: node.leaderData ?? null,
                    };
                } catch (err) {
                    result.error = `node info: ${err.message}`;
                }
                break;
            } catch (err) {
                result.error = err.message;
            }
        }
    }
    _probes.set(extAddressHex, result);
    _log?.debug(
        `matter thread: ${e.vendorName ?? ''} ${e.modelName ?? ''} ${extAddressHex} REST ${result.capability ? 'found on ' + result.port : 'not found'}${result.error ? ' (' + result.error + ')' : ''}`,
    );
    _broadcast?.({ type: 'matter:thread' });
    return _entryView(e);
}

let _probeQueue = Promise.resolve();
function _scheduleProbe(e) {
    _probeQueue = _probeQueue.then(() => probeRouter(e.extAddressHex).catch(() => {}));
}

/**
 * Start the passive mDNS discovery on the controller's environment.
 * @param {object} env  the matter.js Environment (shares the controller's mDNS)
 */
async function start(env, { log, broadcast } = {}) {
    _log = log ?? _log;
    _broadcast = broadcast ?? _broadcast;
    _env = env;
    if (_registry) return;
    const { BorderRouterRegistry } = require('@matter/thread-br-client');
    const registry = new BorderRouterRegistry(env);
    registry.events.added.on((e) => {
        _log?.info(`matter thread: border router ${e.vendorName ?? '?'} ${e.modelName ?? ''} (${e.networkName ?? 'network ?'}, ${e.extAddressHex})`);
        _broadcast?.({ type: 'matter:thread' });
        _scheduleProbe(e);
    });
    registry.events.updated.on(() => _broadcast?.({ type: 'matter:thread' }));
    registry.events.removed.on((e) => {
        _probes.delete(e.extAddressHex);
        _log?.info(`matter thread: border router ${e.extAddressHex} gone`);
        _broadcast?.({ type: 'matter:thread' });
    });
    await registry.start();
    _registry = registry;
    _log?.info('matter thread: border router discovery started');
}

async function stop() {
    const r = _registry;
    _registry = null;
    _probes.clear();
    if (r) {
        try {
            await r.stop();
        } catch {
            /* stopping */
        }
    }
}

/** Probe every border router again (the refresh button). */
async function refresh() {
    if (!_registry) throw new Error('Thread discovery is not running');
    for (const e of _registry.list()) await probeRouter(e.extAddressHex, { force: true }).catch(() => {});
    return listNetworks();
}

function isRunning() {
    return !!_registry;
}

/** Test hook. */
function _inject({ registry } = {}) {
    _registry = registry ?? null;
    _probes.clear();
}

module.exports = { start, stop, refresh, listNetworks, probeRouter, decodeStateBitmap, isRunning, _inject, _probes, _env: () => _env };
