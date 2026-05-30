'use strict';

/**
 * Matter controller — wraps @matter/main ServerNode + Peers API.
 *
 * Call init() once at daemon startup (only when --matter-storage is set).
 * Call close() on daemon shutdown.
 *
 * All nodeIds are exposed as decimal strings (BigInt serialization boundary).
 */

const { Environment, ServerNode } = require('@matter/main');

/** @type {import('@matter/main').ServerNode | null} */
let _server = null;
let _log = null;
/** @type {((msg: object) => void) | null} */
let _broadcast = null;

// ── Attribute / event listeners registered by sandbox scripts ───────────────
// Map<scriptFile, Map<listenerId, { cancel: () => void }>>
const _listeners = new Map();
let _nextListenerId = 1;

// ── Helpers ──────────────────────────────────────────────────────────────────

function _bigintNodeId(nodeId) {
    return BigInt(nodeId);
}

function _nodeIdStr(nodeId) {
    return nodeId.toString();
}

function _findClientNode(nodeIdStr) {
    if (!_server) throw new Error('Matter controller not started');
    for (const node of _server.peers) {
        const addr = node.peerAddress;
        if (addr && _nodeIdStr(addr.nodeId) === nodeIdStr) return node;
    }
    throw new Error(`Matter node not found: ${nodeIdStr}`);
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

    // Configure storage before anything else touches StorageService
    Environment.default.vars.set('storage.path', storagePath);

    // Disable matter.js built-in CLI arg and env-var parsing so it doesn't
    // interfere with the daemon's own yargs config.
    Environment.default.vars.set('environment.disableInteraction', true);

    _server = await ServerNode.create({
        id: 'she-matter-controller',
    });

    await _server.start();
    _log.info('matter controller started, storage:', storagePath);
}

async function close() {
    if (!_server) return;
    try {
        await _server.close();
    } catch (err) {
        /* istanbul ignore next */
        _log?.error('matter controller close error:', err.message);
    } finally {
        _server = null;
    }
}

// ── Device management ─────────────────────────────────────────────────────────

/**
 * List all paired nodes.
 * @returns {{ nodeId: string, online: boolean }[]}
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
        });
    }
    return result;
}

/**
 * Commission a new device.
 *
 * @param {{ passcode: number, discriminator?: number } | { pairingCode: string }} options
 * @returns {Promise<string>}  nodeId of the newly commissioned device
 */
async function commission(options) {
    if (!_server) throw new Error('Matter controller not started');
    const clientNode = await _server.peers.commission(options);
    const addr = clientNode.peerAddress;
    if (!addr) throw new Error('Commission succeeded but node has no peerAddress');
    const nodeId = _nodeIdStr(addr.nodeId);
    _subscribeNodeLifecycle(clientNode, nodeId);
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
 * @returns {{ endpointId: number, clusters: string[] }[]}
 */
function getEndpoints(nodeId) {
    const node = _findClientNode(nodeId);
    const result = [];
    for (const endpoint of node.endpoints) {
        const clusters = endpoint.state ? Object.keys(endpoint.state) : [];
        result.push({ endpointId: endpoint.number ?? 0, clusters });
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
    const endpoint = node.endpoints.for(endpointId);
    const clusterState = endpoint.state?.[_clusterName(clusterName)];
    if (!clusterState) throw new Error(`Cluster "${clusterName}" not found on endpoint ${endpointId}`);
    return clusterState[attrName];
}

// ── Commands ──────────────────────────────────────────────────────────────────

/**
 * Invoke a cluster command.
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
    return node.act(`she.matter.send(${nodeId}, ${endpointId}, ${clusterName}.${commandName})`, async (agent) => {
        const rootParts = agent.parts;
        // Navigate to the target endpoint
        const ep = rootParts ? rootParts.get(endpointId) : null;
        if (!ep) throw new Error(`Endpoint ${endpointId} not found on node ${nodeId}`);
        const clusterAgent = ep[_clusterName(clusterName)];
        if (!clusterAgent) throw new Error(`Cluster "${clusterName}" not found`);
        const cmd = clusterAgent[commandName];
        if (typeof cmd !== 'function') throw new Error(`Command "${commandName}" not found in cluster "${clusterName}"`);
        return cmd.call(clusterAgent, args ?? {});
    });
}

// ── Node lifecycle events (online / offline) ────────────────────────────────

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
    const endpoint = node.endpoints.for(endpointId);
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

module.exports = {
    init,
    close,
    listPaired,
    commission,
    unpair,
    getEndpoints,
    getAttribute,
    sendCommand,
    subscribeAttribute,
    unsubscribe,
    cleanup,
};
