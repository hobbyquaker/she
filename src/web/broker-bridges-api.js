'use strict';

/**
 * broker-bridges-api — the Bridges page of the Broker tab: Mosquitto `connection` blocks.
 *
 * Mounted by broker-api.js under /she/broker/bridges*. The pure logic (block shape,
 * validation, loop check, diff, rollback decision) is in lib/mosquitto-bridges.js; the
 * probe in lib/mosquitto-probe.js. This file does the I/O: read and write mosquitto.conf
 * (locally or over SSH like the other broker pages), reload, probe, roll back.
 *
 * Secrets: remote_password, local_password and bridge_psk live in mosquitto.conf because
 * Mosquitto reads them from there. They are not handed to the UI (GET reports which ones
 * are set), a client sends `null` to keep the stored value, they are masked in the diff and
 * never logged.
 */

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dynsec = require('../lib/dynsec');
const mosquittoConf = require('../lib/mosquitto-conf');
const bridgesLib = require('../lib/mosquitto-bridges');
const probe = require('../lib/mosquitto-probe');
const sshDeploy = require('../lib/ssh-deploy');
const sheConfig = require('../config');
const { getBrokerLogBuffer } = require('./log-ws');

/** How long the managed broker gets to answer after a reload before she rolls back. */
const PROBE_TOTAL_MS = 8000;

/**
 * @param {object} deps
 * @param {(req) => object} deps.getBrokerConfig   config.broker from the live config.json
 * @param {(bc: object) => string} deps.confPath   path of mosquitto.conf
 * @param {() => object|null} deps.log             the daemon logger (may be null)
 * @param {() => object|null} deps.store           the MQTT state store (may be null)
 * @param {Map<string,string>} deps.lastWriteChecksum
 */
