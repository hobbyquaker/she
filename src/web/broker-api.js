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
const dynsec = require('../lib/dynsec');
const mosquittoConf = require('../lib/mosquitto-conf');
const ca = require('../lib/ca');
const sshDeploy = require('../lib/ssh-deploy');
const sheConfig = require('../config');

// Default SSH identity file respects the configured data directory
const DEFAULT_SSH_KEY = path.join(sheConfig['data-dir'], 'ssh', 'broker_id_ed25519');

const router = express.Router();

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
    const ds = dynsec.getStatus();
    const mqttState = req.app.locals.mqttState || {};

    const sysPrefixes = ['$SYS/broker/version', '$SYS/broker/clients/', '$SYS/broker/uptime'];
    const sys = {};
    for (const [topic, entry] of Object.entries(mqttState)) {
        if (sysPrefixes.some((p) => topic.startsWith(p))) {
            sys[topic] = entry;
        }
    }

    res.json({ dynsec: ds, sys, sshKeyDefault: DEFAULT_SSH_KEY });
});

// ── mosquitto.conf ─────────────────────────────────────────────────────────────

/**
 * GET /she/broker/config
 * Returns parsed config structure + raw text + checksum.
 */
router.get('/config', (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const fp = confPath(bc);
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
 */
router.put('/config', (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const fp = confPath(bc);
        const { listeners, managed, passthrough, checksum: clientChecksum } = req.body;
        const content = mosquittoConf.serialise({ listeners, managed, passthrough });
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
 */
router.put('/config/raw', (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const fp = confPath(bc);
        const { content, checksum: clientChecksum } = req.body;
        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'content must be a string' });
        }
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
        if (bc.mode === 'remote' && bc.ssh && bc.ssh.host) {
            const cmd = bc.reloadCmd || 'sudo systemctl reload mosquitto';
            const result = await sshDeploy.runCommand(bc.ssh, cmd);
            return res.json({ ok: true, ...result });
        }
        const result = await mosquittoConf.reload(bc);
        res.json({ ok: true, stdout: result.stdout, stderr: result.stderr });
    } catch (err) {
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
        if (bc.mode === 'remote' && bc.ssh && bc.ssh.host) {
            const cmd = bc.restartCmd || 'sudo systemctl restart mosquitto';
            const result = await sshDeploy.runCommand(bc.ssh, cmd);
            return res.json({ ok: true, ...result });
        }
        const result = await mosquittoConf.restart(bc);
        res.json({ ok: true, stdout: result.stdout, stderr: result.stderr });
    } catch (err) {
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

/** POST /she/broker/ca/server/generate — Generate server cert */
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

module.exports = { router };

// ── SSH routes ─────────────────────────────────────────────────────────────────
// Note: these routes are mounted on the same router but defined after module.exports
// because they add to `router` (which is already exported by reference).

/** POST /she/broker/ssh/keygen — Generate SSH keypair */
router.post('/ssh/keygen', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        const identityFile = (bc.ssh && bc.ssh.identityFile) || DEFAULT_SSH_KEY;
        const publicKey = await sshDeploy.generateKeypair(identityFile);
        res.json({ ok: true, publicKey });
    } catch (err) {
        handleError(res, err);
    }
});

/** POST /she/broker/ssh/test — Test SSH connection */
router.post('/ssh/test', async (req, res) => {
    try {
        const bc = getBrokerConfig(req);
        if (!bc.ssh || !bc.ssh.host) return res.status(400).json({ error: 'broker.ssh.host not configured' });
        await sshDeploy.testConnection(bc.ssh);
        res.json({ ok: true });
    } catch (err) {
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
        const isRemote = bc.mode === 'remote' && bc.ssh && bc.ssh.host;

        const dynSecPath = `${configDir}/dynamic-security.json`;
        const confFilePath = `${configDir}/mosquitto.conf`;

        if (isRemote) {
            // mosquitto_ctrl must run on the broker host — invoke it via SSH.
            try {
                await sshDeploy.runCommand(bc.ssh, `mosquitto_ctrl dynsec init "${dynSecPath}" "${username}" "${password}"`);
            } catch (err) {
                return res.status(500).json({
                    error: `mosquitto_ctrl failed on remote host: ${err.message}. Ensure mosquitto is installed on the remote broker host.`,
                });
            }

            // Read the remote mosquitto.conf, parse, and add the plugin line if missing.
            let remoteConfRaw = '';
            try {
                remoteConfRaw = await sshDeploy.readRemoteFile(bc.ssh, confFilePath);
            } catch {
                // File may not exist yet — start from an empty config
            }
            const parsed = mosquittoConf.parseText(remoteConfRaw);
            if (!parsed.managed.plugin || !String(parsed.managed.plugin).includes('mosquitto_dynamic_security')) {
                parsed.managed.plugin = 'mosquitto_dynamic_security.so';
                parsed.managed.plugin_opt_dynsec_config_file = dynSecPath;
                const content = mosquittoConf.serialise(parsed);
                await sshDeploy.uploadContent(bc.ssh, content, confFilePath);
            }
        } else {
            // Local mode: run mosquitto_ctrl on this host.
            fs.mkdirSync(configDir, { recursive: true });
            try {
                await execFileAsync('mosquitto_ctrl', ['dynsec', 'init', dynSecPath, username, password], { timeout: 10000 });
            } catch (err) {
                return res.status(500).json({
                    error: `mosquitto_ctrl failed: ${err.message}. Ensure mosquitto is installed on this host.`,
                });
            }

            // Ensure plugin line exists in local mosquitto.conf
            const parsed = mosquittoConf.parse(confFilePath);
            if (!parsed.managed.plugin || !String(parsed.managed.plugin).includes('mosquitto_dynamic_security')) {
                parsed.managed.plugin = 'mosquitto_dynamic_security.so';
                parsed.managed.plugin_opt_dynsec_config_file = dynSecPath;
                const content = mosquittoConf.serialise(parsed);
                mosquittoConf.write(confFilePath, content);
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
