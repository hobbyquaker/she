'use strict';

/**
 * dynsec — Dynamic Security plugin client for Mosquitto.
 *
 * Creates a dedicated MQTT connection using the she-admin credentials from
 * config.broker.dynsec.{adminUsername, adminPassword}. All dynsec commands
 * are serialised through a single-inflight request queue so concurrent calls
 * do not confuse the response-correlation logic (the dynsec protocol has no
 * request IDs).
 *
 * Usage:
 *   const dynsec = require('./dynsec');
 *   dynsec.init(config, log);
 *
 *   const { connected } = dynsec.getStatus();
 *   const users = await dynsec.listClients(true);
 */

const mqtt = require('mqtt');

const CONTROL_TOPIC = '$CONTROL/dynamic-security/v1';
const RESPONSE_TOPIC = '$CONTROL/dynamic-security/v1/response';

let _client = null;
let _connected = false;
let _configured = false;
let _dynsecReady = false;
let _timeout = 5000;
let _log = null;

// Serial request queue — one in-flight request at a time
const _queue = [];
let _inflight = false;
let _inflightResolve = null;

// $SYS topic cache — populated by the she-admin MQTT connection which has
// the admin role and therefore $SYS/# subscribe + publishClientReceive ACLs.
const _sysData = {};

function _drain() {
    if (_inflight || _queue.length === 0 || !_connected) return;

    const { command, payload, resolve, reject } = _queue.shift();
    _inflight = true;

    const safePayload = { ...payload };
    if ('password' in safePayload) safePayload.password = '***';
    if (_log) _log.debug(`dynsec: → sending "${command}"`, JSON.stringify(safePayload));

    const timer = setTimeout(() => {
        _inflight = false;
        _inflightResolve = null;
        if (_log) _log.warn(`dynsec: timeout waiting for response to "${command}" (${_timeout}ms) — is the dynsec plugin loaded and the admin user configured?`);
        reject(new Error(`dynsec timeout waiting for response to "${command}"`));
        // Fail-fast: reject all remaining queued commands since the broker is not responding
        while (_queue.length > 0) {
            const queued = _queue.shift();
            queued.reject(new Error(`dynsec: aborting "${queued.command}" — previous command timed out`));
        }
    }, _timeout);

    _inflightResolve = (responses) => {
        clearTimeout(timer);
        _inflight = false;
        _inflightResolve = null;
        const r = responses.find((resp) => resp.command === command);
        if (r && r.error) {
            if (_log) _log.debug(`dynsec: ✕ "${command}" error: ${r.error}`);
            reject(new Error(r.error));
        } else {
            if (_log) _log.debug(`dynsec: ✓ "${command}" ok`);
            resolve(r || {});
        }
        _drain();
    };

    _client.publish(CONTROL_TOPIC, JSON.stringify({ commands: [{ command, ...payload }] }));
}

function _request(command, payload = {}) {
    if (!_configured) {
        return Promise.reject(new Error('she.broker: dynsec not configured — set broker.dynsec in config.json'));
    }
    if (!_connected) {
        if (_log) _log.debug(`dynsec: request "${command}" rejected — not connected (queue length: ${_queue.length})`);
        return Promise.reject(new Error('she.broker: dynsec not connected'));
    }
    const safePayload = { ...payload };
    if ('password' in safePayload) safePayload.password = '***';
    if (_log) _log.debug(`dynsec: queuing "${command}" (queue length: ${_queue.length}, inflight: ${_inflight})`, JSON.stringify(safePayload));
    return new Promise((resolve, reject) => {
        _queue.push({ command, payload, resolve, reject });
        _drain();
    });
}

/**
 * Initialise the dynsec client. No-op if broker.dynsec is not set in config.
 * @param {object} config   - she config object
 * @param {object} log      - she log object
 */
