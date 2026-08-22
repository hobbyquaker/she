'use strict';

/**
 * Services API — management of xyz2mqtt adapter instances (roadmap I4).
 * Mounted at /she/services in server.js; behind the auth middleware.
 *
 * Tier 0 (MQTT only):
 *   GET    /she/services/instances                 inventory from retained <name>/info + <name>/connected
 *   POST   /she/services/instances/:name/restart   publish <name>/maintenance/set/restart
 *   POST   /she/services/instances/:name/loglevel  { level } → <name>/maintenance/set/loglevel
 *   GET    /she/services/instances/:name/retained  topics a wipe would clear
 *   DELETE /she/services/instances/:name/retained  clear them (only while connected = 0)
 *
 * Tier 1 (hosts via systemd, through the she-servicectl helper — local driver in I4, ssh in I5):
 *   GET    /she/services/hosts                                       every configured host: helper list or error
 *   GET    /she/services/hosts/:host/adapters/:adapter/schema        --config-schema (cached)
 *   POST   /she/services/hosts/:host/adapters/:adapter/install       { instance, env } → <adapter> --install
 *   POST   /she/services/hosts/:host/adapters/:adapter/update        { force? } → npm install -g, restart instances
 *   POST   /she/services/hosts/:host/units/:adapter/:instance/:action start|stop|restart|enable|disable
 *   DELETE /she/services/hosts/:host/units/:adapter/:instance        <adapter> --uninstall
 *   GET    /she/services/hosts/:host/units/:adapter/:instance/logs   journal tail (?n=)
 *   POST   /she/services/hosts/:host/units/:adapter/:instance/logs/follow   start/renew a journal follower (serviceLog WS)
 *   DELETE /she/services/hosts/:host/units/:adapter/:instance/logs/follow   stop it
 *   GET    /she/services/hosts/:host/units/:adapter/:instance/env    env file, secrets masked
 *   PUT    /she/services/hosts/:host/units/:adapter/:instance/env    { env, restart? }
 *   GET    /she/services/hosts/:host/broker-env                      /etc/mqtt-interfaces/broker.env
 *   PUT    /she/services/hosts/:host/broker-env                      { env }
 *   GET    /she/services/ssh/pubkey                                  public key of the services identity (I5)
 *   POST   /she/services/ssh/keygen                                  generate it
 *   POST   /she/services/hosts/:host/test                            run `she-servicectl version` → ok / code
 *   POST   /she/services/hosts/:host/helper/deploy                   scp the helper to a remote host, install it, print the sudoers line
 *   POST   /she/services/setup/token                                 mint a one-time token + the curl | bash command (I9)
 *   GET    /she/services/setup/token/:token                          its state: pending | fetched | done | expired
 *   GET    /she/services/setup.sh?token=…                            (no auth) the bootstrap script, served once
 *   POST   /she/services/setup/done?token=…                          (no auth) callback from the script → host entry is added
 *
 * Call init(store, getMqttClient, {getMqttConfig}) once; getMqttConfig returns she's own broker
 * settings ({url, username, password}) so every managed host's broker.env can be kept in sync.
 */

const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const { analyzeServices, wipeTopics, LOG_LEVELS } = require('../lib/services-inventory');
const npmRegistry = require('../lib/npm-registry');
const os = require('os');
const path = require('path');
const {
    createLocalDriver,
    createSshDriver,
    parseList,
    parseJournal,
    parseEnvFile,
    formatEnvFile,
    secretEnvVars,
    shellQuote,
    HostError,
    HELPER,
    HELPER_SOURCE,
} = require('../lib/services-host');
const sshDeploy = require('../lib/ssh-deploy');
const { STORAGE_ROOT } = require('../lib/storage');
const { broadcast } = require('./log-ws');

/** One key for all managed hosts, next to the broker key. */
let SERVICES_IDENTITY = path.join(STORAGE_ROOT, 'ssh', 'services_id_ed25519');
/** Test hook: use a throw-away identity path. */
function setIdentityPath(p) {
    SERVICES_IDENTITY = p;
}
/** The user the bootstrap script creates on remote hosts (I9). */
const REMOTE_USER = 'she-services';

const router = express.Router();

let _store = null;
let _getMqtt = () => null;
let _getMqttConfig = () => null;

function init(store, getMqttClient, { getMqttConfig } = {}) {
    _store = store;
    _getMqtt = getMqttClient;
    _getMqttConfig = typeof getMqttConfig === 'function' ? getMqttConfig : () => null;
}

/** Live `services` block from config.json (like broker-api's getBrokerConfig). */
function getServicesConfig(req) {
    const configPath = req.app.locals.configPath;
    if (!configPath) return {};
    try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return cfg.services && typeof cfg.services === 'object' ? cfg.services : {};
    } catch {
        return {};
    }
}

/** Instance names are topic prefixes; the core's instanceName() rule plus no wildcards/slashes. */
function validInstance(name) {
    return typeof name === 'string' && /^[A-Za-z0-9_.-]+$/.test(name);
}

function findInstance(name) {
    if (!_store) return null;
    const { instances } = analyzeServices(_store.mqttEntries());
    return instances.find((i) => i.instance === name) || null;
}

