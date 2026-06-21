'use strict';

/**
 * broker-api — HTTP API for mosquitto broker management.
 *
 * Mounted at /she/broker/* in server.js.
 * All routes require Bearer token auth (handled by the outer authMiddleware).
 *
 * Covers:
 *   - Status / $SYS stats
 *   - mosquitto.conf read / write / reload / restart / backup management
 *   - dynsec: users, roles, role ACLs, role assignments, groups
 *   - Local CA + client cert issuance (delegates to ca.js)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const dynsec = require('../lib/dynsec');
const mosquittoConf = require('../lib/mosquitto-conf');
const ca = require('../lib/ca');
const sshDeploy = require('../lib/ssh-deploy');
const sheConfig = require('../config');
const { getBrokerLogBuffer } = require('./log-ws');

// Default SSH identity file respects the configured data directory
const DEFAULT_SSH_KEY = path.join(sheConfig['data-dir'], 'ssh', 'broker_id_ed25519');

const router = express.Router();

let _log = null;
let _store = null;

/** Must be called once from index.js so broker-api can emit debug-level log lines. */
function setLogger(log) {
    _log = log;
}

/** Must be called once from index.js to give broker-api access to the MQTT state store. */
function setStore(store) {
    _store = store;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Get broker config from live config.json */
function getBrokerConfig(req) {
    const configPath = req.app.locals.configPath;
    if (!configPath) return {};
    try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return cfg.broker || {};
    } catch {
        return {};
    }
}

/** Resolve mosquitto.conf path from broker config */
function confPath(brokerConfig) {
    const dir = brokerConfig.configDir || '/etc/mosquitto';
    return path.join(dir, 'mosquitto.conf');
}

// Per-request checksum cache so the UI can detect external modifications
// Key: confPath, Value: last-seen checksum after a write
const _lastWriteChecksum = new Map();

function handleError(res, err) {
    res.status(500).json({ error: err.message });
}

// ── Status ─────────────────────────────────────────────────────────────────────

/**
 * GET /she/broker/status
 * Returns dynsec connection status + any $SYS stats collected by the main
 * MQTT client and stored in app.locals.mqttState.
 */
router.get('/status', (req, res) => {
    const bc = getBrokerConfig(req);
    const ds = dynsec.getStatus();
    const sshConfigured = !!(bc.ssh && bc.ssh.host);
    const sshHost = sshConfigured ? bc.ssh.host : null;

    // Prefer $SYS data from the she-admin MQTT client: it has admin role ACLs
    // that explicitly allow $SYS/# even when the main client is denied by
    // default-deny subscribe ACLs.
    const sys = dynsec.getSysData();
    // Fall back to the main MQTT client's state store for any topics not yet
    // received by the dynsec client (e.g. when dynsec is not configured).
    if (_store) {
        const sysPrefixes = [
            '$SYS/broker/version',
            '$SYS/broker/uptime',
            '$SYS/broker/clients/',
            '$SYS/broker/messages/',
            '$SYS/broker/subscriptions/',
            '$SYS/broker/retained messages/',
            '$SYS/broker/bytes/',
            '$SYS/broker/heap/',
        ];
        for (const [topic, entry] of _store.mqttEntries()) {
            if (!sys[topic] && sysPrefixes.some((p) => topic.startsWith(p))) {
                sys[topic] = entry;
            }
        }
    }

    res.json({ dynsec: ds, sys, sshKeyDefault: DEFAULT_SSH_KEY, sshConfigured, sshHost });
});

// ── mosquitto.conf ─────────────────────────────────────────────────────────────

/**
 * GET /she/broker/config
 * Returns parsed config structure + raw text + checksum.
 * In remote mode, reads mosquitto.conf from the broker host via SSH.
 */
router.get('/config', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const fp = confPath(bc);
        if (bc.ssh && bc.ssh.host) {
            _log?.debug(`broker: reading remote config from ${bc.ssh.host}:${fp}`);
            const raw = await sshDeploy.readRemoteFile(bc.ssh, fp);
            const parsed = mosquittoConf.parseText(raw);
            const cs = crypto.createHash('sha256').update(raw).digest('hex');
            return res.json({ ...parsed, checksum: cs, backups: [] });
        }
        const parsed = mosquittoConf.parse(fp);
        const cs = mosquittoConf.checksum(fp);
        const backups = mosquittoConf.listBackups(fp).map((b) => path.basename(b));
        res.json({ ...parsed, checksum: cs, backups });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * PUT /she/broker/config
 * Write structured config (body: { listeners, managed, passthrough, checksum? }).
 * body.checksum is the client's last-known checksum for external-modify detection.
 * In remote mode, uploads directly to the broker host via SCP — no local fs access.
 */
router.put('/config', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const fp = confPath(bc);
        const { listeners, managed, passthrough, checksum: clientChecksum } = req.body;
        const content = mosquittoConf.serialise({ listeners, managed, passthrough });
        if (bc.ssh && bc.ssh.host) {
            _log?.info(`broker: uploading config to remote ${bc.ssh.host}:${fp}`);
            await sshDeploy.uploadContent(bc.ssh, content, fp);
            return res.json({ ok: true, backupPath: null });
        }
        _log?.info(`broker: writing config to local ${fp}`);
        const result = mosquittoConf.write(fp, content, clientChecksum ?? null);
        if (!result.ok) {
            return res.status(409).json({ error: 'external_modify', message: 'mosquitto.conf was modified externally since last read' });
        }
        _lastWriteChecksum.set(fp, mosquittoConf.checksum(fp));
        res.json({ ok: true, backupPath: result.backupPath ? path.basename(result.backupPath) : null });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * PUT /she/broker/config/raw
 * Write raw mosquitto.conf text directly (used by the Advanced editor).
 * In remote mode, uploads directly to the broker host via SCP — no local fs access.
 */
router.put('/config/raw', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const fp = confPath(bc);
        const { content, checksum: clientChecksum } = req.body;
        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'content must be a string' });
        }
        if (bc.ssh && bc.ssh.host) {
            _log?.info(`broker: uploading raw config to remote ${bc.ssh.host}:${fp}`);
            await sshDeploy.uploadContent(bc.ssh, content, fp);
            return res.json({ ok: true, backupPath: null });
        }
        _log?.info(`broker: writing raw config to local ${fp}`);
        const result = mosquittoConf.write(fp, content, clientChecksum ?? null);
        if (!result.ok) {
            return res.status(409).json({ error: 'external_modify', message: 'mosquitto.conf was modified externally since last read' });
        }
        _lastWriteChecksum.set(fp, mosquittoConf.checksum(fp));
        res.json({ ok: true, backupPath: result.backupPath ? path.basename(result.backupPath) : null });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * GET /she/broker/config/backups
 * List backup filenames.
 */
