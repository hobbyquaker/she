'use strict';

/**
 * Matter controller — wraps @matter/main ServerNode + Peers API.
 *
 * Call init() once at daemon startup (only when --matter-storage is set).
 * Call close() on daemon shutdown.
 *
 * All nodeIds are exposed as decimal strings (BigInt serialization boundary).
 */

const { Environment, ServerNode, ControllerBehavior, Logger, LogLevel, LogFormat } = require('@matter/main');

// Upper bound for a commissioning attempt — matter.js has internal retries that
// can keep an HTTP request (and the pairing wizard) hanging for a very long time.
const COMMISSION_TIMEOUT_MS = 120000;

/** @type {import('@matter/main').ServerNode | null} */
let _server = null;
let _log = null;
/** @type {((msg: object) => void) | null} */
let _broadcast = null;

// ── Attribute / event listeners registered by sandbox scripts ───────────────
// Map<scriptFile, Map<listenerId, { cancel: () => void }>>
const _listeners = new Map();
let _nextListenerId = 1;

// ── WS attribute broadcast ───────────────────────────────────────────────────
// Tracks nodeIds that already have global attribute broadcast listeners set up
// so we never attach them more than once per node object.
const _attrBroadcastNodes = new Set();

// ── Helpers ──────────────────────────────────────────────────────────────────

function _bigintNodeId(nodeId) {
    return BigInt(nodeId);
}

function _nodeIdStr(nodeId) {
    return nodeId.toString();
}

function _findClientNode(nodeIdOrName) {
    nodeIdOrName = String(nodeIdOrName);
    if (!_server) throw new Error('Matter controller not started');
    // Try exact numeric nodeId match first
    for (const node of _server.peers) {
        const addr = node.peerAddress;
        if (addr && _nodeIdStr(addr.nodeId) === nodeIdOrName) return node;
    }
    // Fall back to name match (basicInformation.nodeLabel / productName)
    for (const node of _server.peers) {
        if (!node.peerAddress) continue;
        if (_getDeviceName(node) === nodeIdOrName) return node;
    }
    throw new Error(`Matter node not found: ${nodeIdOrName}`);
}

/**
 * Resolve an endpoint by numeric id or by name.
 * @param {object} node ClientNode
 * @param {number|string} endpointIdOrName
 * @returns endpoint object
 */
function _resolveEndpoint(node, endpointIdOrName) {
    const asNum = Number(endpointIdOrName);
    if (Number.isFinite(asNum)) return node.endpoints.for(asNum);
    // Name-based lookup
    const name = String(endpointIdOrName);
    for (const ep of node.endpoints) {
        if (_getEndpointName(ep) === name) return ep;
    }
    throw new Error(`Endpoint not found: ${endpointIdOrName}`);
}

/** Recursively convert BigInt values to numbers/strings so the result is JSON-serialisable. */
function _jsonSafe(v) {
    if (typeof v === 'bigint') return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
    if (Array.isArray(v)) return v.map(_jsonSafe);
    if (v !== null && typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v)) out[k] = _jsonSafe(val);
        return out;
    }
    return v;
}