function createRouter({ getBrokerConfig, confPath, log, store, lastWriteChecksum }) {
    const router = express.Router();
    const L = () => log?.() ?? null;

    const isRemote = (bc) => !!(bc.ssh && bc.ssh.host);
    const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

    /** The conf as it is now: raw text, parsed, checksum. */
    async function readConf(bc) {
        const fp = confPath(bc);
        let raw = '';
        if (isRemote(bc)) {
            try {
                raw = await sshDeploy.readRemoteFile(bc.ssh, fp);
            } catch (e) {
                if (!String(e.message).toLowerCase().includes('no such file')) throw e;
            }
        } else {
            try {
                raw = fs.readFileSync(fp, 'utf8');
            } catch (e) {
                if (e.code !== 'ENOENT') throw e;
            }
        }
        return { fp, raw, parsed: mosquittoConf.parseText(raw), checksum: raw ? sha(raw) : null };
    }

    /** Write text as mosquitto.conf; returns the backup name (local mode) or null. */
    async function writeConf(bc, fp, content, previousRaw) {
        if (isRemote(bc)) {
            if (previousRaw) {
                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                await sshDeploy.uploadContent(bc.ssh, previousRaw, `${fp}.bak-${ts}`);
            }
            await sshDeploy.uploadContent(bc.ssh, content, fp);
            return null;
        }
        const result = mosquittoConf.write(fp, content);
        lastWriteChecksum.set(fp, mosquittoConf.checksum(fp));
        return result.backupPath ? path.basename(result.backupPath) : null;
    }

    async function restoreConf(bc, fp, previousRaw) {
        if (isRemote(bc)) {
            await sshDeploy.uploadContent(bc.ssh, previousRaw, fp);
        } else {
            fs.writeFileSync(fp, previousRaw, 'utf8');
            lastWriteChecksum.set(fp, mosquittoConf.checksum(fp));
        }
    }

    async function reloadBroker(bc) {
        if (isRemote(bc)) return sshDeploy.runCommand(bc.ssh, bc.reloadCmd || 'sudo systemctl reload mosquitto');
        return mosquittoConf.reload(bc);
    }

    async function restartBroker(bc) {
        if (isRemote(bc)) return sshDeploy.runCommand(bc.ssh, bc.restartCmd || 'sudo systemctl restart mosquitto');
        return mosquittoConf.restart(bc);
    }

    /**
     * The managed broker answers an MQTT connection? Uses she's own connection (config.url); null
     * when she has no broker URL. `broker.probeTimeout` (ms) overrides the grace period.
     */
    async function probeManagedBroker(bc) {
        if (!sheConfig.url) return null;
        const totalMs = Number(bc.probeTimeout) > 0 ? Number(bc.probeTimeout) : PROBE_TOTAL_MS;
        return probe.waitForBroker(sheConfig.url, probe.sheConnectOptions(sheConfig), { totalMs, attemptMs: Math.min(3000, totalMs) });
    }

    /**
     * The bridge list for the UI: a secret becomes null in its place (so a client that sends the
     * block back unchanged keeps its line order) and `secrets` says which ones are set.
     */
    function sanitise(bridge) {
        const options = { ...(bridge.options || {}) };
        const secrets = {};
        for (const k of bridgesLib.SECRET_KEYS) {
            if (options[k] === undefined) continue;
            if (options[k] !== '') secrets[k] = true;
            options[k] = null;
        }
        return { ...bridge, options, secrets };
    }

    /**
     * Put the stored secrets back into a bridge the client sent: `null` means "keep what the
     * conf has" (matched by `originalName`, then by `name`); a string sets, '' or absence clears.
     */
    function mergeSecrets(incoming, current) {
        const options = { ...(incoming.options || {}) };
        const prev = current.find((b) => b.name === incoming.originalName) || current.find((b) => b.name === incoming.name);
        for (const k of bridgesLib.SECRET_KEYS) {
            if (options[k] === null) {
                if (prev && prev.options && prev.options[k] !== undefined) options[k] = prev.options[k];
                else delete options[k];
            }
        }
        // an empty value means "not set" — for every option, secret or not
        for (const k of Object.keys(options)) {
            if (options[k] === undefined || options[k] === null || String(options[k]).trim() === '') delete options[k];
        }
        const { originalName: _o, secrets: _s, ...rest } = incoming;
        return { ...rest, name: String(incoming.name ?? '').trim(), addresses: (incoming.addresses || []).map((a) => String(a).trim()).filter(Boolean), options };
    }

    /** Normalise a client-sent list into the lib's shape, with the stored secrets. */
    function normaliseIncoming(list, current) {
        if (!Array.isArray(list)) throw Object.assign(new Error('bridges must be an array'), { status: 400 });
        return list.map((b) => {
            const merged = mergeSecrets(b, current);
            merged.topics = (b.topics || []).map((t) => ({
                pattern: String(t.pattern ?? '').trim(),
                direction: t.direction || 'out',
                qos: Number(t.qos ?? 0),
                localPrefix: String(t.localPrefix ?? '').trim(),
                remotePrefix: String(t.remotePrefix ?? '').trim(),
            }));
            return merged;
        });
    }

    /** `$SYS/broker/connection/<id>/state` as the she-admin and the main client saw it. */
    function connectionStates() {
        const states = {};
        const take = (topic, entry) => {
            const m = topic.match(/^\$SYS\/broker\/connection\/(.+)\/state$/);
            if (!m) return;
            const prev = states[m[1]];
            if (!prev || (entry.ts ?? 0) >= (prev.ts ?? 0)) states[m[1]] = { connected: String(entry.val) === '1', ts: entry.ts ?? null, topic };
        };
        for (const [topic, entry] of Object.entries(dynsec.getSysData())) take(topic, entry);
        const s = store?.();
        if (s) for (const [topic, entry] of s.mqttEntries()) take(topic, entry);
        return states;
    }

    /** Match the states to the bridges: by notification_topic, remote_clientid, `<host>.<name>` or `<name>`. */
    function statesForBridges(list, bc) {
        const byId = connectionStates();
        const hostname = isRemote(bc) ? null : os.hostname();
        const out = {};
        for (const b of list) {
            const o = b.options || {};
            let hit = null;
            if (o.notification_topic) {
                const all = { ...dynsec.getSysData() };
                const s = store?.();
                if (s) for (const [topic, entry] of s.mqttEntries()) if (!all[topic]) all[topic] = entry;
                const e = all[o.notification_topic];
                if (e) hit = { connected: String(e.val) === '1', ts: e.ts ?? null, topic: o.notification_topic };
            } else {
                const id = bridgesLib.remoteClientId(b, hostname);
                if (id && byId[id]) hit = byId[id];
                else {
                    const key = Object.keys(byId).find((k) => k === b.name || k.endsWith(`.${b.name}`));
                    if (key) hit = byId[key];
                }
            }
            out[b.name] = hit || { connected: null, ts: null, topic: null };
        }
        return out;
    }

    function brokerVersion() {
        const sys = dynsec.getSysData();
        let v = sys['$SYS/broker/version']?.val;
        if (!v && store?.()) {
            for (const [topic, entry] of store().mqttEntries()) if (topic === '$SYS/broker/version') v = entry.val;
        }
        return bridgesLib.brokerVersionFromSys(v);
    }

    /**
     * Is this address the broker she manages (so she could create the bridge user there)?
     * The host must be this broker's host and the port, when given, one of its listeners.
     */
    function managedHere(address, bc, listeners = []) {
        const raw = String(address || '');
        const portMatch = raw.match(/^(?:\[[^\]]+\]|[^:]+):(\d+)$/);
        const port = portMatch ? Number(portMatch[1]) : null;
        const host = raw
            .replace(/^\[([^\]]+)\](:\d+)?$/, '$1')
            .replace(/:\d+$/, '')
            .toLowerCase();
        if (!host) return false;
        if (port !== null) {
            const ports = new Set(listeners.map((l) => Number(l.port)).filter(Boolean));
            try {
                if (sheConfig.url) ports.add(Number(new URL(sheConfig.url).port) || 1883);
            } catch {
                /* ignore */
            }
            if (ports.size === 0) ports.add(1883);
            if (!ports.has(port)) return false;
        }
        const candidates = new Set(['localhost', '127.0.0.1', '::1']);
        if (isRemote(bc)) candidates.add(String(bc.ssh.host).toLowerCase());
        else {
            candidates.add(os.hostname().toLowerCase());
            candidates.add(os.hostname().split('.')[0].toLowerCase());
        }
        try {
            if (sheConfig.url) candidates.add(new URL(sheConfig.url).hostname.replace(/^\[|\]$/g, '').toLowerCase());
        } catch {
            /* ignore */
        }
        return candidates.has(host);
    }

    function fail(res, err) {
        res.status(err.status || 500).json({ error: err.message });
    }

    // ── Routes ─────────────────────────────────────────────────────────────────

    /** GET /she/broker/bridges — the bridges of mosquitto.conf, their live state, the broker version. */
    router.get('/bridges', async (req, res) => {
        try {
            const bc = getBrokerConfig(req);
            const { parsed, checksum } = await readConf(bc);
            res.json({
                bridges: parsed.bridges.map(sanitise),
                states: statesForBridges(parsed.bridges, bc),
                checksum,
                brokerVersion: brokerVersion(),
                mode: isRemote(bc) ? 'remote' : 'local',
                probeUrl: sheConfig.url || null,
                presets: bridgesLib.PRESETS.map(({ rules: _r, ...p }) => p),
                options: bridgesLib.BRIDGE_OPTIONS,
            });
        } catch (err) {
            fail(res, err);
        }
    });

    /** POST /she/broker/bridges/preview — validate and show the mosquitto.conf diff. Body: { bridges } */
    router.post('/bridges/preview', async (req, res) => {
        try {
            const bc = getBrokerConfig(req);
            const { raw, parsed, checksum } = await readConf(bc);
            const list = normaliseIncoming(req.body.bridges, parsed.bridges);
            const { errors, warnings } = bridgesLib.validateBridges(list, { brokerVersion: brokerVersion() });
            const after = mosquittoConf.serialise({ ...parsed, bridges: list });
            const diff = bridgesLib.unifiedDiff(raw, after);
            const remote = {};
            for (const b of list) remote[b.name] = { ...bridgesLib.remoteRequirements(b), managedHere: b.addresses.some((a) => managedHere(a, bc, parsed.listeners)) };
            res.json({ errors, warnings, diff, changed: diff !== '', checksum, remote });
        } catch (err) {
            fail(res, err);
        }
    });

    /**
     * PUT /she/broker/bridges — write the bridges, reload, probe, roll back if the broker is gone.
     * Body: { bridges, checksum }  (checksum: the one GET/preview returned, for external-modify detection)
     */
    router.put('/bridges', async (req, res) => {
        const log = L();
        try {
            const bc = getBrokerConfig(req);
            const { fp, raw, parsed, checksum } = await readConf(bc);
            if (req.body.checksum !== undefined && req.body.checksum !== null && checksum !== null && req.body.checksum !== checksum) {
                return res.status(409).json({ error: 'external_modify', message: 'mosquitto.conf was modified since it was read — reload the page' });
            }
            const list = normaliseIncoming(req.body.bridges, parsed.bridges);
            const { errors, warnings } = bridgesLib.validateBridges(list, { brokerVersion: brokerVersion() });
            if (errors.length > 0) return res.status(400).json({ error: 'invalid', errors, warnings });
            const content = mosquittoConf.serialise({ ...parsed, bridges: list });
            if (content === raw) return res.json({ ok: true, unchanged: true, checksum });

            log?.info(`broker: writing ${list.length} bridge${list.length === 1 ? '' : 's'} to ${isRemote(bc) ? `${bc.ssh.host}:` : ''}${fp}`);
            const writtenAt = Date.now();
            const backupPath = await writeConf(bc, fp, content, raw);

            let reloadOk = true;
            let reloadError = null;
            try {
                await reloadBroker(bc);
            } catch (e) {
                reloadOk = false;
                reloadError = e.message;
                log?.warn(`broker: reload after the bridge change failed: ${e.message}`);
            }
            const probed = await probeManagedBroker(bc);
            const probeOk = probed ? probed.ok : true;
            const decision = bridgesLib.decideRollback({ reloadOk, probeOk });

            const brokerErrors = getBrokerLogBuffer()
                .filter((e) => e.ts >= writtenAt - 500 && e.level === 'E')
                .map((e) => e.msg);

            if (!decision.rollback) {
                log?.info(`broker: bridges applied${probed ? ` (broker answered after ${probed.durationMs} ms)` : ''}`);
                return res.json({ ok: true, rolledBack: false, probe: probed, warnings, brokerErrors, backupPath, checksum: sha(content) });
            }

            log?.warn(`broker: rolling back the bridge change — ${decision.reason}`);
            let recovered = null;
            let rollbackError = null;
            try {
                await restoreConf(bc, fp, raw);
                try {
                    if (decision.restart) await restartBroker(bc);
                    else await reloadBroker(bc);
                } catch (e) {
                    rollbackError = `${decision.restart ? 'restart' : 'reload'} after restoring: ${e.message}`;
                    log?.warn(`broker: ${rollbackError}`);
                }
                const again = await probeManagedBroker(bc);
                recovered = again ? again.ok : true;
            } catch (e) {
                rollbackError = `restoring the previous config: ${e.message}`;
                log?.error(`broker: rollback failed — ${rollbackError}`);
            }
            log?.[recovered ? 'info' : 'error'](`broker: rollback ${recovered ? 'done, the broker is back on the previous config' : 'finished, the broker still does not answer'}`);
            res.json({
                ok: false,
                rolledBack: true,
                restarted: decision.restart,
                recovered,
                reason: decision.reason,
                reloadError,
                rollbackError,
                probe: probed,
                brokerErrors,
                backupPath,
                checksum: sha(raw),
            });
        } catch (err) {
            log?.error(`broker: bridge save failed: ${err.message}`);
            fail(res, err);
        }
    });

    /**
     * POST /she/broker/bridges/test — connect once to the remote broker with the bridge's settings.
     * Body: { name?, addresses|address, options: { remote_username, remote_password (null = stored),
     *         remote_clientid, bridge_cafile, bridge_capath, bridge_certfile, bridge_keyfile,
     *         bridge_insecure, bridge_tls_version, bridge_protocol_version } }
     * The connection is made from the she host (not the broker host): the result tells about the
     * remote broker and the credentials, not about routes the broker host may lack.
     */
    router.post('/bridges/test', async (req, res) => {
        const log = L();
        try {
            const bc = getBrokerConfig(req);
            const body = req.body || {};
            const addresses = (body.addresses || (body.address ? [body.address] : [])).map((a) => String(a).trim()).filter(Boolean);
            if (addresses.length === 0) return res.status(400).json({ error: 'address required' });
            const { parsed } = await readConf(bc);
            const bridge = mergeSecrets({ name: body.name, originalName: body.originalName, addresses, options: body.options || {} }, parsed.bridges);
            const o = bridge.options;
            const tls = !!(o.bridge_cafile || o.bridge_capath || o.bridge_certfile || o.bridge_psk || o.bridge_tls_version);
            const m = addresses[0].match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
            const host = m ? m[1] : addresses[0];
            const port = m && m[2] ? Number(m[2]) : tls ? 8883 : 1883;
            const url = `${tls ? 'mqtts' : 'mqtt'}://${host}:${port}`;

            const readFile = async (p) => (isRemote(bc) ? sshDeploy.readRemoteFile(bc.ssh, p) : fs.readFileSync(p, 'utf8'));
            const opts = { clientId: o.remote_clientid || `she-bridge-test-${crypto.randomBytes(3).toString('hex')}` };
            if (o.remote_username) opts.username = o.remote_username;
            if (o.remote_password) opts.password = o.remote_password;
            if (o.bridge_protocol_version === 'mqttv31') opts.protocolVersion = 3;
            else if (o.bridge_protocol_version === 'mqttv50') opts.protocolVersion = 5;
            if (tls) {
                opts.rejectUnauthorized = o.bridge_insecure !== 'true';
                const files = [];
                try {
                    if (o.bridge_cafile) {
                        opts.ca = await readFile(o.bridge_cafile);
                        files.push(o.bridge_cafile);
                    }
                    if (o.bridge_certfile) {
                        opts.cert = await readFile(o.bridge_certfile);
                        files.push(o.bridge_certfile);
                    }
                    if (o.bridge_keyfile) {
                        opts.key = await readFile(o.bridge_keyfile);
                        files.push(o.bridge_keyfile);
                    }
                } catch (e) {
                    return res.json({ ok: false, url, error: `cannot read a TLS file on the broker host: ${e.message}`, stage: 'files' });
                }
                if (o.bridge_capath && !o.bridge_cafile) {
                    // a capath is a directory of hashed certs — load every PEM in it
                    try {
                        const dir = o.bridge_capath;
                        const names = isRemote(bc) ? (await sshDeploy.runCommand(bc.ssh, `ls -1 -- "${dir}"`)).stdout.split('\n').filter(Boolean) : fs.readdirSync(dir);
                        const pems = [];
                        for (const n of names.filter((f) => /\.(crt|pem)$/.test(f))) pems.push(await readFile(path.posix.join(dir, n)));
                        if (pems.length > 0) opts.ca = pems;
                    } catch (e) {
                        return res.json({ ok: false, url, error: `cannot read bridge_capath: ${e.message}`, stage: 'files' });
                    }
                }
                if (o.bridge_tls_version === 'tlsv1.3') opts.minVersion = 'TLSv1.3';
                if (o.bridge_tls_version === 'tlsv1.2') opts.minVersion = 'TLSv1.2';
            }
            log?.debug(`broker: testing bridge connection to ${url} as ${opts.username || '(anonymous)'}`);
            const r = await probe.connectOnce(url, opts, 6000);
            res.json({ ...r, url, from: os.hostname(), stage: 'connect' });
        } catch (err) {
            fail(res, err);
        }
    });

    /** POST /she/broker/bridges/remote-requirements — what the remote broker needs. Body: { bridge } */
    router.post('/bridges/remote-requirements', async (req, res) => {
        try {
            const bc = getBrokerConfig(req);
            const b = req.body.bridge || {};
            const bridge = { ...b, options: Object.fromEntries(Object.entries(b.options || {}).filter(([, v]) => v !== null && v !== undefined)) };
            const { parsed } = await readConf(bc);
            const r = bridgesLib.remoteRequirements(bridge);
            const here = (bridge.addresses || []).some((a) => managedHere(a, bc, parsed.listeners));
            const ds = dynsec.getStatus();
            res.json({ ...r, managedHere: here, canCreate: here && ds.configured && ds.connected });
        } catch (err) {
            fail(res, err);
        }
    });

    /**
     * POST /she/broker/bridges/remote-user — create the bridge user and role on the managed broker.
     * Only when the bridge's remote address is this broker. Body: { bridge, password }
     */
    router.post('/bridges/remote-user', async (req, res) => {
        const log = L();
        try {
            const bc = getBrokerConfig(req);
            const b = req.body.bridge || {};
            const password = req.body.password;
            const { parsed } = await readConf(bc);
            if (!(b.addresses || []).some((a) => managedHere(a, bc, parsed.listeners))) {
                return res.status(409).json({ error: 'The remote address is not the broker this she manages — create the user there yourself.' });
            }
            const r = bridgesLib.remoteRequirements(b);
            if (!r.username) return res.status(400).json({ error: 'the bridge needs a remote username first' });
            if (!password || typeof password !== 'string') return res.status(400).json({ error: 'password required' });
            const done = [];
            const skipped = [];
            const step = async (what, fn) => {
                try {
                    await fn();
                    done.push(what);
                } catch (e) {
                    if (/already exists/i.test(e.message)) skipped.push(`${what} (exists)`);
                    else throw new Error(`${what}: ${e.message}`);
                }
            };
            await step(`user ${r.username}`, () => dynsec.createClient(r.username, password));
            await step(`role ${r.role}`, () => dynsec.createRole(r.role));
            for (const a of r.acls) await step(`${a.acltype} ${a.topic}`, () => dynsec.addRoleACL(r.role, a.acltype, a.topic, true));
            await step(`role ${r.role} → ${r.username}`, () => dynsec.addClientRole(r.username, r.role));
            log?.info(`broker: bridge user ${r.username} with role ${r.role} created on the managed broker`);
            res.json({ ok: true, done, skipped });
        } catch (err) {
            fail(res, err);
        }
    });

    return router;
}

module.exports = { createRouter, PROBE_TOTAL_MS };