router.get('/config/backups', (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const fp = confPath(bc);
        const backups = mosquittoConf.listBackups(fp).map((b) => path.basename(b));
        res.json({ backups });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * POST /she/broker/config/restore
 * Restore a named backup. Body: { backup: '<filename>' }
 */
router.post('/config/restore', (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const fp = confPath(bc);
        const dir = path.dirname(fp);
        const base = path.basename(fp);
        const { backup } = req.body;
        if (!backup || typeof backup !== 'string') {
            return res.status(400).json({ error: 'backup filename required' });
        }
        // Safety: backup must be in the same directory and match expected prefix
        const backupPath = path.resolve(dir, backup);
        if (!backupPath.startsWith(path.resolve(dir) + path.sep) || !path.basename(backupPath).startsWith(`${base}.bak-`)) {
            return res.status(400).json({ error: 'invalid backup filename' });
        }
        mosquittoConf.restoreBackup(backupPath, fp);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * POST /she/broker/reload
 * Send SIGHUP / systemctl reload to mosquitto.
 * In remote mode, the command is executed on the broker host via SSH.
 */
router.post('/reload', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        if (bc.ssh && bc.ssh.host) {
            const cmd = bc.reloadCmd || 'sudo systemctl reload mosquitto';
            _log?.debug(`broker: remote reload on ${bc.ssh.host}: ${cmd}`);
            const result = await sshDeploy.runCommand(bc.ssh, cmd);
            _log?.debug(`broker: remote reload stdout=${result.stdout} stderr=${result.stderr}`);
            return res.json({ ok: true, ...result });
        }
        _log?.debug('broker: local reload mosquitto');
        const result = await mosquittoConf.reload(bc);
        _log?.debug(`broker: local reload stdout=${result.stdout} stderr=${result.stderr}`);
        res.json({ ok: true, stdout: result.stdout, stderr: result.stderr });
    } catch (err) {
        _log?.debug(`broker: reload error: ${err.message}`);
        handleError(res, err);
    }
});

/**
 * POST /she/broker/restart
 * Full mosquitto service restart.
 * In remote mode, the command is executed on the broker host via SSH.
 */
router.post('/restart', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        if (bc.ssh && bc.ssh.host) {
            const cmd = bc.restartCmd || 'sudo systemctl restart mosquitto';
            _log?.debug(`broker: remote restart on ${bc.ssh.host}: ${cmd}`);
            const result = await sshDeploy.runCommand(bc.ssh, cmd);
            _log?.debug(`broker: remote restart stdout=${result.stdout} stderr=${result.stderr}`);
            return res.json({ ok: true, ...result });
        }
        _log?.debug('broker: local restart mosquitto');
        const result = await mosquittoConf.restart(bc);
        _log?.debug(`broker: local restart stdout=${result.stdout} stderr=${result.stderr}`);
        res.json({ ok: true, stdout: result.stdout, stderr: result.stderr });
    } catch (err) {
        _log?.debug(`broker: restart error: ${err.message}`);
        handleError(res, err);
    }
});

// ── dynsec: Users ─────────────────────────────────────────────────────────────

/** GET /she/broker/users */
router.get('/users', async (req, res) => {
    try {
        const users = await dynsec.listClients(true);
        res.json({ users });
    } catch (err) {
        handleError(res, err);
    }
});

/** POST /she/broker/users — body: { username, password } */
router.post('/users', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'username and password required' });
        await dynsec.createClient(username, password);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/** DELETE /she/broker/users/:user */