function init(config, log) {
    _log = log;
    _timeout = (config.broker && config.broker.apiTimeout) || 5000;

    const dynsecCfg = config.broker && config.broker.dynsec;
    if (!dynsecCfg || !dynsecCfg.adminUsername || !dynsecCfg.adminPassword) {
        _log.debug('dynsec: not configured, she.broker API disabled');
        return;
    }
    if (!config.url) {
        _log.warn('dynsec: no broker URL configured, she.broker API disabled');
        return;
    }

    _configured = true;

    const opts = {
        username: dynsecCfg.adminUsername,
        password: dynsecCfg.adminPassword,
        clientId: 'she-dynsec-' + Math.random().toString(16).slice(2, 10),
        clean: true,
    };
    // Inherit TLS options from main config so dynsec works over TLS-secured brokers
    if (config.mqttCa) opts.ca = config.mqttCa;
    if (config.mqttCert) opts.cert = config.mqttCert;
    if (config.mqttKey) opts.key = config.mqttKey;
    if (config.mqttVersion === '5') opts.protocolVersion = 5;

    _client = mqtt.connect(config.url, opts);

    _client.on('connect', () => {
        _log.info('dynsec: MQTT connect event, subscribing to response topic');
        _client.subscribe(RESPONSE_TOPIC, (err) => {
            if (err) {
                _log.error('dynsec: failed to subscribe to response topic:', err.message);
            } else {
                _connected = true;
                _log.info('dynsec: ready — subscribed as', dynsecCfg.adminUsername);
                _drain(); // flush any requests queued before connection
                // Probe whether the plugin is actually loaded and responding
                _request('getDefaultACLAccess').then(() => {
                    _dynsecReady = true;
                    _log.info('dynsec: plugin confirmed active');
                }).catch((err) => {
                    _dynsecReady = false;
                    _log.warn('dynsec: plugin probe failed — is the dynamic-security plugin loaded in mosquitto.conf?', err.message);
                });
            }
        });
        // The admin role has subscribePattern + publishClientReceive for $SYS/#.
        // Subscribe here so the broker status endpoint always has fresh $SYS data
        // even when the main MQTT client lacks the necessary ACL permissions.
        _client.subscribe('$SYS/#', (err) => {
            if (err) _log.debug('dynsec: $SYS/# subscription failed (not critical):', err.message);
        });
    });

    _client.on('close', () => {
        if (_connected) {
            _connected = false;
            _dynsecReady = false;
            _log.warn('dynsec: disconnected');
        }
    });

    _client.on('error', (err) => {
        _log.error('dynsec: MQTT error:', err.message);
    });

    _client.on('message', (topic, payload) => {
        if (topic.startsWith('$SYS/')) {
            const val = payload.toString();
            const now = Date.now();
            const prev = _sysData[topic];
            _sysData[topic] = { val, ts: now, lc: prev && prev.val !== val ? now : (prev ? prev.lc : now) };
            return;
        }
        if (topic !== RESPONSE_TOPIC) return;
        let msg;
        try {
            msg = JSON.parse(payload.toString());
        } catch {
            _log.error('dynsec: invalid JSON on response topic');
            return;
        }
        const cmds = Array.isArray(msg.responses) ? msg.responses.map((r) => r.command).join(', ') : 'none';
        if (_log) _log.debug(`dynsec: ← response received, commands: [${cmds}]`);
        if (_inflightResolve && Array.isArray(msg.responses)) {
            _inflightResolve(msg.responses);
        } else if (!_inflightResolve) {
            if (_log) _log.debug(`dynsec: unexpected response (no inflight request), commands: [${cmds}]`);
        }
    });
}

/** @returns {{ connected: boolean, configured: boolean, dynsecReady: boolean }} */
function getStatus() {
    return { connected: _connected, configured: _configured, dynsecReady: _dynsecReady };
}

/**
 * Permanently stop the dynsec client (called when dynsec is deactivated).
 * Ends the MQTT connection without reconnect, rejects all pending requests,
 * and marks the client as unconfigured so it will not try to reconnect.
 */
function stop() {
    _configured = false;
    _connected = false;
    _dynsecReady = false;
    // Clear $SYS cache
    Object.keys(_sysData).forEach((k) => delete _sysData[k]);
    // Reject any in-flight / queued requests
    if (_inflight && _inflightResolve) {
        _inflightResolve = null;
        _inflight = false;
    }
    while (_queue.length > 0) {
        const { reject } = _queue.shift();
        reject(new Error('dynsec stopped'));
    }
    if (_client) {
        _client.end(true); // force=true — skip DISCONNECT, prevent auto-reconnect
        _client = null;
    }
    if (_log) _log.info('dynsec: stopped');
}