function publish(topic, payload) {
    const mqtt = _getMqtt();
    if (!mqtt) return Promise.reject(Object.assign(new Error('MQTT not connected'), { status: 503 }));
    return new Promise((resolve, reject) => {
        mqtt.publish(topic, payload, { retain: false, qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });
}

// GET /she/services/instances
router.get('/instances', async (req, res) => {
    if (!_store) return res.json({ enabled: false, instances: [], coreCount: 0, legacyCount: 0 });
    const cfg = getServicesConfig(req);
    const result = analyzeServices(_store.mqttEntries());
    // update badge: one registry lookup per adapter (cached 24 h)
    const adapters = [...new Set(result.instances.filter((i) => i.adapter).map((i) => i.adapter))];
    const latest = new Map(await Promise.all(adapters.map(async (a) => [a, await npmRegistry.latestVersion(a)])));
    const instances = await Promise.all(
        result.instances.map(async (i) => {
            if (!i.adapter) return { ...i, latestVersion: null, updateAvailable: null };
            const { updateAvailable } = await npmRegistry.updateInfo(i.adapter, i.version);
            return { ...i, latestVersion: latest.get(i.adapter) ?? null, updateAvailable };
        }),
    );
    res.json({ enabled: cfg.enabled === true, ...result, instances });
});

// POST /she/services/instances/:name/restart
router.post('/instances/:name/restart', async (req, res) => {
    const name = req.params.name;
    if (!validInstance(name)) return res.status(400).json({ error: 'invalid instance name' });
    const inst = findInstance(name);
    if (!inst) return res.status(404).json({ error: 'unknown instance' });
    if (inst.legacy) return res.status(409).json({ error: 'legacy instance has no maintenance topics' });
    if (!inst.maintenance) return res.status(409).json({ error: 'instance runs with --no-maintenance' });
    try {
        await publish(`${name}/maintenance/set/restart`, '');
        res.json({ ok: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /she/services/instances/:name/loglevel { level }
router.post('/instances/:name/loglevel', async (req, res) => {
    const name = req.params.name;
    if (!validInstance(name)) return res.status(400).json({ error: 'invalid instance name' });
    const level = req.body && req.body.level;
    if (!LOG_LEVELS.includes(level)) return res.status(400).json({ error: `level must be one of ${LOG_LEVELS.join(', ')}` });
    const inst = findInstance(name);
    if (!inst) return res.status(404).json({ error: 'unknown instance' });
    if (inst.legacy) return res.status(409).json({ error: 'legacy instance has no maintenance topics' });
    if (!inst.maintenance) return res.status(409).json({ error: 'instance runs with --no-maintenance' });
    try {
        await publish(`${name}/maintenance/set/loglevel`, level);
        res.json({ ok: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET /she/services/instances/:name/retained — what a wipe would clear
router.get('/instances/:name/retained', (req, res) => {
    const name = req.params.name;
    if (!validInstance(name)) return res.status(400).json({ error: 'invalid instance name' });
    if (!_store) return res.json({ own: [], discovery: [] });
    const haPrefix = typeof req.query.haPrefix === 'string' && req.query.haPrefix.trim() ? req.query.haPrefix.trim() : undefined;
    res.json(wipeTopics(_store.mqttEntries(), name, { haPrefix }));
});

// DELETE /she/services/instances/:name/retained — clear retained topics of a gone instance
router.delete('/instances/:name/retained', async (req, res) => {
    const name = req.params.name;
    if (!validInstance(name)) return res.status(400).json({ error: 'invalid instance name' });
    const mqtt = _getMqtt();
    if (!mqtt) return res.status(503).json({ error: 'MQTT not connected' });
    const inst = findInstance(name);
    if (!inst) return res.status(404).json({ error: 'unknown instance' });
    if (inst.connected !== null && inst.connected > 0) {
        return res.status(409).json({ error: 'instance is connected — stop it first' });
    }
    const haPrefix = req.body && typeof req.body.haPrefix === 'string' && req.body.haPrefix.trim() ? req.body.haPrefix.trim() : undefined;
    const includeDiscovery = !(req.body && req.body.discovery === false);
    const plan = wipeTopics(_store.mqttEntries(), name, { haPrefix });
    const topics = [...plan.own, ...(includeDiscovery ? plan.discovery : [])];
    const errors = [];
    for (const t of topics) {
        await new Promise((resolve) => {
            mqtt.publish(t, '', { retain: true, qos: 0 }, (err) => {
                if (err) errors.push({ topic: t, error: err.message });
                resolve();
            });
        });
    }
    res.json({ ok: errors.length === 0, cleared: topics.length - errors.length, errors });
});

// ── Tier 1: hosts ─────────────────────────────────────────────────────────────

const MASK = '***';
const UNIT_ACTIONS = ['start', 'stop', 'restart', 'enable', 'disable'];
const SCHEMA_TTL = 10 * 60 * 1000;
const FOLLOW_TTL = 10 * 60 * 1000;

function validAdapter(name) {
    return typeof name === 'string' && /^[a-z0-9][a-z0-9._-]{0,213}$/.test(name);
}
function validEnvName(name) {
    return typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name);
}

/** Drivers are created per request from the live config; tests inject a factory. */
let _driverFactory = (hostCfg) =>
    hostCfg.ssh && typeof hostCfg.ssh.host === 'string' && hostCfg.ssh.host
        ? createSshDriver(hostCfg, { defaultIdentity: SERVICES_IDENTITY })
        : hostCfg.ssh
          ? null
          : createLocalDriver({ name: hostCfg.name });
function setDriverFactory(fn) {
    _driverFactory = fn;
}

const HOST_NAME_RE = /^[A-Za-z0-9_.:[\]-]+$/;

/**
 * Configured hosts; without any, the she host itself. A remote entry without a name is
 * named after its ssh host.
 */
function hostEntries(req) {
    const cfg = getServicesConfig(req);
    const list = Array.isArray(cfg.hosts) && cfg.hosts.length > 0 ? cfg.hosts : [{ name: 'local' }];
    const seen = new Set();
    return list
        .filter((h) => h && typeof h === 'object')
        .map((h) => ({ ...h, name: typeof h.name === 'string' && h.name ? h.name : h.ssh && typeof h.ssh.host === 'string' ? h.ssh.host : 'local' }))
        .filter((h) => HOST_NAME_RE.test(h.name) && !seen.has(h.name) && seen.add(h.name))
        .map((h) => ({ cfg: h, driver: _driverFactory(h) }));
}

/** Marker in an instance's env file: she keeps the MQTT_URL/USERNAME/PASSWORD of this instance equal to her own. */
const SHE_BROKER_MARKER = 'SHE_USE_BROKER';

/**
 * she's own broker settings as an adapter on the she host (local) or another host would need them;
 * a loopback URL means "the she host" and is rewritten to she's hostname for remote hosts.
 * @returns {{url: string, username: string, password: string}|null}
 */
function sheBrokerSettings(local) {
    const mqtt = _getMqttConfig();
    if (!mqtt || typeof mqtt.url !== 'string' || !mqtt.url) return null;
    let url = mqtt.url;
    if (!local) url = url.replace(/\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?=[:/]|$)/, '//' + os.hostname());
    return { url, username: mqtt.username ? String(mqtt.username) : '', password: mqtt.password ? String(mqtt.password) : '' };
}

/** What the UI shows next to the "use she's broker settings" switch (no password). */
function sheBrokerInfo(local) {
    const b = sheBrokerSettings(local);
    return b ? { url: b.url, username: b.username, hasPassword: b.password !== '' } : null;
}

/** Env prefix of an adapter: from its schema, else the core's default (name upper-cased). */
function envPrefixOf(schema, adapter) {
    const p = schema && schema['x-adapter'] && schema['x-adapter'].envPrefix;
    return typeof p === 'string' && p ? p : adapter.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * Apply the "use she's broker settings" switch to an instance env: sets/removes the marker and,
 * when on, overwrites the prefixed MQTT_URL/USERNAME/PASSWORD with she's values.
 */
function applySheBroker(env, prefix, useSheBroker, local) {
    const out = { ...env };
    if (!useSheBroker) {
        delete out[SHE_BROKER_MARKER];
        return out;
    }
    const b = sheBrokerSettings(local);
    if (!b) throw new HostError('HELPER_FAILED', 'she has no MQTT broker configured (Settings → MQTT)');
    out[SHE_BROKER_MARKER] = '1';
    out[prefix + '_MQTT_URL'] = b.url;
    if (b.username) out[prefix + '_MQTT_USERNAME'] = b.username;
    else delete out[prefix + '_MQTT_USERNAME'];
    if (b.password) out[prefix + '_MQTT_PASSWORD'] = b.password;
    else delete out[prefix + '_MQTT_PASSWORD'];
    return out;
}

function hostError(res, err) {
    if (err instanceof HostError) {
        const status = err.code === 'HELPER_MISSING' ? 503 : err.code === 'SUDO_DENIED' ? 403 : err.code === 'HELPER_FAILED' ? 400 : err.code === 'SSH_FAILED' ? 502 : 500;
        return res.status(status).json({ error: err.message, code: err.code, ...(err.stdout ? { output: err.stdout } : {}) });
    }
    return res.status(500).json({ error: err.message });
}

/** Resolve :host, :adapter and (optionally) :instance params; responds and returns null on error. */
function resolve(req, res, { adapter = false, instance = false } = {}) {
    const entry = hostEntries(req).find((h) => h.cfg.name === req.params.host);
    if (!entry) {
        res.status(404).json({ error: 'unknown host' });
        return null;
    }
    if (!entry.driver) {
        res.status(400).json({ error: 'host entry has an ssh block without a host', code: 'UNSUPPORTED' });
        return null;
    }
    if (adapter && !validAdapter(req.params.adapter)) {
        res.status(400).json({ error: 'invalid adapter name' });
        return null;
    }
    if (instance && !validInstance(req.params.instance)) {
        res.status(400).json({ error: 'invalid instance name' });
        return null;
    }
    return entry;
}

const _schemaCache = new Map(); // host/adapter → {schema, ts}
async function loadSchema(driver, adapter, { force = false } = {}) {
    const key = driver.name + '/' + adapter;
    const hit = _schemaCache.get(key);
    if (hit && !force && Date.now() - hit.ts < SCHEMA_TTL) return hit.schema;
    const { stdout } = await driver.exec(['schema', adapter]);
    let schema;
    try {
        schema = JSON.parse(stdout);
    } catch {
        throw new HostError('EXEC_FAILED', 'adapter did not print a JSON schema');
    }
    _schemaCache.set(key, { schema, ts: Date.now() });
    return schema;
}

function maskEnv(env, secrets) {
    const out = {};
    for (const [k, v] of Object.entries(env)) out[k] = secrets.has(k) && v !== '' ? MASK : v;
    return out;
}

/** Merge a submitted env (with masked secrets) over the current one; validate names. */
function mergeEnv(current, submitted) {
    if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) throw new HostError('HELPER_FAILED', 'env object required');
    const out = {};
    for (const [k, v] of Object.entries(submitted)) {
        if (!validEnvName(k)) throw new HostError('HELPER_FAILED', 'invalid env variable name: ' + k);
        if (v === undefined || v === null) continue;
        const str = typeof v === 'boolean' || typeof v === 'number' ? String(v) : String(v);
        if (str === MASK) {
            if (current[k] !== undefined) out[k] = current[k];
            continue;
        }
        if (str === '') continue;
        out[k] = str;
    }
    return out;
}

/**
 * SV-14: remember the hostname a host reported so MQTT instances (info.host) can be
 * matched to it; only fills an empty field, best effort.
 */
function saveHostname(req, name, hostname) {
    const configPath = req.app.locals.configPath;
    if (!configPath || !hostname) return;
    try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const hosts = cfg.services && Array.isArray(cfg.services.hosts) ? cfg.services.hosts : null;
        const entry = hosts && hosts.find((h) => h && (h.name === name || (!h.name && h.ssh && h.ssh.host === name)));
        if (!entry || entry.hostname) return;
        entry.hostname = hostname;
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
    } catch {
        /* config not writable — the UI still correlates via the live value */
    }
}

/**
 * The host listing runs the helper (and the broker.env sync) on every host — cached for a
 * minute so tab switches and WS-triggered reloads do not hit the hosts; `?refresh=1` and every
 * mutating route bypass/invalidate it. Keyed by the services config so config edits are seen.
 */
const HOSTS_TTL = 60 * 1000;
let _hostsCache = null; // {key, ts, promise}
function hostsCacheKey(req) {
    return String(req.app.locals.configPath) + ':' + JSON.stringify(getServicesConfig(req));
}
function invalidateHosts() {
    _hostsCache = null;
}

// GET /she/services/hosts[?refresh=1]
router.get('/hosts', async (req, res) => {
    const key = hostsCacheKey(req);
    const fresh = req.query.refresh === '1';
    if (!fresh && _hostsCache && _hostsCache.key === key && Date.now() - _hostsCache.ts < HOSTS_TTL) {
        return res.json({ hosts: await _hostsCache.promise, cached: true });
    }
    const promise = listHosts(req);
    _hostsCache = { key, ts: Date.now(), promise };
    res.json({ hosts: await promise, cached: false });
});

async function listHosts(req) {
    return Promise.all(
        hostEntries(req).map(async ({ cfg, driver }) => {
            const base = {
                name: cfg.name,
                local: !cfg.ssh,
                ssh: cfg.ssh ? { host: cfg.ssh.host, port: cfg.ssh.port || 22, user: cfg.ssh.user || os.userInfo().username } : null,
                hostname: cfg.hostname || null,
            };
            if (!driver) return { ...base, ok: false, code: 'UNSUPPORTED', error: 'host entry has an ssh block without a host' };
            try {
                const { stdout } = await driver.exec(['list']);
                const list = parseList(stdout);
                if (!cfg.hostname && list.hostname) saveHostname(req, cfg.name, list.hostname);
                return { ...base, ok: true, hostname: base.hostname || list.hostname, ...list };
            } catch (err) {
                return { ...base, ok: false, code: err.code || 'ERROR', error: err.message };
            }
        }),
    );
}

// every mutating host route changes what the listing would show
router.use((req, res, next) => {
    if (req.method !== 'GET') {
        res.on('finish', () => {
            if (req.path.startsWith('/hosts/')) invalidateHosts();
        });
    }
    next();
});

// ── I5: ssh identity, connection test, helper deploy ─────────────────────────

function identityPath() {
    return sshDeploy.expandHome(SERVICES_IDENTITY);
}

// GET /she/services/ssh/pubkey
router.get('/ssh/pubkey', (req, res) => {
    try {
        const publicKey = fs.readFileSync(identityPath() + '.pub', 'utf8').trim();
        res.json({ publicKey, identityFile: identityPath() });
    } catch {
        res.json({ publicKey: null, identityFile: identityPath() });
    }
});

// POST /she/services/ssh/keygen
router.post('/ssh/keygen', async (req, res) => {
    try {
        const publicKey = await sshDeploy.generateKeypair(identityPath(), 'she-services');
        res.json({ publicKey, identityFile: identityPath() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /she/services/ssh/test { host, port?, user?, identityFile? } — test unsaved host settings from the Config page
router.post('/ssh/test', async (req, res) => {
    const b = req.body || {};
    if (typeof b.host !== 'string' || !/^[A-Za-z0-9_.:[\]-]+$/.test(b.host)) return res.status(400).json({ error: 'invalid host' });
    const ssh = { host: b.host };
    if (b.port !== undefined && b.port !== '' && b.port !== null) {
        const port = Number(b.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'invalid port' });
        ssh.port = port;
    }
    if (typeof b.user === 'string' && b.user) {
        if (!/^[A-Za-z0-9_.-]+$/.test(b.user)) return res.status(400).json({ error: 'invalid user' });
        ssh.user = b.user;
    }
    if (typeof b.identityFile === 'string' && b.identityFile) ssh.identityFile = b.identityFile;
    const driver = _driverFactory({ name: b.host, ssh });
    if (!driver) return res.status(400).json({ error: 'no driver' });
    try {
        const { stdout } = await driver.exec(['version'], { timeout: 20000 });
        res.json({ ok: true, helper: Number(String(stdout).trim()) || null });
    } catch (err) {
        res.json({ ok: false, code: err.code || 'ERROR', error: err.message });
    }
});

// POST /she/services/hosts/:host/test — always 200 with ok/code so the UI can explain
router.post('/hosts/:host/test', async (req, res) => {
    const entry = resolve(req, res);
    if (!entry) return;
    try {
        const { stdout } = await entry.driver.exec(['version'], { timeout: 20000 });
        res.json({ ok: true, helper: Number(String(stdout).trim()) || null });
    } catch (err) {
        res.json({ ok: false, code: err.code || 'ERROR', error: err.message });
    }
});

/** Commands an admin runs when she itself is not allowed to (SV-4: she never edits sudoers remotely). */
function deployInstructions(user, tmpName) {
    return [
        `sudo install -m 755 -o root -g root ~/${tmpName} ${HELPER} && rm -f ~/${tmpName}`,
        `echo '${user} ALL=(root) NOPASSWD: ${HELPER}' | sudo tee /etc/sudoers.d/she-services >/dev/null && sudo chmod 440 /etc/sudoers.d/she-services`,
    ];
}

// POST /she/services/hosts/:host/helper/deploy
router.post('/hosts/:host/helper/deploy', async (req, res) => {
    const entry = resolve(req, res);
    if (!entry) return;
    const { driver, cfg } = entry;
    if (driver.local) return res.status(400).json({ error: 'on the she host the helper is installed by: sudo she --install', code: 'LOCAL' });
    const user = (cfg.ssh && cfg.ssh.user) || os.userInfo().username;
    const tmpName = 'she-servicectl.tmp';
    const instructions = deployInstructions(user, tmpName);
    try {
        await driver.upload(HELPER_SOURCE, tmpName);
    } catch (err) {
        return hostError(res, err);
    }
    // try to install it right away — works when the ssh user is root or already sudo-capable
    let installed = false;
    try {
        await driver.run(`sudo -n install -m 755 -o root -g root ./${shellQuote(tmpName)} ${shellQuote(HELPER)} && rm -f ./${shellQuote(tmpName)}`, { timeout: 30000 });
        installed = true;
    } catch (err) {
        if (err.code === 'SSH_FAILED') return hostError(res, err);
    }
    if (!installed) {
        return res.json({ ok: false, uploaded: true, installed: false, sudoers: false, code: 'SUDO_DENIED', instructions, user });
    }
    // installed — is the helper callable through sudo for this user?
    try {
        const { stdout } = await driver.exec(['version'], { timeout: 20000 });
        return res.json({ ok: true, uploaded: true, installed: true, sudoers: true, helper: Number(String(stdout).trim()) || null, user });
    } catch (err) {
        return res.json({ ok: false, uploaded: true, installed: true, sudoers: false, code: err.code || 'ERROR', error: err.message, instructions: [instructions[1]], user });
    }
});

// GET /she/services/hosts/:host/adapters/:adapter/schema
router.get('/hosts/:host/adapters/:adapter/schema', async (req, res) => {
    const entry = resolve(req, res, { adapter: true });
    if (!entry) return;
    try {
        const schema = await loadSchema(entry.driver, req.params.adapter, { force: req.query.refresh === '1' });
        res.json({ schema, secrets: [...secretEnvVars(schema)], envPrefix: envPrefixOf(schema, req.params.adapter), sheBroker: sheBrokerInfo(entry.driver.local === true) });
    } catch (err) {
        hostError(res, err);
    }
});

// POST /she/services/hosts/:host/adapters/:adapter/install { instance, env }
router.post('/hosts/:host/adapters/:adapter/install', async (req, res) => {
    const entry = resolve(req, res, { adapter: true });
    if (!entry) return;
    const { instance, env, useSheBroker } = req.body || {};
    if (!validInstance(instance)) return res.status(400).json({ error: 'invalid instance name' });
    try {
        let merged = mergeEnv({}, env || {});
        if (useSheBroker === true) {
            let schema = null;
            try {
                schema = await loadSchema(entry.driver, req.params.adapter);
            } catch {
                /* default prefix */
            }
            merged = applySheBroker(merged, envPrefixOf(schema, req.params.adapter), true, entry.driver.local === true);
        }
        const { stdout } = await entry.driver.exec(['install', req.params.adapter, instance], { stdin: formatEnvFile(merged), timeout: 120000 });
        res.json({ ok: true, output: stdout });
    } catch (err) {
        hostError(res, err);
    }
});

// POST /she/services/hosts/:host/adapters/:adapter/update { force? }
router.post('/hosts/:host/adapters/:adapter/update', async (req, res) => {
    const entry = resolve(req, res, { adapter: true });
    if (!entry) return;
    const adapter = req.params.adapter;
    const force = Boolean(req.body && req.body.force);
    try {
        const list = parseList((await entry.driver.exec(['list'])).stdout);
        const known = list.adapters.find((a) => a.name === adapter);
        if (known && known.origin === 'manual' && !force) {
            return res.status(409).json({
                error: adapter + ' was deployed manually on this host (not via npm install -g); updating replaces it with the registry version',
                code: 'MANUAL_DEPLOY',
                origin: 'manual',
                path: known.path || null,
            });
        }
        const { stdout } = await entry.driver.exec(['npm', adapter, 'update'], { timeout: 600000 });
        _schemaCache.delete(entry.driver.name + '/' + adapter);
        const restarted = [];
        const failed = [];
        for (const inst of list.instances.filter((i) => i.adapter === adapter && i.active === 'active')) {
            try {
                await entry.driver.exec(['unit', adapter, inst.instance, 'restart']);
                restarted.push(inst.instance);
            } catch (err) {
                failed.push({ instance: inst.instance, error: err.message });
            }
        }
        res.json({ ok: failed.length === 0, output: stdout, restarted, failed });
    } catch (err) {
        hostError(res, err);
    }
});

// POST /she/services/hosts/:host/units/:adapter/:instance/:action
router.post('/hosts/:host/units/:adapter/:instance/:action', async (req, res) => {
    const entry = resolve(req, res, { adapter: true, instance: true });
    if (!entry) return;
    if (!UNIT_ACTIONS.includes(req.params.action)) return res.status(400).json({ error: 'unknown action' });
    try {
        const { stdout } = await entry.driver.exec(['unit', req.params.adapter, req.params.instance, req.params.action]);
        res.json({ ok: true, output: stdout });
    } catch (err) {
        hostError(res, err);
    }
});

// DELETE /she/services/hosts/:host/units/:adapter/:instance — uninstall
router.delete('/hosts/:host/units/:adapter/:instance', async (req, res) => {
    const entry = resolve(req, res, { adapter: true, instance: true });
    if (!entry) return;
    try {
        stopFollower(followKey(entry.driver.name, req.params.adapter, req.params.instance));
        const { stdout } = await entry.driver.exec(['uninstall', req.params.adapter, req.params.instance], { timeout: 60000 });
        res.json({ ok: true, output: stdout });
    } catch (err) {
        hostError(res, err);
    }
});

// GET /she/services/hosts/:host/units/:adapter/:instance/logs?n=200
router.get('/hosts/:host/units/:adapter/:instance/logs', async (req, res) => {
    const entry = resolve(req, res, { adapter: true, instance: true });
    if (!entry) return;
    const n = Math.min(5000, Math.max(1, parseInt(req.query.n, 10) || 200));
    try {
        const { stdout } = await entry.driver.exec(['logs', req.params.adapter, req.params.instance, '-n', String(n)]);
        res.json({ entries: parseJournal(stdout) });
    } catch (err) {
        hostError(res, err);
    }
});

// ── journal followers: one per {host, unit}, broadcast as serviceLog, expire without renewal ──
const _followers = new Map(); // key → {child, expires, host, unit}

function followKey(host, adapter, instance) {
    return host + '|' + adapter + '@' + instance;
}

function stopFollower(key) {
    const f = _followers.get(key);
    if (!f) return;
    _followers.delete(key);
    try {
        f.child.kill('SIGTERM');
    } catch {
        /* already gone */
    }
}

function sweepFollowers() {
    const now = Date.now();
    for (const [key, f] of _followers) if (f.expires < now) stopFollower(key);
}
const _sweeper = setInterval(sweepFollowers, 60000);
_sweeper.unref();

function stopAllFollowers() {
    for (const key of [..._followers.keys()]) stopFollower(key);
}

// POST /she/services/hosts/:host/units/:adapter/:instance/logs/follow — start or renew
router.post('/hosts/:host/units/:adapter/:instance/logs/follow', (req, res) => {
    const entry = resolve(req, res, { adapter: true, instance: true });
    if (!entry) return;
    const { adapter, instance } = req.params;
    const host = entry.driver.name;
    const key = followKey(host, adapter, instance);
    const unit = adapter + '@' + instance;
    const existing = _followers.get(key);
    if (existing) {
        existing.expires = Date.now() + FOLLOW_TTL;
        return res.json({ ok: true, following: true, renewed: true });
    }
    let child;
    try {
        child = entry.driver.spawn(['logs', adapter, instance, '-n', '0', '--follow']);
    } catch (err) {
        return hostError(res, err);
    }
    const f = { child, expires: Date.now() + FOLLOW_TTL, host, unit };
    _followers.set(key, f);
    let buf = '';
    child.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const e of parseJournal(lines.join('\n'))) broadcast({ type: 'serviceLog', host, unit, ...e });
    });
    let errText = '';
    child.stderr.on('data', (c) => {
        errText += c.toString();
    });
    child.on('exit', (code) => {
        if (_followers.get(key) === f) _followers.delete(key);
        if (code && errText.trim()) {
            broadcast({ type: 'serviceLog', host, unit, ts: Date.now(), level: 'error', msg: 'journal follower ended: ' + errText.trim(), pid: null });
        }
    });
    child.on('error', () => {
        if (_followers.get(key) === f) _followers.delete(key);
    });
    res.json({ ok: true, following: true, renewed: false });
});

// DELETE /she/services/hosts/:host/units/:adapter/:instance/logs/follow
router.delete('/hosts/:host/units/:adapter/:instance/logs/follow', (req, res) => {
    const entry = resolve(req, res, { adapter: true, instance: true });
    if (!entry) return;
    stopFollower(followKey(entry.driver.name, req.params.adapter, req.params.instance));
    res.json({ ok: true, following: false });
});

// GET /she/services/hosts/:host/units/:adapter/:instance/env
router.get('/hosts/:host/units/:adapter/:instance/env', async (req, res) => {
    const entry = resolve(req, res, { adapter: true, instance: true });
    if (!entry) return;
    try {
        const { stdout } = await entry.driver.exec(['env', req.params.adapter, req.params.instance, 'read']);
        const env = parseEnvFile(stdout);
        let schema = null;
        try {
            schema = await loadSchema(entry.driver, req.params.adapter);
        } catch {
            /* form falls back to raw key/value editing */
        }
        const secrets = secretEnvVars(schema, Object.keys(env));
        res.json({
            env: maskEnv(env, secrets),
            secrets: [...secrets],
            schema,
            envPrefix: envPrefixOf(schema, req.params.adapter),
            useSheBroker: env[SHE_BROKER_MARKER] === '1',
            sheBroker: sheBrokerInfo(entry.driver.local === true),
        });
    } catch (err) {
        hostError(res, err);
    }
});

// PUT /she/services/hosts/:host/units/:adapter/:instance/env { env, restart? }
router.put('/hosts/:host/units/:adapter/:instance/env', async (req, res) => {
    const entry = resolve(req, res, { adapter: true, instance: true });
    if (!entry) return;
    const { adapter, instance } = req.params;
    try {
        const current = parseEnvFile((await entry.driver.exec(['env', adapter, instance, 'read'])).stdout);
        let merged = mergeEnv(current, req.body && req.body.env);
        const useSheBroker = req.body && typeof req.body.useSheBroker === 'boolean' ? req.body.useSheBroker : current[SHE_BROKER_MARKER] === '1';
        let schema = null;
        try {
            schema = await loadSchema(entry.driver, adapter);
        } catch {
            /* default prefix */
        }
        merged = applySheBroker(merged, envPrefixOf(schema, adapter), useSheBroker, entry.driver.local === true);
        const header = [
            adapter + ' instance "' + instance + '" - read by ' + adapter + '@' + instance + '.service.',
            'Edited via she. Edit and run: systemctl restart ' + adapter + '@' + instance + '.service',
        ];
        await entry.driver.exec(['env', adapter, instance, 'write'], { stdin: formatEnvFile(merged, header) });
        let restarted = false;
        if (req.body && req.body.restart === true) {
            await entry.driver.exec(['unit', adapter, instance, 'restart']);
            restarted = true;
        }
        res.json({ ok: true, restarted });
    } catch (err) {
        hostError(res, err);
    }
});

// GET /she/services/hosts/:host/broker-env
router.get('/hosts/:host/broker-env', async (req, res) => {
    const entry = resolve(req, res);
    if (!entry) return;
    try {
        const env = parseEnvFile((await entry.driver.exec(['broker-env', 'read'])).stdout);
        const secrets = secretEnvVars(null, Object.keys(env));
        res.json({ env: maskEnv(env, secrets), secrets: [...secrets] });
    } catch (err) {
        hostError(res, err);
    }
});

// PUT /she/services/hosts/:host/broker-env { env }
router.put('/hosts/:host/broker-env', async (req, res) => {
    const entry = resolve(req, res);
    if (!entry) return;
    try {
        const current = parseEnvFile((await entry.driver.exec(['broker-env', 'read'])).stdout);
        const merged = mergeEnv(current, req.body && req.body.env);
        await entry.driver.exec(['broker-env', 'write'], {
            stdin: formatEnvFile(merged, ['Shared broker settings for all mqtt-interfaces adapters on this host (edited via she).']),
        });
        res.json({ ok: true });
    } catch (err) {
        hostError(res, err);
    }
});

// ── I9: remote host bootstrap ─────────────────────────────────────────────────
//
// Settings → "Remote host setup command" mints a one-time token; the admin runs
//   curl -fsSL '<she>/she/services/setup.sh?token=…' | sudo bash
// on the target. The script (POSIX sh, everything embedded, no downloads) creates the
// she-services user, installs she's public key, the helper and the single sudoers rule,
// then calls back so she adds the host entry. The script is generated when the token is
// minted so its sha256 can be shown next to the command.

const SETUP_TTL = 15 * 60 * 1000;
const _setupTokens = new Map(); // token → {script, sha256, created, fetched, done, host}

function sweepSetupTokens() {
    const now = Date.now();
    for (const [t, s] of _setupTokens) if (now - s.created > SETUP_TTL && !s.done) _setupTokens.delete(t);
}
const _setupSweeper = setInterval(sweepSetupTokens, 60000);
_setupSweeper.unref();

function setupState(t) {
    const s = _setupTokens.get(t);
    if (!s) return { status: 'expired' };
    if (s.done) return { status: 'done', host: s.host };
    if (Date.now() - s.created > SETUP_TTL) return { status: 'expired' };
    return { status: s.fetched ? 'fetched' : 'pending' };
}

/** POSIX sh bootstrap script for one token. */
function buildSetupScript({ publicKey, helper, callbackUrl, token, user }) {
    if (helper.split('\n').some((l) => l === 'SHE_HELPER_EOF')) throw new Error('helper contains the heredoc delimiter');
    const q = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
    return `#!/bin/sh
# she — remote host setup for the Services page (roadmap I9). Generated ${new Date().toISOString()}.
# Creates the user ${user}, installs she's SSH public key, the she-servicectl helper and its sudoers rule,
# then tells she about this host. Idempotent; run as root.
set -eu
USER_NAME=${q(user)}
PUBKEY=${q(publicKey)}
CALLBACK=${q(callbackUrl)}
HELPER=/usr/local/bin/she-servicectl
SUDOERS=/etc/sudoers.d/she-services

if [ "$(id -u)" -ne 0 ]; then echo "she setup: run as root (sudo)" >&2; exit 1; fi
command -v systemctl >/dev/null 2>&1 || echo "she setup: warning: systemd not found - the helper needs it to manage adapters" >&2

# 1. user
if ! id -u "$USER_NAME" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "/home/$USER_NAME" --shell /bin/sh --comment "she service management" "$USER_NAME"
    echo "she setup: created user $USER_NAME"
else
    echo "she setup: user $USER_NAME exists"
fi
HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
[ -n "$HOME_DIR" ] || { echo "she setup: no home directory for $USER_NAME" >&2; exit 1; }
[ -d "$HOME_DIR" ] || mkdir -p "$HOME_DIR"

# 2. ssh key
install -d -m 700 -o "$USER_NAME" -g "$(id -gn "$USER_NAME")" "$HOME_DIR/.ssh"
AUTH="$HOME_DIR/.ssh/authorized_keys"
touch "$AUTH"
if ! grep -qF "$PUBKEY" "$AUTH"; then printf '%s\\n' "$PUBKEY" >> "$AUTH"; echo "she setup: added she's public key"; else echo "she setup: public key already present"; fi
chmod 600 "$AUTH"; chown "$USER_NAME:$(id -gn "$USER_NAME")" "$AUTH"

# 3. helper
TMP=$(mktemp)
cat > "$TMP" <<'SHE_HELPER_EOF'
${helper}
SHE_HELPER_EOF
install -m 755 -o root -g root "$TMP" "$HELPER"
rm -f "$TMP"
echo "she setup: installed $HELPER (v$("$HELPER" version))"

# 4. sudoers: exactly one rule
printf '%s ALL=(root) NOPASSWD: %s\\n' "$USER_NAME" "$HELPER" > "$SUDOERS.tmp"
chmod 440 "$SUDOERS.tmp"
if command -v visudo >/dev/null 2>&1; then visudo -cf "$SUDOERS.tmp" >/dev/null; fi
mv "$SUDOERS.tmp" "$SUDOERS"
echo "she setup: wrote $SUDOERS"

# 5. tell she
HOST_NAME=$(hostname)
BODY=$(printf '{"hostname":"%s","user":"%s"}' "$HOST_NAME" "$USER_NAME")
if command -v curl >/dev/null 2>&1; then
    curl -fsS -X POST -H 'Content-Type: application/json' --data "$BODY" "$CALLBACK" >/dev/null && echo "she setup: registered $HOST_NAME with she" || echo "she setup: could not reach she at $CALLBACK - add the host by hand (user $USER_NAME)" >&2
elif command -v wget >/dev/null 2>&1; then
    wget -q -O /dev/null --header='Content-Type: application/json' --post-data="$BODY" "$CALLBACK" && echo "she setup: registered $HOST_NAME with she" || echo "she setup: could not reach she at $CALLBACK - add the host by hand (user $USER_NAME)" >&2
else
    echo "she setup: neither curl nor wget - add the host by hand (user $USER_NAME)" >&2
fi
echo "she setup: done"
`;
}

// POST /she/services/setup/token { origin } → { token, command, sha256, expires }
router.post('/setup/token', async (req, res) => {
    const origin = req.body && typeof req.body.origin === 'string' && /^https?:\/\/[^/\s]+$/.test(req.body.origin) ? req.body.origin : null;
    if (!origin) return res.status(400).json({ error: 'origin required (the URL you reach she at, e.g. http://she:8080)' });
    let publicKey;
    try {
        publicKey = fs.readFileSync(identityPath() + '.pub', 'utf8').trim();
    } catch {
        try {
            publicKey = await sshDeploy.generateKeypair(identityPath(), 'she-services');
        } catch (err) {
            return res.status(500).json({ error: 'cannot create the services SSH key: ' + err.message });
        }
    }
    let helper;
    try {
        helper = fs.readFileSync(HELPER_SOURCE, 'utf8');
    } catch (err) {
        return res.status(500).json({ error: 'helper source missing: ' + err.message });
    }
    const token = crypto.randomBytes(24).toString('hex');
    const callbackUrl = origin + '/she/services/setup/done?token=' + token;
    let script;
    try {
        script = buildSetupScript({ publicKey, helper, callbackUrl, token, user: REMOTE_USER });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
    const sha256 = crypto.createHash('sha256').update(script).digest('hex');
    sweepSetupTokens();
    _setupTokens.set(token, { script, sha256, created: Date.now(), fetched: false, done: false, host: null });
    res.json({
        token,
        command: `curl -fsSL '${origin}/she/services/setup.sh?token=${token}' | sudo bash`,
        scriptUrl: `${origin}/she/services/setup.sh?token=${token}`,
        sha256,
        expires: Date.now() + SETUP_TTL,
        user: REMOTE_USER,
    });
});

// GET /she/services/setup/token/:token → { status, host? }
router.get('/setup/token/:token', (req, res) => {
    res.json(setupState(req.params.token));
});

// GET /she/services/setup.sh?token=… (no auth) — served once
router.get('/setup.sh', (req, res) => {
    const t = typeof req.query.token === 'string' ? req.query.token : '';
    const s = _setupTokens.get(t);
    if (!s || s.done || s.fetched || Date.now() - s.created > SETUP_TTL) {
        return res.status(410).type('text/plain').send('she: setup token unknown, used or expired - mint a new command in Settings -> Services\n');
    }
    s.fetched = true;
    res.type('text/x-shellscript').send(s.script);
});

/** Address the callback came from (first X-Forwarded-For entry behind a proxy), IPv4-mapped prefix stripped. */
function callerAddress(req) {
    const fwd = req.headers['x-forwarded-for'];
    let addr = typeof fwd === 'string' && fwd.trim() ? fwd.split(',')[0].trim() : req.socket.remoteAddress || '';
    if (addr.startsWith('::ffff:')) addr = addr.slice(7);
    return addr;
}

// POST /she/services/setup/done?token=… { hostname, user } (no auth) — add the host entry
router.post('/setup/done', (req, res) => {
    const t = typeof req.query.token === 'string' ? req.query.token : '';
    const s = _setupTokens.get(t);
    if (!s || s.done || Date.now() - s.created > SETUP_TTL) return res.status(410).json({ error: 'setup token unknown, used or expired' });
    const hostname = req.body && typeof req.body.hostname === 'string' && /^[A-Za-z0-9_.-]{1,253}$/.test(req.body.hostname) ? req.body.hostname : null;
    const addr = callerAddress(req);
    if (!addr || !HOST_NAME_RE.test(addr)) return res.status(400).json({ error: 'cannot determine the caller address' });
    s.done = true;
    s.host = addr;
    const configPath = req.app.locals.configPath;
    let added = false;
    if (configPath) {
        try {
            let cfg = {};
            try {
                cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            } catch {
                /* new file */
            }
            if (!cfg.services || typeof cfg.services !== 'object') cfg.services = {};
            if (!Array.isArray(cfg.services.hosts)) cfg.services.hosts = [{ name: 'local' }];
            const exists = cfg.services.hosts.find((h) => h && h.ssh && (h.ssh.host === addr || (hostname && h.ssh.host === hostname)));
            if (exists) {
                exists.ssh.user = REMOTE_USER;
                if (hostname) exists.hostname = hostname;
            } else {
                cfg.services.hosts.push({ ...(hostname ? { hostname } : {}), ssh: { host: addr, user: REMOTE_USER } });
                added = true;
            }
            fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
            invalidateHosts();
        } catch (err) {
            return res.status(500).json({ error: 'cannot update config: ' + err.message });
        }
    }
    res.json({ ok: true, host: addr, hostname, user: REMOTE_USER, added });
});

module.exports = {
    router,
    init,
    setIdentityPath,
    buildSetupScript,
    REMOTE_USER,
    getServicesConfig,
    validInstance,
    validAdapter,
    setDriverFactory,
    stopAllFollowers,
    invalidateHosts,
    mergeEnv,
    maskEnv,
    sheBrokerSettings,
    applySheBroker,
    SHE_BROKER_MARKER,
    SERVICES_IDENTITY,
};
