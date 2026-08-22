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
 *
 * Call init(store, getMqttClient) once (same signature as mqtt-api).
 */

const express = require('express');
const fs = require('fs');
const { analyzeServices, wipeTopics, LOG_LEVELS } = require('../lib/services-inventory');
const npmRegistry = require('../lib/npm-registry');
const { createLocalDriver, parseList, parseJournal, parseEnvFile, formatEnvFile, secretEnvVars, HostError } = require('../lib/services-host');
const { broadcast } = require('./log-ws');

const router = express.Router();

let _store = null;
let _getMqtt = () => null;

function init(store, getMqttClient) {
    _store = store;
    _getMqtt = getMqttClient;
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
let _driverFactory = (hostCfg) => (hostCfg.ssh ? null : createLocalDriver({ name: hostCfg.name }));
function setDriverFactory(fn) {
    _driverFactory = fn;
}

/** Configured hosts; without any, the she host itself. Entries with ssh need the I5 driver. */
function hostEntries(req) {
    const cfg = getServicesConfig(req);
    const list = Array.isArray(cfg.hosts) && cfg.hosts.length > 0 ? cfg.hosts : [{ name: 'local' }];
    return list.filter((h) => h && typeof h.name === 'string' && /^[A-Za-z0-9_.-]+$/.test(h.name)).map((h) => ({ cfg: h, driver: _driverFactory(h) }));
}

function hostError(res, err) {
    if (err instanceof HostError) {
        const status = err.code === 'HELPER_MISSING' ? 503 : err.code === 'SUDO_DENIED' ? 403 : err.code === 'HELPER_FAILED' ? 400 : 500;
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
        res.status(501).json({ error: 'remote hosts are not supported yet (roadmap I5)', code: 'UNSUPPORTED' });
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

// GET /she/services/hosts
router.get('/hosts', async (req, res) => {
    const result = await Promise.all(
        hostEntries(req).map(async ({ cfg, driver }) => {
            const base = { name: cfg.name, local: !cfg.ssh, ssh: cfg.ssh ? { host: cfg.ssh.host } : null, hostname: cfg.hostname || null };
            if (!driver) return { ...base, ok: false, code: 'UNSUPPORTED', error: 'remote hosts are not supported yet (roadmap I5)' };
            try {
                const { stdout } = await driver.exec(['list']);
                const list = parseList(stdout);
                return { ...base, ok: true, hostname: base.hostname || list.hostname, ...list };
            } catch (err) {
                return { ...base, ok: false, code: err.code || 'ERROR', error: err.message };
            }
        }),
    );
    res.json({ hosts: result });
});

// GET /she/services/hosts/:host/adapters/:adapter/schema
router.get('/hosts/:host/adapters/:adapter/schema', async (req, res) => {
    const entry = resolve(req, res, { adapter: true });
    if (!entry) return;
    try {
        const schema = await loadSchema(entry.driver, req.params.adapter, { force: req.query.refresh === '1' });
        res.json({ schema, secrets: [...secretEnvVars(schema)] });
    } catch (err) {
        hostError(res, err);
    }
});

// POST /she/services/hosts/:host/adapters/:adapter/install { instance, env }
router.post('/hosts/:host/adapters/:adapter/install', async (req, res) => {
    const entry = resolve(req, res, { adapter: true });
    if (!entry) return;
    const { instance, env } = req.body || {};
    if (!validInstance(instance)) return res.status(400).json({ error: 'invalid instance name' });
    try {
        const merged = mergeEnv({}, env || {});
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
        res.json({ env: maskEnv(env, secrets), secrets: [...secrets], schema });
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
        const merged = mergeEnv(current, req.body && req.body.env);
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

module.exports = { router, init, getServicesConfig, validInstance, validAdapter, setDriverFactory, stopAllFollowers, mergeEnv, maskEnv };