router.delete('/users/:user', async (req, res) => {
    try {
        await dynsec.deleteClient(req.params.user);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/** PUT /she/broker/users/:user/password — body: { password } */
router.put('/users/:user/password', async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) return res.status(400).json({ error: 'password required' });
        await dynsec.setClientPassword(req.params.user, password);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/** POST /she/broker/users/:user/roles — body: { rolename } */
router.post('/users/:user/roles', async (req, res) => {
    try {
        const { rolename } = req.body;
        if (!rolename) return res.status(400).json({ error: 'rolename required' });
        await dynsec.addClientRole(req.params.user, rolename);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/** DELETE /she/broker/users/:user/roles/:role */
router.delete('/users/:user/roles/:role', async (req, res) => {
    try {
        await dynsec.removeClientRole(req.params.user, req.params.role);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

// ── dynsec: Roles ─────────────────────────────────────────────────────────────

/** GET /she/broker/roles */
router.get('/roles', async (req, res) => {
    try {
        const roles = await dynsec.listRoles(true);
        res.json({ roles });
    } catch (err) {
        handleError(res, err);
    }
});

/** POST /she/broker/roles — body: { rolename } */
router.post('/roles', async (req, res) => {
    try {
        const { rolename } = req.body;
        if (!rolename) return res.status(400).json({ error: 'rolename required' });
        await dynsec.createRole(rolename);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/** DELETE /she/broker/roles/:role */
router.delete('/roles/:role', async (req, res) => {
    try {
        await dynsec.deleteRole(req.params.role);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/** POST /she/broker/roles/:role/acls — body: { acltype, topic, allow, priority? } */
router.post('/roles/:role/acls', async (req, res) => {
    try {
        const { acltype, topic, allow, priority } = req.body;
        if (!acltype || !topic || allow === undefined) return res.status(400).json({ error: 'acltype, topic and allow required' });
        await dynsec.addRoleACL(req.params.role, acltype, topic, !!allow, priority);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/** DELETE /she/broker/roles/:role/acls — body: { acltype, topic } */
router.delete('/roles/:role/acls', async (req, res) => {
    try {
        const { acltype, topic } = req.body;
        if (!acltype || !topic) return res.status(400).json({ error: 'acltype and topic required' });
        await dynsec.removeRoleACL(req.params.role, acltype, topic);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

// ── dynsec: Groups ────────────────────────────────────────────────────────────

/** GET /she/broker/groups */
router.get('/groups', async (req, res) => {
    try {
        const groups = await dynsec.listGroups(true);
        res.json({ groups });
    } catch (err) {
        handleError(res, err);
    }
});

/** POST /she/broker/groups — body: { groupname } */
router.post('/groups', async (req, res) => {
    try {
        const { groupname } = req.body;
        if (!groupname) return res.status(400).json({ error: 'groupname required' });
        await dynsec.createGroup(groupname);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/** DELETE /she/broker/groups/:group */
router.delete('/groups/:group', async (req, res) => {
    try {
        await dynsec.deleteGroup(req.params.group);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/** POST /she/broker/groups/:group/clients — body: { username } */
router.post('/groups/:group/clients', async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.status(400).json({ error: 'username required' });
        await dynsec.addGroupClient(req.params.group, username);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/** DELETE /she/broker/groups/:group/clients/:user */
router.delete('/groups/:group/clients/:user', async (req, res) => {
    try {
        await dynsec.removeGroupClient(req.params.group, req.params.user);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/** POST /she/broker/groups/:group/roles — body: { rolename } */
router.post('/groups/:group/roles', async (req, res) => {
    try {
        const { rolename } = req.body;
        if (!rolename) return res.status(400).json({ error: 'rolename required' });
        await dynsec.addGroupRole(req.params.group, rolename);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/** DELETE /she/broker/groups/:group/roles/:role */
router.delete('/groups/:group/roles/:role', async (req, res) => {
    try {
        await dynsec.removeGroupRole(req.params.group, req.params.role);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

// ── dynsec: Default ACL access ────────────────────────────────────────────────

/** GET /she/broker/acl-defaults */
router.get('/acl-defaults', async (req, res) => {
    try {
        const acls = await dynsec.getDefaultACLAccess();
        res.json({ acls });
    } catch (err) {
        handleError(res, err);
    }
});

/** PUT /she/broker/acl-defaults */
router.put('/acl-defaults', async (req, res) => {
    try {
        const { acls } = req.body;
        if (!Array.isArray(acls)) return res.status(400).json({ error: 'acls array required' });
        await dynsec.setDefaultACLAccess(acls);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

// ── dynsec: Anonymous group ───────────────────────────────────────────────────

/** GET /she/broker/anonymous-group */
router.get('/anonymous-group', async (req, res) => {
    try {
        const group = await dynsec.getAnonymousGroup();
        res.json({ group });
    } catch (err) {
        handleError(res, err);
    }
});

/** PUT /she/broker/anonymous-group */
router.put('/anonymous-group', async (req, res) => {
    try {
        const { groupname } = req.body;
        if (typeof groupname !== 'string' && groupname !== null) return res.status(400).json({ error: 'groupname string or null required' });
        await dynsec.setAnonymousGroup(groupname);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

// ── CA routes ─────────────────────────────────────────────────────────────────

/** GET /she/broker/ca — CA cert info */
router.get('/ca', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const info = await ca.getCA(bc);
        res.json({ ca: info });
    } catch (err) {
        handleError(res, err);
    }
});

/** POST /she/broker/ca/generate — Generate new CA keypair + cert */
router.post('/ca/generate', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const { cn, days } = req.body;
        const info = await ca.generateCA(bc, { cn, days });
        res.json({ ok: true, ...info });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * POST /she/broker/ca/import
 * Import an existing CA from PEM text or a PKCS#12 file.
 * Body (PEM mode):  { cert: string, key: string, chain?: string }
 * Body (P12 mode):  { p12base64: string, passphrase: string, chain?: string }
 */
router.post('/ca/import', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const { cert, key, chain, p12base64, passphrase } = req.body;
        let certPem, keyPem;
        if (p12base64 !== undefined) {
            const p12Buffer = Buffer.from(p12base64, 'base64');
            ({ certPem, keyPem } = await ca.extractFromP12(p12Buffer, passphrase ?? ''));
        } else {
            if (!cert || !key) return res.status(400).json({ error: 'cert and key are required' });
            certPem = cert;
            keyPem = key;
        }
        const result = await ca.importCA(bc, { certPem, keyPem, chainPem: chain || null });
        res.json({ ok: true, ca: result });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * GET /she/broker/fs/complete?path=<prefix>
 * Returns filesystem path completions for a partial absolute path.
 * Works locally or via SSH when broker.ssh is configured.
 */
router.get('/fs/complete', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const inputPath = String(req.query.path || '').trim();
        if (!inputPath.startsWith('/')) return res.json({ suggestions: [] });

        const endsWithSlash = inputPath.endsWith('/');
        const posix = require('path').posix;
        const dir = endsWithSlash ? inputPath : posix.dirname(inputPath);
        const prefix = endsWithSlash ? '' : posix.basename(inputPath);

        let entries = [];
        if (bc.ssh && bc.ssh.host) {
            try {
                const { stdout } = await sshDeploy.runCommand(bc.ssh, `ls -1p -- "${dir}" 2>/dev/null`);
                entries = stdout.split('\n').filter(Boolean);
            } catch {
                entries = [];
            }
        } else {
            try {
                const items = fs.readdirSync(dir, { withFileTypes: true });
                entries = items.map((d) => d.name + (d.isDirectory() ? '/' : ''));
            } catch {
                entries = [];
            }
        }

        const base = dir.endsWith('/') ? dir : dir + '/';
        const suggestions = entries
            .filter((e) => e.startsWith(prefix))
            .map((e) => base + e)
            .slice(0, 25);

        res.json({ suggestions });
    } catch {
        res.json({ suggestions: [] });
    }
});

/** GET /she/broker/ca/server — Server cert info */
router.get('/ca/server', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const serverCrt = path.join(ca.caDir(bc), 'server', 'server.crt');
        const fs = require('fs');
        if (!fs.existsSync(serverCrt)) return res.json({ server: null });
        const fingerprint = await ca.certFingerprint(serverCrt);
        const expires = await ca.certExpiry(serverCrt);
        const cn = await ca.certCN(serverCrt);
        res.json({ server: { fingerprint, expires, cn } });
    } catch (err) {
        handleError(res, err);
    }
});

/** POST /she/broker/ca/server/generate — Generate self-signed server cert (auto-creates internal CA) */
router.post('/ca/server/generate', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const { cn, san, days } = req.body;
        const result = await ca.generateServerCert(bc, { cn, san, days });
        res.json({ ok: true, fingerprint: result.fingerprint, expires: result.expires, certPath: result.certPath, keyPath: result.keyPath });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * POST /she/broker/ca/server/csr
 * Generate a private key + CSR for the server cert.
 * The CSR PEM is returned for external signing; the key is kept on disk.
 * Body: { cn?, san?: string[], days?: number }
 */
router.post('/ca/server/csr', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const { cn, san, days } = req.body;
        const result = await ca.generateServerCSR(bc, { cn, san, days });
        res.json({ ok: true, csrPem: result.csrPem });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * POST /she/broker/ca/server/import
 * Install an externally-signed server certificate (PEM or PKCS#12).
 * Body (PEM):  { cert: string, key?: string }
 *   key is optional when a key already exists on disk (e.g. from /csr).
 * Body (P12):  { p12base64: string, passphrase?: string }
 */
router.post('/ca/server/import', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const { cert, key, p12base64, passphrase } = req.body;
        let certPem, keyPem;
        if (p12base64 !== undefined) {
            const p12Buffer = Buffer.from(p12base64, 'base64');
            ({ certPem, keyPem } = await ca.extractFromP12(p12Buffer, passphrase ?? ''));
        } else {
            if (!cert) return res.status(400).json({ error: 'cert is required' });
            certPem = cert;
            keyPem = key || null;
        }
        const result = await ca.importServerCert(bc, { certPem, keyPem });
        res.json({ ok: true, server: result });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * POST /she/broker/ca/server/pathlink
 * Install a server cert+key from existing file paths on the broker host.
 * Reads via SSH if broker.ssh is configured, otherwise reads local files.
 * Body: { certPath: string, keyPath: string }
 */
router.post('/ca/server/pathlink', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const { certPath, keyPath } = req.body;
        if (!certPath || !keyPath) return res.status(400).json({ error: 'certPath and keyPath are required' });
        if (!certPath.startsWith('/') || !keyPath.startsWith('/')) return res.status(400).json({ error: 'Absolute paths required' });

        let certPem, keyPem;
        if (bc.ssh && bc.ssh.host) {
            certPem = await sshDeploy.readRemoteFile(bc.ssh, certPath);
            keyPem = await sshDeploy.readRemoteFile(bc.ssh, keyPath);
        } else {
            certPem = fs.readFileSync(certPath, 'utf8');
            keyPem = fs.readFileSync(keyPath, 'utf8');
        }

        const result = await ca.importServerCert(bc, { certPem, keyPem });
        res.json({ ok: true, server: result });
    } catch (err) {
        handleError(res, err);
    }
});

/** GET /she/broker/ca/certs — List issued client certs (from sheDB) */
router.get('/ca/certs', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) return res.json({ certs: [] });
        const certs = db.query(
            (doc) => doc._id && doc._id.startsWith('she/broker/cert/'),
            (doc) => doc,
        );
        res.json({ certs });
    } catch (err) {
        handleError(res, err);
    }
});

/** POST /she/broker/ca/certs — Issue new client cert */
router.post('/ca/certs', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const { cn, days } = req.body;
        if (!cn) return res.status(400).json({ error: 'cn required' });
        const result = await ca.issueClientCert(bc, { cn, days });
        // Store metadata in sheDB
        const db = req.app.locals.db;
        if (db) {
            db.set(`she/broker/cert/${result.serial}`, {
                cn: result.cn,
                serial: result.serial,
                fingerprint: result.fingerprint,
                issued: result.issued,
                expires: result.expires,
                revoked: false,
                revokedAt: null,
            });
        }
        // Return everything except the passphrase hidden
        res.json({
            ok: true,
            serial: result.serial,
            cn: result.cn,
            fingerprint: result.fingerprint,
            issued: result.issued,
            expires: result.expires,
            passphrase: result.passphrase,
            // crt and key included so UI can offer individual downloads
            crt: result.crt,
            key: result.key,
        });
    } catch (err) {
        handleError(res, err);
    }
});

/** DELETE /she/broker/ca/certs/:serial — Revoke client cert, regenerate CRL */
router.delete('/ca/certs/:serial', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const { serial } = req.params;
        const db = req.app.locals.db;
        const meta = db ? db.get(`she/broker/cert/${serial}`) : null;
        if (!meta) return res.status(404).json({ error: 'cert not found' });

        // Find the cert file
        const paths = ca.clientCertPaths(bc, meta.cn);
        const revokedPaths = [];
        const fs = require('fs');
        if (fs.existsSync(paths.crtPath)) revokedPaths.push(paths.crtPath);

        // Collect all other revoked certs
        if (db) {
            const allCerts = db.query(
                (doc) => doc._id && doc._id.startsWith('she/broker/cert/') && doc.revoked && doc._id !== `she/broker/cert/${serial}`,
                (doc) => doc,
            );
            for (const c of allCerts) {
                const p = ca.clientCertPaths(bc, c.cn);
                if (fs.existsSync(p.crtPath)) revokedPaths.push(p.crtPath);
            }
        }

        await ca.generateCRL(bc, revokedPaths);

        // Mark revoked in sheDB
        if (db) {
            db.extend(`she/broker/cert/${serial}`, { revoked: true, revokedAt: new Date().toISOString() });
        }

        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/** GET /she/broker/ca/certs/:serial/download?type=p12|crt|key|ca */
router.get('/ca/certs/:serial/download', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const { serial } = req.params;
        const { type = 'p12' } = req.query;
        const db = req.app.locals.db;
        const meta = db ? db.get(`she/broker/cert/${serial}`) : null;
        if (!meta) return res.status(404).json({ error: 'cert not found' });

        const paths = ca.clientCertPaths(bc, meta.cn);
        const fs = require('fs');
        let filePath, contentType, filename;

        switch (type) {
            case 'p12':
                filePath = paths.p12Path;
                contentType = 'application/x-pkcs12';
                filename = `${meta.cn}.p12`;
                break;
            case 'crt':
                filePath = paths.crtPath;
                contentType = 'application/x-pem-file';
                filename = `${meta.cn}.crt`;
                break;
            case 'key':
                filePath = paths.keyPath;
                contentType = 'application/x-pem-file';
                filename = `${meta.cn}.key`;
                break;
            case 'ca':
                filePath = paths.caPath;
                contentType = 'application/x-pem-file';
                filename = 'ca.crt';
                break;
            default:
                return res.status(400).json({ error: 'invalid type' });
        }

        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', contentType);
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        handleError(res, err);
    }
});

/** GET /she/broker/ca/trusted — List trusted CA certs in capath dir */
router.get('/ca/trusted', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const certs = await ca.listTrustedCerts(bc);
        res.json({ certs });
    } catch (err) {
        handleError(res, err);
    }
});

/** POST /she/broker/ca/trusted — Add trusted CA cert (body: { pem: string }) */
router.post('/ca/trusted', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const { pem } = req.body;
        if (!pem || typeof pem !== 'string') return res.status(400).json({ error: 'pem required' });
        const result = await ca.addTrustedCert(bc, pem);
        res.json({ ok: true, ...result });
    } catch (err) {
        handleError(res, err);
    }
});

/** DELETE /she/broker/ca/trusted/:fingerprint — Remove trusted CA cert */
router.delete('/ca/trusted/:fingerprint', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const fingerprint = decodeURIComponent(req.params.fingerprint);
        await ca.removeTrustedCert(bc, fingerprint);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * POST /she/broker/ca/trusted/addpath
 * Add a trusted CA cert from an existing file path on the broker host.
 * Reads via SSH if broker.ssh is configured, otherwise reads local file.
 * Body: { path: string }
 */
router.post('/ca/trusted/addpath', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const { path: filePath } = req.body;
        if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'path required' });
        if (!filePath.startsWith('/')) return res.status(400).json({ error: 'Absolute path required' });

        let pemContent;
        if (bc.ssh && bc.ssh.host) {
            pemContent = await sshDeploy.readRemoteFile(bc.ssh, filePath);
        } else {
            pemContent = fs.readFileSync(filePath, 'utf8');
        }

        const result = await ca.addTrustedCert(bc, pemContent);
        res.json({ ok: true, ...result });
    } catch (err) {
        handleError(res, err);
    }
});

// GET /she/broker/logs?limit=<N> — recent broker log entries (ring buffer, max 500)
router.get('/logs', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 500, 1000);
    const all = getBrokerLogBuffer();
    res.json(limit >= all.length ? all : all.slice(-limit));
});

module.exports = { router, setLogger, setStore };

// ── dynsec: ACL topic inspection ──────────────────────────────────────────────

/**
 * GET /she/broker/acl-check?topic=<topic>
 * Returns authoritative per-topic ACL breakdown: for each operation type
 * (send / subscribe / receive), lists matching roles with their holders
 * (direct users and group membership) plus the effective default.
 */
router.get('/acl-check', async (req, res) => {
    try {
        const topic = String(req.query.topic || '').trim();
        if (!topic) return res.status(400).json({ error: 'topic query param required' });

        const mqttWildcard = require('../lib/mqtt-wildcards');

        const [roles, groups, defaultAcls] = await Promise.all([dynsec.listRoles(true), dynsec.listGroups(true), dynsec.getDefaultACLAccess()]);

        // Build index: rolename → groups that carry it (with their member lists)
        const groupsByRole = new Map();
        for (const g of groups) {
            for (const r of g.roles ?? []) {
                if (!groupsByRole.has(r.rolename)) groupsByRole.set(r.rolename, []);
                groupsByRole.get(r.rolename).push({
                    groupname: g.groupname,
                    members: (g.clients ?? []).map((c) => c.username),
                });
            }
        }

        const SEND_TYPES = new Set(['publishClientSend']);
        const SUBSCRIBE_TYPES = new Set(['subscribePattern', 'subscribeLiteral']);
        const RECEIVE_TYPES = new Set(['publishClientReceive']);

        function aclMatches(acltype, aclTopic) {
            if (aclTopic.includes('%u') || aclTopic.includes('%c')) return 'dynamic';
            if (acltype === 'subscribeLiteral' || acltype === 'unsubscribeLiteral') {
                return aclTopic === topic ? 'match' : 'no-match';
            }
            return mqttWildcard(topic, aclTopic) !== null ? 'match' : 'no-match';
        }

        function matchRoles(typeSet) {
            const result = [];
            for (const role of roles) {
                for (const acl of role.acls ?? []) {
                    if (!typeSet.has(acl.acltype)) continue;
                    const m = aclMatches(acl.acltype, acl.topic);
                    if (m !== 'no-match') {
                        result.push({
                            rolename: role.rolename,
                            allow: acl.allow,
                            dynamic: m === 'dynamic',
                            users: (role.clients ?? []).map((c) => c.username),
                            groups: groupsByRole.get(role.rolename) ?? [],
                        });
                        break; // first matching ACL per role wins
                    }
                }
            }
            return result;
        }

        function defaultAllow(type) {
            const d = defaultAcls.find((a) => a.acltype === type);
            return d ? d.allow : false;
        }

        res.json({
            topic,
            send: { roles: matchRoles(SEND_TYPES), default: defaultAllow('publishClientSend') },
            subscribe: { roles: matchRoles(SUBSCRIBE_TYPES), default: defaultAllow('subscribePattern') },
            receive: { roles: matchRoles(RECEIVE_TYPES), default: defaultAllow('publishClientReceive') },
        });
    } catch (err) {
        handleError(res, err);
    }
});

// ── Local tool check ──────────────────────────────────────────────────────────

/**
 * GET /she/broker/local/check
 * Check whether local mosquitto tools are available in PATH.
 * Resolves by spawning each tool; ENOENT = not found, any other outcome = found.
 */
router.get('/local/check', async (req, res) => {
    function probe(cmd) {
        return new Promise((resolve) => {
            const cp = spawn(cmd, ['--help'], { stdio: 'ignore' });
            cp.on('error', (e) => resolve(e.code !== 'ENOENT'));
            cp.on('close', () => resolve(true));
        });
    }
    try {
        const [mosquittoCtrl, mosquitto] = await Promise.all([probe('mosquitto_ctrl'), probe('mosquitto')]);
        res.json({ mosquittoCtrl, mosquitto });
    } catch (err) {
        handleError(res, err);
    }
});

// ── IP address listing ────────────────────────────────────────────────────────

/**
 * GET /she/broker/ip-addresses
 * List host IP addresses for bind-address autocomplete.
 * Runs `ip a` locally or via SSH depending on broker.ssh configuration.
 */
router.get('/ip-addresses', async (req, res) => {
    const bc = getBrokerConfig(req);
    try {
        let stdout = '';
        if (bc.ssh && bc.ssh.host) {
            const result = await sshDeploy.runCommand(bc.ssh, 'ip a 2>/dev/null || ip addr 2>/dev/null');
            stdout = result.stdout;
        } else {
            const result = await execFileAsync('ip', ['a'], { timeout: 5000 }).catch(() => execFileAsync('ip', ['addr'], { timeout: 5000 }));
            stdout = result.stdout;
        }
        // Extract IPv4 and IPv6 addresses; skip loopback
        const addresses = [];
        for (const m of stdout.matchAll(/inet6?\s+([\da-f.:]+)(?:\/\d+)?/gi)) {
            const addr = m[1];
            if (addr === '127.0.0.1' || addr === '::1') continue;
            addresses.push(addr);
        }
        res.json({ addresses: [...new Set(addresses)] });
    } catch {
        res.json({ addresses: [] });
    }
});

// ── SSH routes ─────────────────────────────────────────────────────────────────
// Note: these routes are mounted on the same router but defined after module.exports
// because they add to `router` (which is already exported by reference).

/** GET /she/broker/ssh/pubkey — Read existing public key (if any) */
router.get('/ssh/pubkey', (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const identityFile = sshDeploy.expandHome((bc.ssh && bc.ssh.identityFile) || DEFAULT_SSH_KEY);
        const pubPath = identityFile + '.pub';
        if (!fs.existsSync(pubPath)) return res.json({ publicKey: null });
        const publicKey = fs.readFileSync(pubPath, 'utf8').trim();
        res.json({ publicKey });
    } catch (err) {
        handleError(res, err);
    }
});

/** POST /she/broker/ssh/keygen — Generate SSH keypair */
router.post('/ssh/keygen', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const identityFile = (bc.ssh && bc.ssh.identityFile) || DEFAULT_SSH_KEY;
        _log?.debug(`broker: generating SSH keypair at ${identityFile}`);
        const publicKey = await sshDeploy.generateKeypair(identityFile);
        _log?.debug('broker: SSH keypair generated ok');
        res.json({ ok: true, publicKey });
    } catch (err) {
        _log?.debug(`broker: SSH keygen error: ${err.message}`);
        handleError(res, err);
    }
});

/** POST /she/broker/ssh/test — Test SSH connection */
router.post('/ssh/test', async (req, res) => {
    const bc = getBrokerConfig(req);
    try {
        if (!bc.ssh || !bc.ssh.host) return res.status(400).json({ error: 'broker.ssh.host not configured' });
        const user = (bc.ssh && bc.ssh.user) || require('os').userInfo().username;
        const key = sshDeploy.expandHome((bc.ssh && bc.ssh.identityFile) || DEFAULT_SSH_KEY);
        _log?.debug(`broker: testing SSH to ${user}@${bc.ssh.host}:${bc.ssh.port || 22} key=${key}`);
        await sshDeploy.testConnection(bc.ssh);
        _log?.debug(`broker: SSH connection to ${bc.ssh.host} ok`);
        res.json({ ok: true });
    } catch (err) {
        _log?.debug(`broker: SSH test to ${bc.ssh && bc.ssh.host} failed: ${err.message}`);
        res.json({ ok: false, error: err.message });
    }
});

// ── Bootstrap wizard ───────────────────────────────────────────────────────────

/**
 * POST /she/broker/wizard/probe
 * Check if dynsec is already active by looking at the dynsec client status.
 */
router.post('/wizard/probe', (req, res) => {
    const status = dynsec.getStatus();
    res.json({ active: status.connected, configured: status.configured });
});

/**
 * POST /she/broker/wizard/bootstrap
 * Full bootstrap flow:
 *   1. Generate dynamic-security.json via mosquitto_ctrl
 *      - Remote mode: run mosquitto_ctrl on the broker host via SSH
 *      - Local mode:  run mosquitto_ctrl locally
 *   2. Ensure plugin line exists in mosquitto.conf
 *   3. Return credentials (store in config.json via /she/config)
 *
 * Note: mosquitto_ctrl is part of the mosquitto package and must be installed
 * on the same host as the broker. It cannot be used to manage a remote broker,
 * which is why we invoke it via SSH in remote mode.
 *
 * Body: { adminUsername?, adminPassword?, configDir? }
 */
router.post('/wizard/bootstrap', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const crypto = require('crypto');
        const { execFile } = require('child_process');
        const { promisify } = require('util');
        const execFileAsync = promisify(execFile);

        const username = req.body.adminUsername || 'she-admin';
        const password = req.body.adminPassword || crypto.randomBytes(18).toString('base64url');
        const configDir = (req.body.configDir || bc.configDir || '/etc/mosquitto').replace(/\\/g, '/');
        const isRemote = !!(bc.ssh && bc.ssh.host);

        const dynSecPath = `${configDir}/dynamic-security.json`;
        const confFilePath = `${configDir}/mosquitto.conf`;

        _log?.debug(`broker: wizard bootstrap mode=${isRemote ? 'remote' : 'local'} configDir=${configDir} adminUser=${username}`);

        if (isRemote) {
            // mosquitto_ctrl must run on the broker host — invoke it via SSH.
            // Delete any existing file first: mosquitto_ctrl init refuses to overwrite
            // an existing file, which would leave the old credentials in place while
            // config.json now holds new ones, causing "not authorised" on reconnect.
            try {
                await sshDeploy.runCommand(bc.ssh, `sudo rm -f "${dynSecPath}"`);
                _log?.debug(`broker: removed existing ${dynSecPath} on remote (if any)`);
            } catch (e) {
                _log?.warn(`broker: could not remove existing ${dynSecPath} on remote: ${e.message}`);
            }
            const ctrlCmd = `mosquitto_ctrl dynsec init "${dynSecPath}" "${username}" "${password}"`;
            _log?.debug(`broker: SSH mosquitto_ctrl on ${bc.ssh.host}: mosquitto_ctrl dynsec init "${dynSecPath}" "${username}" ***`);
            try {
                const r = await sshDeploy.runCommand(bc.ssh, ctrlCmd);
                _log?.debug(`broker: mosquitto_ctrl ok stdout=${r.stdout} stderr=${r.stderr}`);
            } catch (err) {
                _log?.debug(`broker: mosquitto_ctrl SSH failed: ${err.message}`);
                return res.status(500).json({
                    error: `mosquitto_ctrl failed on remote host: ${err.message}. Ensure mosquitto is installed on the remote broker host.`,
                });
            }

            // Verify mosquitto_ctrl actually wrote the json and contains our admin user.
            // mosquitto_ctrl 2.0 silently exits 0 even when it cannot overwrite an existing
            // file (e.g. owned by root). Reading it back catches this class of silent failure.
            try {
                const jsonRaw = await sshDeploy.readRemoteFile(bc.ssh, dynSecPath);
                const dynSecJson = JSON.parse(jsonRaw);
                const clients = Array.isArray(dynSecJson.clients) ? dynSecJson.clients : [];
                if (!clients.some((c) => c.username === username)) {
                    _log?.warn(`broker: dynamic-security.json does not contain user "${username}" — mosquitto_ctrl may have silently skipped an existing file`);
                    return res.status(500).json({
                        error: `dynamic-security.json was not updated: user "${username}" not found. The file may be owned by root and not writable by the SSH user. Delete ${dynSecPath} on the broker host and run the wizard again, or use the Manual setup option.`,
                    });
                }
                _log?.debug(`broker: dynamic-security.json verified — user "${username}" present`);
            } catch (e) {
                _log?.warn(`broker: could not verify dynamic-security.json after init: ${e.message}`);
            }

            // Fix ownership and permissions: mosquitto_ctrl creates the file owned by the
            // SSH user (typically mode 600). Mosquitto runs as the 'mosquitto' system user
            // and must be able to read it. Chown to mosquitto:mosquitto and set 644.
            try {
                await sshDeploy.runCommand(bc.ssh, `sudo chown mosquitto:mosquitto "${dynSecPath}" && sudo chmod 644 "${dynSecPath}"`);
                _log?.debug(`broker: fixed ownership and permissions on remote ${dynSecPath}`);
            } catch (e) {
                _log?.warn(`broker: could not chown/chmod remote ${dynSecPath}: ${e.message} — mosquitto may fail with 'File is not readable'`);
            }

            // Discover the full path to the .so on the remote host.
            let soPath = 'mosquitto_dynamic_security.so'; // fallback: rely on LD_LIBRARY_PATH
            try {
                const found = await sshDeploy.runCommand(bc.ssh, "find /usr /lib -maxdepth 8 -name 'mosquitto_dynamic_security.so' 2>/dev/null | head -1");
                if (found.stdout) {
                    soPath = found.stdout;
                    _log?.debug(`broker: discovered .so on remote at ${soPath}`);
                }
            } catch (e) {
                _log?.debug(`broker: remote .so discovery failed (${e.message}), using bare filename`);
            }

            // Read the remote mosquitto.conf, parse, and add the plugin line if missing.
            let remoteConfRaw = '';
            try {
                _log?.debug(`broker: reading remote conf ${bc.ssh.host}:${confFilePath}`);
                remoteConfRaw = await sshDeploy.readRemoteFile(bc.ssh, confFilePath);
                _log?.debug(`broker: remote conf read ok (${remoteConfRaw.length} bytes)`);
            } catch (e) {
                _log?.debug(`broker: remote conf read failed (${e.message}), starting from empty config`);
            }
            const parsed = mosquittoConf.parseText(remoteConfRaw);
            if (!parsed.managed.plugin || !String(parsed.managed.plugin).includes('mosquitto_dynamic_security')) {
                parsed.managed.plugin = soPath;
                parsed.managed.plugin_opt_config_file = dynSecPath;
                const content = mosquittoConf.serialise(parsed);
                _log?.debug(`broker: uploading updated conf to ${bc.ssh.host}:${confFilePath}`);
                await sshDeploy.uploadContent(bc.ssh, content, confFilePath);
                _log?.debug('broker: conf upload ok');
            } else {
                _log?.debug('broker: plugin line already present in remote conf, skipping upload');
            }
        } else {
            // Local mode: run mosquitto_ctrl on this host.
            fs.mkdirSync(configDir, { recursive: true });
            // Delete any existing file first so mosquitto_ctrl always writes fresh credentials.
            try {
                fs.rmSync(dynSecPath, { force: true });
                _log?.debug(`broker: removed existing ${dynSecPath} on local host (if any)`);
            } catch (e) {
                _log?.warn(`broker: could not remove existing ${dynSecPath}: ${e.message}`);
            }
            _log?.debug(`broker: local mosquitto_ctrl dynsec init ${dynSecPath} ${username} ***`);
            try {
                const r = await execFileAsync('mosquitto_ctrl', ['dynsec', 'init', dynSecPath, username, password], { timeout: 10000 });
                _log?.debug(`broker: mosquitto_ctrl ok stdout=${r.stdout} stderr=${r.stderr}`);
            } catch (err) {
                _log?.debug(`broker: local mosquitto_ctrl failed: ${err.message}`);
                return res.status(500).json({
                    error: `mosquitto_ctrl failed: ${err.message}. Ensure mosquitto is installed on this host.`,
                });
            }

            // Verify mosquitto_ctrl actually wrote the json and contains our admin user.
            try {
                const jsonRaw = fs.readFileSync(dynSecPath, 'utf8');
                const dynSecJson = JSON.parse(jsonRaw);
                const clients = Array.isArray(dynSecJson.clients) ? dynSecJson.clients : [];
                if (!clients.some((c) => c.username === username)) {
                    _log?.warn(`broker: dynamic-security.json does not contain user "${username}" — mosquitto_ctrl may have silently skipped an existing file`);
                    return res.status(500).json({
                        error: `dynamic-security.json was not updated: user "${username}" not found. Delete ${dynSecPath} and run the wizard again.`,
                    });
                }
                _log?.debug(`broker: dynamic-security.json verified — user "${username}" present`);
            } catch (e) {
                _log?.warn(`broker: could not verify dynamic-security.json after init: ${e.message}`);
            }

            // Fix ownership and permissions: mosquitto_ctrl creates the file owned by the
            // current user. Mosquitto runs as the 'mosquitto' system user and needs read access.
            try {
                await execFileAsync('sudo', ['chown', 'mosquitto:mosquitto', dynSecPath], { timeout: 5000 });
                _log?.debug(`broker: fixed ownership on local ${dynSecPath}`);
            } catch (e) {
                _log?.warn(`broker: could not chown local ${dynSecPath}: ${e.message}`);
            }
            try {
                fs.chmodSync(dynSecPath, 0o644);
                _log?.debug(`broker: fixed permissions on local ${dynSecPath}`);
            } catch (e) {
                _log?.warn(`broker: could not chmod local ${dynSecPath}: ${e.message}`);
            }

            let soPath = 'mosquitto_dynamic_security.so'; // fallback: rely on LD_LIBRARY_PATH
            try {
                const r2 = await execFileAsync('find', ['/usr', '/lib', '-maxdepth', '8', '-name', 'mosquitto_dynamic_security.so'], { timeout: 8000 });
                const lines = r2.stdout.trim().split('\n').filter(Boolean);
                if (lines.length > 0) {
                    soPath = lines[0];
                    _log?.debug(`broker: discovered .so at ${soPath}`);
                }
            } catch (e) {
                _log?.debug(`broker: local .so discovery failed (${e.message}), using bare filename`);
            }

            // Ensure plugin line exists in local mosquitto.conf
            const parsed = mosquittoConf.parse(confFilePath);
            if (!parsed.managed.plugin || !String(parsed.managed.plugin).includes('mosquitto_dynamic_security')) {
                parsed.managed.plugin = soPath;
                parsed.managed.plugin_opt_config_file = dynSecPath;
                const content = mosquittoConf.serialise(parsed);
                _log?.debug(`broker: writing updated local conf to ${confFilePath}`);
                mosquittoConf.write(confFilePath, content);
                _log?.debug('broker: local conf write ok');
            } else {
                _log?.debug('broker: plugin line already present in local conf, skipping write');
            }
        }

        res.json({
            ok: true,
            adminUsername: username,
            adminPassword: password,
            dynSecPath,
            confFilePath,
            message: `Bootstrap complete. Save these credentials to config.json under broker.dynsec, then restart mosquitto (POST /she/broker/restart).`,
        });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * POST /she/broker/wizard/deactivate
 * Remove dynsec plugin lines from mosquitto.conf (remote or local),
 * stop the dynsec MQTT client immediately, and clear broker.dynsec credentials
 * from config.json so she does not try to reconnect on next restart.
 * Caller must still restart mosquitto to fully remove the plugin.
 */
router.post('/wizard/deactivate', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const fp = confPath(bc);
        if (bc.ssh && bc.ssh.host) {
            const raw = await sshDeploy.readRemoteFile(bc.ssh, fp);
            const parsed = mosquittoConf.parseText(raw);
            delete parsed.managed.plugin;
            delete parsed.managed.plugin_opt_config_file;
            // Also remove old key name in case conf was written by an earlier she version
            delete parsed.managed.plugin_opt_dynsec_config_file;
            const content = mosquittoConf.serialise(parsed);
            await sshDeploy.uploadContent(bc.ssh, content, fp);
        } else {
            const parsed = mosquittoConf.parse(fp);
            delete parsed.managed.plugin;
            delete parsed.managed.plugin_opt_config_file;
            // Also remove old key name in case conf was written by an earlier she version
            delete parsed.managed.plugin_opt_dynsec_config_file;
            const content = mosquittoConf.serialise(parsed);
            mosquittoConf.write(fp, content);
        }

        // Stop the dynsec client immediately — prevents log flooding from
        // repeated reconnect attempts against a broker that no longer has
        // the dynamic-security plugin loaded.
        dynsec.stop();

        // Clear broker.dynsec credentials from config.json so the dynsec
        // client is not re-initialised if she is restarted.
        const configPath = req.app.locals.configPath;
        if (configPath) {
            try {
                const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (cfg.broker && cfg.broker.dynsec) {
                    delete cfg.broker.dynsec;
                    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 4) + '\n', 'utf8');
                    _log?.info('broker: cleared broker.dynsec credentials from config.json');
                }
            } catch (e) {
                _log?.warn(`broker: failed to clear dynsec credentials from config.json: ${e.message}`);
            }
        }

        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * POST /she/broker/wizard/reinit
 * Re-initialise the dynsec MQTT client with the credentials that were just
 * saved to config.json by the wizard. Called immediately after saving
 * credentials so the daemon picks them up without requiring a full she restart.
 *
 * Uses the startup config (URL, TLS, etc.) merged with the fresh broker
 * section from config.json.
 */
router.post('/wizard/reinit', (req, res) => {
    try {
        const configPath = req.app.locals.configPath;
        if (!configPath) return res.status(500).json({ error: 'no configPath in app.locals' });
        const freshCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!freshCfg.broker?.dynsec?.adminUsername || !freshCfg.broker?.dynsec?.adminPassword) {
            return res.status(400).json({ error: 'broker.dynsec credentials not set in config.json' });
        }
        // Merge startup config (URL, TLS, etc.) with fresh broker section from config.json
        const reInitConfig = { ...sheConfig, broker: freshCfg.broker };
        dynsec.stop(); // clean up any existing client first
        dynsec.init(reInitConfig, _log);
        _log?.info('broker: dynsec client re-initialised with updated credentials');
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * GET /she/broker/wizard/diagnose
 * Reads dynamic-security.json (remote or local) and analyses whether the
 * admin user exists, has the admin role, and whether that role contains the
 * required publishClientSend ACL for $CONTROL/dynamic-security/#.
 * Returns a structured diagnostic report to help debug probe timeouts.
 */
router.get('/wizard/diagnose', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const adminUsername = bc.dynsec && bc.dynsec.adminUsername;
        const configDir = bc.configDir || '/etc/mosquitto';
        const dynSecPath = `${configDir}/dynamic-security.json`;

        let jsonRaw = null;
        let readError = null;

        if (bc.ssh && bc.ssh.host) {
            try {
                jsonRaw = await sshDeploy.readRemoteFile(bc.ssh, dynSecPath);
            } catch (e) {
                readError = `Cannot read ${dynSecPath} on ${bc.ssh.host}: ${e.message}`;
            }
        } else {
            try {
                jsonRaw = fs.readFileSync(dynSecPath, 'utf8');
            } catch (e) {
                readError = `Cannot read ${dynSecPath}: ${e.message}`;
            }
        }

        if (readError) {
            return res.json({ ok: false, error: readError, dynSecPath });
        }

        let dynSecJson;
        try {
            dynSecJson = JSON.parse(jsonRaw);
        } catch (e) {
            return res.json({ ok: false, error: `dynamic-security.json is not valid JSON: ${e.message}`, dynSecPath });
        }

        const clients = Array.isArray(dynSecJson.clients) ? dynSecJson.clients : [];
        const roles = Array.isArray(dynSecJson.roles) ? dynSecJson.roles : [];

        const adminClient = adminUsername ? clients.find((c) => c.username === adminUsername) : null;
        const adminClientExists = !!adminClient;
        const adminRoles = adminClient ? (adminClient.roles || []).map((r) => r.rolename || r) : [];
        const hasAdminRole = adminRoles.includes('admin');

        const adminRoleDef = roles.find((r) => r.rolename === 'admin');
        const adminRoleAcls = adminRoleDef ? adminRoleDef.acls || [] : [];
        const hasControlSendAcl = adminRoleAcls.some((a) => a.acltype === 'publishClientSend' && (a.topic || '').includes('$CONTROL/dynamic-security'));

        const issues = [];
        if (!adminUsername) issues.push('broker.dynsec.adminUsername not set in config.json');
        if (adminUsername && !adminClientExists)
            issues.push(
                `User "${adminUsername}" not found in dynamic-security.json — mosquitto_ctrl init may have silently failed (file exists and is not writable by the SSH user). Delete ${dynSecPath} on the broker and re-run the wizard.`,
            );
        if (adminClientExists && !hasAdminRole)
            issues.push(`User "${adminUsername}" exists but does not have the "admin" role — ACL for $CONTROL/dynamic-security/# may be missing.`);
        if (hasAdminRole && !hasControlSendAcl)
            issues.push(
                `The "admin" role exists but is missing a publishClientSend ACL for $CONTROL/dynamic-security/#. Re-run mosquitto_ctrl dynsec init to regenerate the file.`,
            );

        res.json({
            ok: issues.length === 0,
            dynSecPath,
            adminUsername,
            adminClientExists,
            adminRoles,
            hasAdminRole,
            hasControlSendAcl,
            clientCount: clients.length,
            roleCount: roles.length,
            issues,
        });
    } catch (err) {
        handleError(res, err);
    }
});