// ── User management ────────────────────────────────────────────────────────────

function createClient(username, password, options = {}) {
    return _request('createClient', { username, password, ...options });
}

function deleteClient(username) {
    return _request('deleteClient', { username });
}

function setClientPassword(username, password) {
    return _request('modifyClient', { username, password });
}

function listClients(verbose = false) {
    return _request('listClients', { verbose }).then((r) => r.data?.clients ?? r.clients ?? []);
}

function getClient(username) {
    return _request('getClient', { username }).then((r) => r.data?.client ?? r.client);
}

// ── Role management ────────────────────────────────────────────────────────────

function createRole(rolename, options = {}) {
    return _request('createRole', { rolename, ...options });
}

function deleteRole(rolename) {
    return _request('deleteRole', { rolename });
}

function listRoles(verbose = false) {
    return _request('listRoles', { verbose }).then((r) => r.data?.roles ?? r.roles ?? []);
}

function getRole(rolename) {
    return _request('getRole', { rolename }).then((r) => r.data?.role ?? r.role);
}

/**
 * @param {string} rolename
 * @param {string} acltype  'publishClientSend'|'publishClientReceive'|
 *                          'subscribeLiteral'|'subscribePattern'|
 *                          'unsubscribeLiteral'|'unsubscribePattern'
 * @param {string}  topic
 * @param {boolean} allow
 * @param {number}  [priority=-1]
 */
function addRoleACL(rolename, acltype, topic, allow, priority = -1) {
    return _request('addRoleACL', { rolename, acltype, topic, allow, priority });
}

function removeRoleACL(rolename, acltype, topic) {
    return _request('removeRoleACL', { rolename, acltype, topic });
}

// ── Role ↔ client assignment ───────────────────────────────────────────────────

function addClientRole(username, rolename, priority = -1) {
    return _request('addClientRole', { username, rolename, priority });
}

function removeClientRole(username, rolename) {
    return _request('removeClientRole', { username, rolename });
}

// ── Group management ───────────────────────────────────────────────────────────

function createGroup(groupname) {
    return _request('createGroup', { groupname });
}

function deleteGroup(groupname) {
    return _request('deleteGroup', { groupname });
}

function listGroups(verbose = false) {
    return _request('listGroups', { verbose }).then((r) => r.data?.groups ?? r.groups ?? []);
}

function getGroup(groupname) {
    return _request('getGroup', { groupname }).then((r) => r.data?.group ?? r.group);
}

function addGroupClient(groupname, username, priority = -1) {
    return _request('addGroupClient', { groupname, username, priority });
}

function removeGroupClient(groupname, username) {
    return _request('removeGroupClient', { groupname, username });
}

function addGroupRole(groupname, rolename, priority = -1) {
    return _request('addGroupRole', { groupname, rolename, priority });
}

function removeGroupRole(groupname, rolename) {
    return _request('removeGroupRole', { groupname, rolename });
}

// ── Default ACL access ─────────────────────────────────────────────────────────

function getDefaultACLAccess() {
    return _request('getDefaultACLAccess').then((r) => r.data?.acls ?? r.acls ?? []);
}

/** Returns the $SYS topic cache collected by the she-admin MQTT client. */
function getSysData() {
    return { ..._sysData };
}

function setDefaultACLAccess(acls) {
    return _request('setDefaultACLAccess', { acls });
}

module.exports = {
    init,
    getStatus,
    getSysData,
    stop,
    // Users
    createClient,
    deleteClient,
    setClientPassword,
    listClients,
    getClient,
    // Roles
    createRole,
    deleteRole,
    listRoles,
    getRole,
    addRoleACL,
    removeRoleACL,
    // Role assignments
    addClientRole,
    removeClientRole,
    // Groups
    createGroup,
    deleteGroup,
    listGroups,
    getGroup,
    addGroupClient,
    removeGroupClient,
    addGroupRole,
    removeGroupRole,
    // Default ACLs
    getDefaultACLAccess,
    setDefaultACLAccess,
};