/** Resolve a cluster name (camelCase) from a cluster ID number or string. */
function _clusterName(clusterId) {
    // matter.js cluster state keys are camelCase cluster names.
    // For generic access we accept either the camelCase name directly or skip resolution.
    // The caller must pass the camelCase cluster name (e.g. "onOff", "levelControl").
    return clusterId;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Initialise the Matter controller.
 * Must be called before any other method.
 *
 * @param {string} storagePath  Absolute path to the matter storage directory (~/.she/matter)
 * @param {{ info: Function, warn: Function, error: Function }} log  Daemon logger
 * @param {((msg: object) => void) | null} [broadcastFn]  WebSocket broadcast function from log-ws.js
 */
async function init(storagePath, log, broadcastFn) {
    _broadcast = broadcastFn ?? null;
    if (_server) throw new Error('Matter controller already started');
    _log = log;

    // Route matter.js's own diagnostics into the daemon logger so commissioning
    // problems (discovery, PASE failures, retries) are visible in the Logs tab —
    // by default matter.js writes straight to stdout, bypassing she's logging.
    Logger.format = LogFormat.PLAIN;
    Logger.level = LogLevel.INFO;
    Logger.destinations.default.write = (text, message) => {
        if (message.level >= LogLevel.ERROR) _log.error('matter.js:', text);
        else if (message.level === LogLevel.WARN) _log.warn('matter.js:', text);
        else _log.debug('matter.js:', text);
    };

    // Configure storage before anything else touches StorageService
    Environment.default.vars.set('storage.path', storagePath);

    // Disable matter.js built-in CLI arg and env-var parsing so it doesn't
    // interfere with the daemon's own yargs config.
    // Wrapped in try/catch because the internal variable layout changed in some
    // @matter/main versions and throws when 'environment' is not a map segment.
    try {
        Environment.default.vars.set('environment.disableInteraction', true);
    } catch {
        // Non-fatal: the daemon has no interactive terminal anyway.
    }

    _server = await ServerNode.create({
        id: 'she-matter-controller',
    });

    await _server.start();
    _log.info('matter controller started, storage:', storagePath);

    // Subscribe lifecycle events for already-paired nodes (persisted from previous session).
    for (const node of _server.peers) {
        const addr = node.peerAddress;
        if (!addr) continue;
        const nodeId = _nodeIdStr(addr.nodeId);
        _subscribeNodeLifecycle(node, nodeId);
        if (node.lifecycle?.isOnline) _broadcastNodeAttributes(node, nodeId);
    }
}

async function close() {
    if (!_server) return;
    try {
        await _server.close();
    } catch (err) {
        _log?.error('matter controller close error:', err.message);
    } finally {
        _server = null;
    }
}

// ── Device management ─────────────────────────────────────────────────────────

/**
 * Extract a human-readable name for a node from its root endpoint's basicInformation cluster.
 * Returns null when the cluster is unavailable or the node is offline.
 * @param {object} node ClientNode
 * @returns {string|null}
 */
function _getDeviceName(node) {
    try {
        for (const ep of node.endpoints) {
            if ((ep.number ?? 0) !== 0) continue;
            const bi = ep.state?.basicInformation;
            if (bi?.nodeLabel) return bi.nodeLabel;
            if (bi?.productName) return bi.productName;
        }
    } catch {
        /* node may be offline */
    }
    return null;
}

/**
 * Extract a human-readable name for a single endpoint.
 * Prefers bridgedDeviceBasicInformation.nodeLabel for bridged devices,
 * falls back to basicInformation for the root endpoint.
 * @param {object} endpoint
 * @returns {string|null}
 */
function _getEndpointName(endpoint) {
    try {
        const state = endpoint.state;
        if (!state) return null;
        const bridgedBi = state.bridgedDeviceBasicInformation;
        if (bridgedBi?.nodeLabel) return bridgedBi.nodeLabel;
        const bi = state.basicInformation;
        if (bi?.nodeLabel) return bi.nodeLabel;
        if (bi?.productName) return bi.productName;
    } catch {
        /* best-effort */
    }
    return null;
}

/**
 * Extract vendor + product subtitle for the root endpoint (endpoint 0).
 * Returns null when unavailable.
 * @param {object} node
 * @returns {string|null}
 */
function _getDeviceSubtitle(node) {
    try {
        for (const ep of node.endpoints) {
            if ((ep.number ?? 0) !== 0) continue;
            const bi = ep.state?.basicInformation;
            const parts = [];
            if (bi?.vendorName) parts.push(bi.vendorName);
            if (bi?.productName && bi.productName !== _getDeviceName(node)) parts.push(bi.productName);
            return parts.length ? parts.join(' · ') : null;
        }
    } catch {
        /* offline */
    }
    return null;
}

/**
 * List all paired nodes.
 * @returns {{ nodeId: string, online: boolean, name: string|null }[]}
 */
function listPaired() {
    if (!_server) return [];
    const result = [];
    for (const node of _server.peers) {
        const addr = node.peerAddress;
        if (!addr) continue; // not commissioned yet (in discovery)
        result.push({
            nodeId: _nodeIdStr(addr.nodeId),
            online: node.lifecycle?.isOnline ?? false,
            name: _getDeviceName(node),
        });
    }
    return result;
}

/**
 * Commission a new device.
 *
 * @param {{ passcode: number, discriminator?: number, discoveryAddress?: string } | { pairingCode: string, discoveryAddress?: string }} options
 *   discoveryAddress: optional "ip" or "ip:port" to bypass mDNS discovery and connect directly.
 * @returns {Promise<string>}  nodeId of the newly commissioned device
 */
async function commission(options) {
    if (!_server) throw new Error('Matter controller not started');

    // Accept QR-code payloads ("MT:...") — matter.js's pairingCode option only
    // decodes 11/21-digit manual pairing codes, so decode QR payloads here.
    if (typeof options.pairingCode === 'string' && options.pairingCode.trim().toUpperCase().startsWith('MT:')) {
        const { QrPairingCodeCodec } = require('@matter/types');
        const [decoded] = QrPairingCodeCodec.decode(options.pairingCode.trim());
        const { pairingCode: _pc, ...rest } = options;
        options = { ...rest, passcode: decoded.passcode, discriminator: decoded.discriminator };
        _log.debug('matter: decoded QR pairing code, discriminator', decoded.discriminator);
    }

    const label = options.pairingCode !== undefined ? 'pairing code' : `passcode${options.discriminator !== undefined ? ' + discriminator ' + options.discriminator : ''}`;
    _log.info(`matter: commissioning start (${label}${options.discoveryAddress ? ', direct address ' + options.discoveryAddress : ''})`);
    let timer;
    try {
        const nodeId = await Promise.race([
            _commissionInner(options),
            new Promise((_resolve, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(`commissioning timed out after ${COMMISSION_TIMEOUT_MS / 1000} s — check that the pairing window is still open and the device is reachable`),
                        ),
                    COMMISSION_TIMEOUT_MS,
                );
            }),
        ]);
        _log.info('matter: commissioning succeeded, nodeId', nodeId);
        return nodeId;
    } catch (err) {
        _log.error('matter: commissioning failed:', err.message);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function _commissionInner(options) {
    const { discoveryAddress, ...commissionOpts } = options;
    let clientNode;
    if (discoveryAddress) {
        const colonIdx = discoveryAddress.lastIndexOf(':');
        let ip, port;
        if (colonIdx > 0 && !discoveryAddress.startsWith('[') && colonIdx !== discoveryAddress.indexOf(':')) {
            // IPv6 without brackets — treat whole string as IP, use default port
            ip = discoveryAddress;
            port = 5540;
        } else if (colonIdx > 0) {
            const maybePort = parseInt(discoveryAddress.slice(colonIdx + 1), 10);
            if (Number.isFinite(maybePort)) {
                ip = discoveryAddress.slice(0, colonIdx).replace(/^\[|\]$/g, '');
                port = maybePort;
            } else {
                ip = discoveryAddress;
                port = 5540;
            }
        } else {
            ip = discoveryAddress;
            port = 5540;
        }
        _log.info(`matter: using direct discovery address ${ip}:${port} (bypassing mDNS)`);
        _server.behaviors.require(ControllerBehavior);
        clientNode = await _server.peers.forDescriptor({ addresses: [{ type: 'udp', ip, port }] });
        await clientNode.commission(commissionOpts);
    } else {
        clientNode = await _server.peers.commission(commissionOpts);
    }
    const addr = clientNode.peerAddress;
    if (!addr) throw new Error('Commission succeeded but node has no peerAddress');
    const nodeId = _nodeIdStr(addr.nodeId);
    _subscribeNodeLifecycle(clientNode, nodeId);
    // A freshly commissioned node is already online, so the lifecycle 'online'
    // event (the other place this is wired) will not fire again — attach the
    // attribute watchers now or the node stays without live updates until the
    // next daemon restart.
    _broadcastNodeAttributes(clientNode, nodeId);
    _broadcast?.({ type: 'matter:deviceList', devices: listPaired() });
    return nodeId;
}

/**
 * Decommission and locally delete a paired node.
 * Tries graceful decommission first; falls back to force-delete.
 *
 * @param {string} nodeId
 */
async function unpair(nodeId) {
    const node = _findClientNode(nodeId);
    try {
        await node.decommission();
    } catch (err) {
        _log?.warn(`matter: decommission of ${nodeId} failed (${err.message}), force-deleting`);
        await node.delete();
    }
    _broadcast?.({ type: 'matter:deviceList', devices: listPaired() });
}

/**
 * Return the endpoint structure of a paired node.
 * Each endpoint entry carries the list of available cluster names.
 *
 * @param {string} nodeId
 * @returns {{ endpointId: number, clusters: string[], name: string|null }[]}
 */
function getEndpoints(nodeId) {
    const node = _findClientNode(nodeId);
    const result = [];
    for (const endpoint of node.endpoints) {
        const clusters = [];
        if (endpoint.state) {
            for (const [clusterName, clusterState] of Object.entries(endpoint.state)) {
                const attrs = {};
                if (clusterState && typeof clusterState === 'object') {
                    for (const [k, v] of Object.entries(clusterState)) {
                        attrs[k] = _jsonSafe(v);
                    }
                }
                clusters.push({ name: clusterName, attrs });
            }
        }
        result.push({ endpointId: endpoint.number ?? 0, clusters, name: _getEndpointName(endpoint) });
    }
    return result;
}

// ── Attribute access ──────────────────────────────────────────────────────────

/**
 * Read a single attribute value.
 *
 * @param {string}          nodeId
 * @param {number}          endpointId
 * @param {string}          clusterName  camelCase cluster name, e.g. "onOff"
 * @param {string}          attrName     camelCase attribute name, e.g. "onOff"
 * @returns {Promise<unknown>}
 */
async function getAttribute(nodeId, endpointId, clusterName, attrName) {
    const node = _findClientNode(nodeId);
    const endpoint = _resolveEndpoint(node, endpointId);
    const clusterState = endpoint.state?.[_clusterName(clusterName)];
    if (!clusterState) throw new Error(`Cluster "${clusterName}" not found on endpoint ${endpointId}`);
    return clusterState[attrName];
}

/**
 * Write a single attribute value (a remote write for client nodes — the
 * attribute must be writable per the device's Matter data model).
 *
 * @param {string}  nodeId
 * @param {number}  endpointId
 * @param {string}  clusterName  camelCase cluster name, e.g. "basicInformation"
 * @param {string}  attrName     camelCase attribute name, e.g. "nodeLabel"
 * @param {*}       value
 * @returns {Promise<void>}
 */
async function setAttribute(nodeId, endpointId, clusterName, attrName, value) {
    const node = _findClientNode(nodeId);
    const endpoint = _resolveEndpoint(node, endpointId);
    await endpoint.set({ [_clusterName(clusterName)]: { [attrName]: value } });
}

/**
 * Rename a device by writing basicInformation.nodeLabel on the root endpoint —
 * the Matter-standard writable user label (max 32 chars), persisted on the
 * device itself. she prefers nodeLabel over productName wherever names are
 * shown or matched, so the new name is immediately usable in scripts.
 *
 * @param {string} nodeId
 * @param {string} name
 * @returns {Promise<void>}
 */
async function rename(nodeId, name) {
    await setAttribute(nodeId, 0, 'basicInformation', 'nodeLabel', String(name));
    _log?.info(`matter: renamed node ${nodeId} to "${name}"`);
    _broadcast?.({ type: 'matter:deviceList', devices: listPaired() });
}

// ── Commands ──────────────────────────────────────────────────────────────────

/**
 * Best-effort: list the mandatory field names (camelCase) of a command's
 * request schema. Handles both shapes matter.js uses: a TLV ObjectSchema
 * (fieldDefinitions, camelCase keys) and a CommandModel (children with
 * PascalCase names and conformance flags). Returns [] when unresolvable.
 * @param {object} cluster      the behavior's cluster definition
 * @param {string} commandName
 * @returns {string[]}
 */
function _mandatoryCommandFields(cluster, commandName) {
    try {
        const cmd = cluster?.commands?.[commandName];
        const schema = cmd?.schema ?? cmd?.requestSchema;
        if (schema?.fieldDefinitions) {
            return Object.entries(schema.fieldDefinitions)
                .filter(([, def]) => !def?.optional)
                .map(([name]) => name);
        }
        if (schema?.children) {
            return [...schema.children].filter((c) => c.effectiveConformance?.isMandatory !== false).map((c) => c.name.charAt(0).toLowerCase() + c.name.slice(1));
        }
    } catch {
        /* best-effort — fall through */
    }
    return [];
}

/**
 * Invoke a cluster command.
 *
 * Mandatory boilerplate fields that scripts rarely care about are filled with
 * neutral defaults when omitted: optionsMask/optionsOverride → {} (bitmap 0,
 * "obey the device's options") and transitionTime → 0 (instant). So
 * she.matter.send('x', 1, 'levelControl', 'moveToLevel', { level: 128 }) works
 * without spelling out the full Matter command schema.
 *
 * @param {string}  nodeId
 * @param {number}  endpointId
 * @param {string}  clusterName  camelCase cluster name, e.g. "onOff"
 * @param {string}  commandName  camelCase command name, e.g. "on"
 * @param {object}  [args={}]
 * @returns {Promise<unknown>}
 */
async function sendCommand(nodeId, endpointId, clusterName, commandName, args) {
    const node = _findClientNode(nodeId);
    // Use the target endpoint's own act() instead of navigating via agent.parts,
    // because Parts in @matter/node is a set-like iterable, not a Map (.get doesn't exist).
    const endpoint = _resolveEndpoint(node, endpointId);
    return endpoint.act(`she.matter.send(${nodeId}, ${endpointId}, ${clusterName}.${commandName})`, async (agent) => {
        const clusterAgent = agent[_clusterName(clusterName)];
        if (!clusterAgent) throw new Error(`Cluster "${clusterName}" not found on endpoint ${endpointId}`);
        const cmd = clusterAgent[commandName];
        if (typeof cmd !== 'function') throw new Error(`Command "${commandName}" not found in cluster "${clusterName}"`);
        // Fill neutral defaults for mandatory boilerplate fields the caller omitted.
        const merged = args !== undefined && args !== null && typeof args === 'object' ? { ...args } : {};
        for (const field of _mandatoryCommandFields(clusterAgent.cluster, commandName)) {
            if (merged[field] !== undefined) continue;
            if (field === 'optionsMask' || field === 'optionsOverride') merged[field] = {};
            else if (field === 'transitionTime') merged[field] = 0;
        }
        // Only pass args when there is actually a payload.
        // Void commands (e.g. onOff.off) fail TLV validation if passed an empty object.
        const hasArgs = Object.keys(merged).length > 0;
        return hasArgs ? cmd.call(clusterAgent, merged) : cmd.call(clusterAgent);
    });
}

// ── Node lifecycle events (online / offline) ────────────────────────────────

/**
 * Subscribe to all attribute $Changed events on every endpoint/cluster of a node
 * and forward each change to the WS broadcast so the web UI can display a live
 * event feed.  A per-node guard prevents double-registration on reconnects.
 *
 * @param {object} node   ClientNode
 * @param {string} nodeId decimal string
 */
function _broadcastNodeAttributes(node, nodeId) {
    if (!_broadcast) return;
    if (_attrBroadcastNodes.has(nodeId)) return;
    _attrBroadcastNodes.add(nodeId);
    let count = 0;
    try {
        for (const endpoint of node.endpoints) {
            const endpointId = endpoint.number ?? 0;
            if (!endpoint.state) continue;
            // Iterate cluster names from state (enumerable), then access events via
            // bracket notation — endpoint.events may be a Proxy that doesn't enumerate.
            for (const clusterName of Object.keys(endpoint.state)) {
                const clusterState = endpoint.state[clusterName];
                if (!clusterState || typeof clusterState !== 'object') continue;
                const clusterEvents = endpoint.events?.[clusterName];
                if (!clusterEvents) continue;
                for (const attrName of Object.keys(clusterState)) {
                    const changeEvent = clusterEvents[`${attrName}$Changed`];
                    if (!changeEvent || typeof changeEvent.on !== 'function') continue;
                    changeEvent.on((value) => {
                        _broadcast?.({
                            type: 'matter:attr',
                            nodeId,
                            endpointId,
                            clusterName,
                            attrName,
                            value: _jsonSafe(value),
                            ts: Date.now(),
                        });
                    });
                    count++;
                }
            }
        }
        if (count === 0) {
            // Endpoint structure not populated yet (e.g. right after commissioning)
            // — drop the guard so the next lifecycle 'online' event retries.
            _attrBroadcastNodes.delete(nodeId);
            _log?.debug(`matter: no watchable attributes on node ${nodeId} yet, will retry on next online event`);
        } else {
            _log?.info(`matter: watching ${count} attribute(s) on node ${nodeId}`);
        }
    } catch (err) {
        _attrBroadcastNodes.delete(nodeId); // allow retry
        _log?.warn(`matter: attribute broadcast setup failed for ${nodeId}: ${err.message}`);
    }
}

/**
 * Subscribe to online/offline lifecycle changes for a node and broadcast them.
 * @param {object} node ClientNode
 * @param {string} nodeId decimal string
 */
function _subscribeNodeLifecycle(node, nodeId) {
    const lc = node.lifecycle;
    if (!lc) return;
    lc.online?.on?.(() => {
        _broadcast?.({ type: 'matter:deviceStatus', nodeId, online: true });
        _broadcastNodeAttributes(node, nodeId);
    });
    lc.offline?.on?.(() => {
        _broadcast?.({ type: 'matter:deviceStatus', nodeId, online: false });
    });
}

// ── Subscriptions (for sandbox) ───────────────────────────────────────────────

/**
 * Subscribe to attribute changes on a specific cluster attribute.
 * Returns a listenerId that can be passed to unsubscribe().
 *
 * @param {string}   scriptFile   For cleanup tracking
 * @param {string}   nodeId
 * @param {number}   endpointId
 * @param {string}   clusterName  camelCase cluster name
 * @param {string}   attrName     camelCase attribute name
 * @param {Function} callback     (value, oldValue) => void
 * @returns {number}  listenerId
 */
function subscribeAttribute(scriptFile, nodeId, endpointId, clusterName, attrName, callback) {
    const node = _findClientNode(nodeId);
    const endpoint = _resolveEndpoint(node, endpointId);
    const events = endpoint.events?.[_clusterName(clusterName)];
    if (!events) throw new Error(`Cluster "${clusterName}" not found on endpoint ${endpointId}`);
    const changeEvent = events[`${attrName}$Changed`];
    if (!changeEvent) throw new Error(`Attribute "${attrName}" on cluster "${clusterName}" has no change event`);

    const listenerId = _nextListenerId++;
    const cancel = changeEvent.on((value, oldValue) => {
        try {
            callback(value, oldValue);
        } catch (err) {
            _log?.error(`matter subscriber error in ${scriptFile}:`, err.message);
        }
    });

    if (!_listeners.has(scriptFile)) _listeners.set(scriptFile, new Map());
    _listeners.get(scriptFile).set(listenerId, { cancel });
    return listenerId;
}

/**
 * Remove a specific subscription by listenerId.
 */
function unsubscribe(scriptFile, listenerId) {
    const scriptListeners = _listeners.get(scriptFile);
    if (!scriptListeners) return;
    const entry = scriptListeners.get(listenerId);
    if (entry) {
        entry.cancel();
        scriptListeners.delete(listenerId);
    }
}

/**
 * Remove all subscriptions registered by a script (called on hot-reload).
 *
 * @param {string} scriptFile
 */
function cleanup(scriptFile) {
    const scriptListeners = _listeners.get(scriptFile);
    if (!scriptListeners) return;
    for (const { cancel } of scriptListeners.values()) {
        try {
            cancel();
        } catch {
            // ignore
        }
    }
    _listeners.delete(scriptFile);
}

/**
 * Get vendor · product subtitle for a node by nodeId string.
 * @param {string} nodeId
 * @returns {string|null}
 */
function getDeviceSubtitle(nodeId) {
    try {
        const node = _findClientNode(nodeId);
        return _getDeviceSubtitle(node);
    } catch {
        return null;
    }
}

function isStarted() {
    return _server !== null;
}

module.exports = {
    init,
    close,
    isStarted,
    listPaired,
    commission,
    unpair,
    getEndpoints,
    getDeviceSubtitle,
    getAttribute,
    setAttribute,
    rename,
    sendCommand,
    subscribeAttribute,
    unsubscribe,
    cleanup,
};
