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
const dcl = require('./dcl');

// Upper bound for a commissioning attempt — matter.js has internal retries that
// can keep an HTTP request (and the pairing wizard) hanging for a very long time.
const COMMISSION_TIMEOUT_MS = 120000;

/** @type {import('@matter/main').ServerNode | null} */
let _server = null;
let _log = null;
// Rate-limit state for repeating matter.js error lines (B6)
let _lastMatterErr = { line: '', ts: 0, suppressed: 0 };

/** Depth-limited, cycle-safe rendering of arbitrary throwables/objects. */
function _inspect(v) {
    return require('util').inspect(v, { depth: 6, breakLength: 160 });
}
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

/**
 * Recursively convert values so the result is JSON-serialisable: BigInt to a number (or a string
 * beyond 2^53), byte arrays to `{ $bytes: "<hex>" }` — JSON.stringify would turn a Uint8Array into
 * an object of numbered keys, which the UI cannot tell from a struct.
 */
function _jsonSafe(v) {
    if (typeof v === 'bigint') return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
    if (ArrayBuffer.isView(v)) return { $bytes: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex') };
    if (v instanceof ArrayBuffer) return { $bytes: Buffer.from(v).toString('hex') };
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
async function init(storagePath, log, broadcastFn, options = {}) {
    _broadcast = broadcastFn ?? null;
    if (_server) throw new Error('Matter controller already started');
    _log = log;

    // Route matter.js's own diagnostics into the daemon logger so commissioning
    // problems (discovery, PASE failures, retries) are visible in the Logs tab —
    // by default matter.js writes straight to stdout, bypassing she's logging.
    Logger.format = LogFormat.PLAIN;
    Logger.level = LogLevel.INFO;
    Logger.destinations.default.write = (text, message) => {
        // she's log adds its own timestamp — drop matter.js's embedded one
        let line = text.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s*/, '');
        if (message.level >= LogLevel.ERROR) {
            // PLAIN formatting renders some throwables as "{}" — recover the
            // detail from the structured message values (B6).
            if (/(\{\}|\[object \w+\])\s*$/.test(line)) {
                const details = (message.values ?? [])
                    .filter((v) => v !== null && typeof v === 'object')
                    .map((v) => _inspect(v))
                    .filter((d) => d && d !== '{}');
                if (details.length) line += ' — ' + details.join(' — ');
            }
            // Rate-limit identical repeating error lines (e.g. a failing
            // reconnect loop): suppress repeats within 30 s, keep a heartbeat.
            const now = Date.now();
            if (line === _lastMatterErr.line && now - _lastMatterErr.ts < 30000) {
                _lastMatterErr.ts = now;
                _lastMatterErr.suppressed++;
                if (_lastMatterErr.suppressed % 20 !== 0) return;
                _log.error(`matter.js: (error repeated ${_lastMatterErr.suppressed} times) ${line}`);
                return;
            }
            if (_lastMatterErr.suppressed % 20 !== 0) {
                _log.error(`matter.js: (previous error repeated ${_lastMatterErr.suppressed} more times)`);
            }
            _lastMatterErr = { line, ts: now, suppressed: 0 };
            _log.error('matter.js:', line);
        } else if (message.level === LogLevel.WARN) {
            _log.warn('matter.js:', line);
        } else {
            _log.debug('matter.js:', line);
        }
    };

    // matter.js's default unhandled-error reporter logs the bare value, which
    // renders as "{}" for non-Error throwables and drops cause / AggregateError
    // details. The hook is explicitly replaceable — report full detail (B6).
    //
    // matter.js wires this to process.uncaughtExceptionMonitor, which fires for
    // EVERY uncaught exception in the process — matter internals, sandbox
    // script errors, and she's own code alike. Attribute by stack:
    //   - sandbox script errors are skipped entirely (she's per-script domain
    //     handles and logs them with correct script attribution);
    //   - only stacks that actually contain matter.js frames get the
    //     "matter.js:" label — everything else is reported neutrally, since it
    //     may just as well be a bug in she itself.
    Logger.reportUnhandledError = (error) => {
        try {
            const stack = typeof error?.stack === 'string' ? error.stack : '';
            if (stack) {
                if (stack.includes('Script.runInContext') || stack.includes('node:vm')) return;
                try {
                    const config = require('../config');
                    const dirs = config.dir ? (Array.isArray(config.dir) ? config.dir : [config.dir]) : [];
                    if (dirs.some((d) => d && stack.includes(d))) return;
                } catch {
                    /* config unavailable — fall through to logging */
                }
            }
            const fromMatter = stack.includes('/@matter/') || stack.includes('\\@matter\\') || stack.includes('@project-chip');
            _log.error(fromMatter ? 'matter.js: unhandled error:' : 'unhandled error:', _inspect(error));
        } catch {
            /* never throw from the error reporter */
        }
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
        // the fabric label devices show for she (new commissionings; existing fabrics keep theirs)
        controller: { adminFabricLabel: 'she' },
    });

    // The OTA provider endpoint with matter.js's SoftwareUpdateManager (M22): finds updates on the
    // CSA ledger, serves the image over BDX when the user starts an update. Not with DCL access off.
    if (options.dclOffline !== true) _setupOta(storagePath).catch((err) => _log?.warn(`matter: OTA provider not available: ${err.message}`));

    await _server.start();
    _log.info('matter controller started, storage:', storagePath);

    // she's Matter groups (M23): the key sets and the group → key set map into she's own fabric
    try {
        _loadGroups(storagePath);
        await _registerGroupsInFabric();
    } catch (err) {
        _log?.warn(`matter: groups not registered: ${err.message}`);
    }

    // Device information from the CSA ledger (M25) — never holds the start, never throws
    dcl.start({ env: _server.env, storageDir: storagePath, log, offline: options.dclOffline === true }).catch((err) => _log?.warn(`matter: DCL start failed: ${err.message}`));

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
    _ota = null;
    await dcl.close();
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
    const { discoveryAddress, ...rest } = options;
    // matter.js (0.17.0 … 0.17.9) passes an absent regulatory location and country through
    // CommissioningClient as `undefined`, which overrides the commissioner's own default "XX":
    // every Thread or Wi-Fi device then fails at SetRegulatoryConfig ("Missing mandatory field
    // countryCode"). "XX" (unknown country) is always valid; IndoorOutdoor is used only when the
    // device reports that capability, otherwise the device keeps its own location.
    const { GeneralCommissioning } = require('@matter/main/clusters');
    const commissionOpts = {
        regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
        regulatoryCountryCode: 'XX',
        ...rest,
    };
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
                        attrs[k] = _attrValue(clusterName, k, v);
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
 * Uses the interaction-level write rather than Endpoint.set(): set() requires
 * a synthesized client behavior, which matter.js does not create for every
 * cluster (e.g. basicInformation on the root endpoint reports
 * "Behavior ... is not present on this endpoint" although the cluster and its
 * state are there). The interaction write goes over the same wire path that
 * commands use and needs no behavior instance.
 *
 * @param {string}  nodeId
 * @param {number}  endpointId
 * @param {string}  clusterName  camelCase cluster name, e.g. "basicInformation"
 * @param {string}  attrName     camelCase attribute name, e.g. "nodeLabel"
 * @param {*}       value
 * @returns {Promise<void>}
 */
async function setAttribute(nodeId, endpointId, clusterName, attrName, value) {
    await _writeAttribute(_findClientNode(nodeId), endpointId, clusterName, attrName, value);
}

function _clusterDef(clusterName, attrName) {
    const clusters = require('@matter/main/clusters');
    const clusterDef = clusters[clusterName.charAt(0).toUpperCase() + clusterName.slice(1)]?.Complete;
    if (!clusterDef) throw new Error(`Unknown cluster "${clusterName}"`);
    if (attrName !== undefined && !clusterDef.attributes?.[attrName]) throw new Error(`Unknown attribute "${clusterName}.${attrName}"`);
    return clusterDef;
}

/** The interaction-level write (see setAttribute) for a resolved node. */
async function _writeAttribute(node, endpointId, clusterName, attrName, value) {
    const { Write, WriteResult } = require('@matter/protocol');
    const clusterDef = _clusterDef(clusterName, attrName);
    const request = Write(Write.Attribute({ endpoint: Number(endpointId), cluster: clusterDef, attributes: attrName, value }));
    const result = await node.interaction.write(request);
    WriteResult.assertSuccess(result);
}

/**
 * A fresh read of one attribute from the device (not the cached state): the bindings code must
 * never write a fabric-scoped list from stale state. `fabricFiltered: false` returns the other
 * fabrics' entries of a fabric-scoped list too (their non-sensitive fields).
 */
async function _readAttribute(node, endpointId, clusterName, attrName, { fabricFiltered = true } = {}) {
    const { Read } = require('@matter/protocol');
    const clusterDef = _clusterDef(clusterName, attrName);
    const request = Read({ fabricFilter: fabricFiltered }, Read.Attribute({ endpoint: Number(endpointId), cluster: clusterDef, attributes: attrName }));
    let value;
    let found = false;
    for await (const chunk of node.interaction.read(request)) {
        for await (const report of chunk) {
            if (report.kind === 'attr-value') {
                value = report.value;
                found = true;
            } else if (report.kind === 'attr-status') {
                throw new Error(`reading ${clusterName}.${attrName} failed with status ${report.status}`);
            }
        }
    }
    if (!found) throw new Error(`reading ${clusterName}.${attrName}: the device returned no value`);
    return value;
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

/** Lowercase the first character (PascalCase model names → camelCase). */
function _camelize(s) {
    return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Best-effort: list the mandatory field names (camelCase) of a command's
 * request schema. Resolution mirrors matter.js's own command lookup:
 *   1. the behavior's cluster definition (unwrapping a `.cluster`-wrapped
 *      specifier like @matter/protocol Specifier.clusterFor does), commands as
 *      a TLV Command (requestSchema/fieldDefinitions) or a model-based command
 *      ({ schema: CommandModel });
 *   2. fallback: the behavior's ClusterModel schema — request-direction
 *      CommandModel children matched by camelized name (the shape generated
 *      for discovered client clusters).
 * Returns [] when unresolvable.
 * @param {object} behavior     the cluster behavior (agent[clusterName])
 * @param {string} commandName
 * @returns {string[]}
 */
function _mandatoryCommandFields(behavior, commandName) {
    try {
        let cluster = behavior?.cluster;
        if (cluster && typeof cluster === 'object' && 'cluster' in cluster) cluster = cluster.cluster;
        let cmd = cluster?.commands?.[commandName];
        if (!cmd) {
            // Discovered client clusters: command models live on the ClusterModel schema
            const schemaModel = behavior?.schema ?? behavior?.constructor?.schema;
            if (schemaModel?.children) {
                for (const c of schemaModel.children) {
                    if (c.tag === 'command' && c.name && _camelize(c.name) === commandName && c.direction !== 'response') {
                        cmd = { schema: c };
                        break;
                    }
                }
            }
        }
        const schema = cmd?.schema ?? cmd?.requestSchema;
        if (schema?.fieldDefinitions) {
            return Object.entries(schema.fieldDefinitions)
                .filter(([, def]) => !def?.optional)
                .map(([name]) => name);
        }
        if (schema?.children) {
            return [...schema.children].filter((c) => c.effectiveConformance?.isMandatory !== false).map((c) => _camelize(c.name));
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
    // she.matter.send('group:Wohnzimmer', null, 'onOff', 'on') — a group command (M23)
    if (typeof nodeId === 'string' && nodeId.startsWith('group:')) {
        return sendGroupCommand(nodeId.slice(6), clusterName, commandName, args);
    }
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
        let mandatoryFields = _mandatoryCommandFields(clusterAgent, commandName);
        if (mandatoryFields.length === 0) {
            _log?.debug(`matter: could not resolve request fields for ${clusterName}.${commandName}`);
            // Last resort: every LevelControl/ColorControl command carries the two
            // options bitmaps (and the TLV encoder ignores unknown fields), so
            // injecting them is safe even for the few commands without them.
            if (_clusterName(clusterName) === 'levelControl' || _clusterName(clusterName) === 'colorControl') {
                mandatoryFields = ['optionsMask', 'optionsOverride'];
            }
        }
        for (const field of mandatoryFields) {
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

// ── Bindings and ACLs (M13) ───────────────────────────────────────────────────

const bindings = require('./bindings');

/** The root endpoint's cluster state of a node, or undefined. */
function _rootState(node, clusterName) {
    try {
        for (const ep of node.endpoints) if ((ep.number ?? 0) === 0) return ep.state?.[clusterName];
    } catch {
        /* offline */
    }
    return undefined;
}

/** she's own node ID in the fabric the peer was commissioned into. */
function _sheNodeIdFor(node) {
    const { FabricManager } = require('@matter/protocol');
    const fabric = _server.env.get(FabricManager).for(node.peerAddress.fabricIndex);
    return fabric.rootNodeId;
}

/** The index the *device* gives she's fabric (what its fabric-scoped entries carry). */
function _deviceFabricIndex(node) {
    const v = _rootState(node, 'operationalCredentials')?.currentFabricIndex;
    return v === undefined || v === null ? undefined : Number(v);
}

function _requireOnline(node, what) {
    if (!node.lifecycle?.isOnline) throw new Error(`${what} (${_getDeviceName(node) ?? _nodeIdStr(node.peerAddress.nodeId)}) is offline`);
}

/** Endpoint data the bindings classifier needs: device types, server and client cluster IDs. */
function _endpointSummary(node) {
    const out = [];
    for (const ep of node.endpoints) {
        const d = ep.state?.descriptor;
        out.push({
            endpointId: ep.number ?? 0,
            name: _getEndpointName(ep),
            deviceTypes: (d?.deviceTypeList ?? []).map((t) => Number(t?.deviceType ?? t)),
            serverList: (d?.serverList ?? []).map(Number),
            clientList: (d?.clientList ?? []).map(Number),
        });
    }
    return out;
}

/**
 * Every binding of every commissioned node: she's own fabric's entries resolved to device names,
 * the other fabrics' entries (D-10) with node IDs in that fabric's numbering. Online nodes are
 * read fresh with fabric filtering off; offline ones show what the cache holds (own fabric).
 */
async function listBindings() {
    if (!_server) return [];
    const result = [];
    for (const node of _server.peers) {
        const addr = node.peerAddress;
        if (!addr) continue;
        const nodeId = _nodeIdStr(addr.nodeId);
        const deviceFabric = _deviceFabricIndex(node);
        for (const ep of node.endpoints) {
            const endpointId = ep.number ?? 0;
            const cached = ep.state?.binding;
            if (!cached) continue;
            let entries = Array.isArray(cached.binding) ? cached.binding : [];
            let fresh = false;
            if (node.lifecycle?.isOnline) {
                try {
                    entries = (await _readAttribute(node, endpointId, 'binding', 'binding', { fabricFiltered: false })) ?? [];
                    fresh = true;
                } catch (err) {
                    _log?.debug(`matter: reading bindings of ${nodeId}/${endpointId} failed, using cached state: ${err.message}`);
                }
            }
            for (const b of entries) {
                const fi = b.fabricIndex === undefined || b.fabricIndex === null ? undefined : Number(b.fabricIndex);
                const own = !fresh || fi === undefined || deviceFabric === undefined || fi === deviceFabric;
                const entry = {
                    sourceNodeId: nodeId,
                    sourceName: _getDeviceName(node),
                    sourceEndpointId: endpointId,
                    sourceEndpointName: _getEndpointName(ep),
                    own,
                    fabricIndex: fi,
                    node: b.node === undefined || b.node === null ? null : String(b.node),
                    group: b.group === undefined || b.group === null ? null : Number(b.group),
                    endpoint: b.endpoint === undefined || b.endpoint === null ? null : Number(b.endpoint),
                    cluster: b.cluster === undefined || b.cluster === null ? null : Number(b.cluster),
                    clusterName: b.cluster === undefined || b.cluster === null ? null : bindings.clusterNameOf(Number(b.cluster)),
                    targetName: null,
                    targetEndpointName: null,
                };
                if (own && entry.group !== null) {
                    const g = _groupStore?.groups.find((x) => Number(x.id) === entry.group);
                    entry.targetName = g ? `group ${g.name}` : null;
                }
                if (own && entry.node !== null) {
                    try {
                        const target = _findClientNode(entry.node);
                        entry.targetName = _getDeviceName(target);
                        if (entry.endpoint !== null) entry.targetEndpointName = _getEndpointName(_resolveEndpoint(target, entry.endpoint));
                    } catch {
                        /* a node she does not know (any more) */
                    }
                }
                result.push(entry);
            }
        }
    }
    return result;
}

/** Binding sources, targets and the endpoints that cannot bind, from the descriptor clusters. */
function bindingCandidates() {
    if (!_server) return { sources: [], targets: [], notBindable: [] };
    const nodes = [];
    for (const node of _server.peers) {
        const addr = node.peerAddress;
        if (!addr) continue;
        nodes.push({ nodeId: _nodeIdStr(addr.nodeId), name: _getDeviceName(node), online: node.lifecycle?.isOnline ?? false, endpoints: _endpointSummary(node) });
    }
    return bindings.classifyEndpoints(nodes);
}

/**
 * Create a binding: grant the source Operate on the target (ACL, guarded, read back), then add
 * the entries to the source's Binding list (read back); the ACL change is rolled back when the
 * binding write fails.
 *
 * @param {{ source: { nodeId: string, endpointId: number }, target: { nodeId: string, endpointId: number }, clusters: (string|number)[] }} opts
 * @returns {Promise<{ ok: true, clusters: number[], aclChanged: boolean, bindingsAdded: number[] }>}
 */
async function addBinding({ source, target, clusters }) {
    if (!_server) throw new Error('Matter controller not started');
    if (!Array.isArray(clusters) || clusters.length === 0) throw new Error('clusters must name at least one cluster');
    if (target && target.group !== undefined && target.group !== null) return _addGroupBinding({ source, group: target.group, clusters });
    const clusterIds = clusters.map(bindings.clusterIdOf);
    const sourceNode = _findClientNode(source.nodeId);
    const targetNode = _findClientNode(target.nodeId);
    if (sourceNode === targetNode && Number(source.endpointId) === Number(target.endpointId)) throw new Error('source and target are the same endpoint');
    _requireOnline(sourceNode, 'the source');
    _requireOnline(targetNode, 'the target');
    if (sourceNode.peerAddress.fabricIndex !== targetNode.peerAddress.fabricIndex) throw new Error('source and target are not in the same fabric');
    const sheNodeId = _sheNodeIdFor(targetNode);
    const subject = sourceNode.peerAddress.nodeId;
    const targetEp = Number(target.endpointId);
    const sourceEp = Number(source.endpointId);
    const label = `${_getDeviceName(sourceNode) ?? source.nodeId}/${sourceEp} → ${_getDeviceName(targetNode) ?? target.nodeId}/${targetEp}`;

    // 1. the target's ACL: read fresh, extend, guard, write, read back
    const aclBefore = (await _readAttribute(targetNode, 0, 'accessControl', 'acl')) ?? [];
    const limits = _rootState(targetNode, 'accessControl');
    const aclAfter = bindings.grantOperate(aclBefore, { subject, endpoint: targetEp, clusters: clusterIds, sheNodeId, limits, fabricIndex: _deviceFabricIndex(targetNode) });
    const aclChanged = JSON.stringify(_jsonSafe(aclAfter)) !== JSON.stringify(_jsonSafe(aclBefore));
    if (aclChanged) {
        bindings.assertSafeAcl(aclAfter, sheNodeId);
        _log?.info(`matter: binding ${label}: granting Operate on the target`);
        await _writeAttribute(targetNode, 0, 'accessControl', 'acl', aclAfter);
        const readBack = (await _readAttribute(targetNode, 0, 'accessControl', 'acl')) ?? [];
        if (!bindings.findAdminEntry(readBack, sheNodeId)) throw new Error("the target's ACL lost she's Administer entry after the write — check the device immediately");
        const granted = bindings.grantedClusters(readBack, { subject, endpoint: targetEp });
        const missing = clusterIds.filter((id) => !granted.includes(id));
        if (missing.length) throw new Error(`the target did not keep the access grant for cluster(s) ${missing.join(', ')}`);
    }

    // 2. the source's Binding list: read fresh, append, write, read back — roll the ACL back on failure
    try {
        const before = (await _readAttribute(sourceNode, sourceEp, 'binding', 'binding')) ?? [];
        const { bindings: after, added } = bindings.addBindingEntries(before, {
            node: targetNode.peerAddress.nodeId,
            endpoint: targetEp,
            clusters: clusterIds,
            fabricIndex: _deviceFabricIndex(sourceNode),
        });
        if (added.length) {
            _log?.info(`matter: binding ${label}: writing the source's binding list`);
            await _writeAttribute(sourceNode, sourceEp, 'binding', 'binding', after);
            const readBack = (await _readAttribute(sourceNode, sourceEp, 'binding', 'binding')) ?? [];
            const bound = bindings.clustersStillBound(readBack, { node: targetNode.peerAddress.nodeId, endpoint: targetEp });
            const missing = clusterIds.filter((id) => !bound.includes(id));
            if (missing.length) throw new Error(`the source did not keep the binding for cluster(s) ${missing.join(', ')}`);
        }
        _broadcast?.({ type: 'matter:bindings' });
        return { ok: true, clusters: clusterIds, aclChanged, bindingsAdded: added };
    } catch (err) {
        if (aclChanged) {
            _log?.warn(`matter: binding ${label} failed (${err.message}) — rolling the target's ACL back`);
            try {
                bindings.assertSafeAcl(aclBefore, sheNodeId);
                await _writeAttribute(targetNode, 0, 'accessControl', 'acl', aclBefore);
            } catch (rollbackErr) {
                _log?.error(`matter: ACL rollback on ${target.nodeId} failed: ${rollbackErr.message}`);
            }
        }
        throw err;
    }
}

/**
 * Remove a binding: drop the entries from the source's Binding list, then revoke the ACL grant
 * for the clusters no other binding of that source still needs. A target that is offline keeps
 * its grant (reported in the result) — the binding itself is gone.
 */
async function removeBinding({ source, target, clusters }) {
    if (!_server) throw new Error('Matter controller not started');
    if (!Array.isArray(clusters) || clusters.length === 0) throw new Error('clusters must name at least one cluster');
    if (target && target.group !== undefined && target.group !== null) return _removeGroupBinding({ source, group: target.group, clusters });
    const clusterIds = clusters.map(bindings.clusterIdOf);
    const sourceNode = _findClientNode(source.nodeId);
    _requireOnline(sourceNode, 'the source');
    const sourceEp = Number(source.endpointId);
    const targetEp = Number(target.endpointId);
    let targetNode = null;
    try {
        targetNode = _findClientNode(target.nodeId);
    } catch {
        /* the target may be gone — the binding entry is removed anyway */
    }
    const targetNodeId = targetNode ? targetNode.peerAddress.nodeId : BigInt(target.nodeId);

    const before = (await _readAttribute(sourceNode, sourceEp, 'binding', 'binding')) ?? [];
    const { bindings: after, removed } = bindings.removeBindingEntries(before, { node: targetNodeId, endpoint: targetEp, clusters: clusterIds });
    if (removed.length) {
        await _writeAttribute(sourceNode, sourceEp, 'binding', 'binding', after);
        const readBack = (await _readAttribute(sourceNode, sourceEp, 'binding', 'binding')) ?? [];
        const still = bindings.clustersStillBound(readBack, { node: targetNodeId, endpoint: targetEp });
        const left = clusterIds.filter((id) => still.includes(id));
        if (left.length) throw new Error(`the source kept the binding for cluster(s) ${left.join(', ')}`);
    }

    // which of the clusters does another entry of this source still bind on that endpoint?
    const stillBound = bindings.clustersStillBound(after, { node: targetNodeId, endpoint: targetEp });
    const toRevoke = clusterIds.filter((id) => !stillBound.includes(id));
    let aclRevoked = false;
    let warning = null;
    if (toRevoke.length && targetNode) {
        if (!targetNode.lifecycle?.isOnline) {
            warning = 'the target is offline — its access grant for the source stays until it is back and the binding is removed again';
        } else {
            const sheNodeId = _sheNodeIdFor(targetNode);
            const acl = (await _readAttribute(targetNode, 0, 'accessControl', 'acl')) ?? [];
            const aclAfter = bindings.revokeOperate(acl, { subject: sourceNode.peerAddress.nodeId, endpoint: targetEp, clusters: toRevoke, sheNodeId });
            if (JSON.stringify(_jsonSafe(aclAfter)) !== JSON.stringify(_jsonSafe(acl))) {
                bindings.assertSafeAcl(aclAfter, sheNodeId);
                await _writeAttribute(targetNode, 0, 'accessControl', 'acl', aclAfter);
                const readBack = (await _readAttribute(targetNode, 0, 'accessControl', 'acl')) ?? [];
                if (!bindings.findAdminEntry(readBack, sheNodeId)) throw new Error("the target's ACL lost she's Administer entry after the write — check the device immediately");
                aclRevoked = true;
            }
        }
    } else if (toRevoke.length && !targetNode) {
        warning = 'the target is not paired with she — nothing to revoke there';
    }
    _broadcast?.({ type: 'matter:bindings' });
    return { ok: true, clusters: clusterIds, bindingsRemoved: removed, aclRevoked, warning };
}

// ── Groups (M23) ──────────────────────────────────────────────────────────────

const groups = require('./groups');

/** @type {{ keySets: object, groups: object[] } | null} null = the store cannot be read (no key) */
let _groupStore = null;
let _groupStorageDir = null;
let _groupStoreError = null;

function _loadGroups(storagePath) {
    _groupStorageDir = storagePath;
    try {
        _groupStore = groups.readStore(storagePath);
        _groupStoreError = null;
        if (_groupStore.groups.length) _log?.info(`matter: ${_groupStore.groups.length} group(s), ${Object.keys(_groupStore.keySets).length} key set(s) loaded`);
    } catch (err) {
        _groupStore = null;
        _groupStoreError = err.message;
        _log?.error(`matter: the group store cannot be read: ${err.message}`);
    }
}

function _saveGroups() {
    groups.writeStore(_groupStorageDir, _groupStore);
}

function _requireGroups() {
    if (!_server) throw new Error('Matter controller not started');
    if (!_groupStore) throw new Error(`the group store is not available: ${_groupStoreError ?? 'not loaded'}`);
    return _groupStore;
}

/** she's own fabrics (one, normally). */
function _ownFabrics() {
    const { FabricManager } = require('@matter/protocol');
    return _server.env.get(FabricManager).fabrics;
}

/** Register every key set and the group → key set map in she's fabric(s), so she can send group messages. */
async function _registerGroupsInFabric() {
    if (!_groupStore) return;
    const { GroupId } = require('@matter/types');
    for (const fabric of _ownFabrics()) {
        for (const ks of Object.values(_groupStore.keySets)) await fabric.groups.setFromGroupKeySet(groups.groupKeySetStruct(ks));
        fabric.groups.groupKeyIdMap = new Map(_groupStore.groups.map((g) => [GroupId(Number(g.id)), Number(g.keySetId)]));
    }
}

function _findGroup(ref) {
    const store = _requireGroups();
    const str = String(ref);
    const g = store.groups.find((x) => String(x.id) === str) ?? store.groups.find((x) => x.name === str);
    if (!g) throw new Error(`Matter group not found: ${ref}`);
    return g;
}

function _memberClusters(node, endpointId) {
    const ep = _endpointSummary(node).find((e) => e.endpointId === Number(endpointId));
    if (!ep) throw new Error(`Endpoint not found: ${endpointId}`);
    const ids = Object.values(bindings.BINDABLE_CLUSTERS)
        .map((d) => d.id)
        .filter((id) => ep.serverList.includes(id));
    if (!ids.length) throw new Error('the endpoint has no cluster a group could control (On/Off, Level Control, …)');
    return ids;
}

/** The key set and the group's map entry on a device — written only when missing; limits checked first. */
async function _ensureKeySetOnDevice(node, ks, groupId, { groupIsNew = true } = {}) {
    const nodeId = _nodeIdStr(node.peerAddress.nodeId);
    const idsResp = await sendCommand(nodeId, 0, 'groupKeyManagement', 'keySetReadAllIndices');
    const ids = (idsResp?.groupKeySetIDs ?? idsResp?.groupKeySetIds ?? []).map(Number);
    const map = (await _readAttribute(node, 0, 'groupKeyManagement', 'groupKeyMap')) ?? [];
    let groupsOnDevice = 0;
    try {
        const table = (await _readAttribute(node, 0, 'groupKeyManagement', 'groupTable')) ?? [];
        groupsOnDevice = new Set(table.map((t) => Number(t.groupId))).size;
    } catch {
        groupsOnDevice = new Set(map.map((e) => Number(e.groupId))).size;
    }
    const keySetIsNew = !ids.includes(Number(ks.id));
    groups.assertWithinLimits({
        keySetsOnDevice: ids.length,
        keySetIsNew,
        groupsOnDevice,
        groupIsNew: groupIsNew && !map.some((e) => Number(e.groupId) === Number(groupId)),
        limits: _rootState(node, 'groupKeyManagement'),
    });
    if (keySetIsNew) {
        _log?.info(`matter: writing key set ${ks.id} to node ${nodeId}`);
        await sendCommand(nodeId, 0, 'groupKeyManagement', 'keySetWrite', { groupKeySet: groups.groupKeySetStruct(ks) });
    }
    const after = groups.groupKeyMapAdd(map, { groupId, keySetId: ks.id, fabricIndex: _deviceFabricIndex(node) });
    if (JSON.stringify(_jsonSafe(after)) !== JSON.stringify(_jsonSafe(map))) {
        await _writeAttribute(node, 0, 'groupKeyManagement', 'groupKeyMap', after);
        const back = (await _readAttribute(node, 0, 'groupKeyManagement', 'groupKeyMap')) ?? [];
        if (!back.some((e) => Number(e.groupId) === Number(groupId) && Number(e.groupKeySetId) === Number(ks.id)))
            throw new Error('the device did not keep the group key map entry');
    }
}

/** Drop the group's map entry and, when nothing else maps it, the key set — best effort. */
async function _dropKeySetOnDevice(node, ks, groupId) {
    const nodeId = _nodeIdStr(node.peerAddress.nodeId);
    const map = (await _readAttribute(node, 0, 'groupKeyManagement', 'groupKeyMap')) ?? [];
    const after = groups.groupKeyMapRemove(map, groupId);
    if (after.length !== map.length) await _writeAttribute(node, 0, 'groupKeyManagement', 'groupKeyMap', after);
    if (!groups.keySetStillMapped(after, ks.id)) {
        try {
            await sendCommand(nodeId, 0, 'groupKeyManagement', 'keySetRemove', { groupKeySetId: Number(ks.id) });
        } catch (err) {
            _log?.debug(`matter: key set ${ks.id} not removed from node ${nodeId}: ${err.message}`);
        }
    }
}

async function _provisionMember(group, ks, node, endpointId, clusters) {
    _requireOnline(node, 'the member');
    const nodeId = _nodeIdStr(node.peerAddress.nodeId);
    await _ensureKeySetOnDevice(node, ks, group.id);
    const resp = await sendCommand(nodeId, endpointId, 'groups', 'addGroup', { groupId: Number(group.id), groupName: group.name });
    if (resp?.status !== undefined && Number(resp.status) !== 0) throw new Error(`AddGroup refused with status ${resp.status}`);
    const sheNodeId = _sheNodeIdFor(node);
    const acl = (await _readAttribute(node, 0, 'accessControl', 'acl')) ?? [];
    const aclAfter = bindings.grantOperate(acl, {
        subject: Number(group.id),
        authMode: bindings.AUTH_MODE.group,
        endpoint: Number(endpointId),
        clusters,
        sheNodeId,
        limits: _rootState(node, 'accessControl'),
        fabricIndex: _deviceFabricIndex(node),
    });
    if (JSON.stringify(_jsonSafe(aclAfter)) !== JSON.stringify(_jsonSafe(acl))) {
        bindings.assertSafeAcl(aclAfter, sheNodeId);
        await _writeAttribute(node, 0, 'accessControl', 'acl', aclAfter);
        const back = (await _readAttribute(node, 0, 'accessControl', 'acl')) ?? [];
        if (!bindings.findAdminEntry(back, sheNodeId)) throw new Error("the device's ACL lost she's Administer entry after the write — check the device immediately");
        const granted = bindings.grantedClusters(back, { subject: Number(group.id), endpoint: Number(endpointId), authMode: bindings.AUTH_MODE.group });
        const missing = clusters.filter((id) => !granted.includes(id));
        if (missing.length) throw new Error(`the device did not keep the group's access grant for cluster(s) ${missing.join(', ')}`);
    }
}

/** Reverse of _provisionMember, each step best effort; the other groups of she on the device keep their key set. */
async function _deprovisionMember(group, ks, node, endpointId, clusters) {
    const nodeId = _nodeIdStr(node.peerAddress.nodeId);
    const problems = [];
    try {
        await sendCommand(nodeId, endpointId, 'groups', 'removeGroup', { groupId: Number(group.id) });
    } catch (err) {
        problems.push(`RemoveGroup: ${err.message}`);
    }
    try {
        const sheNodeId = _sheNodeIdFor(node);
        const acl = (await _readAttribute(node, 0, 'accessControl', 'acl')) ?? [];
        const aclAfter = bindings.revokeOperate(acl, { subject: Number(group.id), authMode: bindings.AUTH_MODE.group, endpoint: Number(endpointId), clusters, sheNodeId });
        if (JSON.stringify(_jsonSafe(aclAfter)) !== JSON.stringify(_jsonSafe(acl))) {
            bindings.assertSafeAcl(aclAfter, sheNodeId);
            await _writeAttribute(node, 0, 'accessControl', 'acl', aclAfter);
        }
    } catch (err) {
        problems.push(`ACL: ${err.message}`);
    }
    // the map entry stays while another endpoint of this node is in the group
    const stillMember = group.members.some((m) => m.nodeId === nodeId && Number(m.endpointId) !== Number(endpointId));
    if (!stillMember) {
        try {
            await _dropKeySetOnDevice(node, ks, group.id);
        } catch (err) {
            problems.push(`key set: ${err.message}`);
        }
    }
    return problems;
}

function _memberView(m) {
    let node = null;
    try {
        node = _findClientNode(m.nodeId);
    } catch {
        /* unpaired since */
    }
    let endpointName = null;
    let state = { onOff: null, level: null };
    if (node) {
        try {
            const ep = _resolveEndpoint(node, m.endpointId);
            endpointName = _getEndpointName(ep);
            const onOff = ep.state?.onOff?.onOff;
            const level = ep.state?.levelControl?.currentLevel;
            state = { onOff: typeof onOff === 'boolean' ? onOff : null, level: level === undefined || level === null ? null : Number(level) };
        } catch {
            /* endpoint gone */
        }
    }
    return {
        nodeId: m.nodeId,
        endpointId: Number(m.endpointId),
        name: node ? _getDeviceName(node) : null,
        endpointName,
        online: node?.lifecycle?.isOnline ?? false,
        paired: !!node,
        clusters: (m.clusters ?? []).map(Number),
        clusterNames: (m.clusters ?? []).map((id) => bindings.clusterNameOf(Number(id)) ?? String(id)),
        status: m.status ?? 'ok',
        error: m.error ?? null,
        state,
    };
}

function _groupView(g) {
    const members = (g.members ?? []).map(_memberView);
    const ks = _groupStore.keySets[String(g.keySetId)];
    return {
        id: Number(g.id),
        name: g.name,
        keySetId: Number(g.keySetId),
        keySet: ks ? groups.publicKeySet(ks) : null,
        members,
        state: groups.derivedState(members.map((m) => m.state)),
        created: g.created ?? null,
    };
}

/** she's groups with their members, the derived state and the key sets (never the keys). */
function listGroups() {
    if (!_server) return { available: false, error: 'Matter controller not started', groups: [], keySets: [] };
    if (!_groupStore) return { available: false, error: _groupStoreError, groups: [], keySets: [] };
    return {
        available: true,
        error: null,
        groups: _groupStore.groups.map(_groupView),
        keySets: Object.values(_groupStore.keySets).map(groups.publicKeySet),
        sharedKeySetId: groups.SHARED_KEY_SET_ID,
    };
}

function _sharedKeySet() {
    const store = _requireGroups();
    const id = String(groups.SHARED_KEY_SET_ID);
    if (!store.keySets[id]) store.keySets[id] = groups.newKeySet(groups.SHARED_KEY_SET_ID, { name: 'shared', shared: true });
    return store.keySets[id];
}

/**
 * Create a group: a free application group ID, the shared key set (default) or one of its own.
 * @param {{ name: string, keySet?: 'shared'|'own' }} opts
 */
async function createGroup({ name, keySet = 'shared' } = {}) {
    const store = _requireGroups();
    if (!groups.validName(name)) throw new Error(`the group name must be 1 to ${groups.GROUP_NAME_MAX} bytes`);
    name = String(name).trim();
    if (store.groups.some((g) => g.name === name)) throw new Error(`a group named "${name}" exists`);
    const id = groups.nextGroupId(store.groups);
    let ks;
    if (keySet === 'own') {
        ks = groups.newKeySet(groups.nextKeySetId(store.keySets), { name, shared: false });
        store.keySets[String(ks.id)] = ks;
    } else {
        ks = _sharedKeySet();
    }
    const g = { id, name, keySetId: ks.id, members: [], created: Date.now() };
    store.groups.push(g);
    _saveGroups();
    await _registerGroupsInFabric();
    _log?.info(`matter: group "${name}" (${id}) created with key set ${ks.id}${ks.shared ? ' (shared)' : ''}`);
    _broadcast?.({ type: 'matter:groups' });
    return _groupView(g);
}

/** Rename a group in she (the name the devices hold is cosmetic and stays). */
function renameGroup(ref, name) {
    const g = _findGroup(ref);
    if (!groups.validName(name)) throw new Error(`the group name must be 1 to ${groups.GROUP_NAME_MAX} bytes`);
    g.name = String(name).trim();
    _saveGroups();
    _broadcast?.({ type: 'matter:groups' });
    return _groupView(g);
}

/** Delete a group: every member is deprovisioned (best effort), an own key set that is no longer used goes too. */
async function deleteGroup(ref) {
    const store = _requireGroups();
    const g = _findGroup(ref);
    const ks = store.keySets[String(g.keySetId)];
    const problems = [];
    for (const m of [...g.members]) {
        try {
            const node = _findClientNode(m.nodeId);
            if (!node.lifecycle?.isOnline) {
                problems.push(`${_getDeviceName(node) ?? m.nodeId}/${m.endpointId}: offline — the device keeps the group until it is removed again`);
                continue;
            }
            g.members = g.members.filter((x) => x !== m);
            problems.push(...(await _deprovisionMember(g, ks, node, m.endpointId, m.clusters ?? [])).map((p) => `${_getDeviceName(node) ?? m.nodeId}/${m.endpointId}: ${p}`));
        } catch (err) {
            problems.push(`${m.nodeId}/${m.endpointId}: ${err.message}`);
        }
    }
    store.groups = store.groups.filter((x) => x !== g);
    if (ks && !ks.shared && !store.groups.some((x) => Number(x.keySetId) === Number(ks.id))) delete store.keySets[String(ks.id)];
    _saveGroups();
    await _registerGroupsInFabric();
    _log?.info(`matter: group "${g.name}" (${g.id}) deleted`);
    _broadcast?.({ type: 'matter:groups' });
    return { ok: true, problems };
}

/**
 * Add an endpoint to a group: key set and map entry on the device, AddGroup on the endpoint, the
 * group's ACL entry (guarded, read back). A failure is recorded on the member for the UI.
 * @param {string|number} ref  group id or name
 * @param {{ nodeId: string, endpointId: number, clusters?: (string|number)[] }} member
 */
async function addGroupMember(ref, { nodeId, endpointId, clusters }) {
    const store = _requireGroups();
    const g = _findGroup(ref);
    const node = _findClientNode(nodeId);
    const id = _nodeIdStr(node.peerAddress.nodeId);
    const ep = Number(endpointId);
    if (!Number.isInteger(ep) || ep < 1) throw new Error('endpointId must be an endpoint number ≥ 1');
    const clusterIds = clusters && clusters.length ? clusters.map(bindings.clusterIdOf) : _memberClusters(node, ep);
    const ks = store.keySets[String(g.keySetId)];
    if (!ks) throw new Error(`the group's key set ${g.keySetId} is missing from the store`);
    let m = g.members.find((x) => x.nodeId === id && Number(x.endpointId) === ep);
    if (!m) {
        m = { nodeId: id, endpointId: ep, clusters: clusterIds, status: 'pending', error: null, added: Date.now() };
        g.members.push(m);
    } else {
        m.clusters = clusterIds;
        m.status = 'pending';
        m.error = null;
    }
    _saveGroups();
    try {
        await _provisionMember(g, ks, node, ep, clusterIds);
        m.status = 'ok';
        m.error = null;
        _log?.info(`matter: ${_getDeviceName(node) ?? id}/${ep} joined group "${g.name}"`);
    } catch (err) {
        m.status = 'error';
        m.error = err.message;
        _log?.warn(`matter: ${_getDeviceName(node) ?? id}/${ep} could not join group "${g.name}": ${err.message}`);
        _saveGroups();
        _broadcast?.({ type: 'matter:groups' });
        throw err;
    }
    _saveGroups();
    _broadcast?.({ type: 'matter:groups' });
    return _groupView(g);
}

/** Remove an endpoint from a group; the device is cleaned when online (problems are reported, not thrown). */
async function removeGroupMember(ref, nodeId, endpointId) {
    const store = _requireGroups();
    const g = _findGroup(ref);
    const ep = Number(endpointId);
    const m = g.members.find((x) => String(x.nodeId) === String(nodeId) && Number(x.endpointId) === ep);
    if (!m) throw new Error(`${nodeId}/${endpointId} is not a member of group "${g.name}"`);
    g.members = g.members.filter((x) => x !== m);
    _saveGroups();
    let problems = [];
    try {
        const node = _findClientNode(m.nodeId);
        if (node.lifecycle?.isOnline) problems = await _deprovisionMember(g, store.keySets[String(g.keySetId)], node, ep, m.clusters ?? []);
        else problems.push('the device is offline — it keeps the group until it is removed again');
    } catch (err) {
        problems.push(err.message);
    }
    _broadcast?.({ type: 'matter:groups' });
    return { ok: true, problems, group: _groupView(g) };
}

/**
 * Send a command to a group — one multicast, no answer by design (best effort; a lost multicast
 * on Thread is not retried).
 * @param {string|number} ref  group id or name
 */
async function sendGroupCommand(ref, clusterName, commandName, args) {
    const g = _findGroup(ref);
    const { Invoke } = require('@matter/protocol');
    const { GroupId, NodeId } = require('@matter/types');
    const clusterDef = _clusterDef(clusterName);
    if (!clusterDef.commands?.[commandName]) throw new Error(`Command "${commandName}" not found in cluster "${clusterName}"`);
    const [fabric] = _ownFabrics();
    if (!fabric) throw new Error('she has no fabric yet');
    const address = { fabricIndex: fabric.fabricIndex, nodeId: NodeId.fromGroupId(GroupId(Number(g.id))) };
    const group = _server.peers.get(address) ?? (await _server.peers.forAddress(address));
    const merged = args !== undefined && args !== null && typeof args === 'object' ? { ...args } : {};
    for (const field of _mandatoryCommandFields({ cluster: clusterDef }, commandName)) {
        if (merged[field] !== undefined) continue;
        if (field === 'optionsMask' || field === 'optionsOverride') merged[field] = {};
        else if (field === 'transitionTime') merged[field] = 0;
    }
    const invoke = Invoke({ commands: [{ cluster: clusterDef, command: commandName, fields: merged }] });
    for await (const chunk of group.interaction.invoke(invoke)) {
        for (const _entry of chunk) {
            /* a group invoke has no response */
        }
    }
    _log?.debug(`matter: group "${g.name}" ← ${clusterName}.${commandName}`);
    return null;
}

/** A group binding: the source gets the group's key set and map entry, then a `{ group, cluster }` entry (M23). */
async function _addGroupBinding({ source, group, clusters }) {
    const store = _requireGroups();
    const g = _findGroup(group);
    const clusterIds = clusters.map(bindings.clusterIdOf);
    const sourceNode = _findClientNode(source.nodeId);
    _requireOnline(sourceNode, 'the source');
    const sourceEp = Number(source.endpointId);
    const ks = store.keySets[String(g.keySetId)];
    if (!ks) throw new Error(`the group's key set ${g.keySetId} is missing from the store`);
    await _ensureKeySetOnDevice(sourceNode, ks, g.id);
    const before = (await _readAttribute(sourceNode, sourceEp, 'binding', 'binding')) ?? [];
    const { bindings: after, added } = bindings.addBindingEntries(before, { group: g.id, clusters: clusterIds, fabricIndex: _deviceFabricIndex(sourceNode) });
    if (added.length) {
        await _writeAttribute(sourceNode, sourceEp, 'binding', 'binding', after);
        const back = (await _readAttribute(sourceNode, sourceEp, 'binding', 'binding')) ?? [];
        const bound = bindings.clustersStillBound(back, { group: g.id });
        const missing = clusterIds.filter((id) => !bound.includes(id));
        if (missing.length) throw new Error(`the source did not keep the group binding for cluster(s) ${missing.join(', ')}`);
    }
    _log?.info(`matter: group binding ${_getDeviceName(sourceNode) ?? source.nodeId}/${sourceEp} → "${g.name}"`);
    _broadcast?.({ type: 'matter:bindings' });
    return { ok: true, clusters: clusterIds, aclChanged: false, bindingsAdded: added, group: Number(g.id) };
}

async function _removeGroupBinding({ source, group, clusters }) {
    const store = _requireGroups();
    const clusterIds = clusters.map(bindings.clusterIdOf);
    const sourceNode = _findClientNode(source.nodeId);
    _requireOnline(sourceNode, 'the source');
    const sourceEp = Number(source.endpointId);
    const groupId = Number(group);
    const before = (await _readAttribute(sourceNode, sourceEp, 'binding', 'binding')) ?? [];
    const { bindings: after, removed } = bindings.removeBindingEntries(before, { group: groupId, clusters: clusterIds });
    if (removed.length) await _writeAttribute(sourceNode, sourceEp, 'binding', 'binding', after);
    let warning = null;
    const g = store.groups.find((x) => Number(x.id) === groupId);
    const id = _nodeIdStr(sourceNode.peerAddress.nodeId);
    const isMember = !!g?.members.some((m) => m.nodeId === id);
    if (!bindings.groupStillBound(after, groupId) && !isMember && g) {
        try {
            await _dropKeySetOnDevice(sourceNode, store.keySets[String(g.keySetId)], groupId);
        } catch (err) {
            warning = `the source keeps the group's key set: ${err.message}`;
        }
    }
    _broadcast?.({ type: 'matter:bindings' });
    return { ok: true, clusters: clusterIds, bindingsRemoved: removed, aclRevoked: false, warning };
}

// ── Firmware updates (M22) ────────────────────────────────────────────────────

/** @type {object|null} the OTA provider endpoint (matter.js Endpoint) */
let _ota = null;
/** nodeId → { info, checkedAt } — the updates the ledger offered, persisted across restarts */
let _updates = new Map();
let _updatesFile = null;
/** nodeId → 'done' | 'failed' | null — the last outcome, for the UI */
const _updateOutcome = new Map();

/** OTA requestor UpdateState (cluster 0x002A) names. */
const UPDATE_STATES = ['unknown', 'idle', 'querying', 'delayed on query', 'downloading', 'applying', 'delayed on apply', 'rolling back', 'delayed on user consent'];

function _loadUpdates() {
    _updates = new Map();
    if (!_updatesFile) return;
    try {
        const raw = JSON.parse(require('fs').readFileSync(_updatesFile, 'utf8'));
        for (const [k, v] of Object.entries(raw)) if (v && typeof v === 'object') _updates.set(k, v);
    } catch (err) {
        if (err.code !== 'ENOENT') _log?.warn(`matter: cannot read ${_updatesFile}: ${err.message}`);
    }
}

function _saveUpdates() {
    if (!_updatesFile) return;
    try {
        const fs = require('fs');
        fs.writeFileSync(_updatesFile + '.tmp', JSON.stringify(Object.fromEntries(_updates), null, 1));
        fs.renameSync(_updatesFile + '.tmp', _updatesFile);
    } catch (err) {
        _log?.warn(`matter: cannot write ${_updatesFile}: ${err.message}`);
    }
}

function _updateInfo(info) {
    return {
        softwareVersion: Number(info.softwareVersion),
        softwareVersionString: info.softwareVersionString ?? String(info.softwareVersion),
        releaseNotesUrl: info.releaseNotesUrl ?? null,
        vendorId: Number(info.vendorId),
        productId: Number(info.productId),
        source: info.source === undefined ? null : String(info.source),
    };
}

async function _setupOta(storagePath) {
    const { Endpoint } = require('@matter/main');
    const { OtaProviderEndpoint } = require('@matter/main/endpoints');
    const { SoftwareUpdateManager } = require('@matter/node');
    _updatesFile = require('path').join(storagePath, 'ota-updates.json');
    _loadUpdates();
    const ota = new Endpoint(OtaProviderEndpoint.with(SoftwareUpdateManager), {
        id: 'ota-provider',
        // never announce she as every device's default provider: updates start on a click only
        softwareupdates: { announceAsDefaultProvider: false },
    });
    await _server.add(ota);
    _ota = ota;
    const ev = ota.events.softwareupdates;
    ev.updateAvailable.on((peer, info) => {
        const nodeId = _nodeIdStr(peer.nodeId);
        _updates.set(nodeId, { info: _updateInfo(info), checkedAt: Date.now() });
        _saveUpdates();
        _log?.info(`matter: update available for node ${nodeId}: ${info.softwareVersionString ?? info.softwareVersion}`);
        _broadcast?.({ type: 'matter:update', nodeId, available: _updateInfo(info) });
    });
    ev.updateDone.on((peer) => {
        const nodeId = _nodeIdStr(peer.nodeId);
        _updates.delete(nodeId);
        _saveUpdates();
        _updateOutcome.set(nodeId, 'done');
        _log?.info(`matter: update of node ${nodeId} finished`);
        _broadcast?.({ type: 'matter:update', nodeId, outcome: 'done' });
    });
    ev.updateFailed.on((peer) => {
        const nodeId = _nodeIdStr(peer.nodeId);
        _updateOutcome.set(nodeId, 'failed');
        _log?.warn(`matter: update of node ${nodeId} failed or was cancelled`);
        _broadcast?.({ type: 'matter:update', nodeId, outcome: 'failed' });
    });
    _log?.info('matter: OTA provider ready (updates from the CSA ledger, started by the user only)');
}

/** Run a function with the SoftwareUpdateManager agent. */
function _withUpdates(label, fn) {
    if (!_ota) throw new Error('firmware updates are not available (DCL access is off or the OTA provider failed to start)');
    return _ota.act(label, (agent) => fn(agent.softwareupdates));
}

/** The update view of one node: versions, what the ledger offered, the requestor's state. */
function _nodeUpdateView(node, pending) {
    const nodeId = _nodeIdStr(node.peerAddress.nodeId);
    const bi = _rootState(node, 'basicInformation') ?? {};
    const req = _rootState(node, 'otaSoftwareUpdateRequestor') ?? {};
    const state = req.updateState === undefined || req.updateState === null ? null : Number(req.updateState);
    const known = _updates.get(nodeId);
    const current = bi.softwareVersion === undefined ? null : Number(bi.softwareVersion);
    const available = known?.info && (current === null || known.info.softwareVersion > current) ? known.info : null;
    const q = pending?.find((p) => _nodeIdStr(p.peerAddress.nodeId) === nodeId) ?? null;
    return {
        nodeId,
        name: _getDeviceName(node),
        online: node.lifecycle?.isOnline ?? false,
        vendorId: bi.vendorId === undefined ? null : Number(bi.vendorId),
        productId: bi.productId === undefined ? null : Number(bi.productId),
        softwareVersion: current,
        softwareVersionString: bi.softwareVersionString ?? null,
        hasRequestor: !!_rootState(node, 'otaSoftwareUpdateRequestor'),
        available,
        checkedAt: known?.checkedAt ?? null,
        updateState: state,
        updateStateName: state === null ? null : (UPDATE_STATES[state] ?? String(state)),
        updateStateProgress: req.updateStateProgress === undefined || req.updateStateProgress === null ? null : Number(req.updateStateProgress),
        pending: q
            ? {
                  status: q.status,
                  targetSoftwareVersion: Number(q.targetSoftwareVersion),
                  bdxTransferredBytes: q.bdxTransferredBytes ?? null,
                  bdxDataLength: q.bdxDataLength ?? null,
              }
            : null,
        outcome: _updateOutcome.get(nodeId) ?? null,
    };
}

/** All nodes with their firmware state (M22). */
async function listUpdates() {
    if (!_server) return { available: false, nodes: [] };
    let pending = [];
    if (_ota) {
        try {
            pending = await _withUpdates('she.matter.updates', (m) => m.queuedUpdates);
        } catch (err) {
            _log?.debug(`matter: reading the update queue failed: ${err.message}`);
        }
    }
    const nodes = [];
    for (const node of _server.peers) if (node.peerAddress) nodes.push(_nodeUpdateView(node, pending));
    return { available: !!_ota, nodes };
}

/**
 * Ask the ledger now — for one node, or for every online node. Returns the update view.
 * @param {string} [nodeId]
 */
async function checkUpdates(nodeId) {
    if (!_server) throw new Error('Matter controller not started');
    const peerToCheck = nodeId === undefined ? undefined : _findClientNode(nodeId);
    if (peerToCheck) _requireOnline(peerToCheck, 'the device');
    const found = await _withUpdates('she.matter.checkUpdates', (m) => m.queryUpdates(peerToCheck ? { peerToCheck } : {}));
    const seen = new Set();
    for (const { peerAddress, info } of found ?? []) {
        const id = _nodeIdStr(peerAddress.nodeId);
        seen.add(id);
        _updates.set(id, { info: _updateInfo(info), checkedAt: Date.now() });
    }
    // a node checked without a result has no update (any more)
    const checked = peerToCheck
        ? [_nodeIdStr(peerToCheck.peerAddress.nodeId)]
        : [..._server.peers].filter((n) => n.peerAddress && n.lifecycle?.isOnline).map((n) => _nodeIdStr(n.peerAddress.nodeId));
    for (const id of checked) {
        if (!seen.has(id)) _updates.set(id, { info: null, checkedAt: Date.now() });
    }
    for (const [id, v] of _updates) if (v.info === null) _updates.set(id, { info: null, checkedAt: v.checkedAt });
    _saveUpdates();
    _broadcast?.({ type: 'matter:update' });
    return listUpdates();
}

/**
 * Start the update of a node to the version the ledger offered (or the given one). Never
 * automatic: this is the user's click. One update per device at a time; the device must be idle.
 * @param {string} nodeId
 * @param {{ softwareVersion?: number }} [opts]
 */
async function startUpdate(nodeId, { softwareVersion } = {}) {
    const node = _findClientNode(nodeId);
    _requireOnline(node, 'the device');
    const id = _nodeIdStr(node.peerAddress.nodeId);
    const pending = await _withUpdates('she.matter.startUpdate', (m) => m.queuedUpdates);
    const view = _nodeUpdateView(node, pending);
    if (!view.hasRequestor) throw new Error('the device has no OTA requestor cluster — it cannot be updated over Matter');
    const target = softwareVersion !== undefined ? Number(softwareVersion) : view.available?.softwareVersion;
    if (!Number.isFinite(target)) throw new Error('no update is known for this device — check for updates first');
    if (view.softwareVersion !== null && target <= view.softwareVersion) throw new Error(`version ${target} is not newer than the installed ${view.softwareVersion}`);
    if (view.updateState !== null && view.updateState !== 1 && view.updateState !== 0) throw new Error(`the device is busy (${view.updateStateName}) — wait until it is idle`);
    if (view.pending) throw new Error(`an update to ${view.pending.targetSoftwareVersion} is already ${view.pending.status}`);
    const vendorId = view.vendorId;
    const productId = view.productId;
    if (vendorId === null || productId === null) throw new Error('the device reports no vendor/product ID');
    _updateOutcome.delete(id);
    await _withUpdates('she.matter.startUpdate', (m) => m.forceUpdate(node.peerAddress, vendorId, productId, target));
    _log?.info(`matter: update of node ${id} to ${target} started`);
    _broadcast?.({ type: 'matter:update', nodeId: id, started: target });
    return { ok: true, nodeId: id, targetSoftwareVersion: target };
}

/** Cancel a queued or running update (possible while querying or downloading). */
async function cancelUpdate(nodeId) {
    const node = _findClientNode(nodeId);
    const id = _nodeIdStr(node.peerAddress.nodeId);
    await _withUpdates('she.matter.cancelUpdate', (m) => m.removeConsent(node.peerAddress));
    _log?.info(`matter: update of node ${id} cancelled`);
    _broadcast?.({ type: 'matter:update', nodeId: id, outcome: 'cancelled' });
    return { ok: true, nodeId: id };
}

// ── Multi-admin: fabrics, pairing windows (M20) ───────────────────────────────

/** Vendor IDs of the common controllers, for when the ledger has no name (or is off). */
const KNOWN_FABRIC_VENDORS = { 0x1349: 'Apple', 0x6006: 'Google', 0x131d: 'Amazon', 0x10e1: 'SmartThings', 0x1393: 'Home Assistant', 0xfff1: 'matter.js (test vendor)' };

// nodeId → the codes of the pairing window she opened on that device
const _windows = new Map();

/** Run an invoke request on a node and return the response data; throws on a failure status. */
async function _invoke(node, invoke, what) {
    const { Status, StatusResponseError } = require('@matter/types');
    let data;
    for await (const chunk of node.interaction.invoke(invoke)) {
        for (const entry of chunk) {
            if (entry.kind === 'cmd-status' && entry.status !== Status.Success) {
                throw StatusResponseError.create(entry.status, `${what} failed`, entry.clusterStatus);
            }
            if (entry.kind === 'cmd-response') data = entry.data;
        }
    }
    return data;
}

/**
 * The fabrics a device belongs to (Operational Credentials `fabrics`, read with fabric filtering
 * off), each named after its label or its vendor; she's own fabric marked.
 * @param {string} nodeId
 */
async function listFabrics(nodeId) {
    const node = _findClientNode(nodeId);
    const oc = _rootState(node, 'operationalCredentials') ?? {};
    let fabrics = Array.isArray(oc.fabrics) ? oc.fabrics : [];
    let fresh = false;
    if (node.lifecycle?.isOnline) {
        try {
            fabrics = (await _readAttribute(node, 0, 'operationalCredentials', 'fabrics', { fabricFiltered: false })) ?? [];
            fresh = true;
        } catch (err) {
            _log?.debug(`matter: reading fabrics of ${nodeId} failed, using cached state: ${err.message}`);
        }
    }
    const current = _deviceFabricIndex(node);
    const ac = _rootState(node, 'administratorCommissioning') ?? {};
    const list = fabrics.map((f) => {
        const vendorId = f.vendorId === undefined || f.vendorId === null ? null : Number(f.vendorId);
        const fabricIndex = f.fabricIndex === undefined || f.fabricIndex === null ? null : Number(f.fabricIndex);
        const vendorName = vendorId === null ? null : (dcl.vendorName(vendorId) ?? KNOWN_FABRIC_VENDORS[vendorId] ?? null);
        const label = typeof f.label === 'string' ? f.label : '';
        const own = fabricIndex !== null && current !== undefined && fabricIndex === current;
        return {
            fabricIndex,
            fabricId: f.fabricId === undefined || f.fabricId === null ? null : String(f.fabricId),
            nodeId: f.nodeId === undefined || f.nodeId === null ? null : String(f.nodeId),
            vendorId,
            vendorName,
            label,
            own,
            name: own ? label || 'she' : label || vendorName || (vendorId === null ? 'unknown' : `vendor 0x${vendorId.toString(16).padStart(4, '0')}`),
        };
    });
    const win = _windows.get(_nodeIdStr(node.peerAddress.nodeId));
    return {
        nodeId: _nodeIdStr(node.peerAddress.nodeId),
        fresh,
        fabrics: list,
        supportedFabrics: oc.supportedFabrics === undefined ? null : Number(oc.supportedFabrics),
        commissionedFabrics: oc.commissionedFabrics === undefined ? null : Number(oc.commissionedFabrics),
        window: {
            status: ac.windowStatus === undefined || ac.windowStatus === null ? null : Number(ac.windowStatus), // 0 closed, 1 enhanced, 2 basic
            adminFabricIndex: ac.adminFabricIndex === undefined || ac.adminFabricIndex === null ? null : Number(ac.adminFabricIndex),
            adminVendorId: ac.adminVendorId === undefined || ac.adminVendorId === null ? null : Number(ac.adminVendorId),
            codes: win && win.expiresAt > Date.now() ? win : null,
        },
    };
}

/**
 * Open an enhanced commissioning window on a device so another app (Apple Home, Home Assistant,
 * …) can add it: a random passcode and discriminator, the PAKE verifier computed here, the timed
 * OpenCommissioningWindow command, and the QR payload and manual code to show.
 * @param {string} nodeId
 * @param {{ timeoutSeconds?: number }} [opts]  the window length, 180 … 900 s (Matter's limits)
 */
async function openCommissioningWindow(nodeId, { timeoutSeconds = 900 } = {}) {
    const node = _findClientNode(nodeId);
    _requireOnline(node, 'the device');
    const timeout = Math.min(900, Math.max(180, Number(timeoutSeconds) || 900));
    const { PaseClient, Invoke } = require('@matter/protocol');
    const { Crypto } = require('@matter/general');
    const { QrPairingCodeCodec, ManualPairingCodeCodec, DiscoveryCapabilitiesSchema } = require('@matter/types');
    const clusters = require('@matter/main/clusters');
    const crypto = _server.env.get(Crypto);
    const passcode = PaseClient.generateRandomPasscode(crypto);
    const discriminator = PaseClient.generateRandomDiscriminator(crypto);
    const salt = require('crypto').randomBytes(32);
    const iterations = 1000;
    const pakePasscodeVerifier = await PaseClient.generatePakePasscodeVerifier(crypto, passcode, { iterations, salt });
    const invoke = Invoke({
        timed: true,
        commands: [
            Invoke.ConcreteCommandRequest({
                endpoint: 0,
                cluster: clusters.AdministratorCommissioning.Complete,
                command: 'openCommissioningWindow',
                fields: { commissioningTimeout: timeout, pakePasscodeVerifier, discriminator, iterations, salt },
            }),
        ],
    });
    await _invoke(node, invoke, 'OpenCommissioningWindow');
    const bi = _rootState(node, 'basicInformation') ?? {};
    const vendorId = Number(bi.vendorId ?? 0);
    const productId = Number(bi.productId ?? 0);
    const qrCode = QrPairingCodeCodec.encode([
        { version: 0, vendorId, productId, flowType: 0, discoveryCapabilities: DiscoveryCapabilitiesSchema.encode({ onIpNetwork: true }), discriminator, passcode },
    ]);
    const manualCode = ManualPairingCodeCodec.encode({ discriminator, passcode });
    const id = _nodeIdStr(node.peerAddress.nodeId);
    const win = { passcode, discriminator, qrCode, manualCode, openedAt: Date.now(), expiresAt: Date.now() + timeout * 1000, timeoutSeconds: timeout };
    _windows.set(id, win);
    _log?.info(`matter: commissioning window opened on node ${id} for ${timeout} s (discriminator ${discriminator})`);
    _broadcast?.({ type: 'matter:fabrics', nodeId: id });
    return win;
}

/** Close a pairing window early (RevokeCommissioning, timed). */
async function closeCommissioningWindow(nodeId) {
    const node = _findClientNode(nodeId);
    _requireOnline(node, 'the device');
    const { Invoke } = require('@matter/protocol');
    const clusters = require('@matter/main/clusters');
    const invoke = Invoke({
        timed: true,
        commands: [Invoke.ConcreteCommandRequest({ endpoint: 0, cluster: clusters.AdministratorCommissioning.Complete, command: 'revokeCommissioning', fields: {} })],
    });
    const id = _nodeIdStr(node.peerAddress.nodeId);
    try {
        await _invoke(node, invoke, 'RevokeCommissioning');
    } catch (err) {
        // WindowNotOpen (cluster status 4) when it already closed — not a failure for the user
        if (!/WindowNotOpen|clusterStatus.*4\b|status 4\b/i.test(err.message) && err.clusterStatus !== 4) throw err;
    }
    _windows.delete(id);
    _log?.info(`matter: commissioning window on node ${id} closed`);
    _broadcast?.({ type: 'matter:fabrics', nodeId: id });
}

/**
 * Remove another controller's fabric from a device (Operational Credentials RemoveFabric). she's
 * own fabric cannot be removed this way — that is "unpair".
 * @param {string} nodeId
 * @param {number} fabricIndex  the device's index of that fabric (from listFabrics)
 */
async function removeFabric(nodeId, fabricIndex) {
    const node = _findClientNode(nodeId);
    _requireOnline(node, 'the device');
    const fi = Number(fabricIndex);
    if (!Number.isInteger(fi) || fi < 1) throw new Error('fabricIndex must be a positive integer');
    if (fi === _deviceFabricIndex(node)) throw new Error("that is she's own fabric — unpair the device instead");
    const id = _nodeIdStr(node.peerAddress.nodeId);
    const result = await sendCommand(id, 0, 'operationalCredentials', 'removeFabric', { fabricIndex: fi });
    const status = result?.statusCode === undefined ? 0 : Number(result.statusCode);
    if (status !== 0) throw new Error(`the device refused to remove fabric ${fi}: status ${status}${result?.debugText ? ' (' + result.debugText + ')' : ''}`);
    _log?.info(`matter: removed fabric ${fi} from node ${id}`);
    _broadcast?.({ type: 'matter:fabrics', nodeId: id });
    return { ok: true, fabricIndex: fi };
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
/** Matter's attribute OIDs (1.3.6.1.4.1.37244.1.x, Matter core spec 6.5.6.1) by name. */
const MATTER_DN_OIDS = {
    '1.3.6.1.4.1.37244.1.1': 'matter-node-id',
    '1.3.6.1.4.1.37244.1.2': 'matter-firmware-signing-id',
    '1.3.6.1.4.1.37244.1.3': 'matter-icac-id',
    '1.3.6.1.4.1.37244.1.4': 'matter-rcac-id',
    '1.3.6.1.4.1.37244.1.5': 'matter-fabric-id',
    '1.3.6.1.4.1.37244.1.6': 'matter-noc-cat',
};

/** node's X509Certificate distinguished name ("oid=value\n…") with Matter's OIDs named */
function _matterDn(dn) {
    return String(dn || '')
        .split('\n')
        .filter(Boolean)
        .map((part) => {
            const eq = part.indexOf('=');
            const key = part.slice(0, eq);
            return `${MATTER_DN_OIDS[key] || key}=${part.slice(eq + 1)}`;
        })
        .join(', ');
}

/**
 * A Matter operational certificate (TLV, as the OperationalCredentials cluster holds it) as
 * `{ $cert: { kind, subject, validFrom, validTo, fingerprint, pem } }`: converted to X.509 DER by
 * matter.js, read back by node's X509Certificate. Anything that does not convert stays `$bytes`.
 */
function _certValue(kind, bytes) {
    if (!ArrayBuffer.isView(bytes)) return _jsonSafe(bytes);
    try {
        const { Noc, Icac, Rcac } = require('@matter/protocol');
        const cert = { NOC: Noc, ICAC: Icac, RCAC: Rcac }[kind].fromTlv(bytes);
        const der = Buffer.from(cert.asSignedDer());
        const x509 = new (require('crypto').X509Certificate)(der);
        const lines = der
            .toString('base64')
            .match(/.{1,64}/g)
            .join('\n');
        return {
            $cert: {
                kind,
                // Matter's own fields (nodeId, fabricId, rcacId, icacId, caseAuthenticatedTags …)
                subject: _jsonSafe(cert.cert.subject),
                issuer: _jsonSafe(cert.cert.issuer),
                // the same as X.509 distinguished names, with Matter's OIDs named
                subjectDn: _matterDn(x509.subject),
                issuerDn: _matterDn(x509.issuer),
                serialNumber: x509.serialNumber,
                validFrom: new Date(x509.validFrom).toISOString(),
                validTo: new Date(x509.validTo).toISOString(),
                ca: x509.ca,
                // key usage, extended key usage, basic constraints, key identifiers — all the
                // certificate carries; Matter operational certificates have no CRL distribution point
                extensions: _jsonSafe(cert.cert.extensions),
                fingerprint: x509.fingerprint256,
                pem: `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----`,
            },
        };
    } catch {
        return _jsonSafe(bytes);
    }
}

/** An attribute value for the UI and the REST API: certificates as PEM, the rest via _jsonSafe. */
function _attrValue(clusterName, attrName, value) {
    if (clusterName === 'operationalCredentials') {
        if (attrName === 'nocs' && Array.isArray(value)) {
            return value.map((entry) => {
                const out = _jsonSafe(entry);
                if (entry?.noc) out.noc = _certValue('NOC', entry.noc);
                if (entry?.icac) out.icac = _certValue('ICAC', entry.icac);
                return out;
            });
        }
        if (attrName === 'trustedRootCertificates' && Array.isArray(value)) {
            return value.map((root) => _certValue('RCAC', root));
        }
    }
    return _jsonSafe(value);
}

/**
 * The names (camelCase) of a cluster's events — from the client behavior's model (what matter.js
 * generated for the discovered cluster), else from the standard cluster definition. Events live in
 * the same per-cluster table as the attribute change events (`endpoint.events[cluster]`), keyed by
 * their bare name; attribute and event names of a cluster never collide (M18).
 * @param {object} endpoint
 * @param {string} clusterName
 * @returns {string[]}
 */
function _clusterEventNames(endpoint, clusterName) {
    const names = new Set();
    try {
        const schema = endpoint.behaviors?.supported?.[clusterName]?.schema;
        if (schema?.children) {
            for (const c of schema.children) if (c.tag === 'event' && c.name) names.add(_camelize(c.name));
        }
    } catch {
        /* best-effort */
    }
    if (names.size === 0) {
        try {
            const clusters = require('@matter/main/clusters');
            const def = clusters[clusterName.charAt(0).toUpperCase() + clusterName.slice(1)]?.Complete;
            for (const k of Object.keys(def?.events ?? {})) names.add(k);
        } catch {
            /* best-effort */
        }
    }
    return [...names];
}

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
                            value: _attrValue(clusterName, attrName, value),
                            ts: Date.now(),
                        });
                        // Device/endpoint labels feed the device list — rebroadcast it
                        // when they change. This is also what completes a rename():
                        // the local mirror only learns the new nodeLabel when the
                        // device's subscription report arrives, i.e. exactly now.
                        if (attrName === 'nodeLabel' || attrName === 'productName') {
                            _broadcast?.({ type: 'matter:deviceList', devices: listPaired() });
                        }
                    });
                    count++;
                }
                // Cluster events (Switch.initialPress, multiPressComplete, …) go to the feed as
                // well: the UI shows them typed matter:event (M18).
                for (const eventName of _clusterEventNames(endpoint, clusterName)) {
                    const ev = clusterEvents[eventName];
                    if (!ev || typeof ev.on !== 'function') continue;
                    ev.on((payload) => {
                        _broadcast?.({
                            type: 'matter:event',
                            nodeId,
                            endpointId,
                            clusterName,
                            eventName,
                            value: _jsonSafe(payload),
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
    // An attribute's change event, or — when `attrName` is not an attribute — the cluster event of
    // that name (Switch.multiPressComplete …), so button presses reach scripts through the same
    // call (M18). An event callback gets the payload and `{ event: true, cluster, name, ts }`.
    let changeEvent = events[`${attrName}$Changed`];
    let isEvent = false;
    if (!changeEvent) {
        changeEvent = events[attrName];
        isEvent = true;
    }
    if (!changeEvent || typeof changeEvent.on !== 'function') {
        throw new Error(`"${attrName}" is neither an attribute with a change event nor an event of cluster "${clusterName}"`);
    }

    const listenerId = _nextListenerId++;
    const observer = (value, oldValue) => {
        try {
            if (isEvent) callback(value, { event: true, cluster: clusterName, name: attrName, ts: Date.now() });
            else callback(value, oldValue);
        } catch (err) {
            _log?.error(`matter subscriber error in ${scriptFile}:`, err.message);
        }
    };
    // Observable.on() returns void — detaching needs off() with the same
    // observer reference. (A cancel based on on()'s return value silently did
    // nothing, leaking one listener per hot-reload.)
    changeEvent.on(observer);
    const cancel = () => changeEvent.off(observer);

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
    let cancelled = 0;
    for (const { cancel } of scriptListeners.values()) {
        try {
            cancel();
            cancelled++;
        } catch (err) {
            // Don't swallow silently — a broken cancel means a leaked listener
            // (this hid the on()-returns-void bug above for a long time).
            _log?.warn(`matter: failed to cancel a subscription of ${scriptFile}: ${err.message}`);
        }
    }
    if (cancelled > 0) _log?.debug(`matter: cancelled ${cancelled} subscription(s) of ${scriptFile}`);
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

/**
 * Vendor and product details for a node from the CSA ledger (M25): what the ledger says about
 * the vendor/product IDs the device reports.
 * @param {string} nodeId
 */
async function getDeviceInfo(nodeId) {
    const node = _findClientNode(nodeId);
    const bi = _rootState(node, 'basicInformation') ?? {};
    const info = await dcl.deviceInfo(bi);
    return {
        ...info,
        reported: {
            vendorName: bi.vendorName ?? null,
            productName: bi.productName ?? null,
            productLabel: bi.productLabel ?? null,
            productUrl: bi.productUrl ?? null,
            partNumber: bi.partNumber ?? null,
            softwareVersion: bi.softwareVersion === undefined ? null : Number(bi.softwareVersion),
            softwareVersionString: bi.softwareVersionString ?? null,
            hardwareVersionString: bi.hardwareVersionString ?? null,
            serialNumber: bi.serialNumber ?? null,
        },
    };
}

function isStarted() {
    return _server !== null;
}

module.exports = {
    // for the unit tests: the value conversion, without a running controller
    _attrValue,
    init,
    close,
    isStarted,
    listPaired,
    commission,
    unpair,
    getEndpoints,
    getDeviceSubtitle,
    getDeviceInfo,
    getAttribute,
    setAttribute,
    rename,
    sendCommand,
    listGroups,
    createGroup,
    renameGroup,
    deleteGroup,
    addGroupMember,
    removeGroupMember,
    sendGroupCommand,
    listUpdates,
    checkUpdates,
    startUpdate,
    cancelUpdate,
    listFabrics,
    openCommissioningWindow,
    closeCommissioningWindow,
    removeFabric,
    listBindings,
    bindingCandidates,
    addBinding,
    removeBinding,
    subscribeAttribute,
    unsubscribe,
    cleanup,
};
