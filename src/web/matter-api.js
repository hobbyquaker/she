'use strict';

/**
 * Matter controller REST API — Express router mounted at /she/matter
 *
 * Routes:
 *   GET    /she/matter/devices                          → list paired nodes
 *   POST   /she/matter/commission                       → commission a device
 *   GET    /she/matter/devices/:nodeId                  → node detail (endpoints + clusters)
 *   GET    /she/matter/devices/:nodeId/dcl              → vendor and product details from the CSA ledger
 *   GET    /she/matter/thread/networks                  → Thread networks on the LAN with their border routers
 *   POST   /she/matter/thread/refresh                   → probe every border router's REST API again
 *   POST   /she/matter/thread/routers/:ext/probe        → probe one border router
 *   GET    /she/matter/health                           → every node's battery, last seen, offline history, alerts
 *   POST   /she/matter/health/check                     → evaluate the alerts now
 *   GET    /she/matter/devices/:nodeId/health           → one node
 *   GET    /she/matter/thread/datasets                  → the known Thread datasets, redacted
 *   POST   /she/matter/thread/datasets                  → import { tlv, source?, note? }
 *   PUT    /she/matter/thread/datasets/:ext             → { meshcop } MeshCoP diagnostics on/off
 *   DELETE /she/matter/thread/datasets/:ext             → forget a dataset
 *   POST   /she/matter/thread/datasets/:ext/reveal      → the full TLV (behind a confirmation in the UI)
 *   POST   /she/matter/thread/routers/:ext/import-dataset → read the active dataset from a border router's REST API
 *   GET    /she/matter/thread/health                    → Thread health alerts (active, history, MQTT topic)
 *   POST   /she/matter/thread/health/check              → evaluate now
 *   DELETE /she/matter/thread/health/history            → forget the history
 *   GET    /she/matter/thread/mesh                      → the Thread mesh graph (nodes, links, bindings)
 *   POST   /she/matter/thread/mesh/refresh[/:nodeId]    → re-read the neighbour and route tables
 *   GET    /she/matter/bridge                           → the MQTT bridge's settings, devices, status
 *   PUT    /she/matter/bridge                           → { enabled?, format?, templates? }
 *   PUT    /she/matter/bridge/devices/:nodeId           → { name?, publish? } (the MQTT name, on/off)
 *   GET    /she/matter/groups                           → she's groups, members, derived state, key sets
 *   POST   /she/matter/groups                           → create { name, keySet? }
 *   PATCH  /she/matter/groups/:id                       → rename
 *   DELETE /she/matter/groups/:id                       → delete (members deprovisioned)
 *   POST   /she/matter/groups/:id/members               → add { nodeId, endpointId, clusters? }
 *   DELETE /she/matter/groups/:id/members/:nodeId/:ep   → remove a member
 *   POST   /she/matter/groups/:id/command               → one multicast command { clusterName, command, args? }
 *   GET    /she/matter/updates                          → firmware state of every node, updates the ledger offers
 *   POST   /she/matter/updates/check                    → ask the ledger now (every online node)
 *   POST   /she/matter/devices/:nodeId/update/check     → ask the ledger for one node
 *   POST   /she/matter/devices/:nodeId/update           → start the update (the user's click)
 *   DELETE /she/matter/devices/:nodeId/update           → cancel it
 *   GET    /she/matter/devices/:nodeId/fabrics          → the device's fabrics and pairing-window state
 *   POST   /she/matter/devices/:nodeId/commissioning-window → open a pairing window (QR + manual code)
 *   DELETE /she/matter/devices/:nodeId/commissioning-window → close it
 *   DELETE /she/matter/devices/:nodeId/fabrics/:fabricIndex → remove another controller's fabric
 *   DELETE /she/matter/devices/:nodeId                  → unpair a device
 *   POST   /she/matter/devices/:nodeId/command          → invoke a cluster command
 *   GET    /she/matter/bindings                         → every binding (own fabric resolved, other fabrics read-only)
 *   GET    /she/matter/bindings/candidates              → sources, targets, endpoints that cannot bind
 *   POST   /she/matter/bindings                         → create { source, target, clusters } (ACL grant + binding)
 *   DELETE /she/matter/bindings                         → remove { source, target, clusters }
 *
 * All NodeIds are represented as decimal strings in JSON.
 */

const express = require('express');

const router = express.Router();

function getController() {
    return require('../matter/controller');
}

function notReady(res) {
    return res.status(503).json({ error: 'Matter controller not started (--matter-storage not set)' });
}

function isReady() {
    try {
        return getController().isStarted();
    } catch {
        return false;
    }
}

// GET /she/matter/devices — list paired nodes
router.get('/devices', (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(getController().listPaired());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /she/matter/commission — { passcode, discriminator? } or { pairingCode }
router.post('/commission', async (req, res) => {
    if (!isReady()) return notReady(res);
    const body = req.body;
    if (!body || (body.passcode === undefined && body.pairingCode === undefined)) {
        return res.status(400).json({ error: 'body must contain passcode or pairingCode' });
    }
    try {
        const nodeId = await getController().commission(body);
        res.status(201).json({ nodeId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /she/matter/devices/:nodeId/rename — { name } → writes basicInformation.nodeLabel
router.post('/devices/:nodeId/rename', async (req, res) => {
    if (!isReady()) return notReady(res);
    const name = req.body?.name;
    if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'body must contain a non-empty name' });
    }
    if (name.trim().length > 32) {
        return res.status(400).json({ error: 'name must be at most 32 characters (Matter nodeLabel limit)' });
    }
    try {
        await getController().rename(req.params.nodeId, name.trim());
        res.json({ ok: true });
    } catch (err) {
        if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// GET /she/matter/devices/:nodeId — node detail
router.get('/devices/:nodeId', (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        const ctrl = getController();
        const endpoints = ctrl.getEndpoints(req.params.nodeId);
        // Derive device-level name and subtitle from the root endpoint (0)
        const rootEp = endpoints.find((ep) => ep.endpointId === 0);
        const name = rootEp?.name ?? endpoints.find((ep) => ep.name)?.name ?? null;
        const subtitle = ctrl.getDeviceSubtitle(req.params.nodeId);
        res.json({ nodeId: req.params.nodeId, endpoints, name, subtitle });
    } catch (err) {
        if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// GET /she/matter/devices/:nodeId/dcl — vendor and product details from the CSA ledger (M25)
router.get('/devices/:nodeId/dcl', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(await getController().getDeviceInfo(req.params.nodeId));
    } catch (err) {
        if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ── Thread (M15) ──────────────────────────────────────────────────────────────

function getThread() {
    return require('../matter/thread');
}

// GET /she/matter/thread/networks — the Thread networks on the LAN with their border routers
router.get('/thread/networks', (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(getThread().listNetworks());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /she/matter/thread/refresh — probe every border router's REST API again
router.post('/thread/refresh', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(await getThread().refresh());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /she/matter/thread/routers/:ext/probe — probe one border router
router.post('/thread/routers/:ext/probe', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(await getThread().probeRouter(req.params.ext, { force: true }));
    } catch (err) {
        if (/not found/.test(err.message)) return res.status(404).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ── Device health (M21) ───────────────────────────────────────────────────────

// GET /she/matter/health — every node: battery, last seen, offline history, alerts
router.get('/health', (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(require('../matter/device-health').listHealth());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /she/matter/health/check — evaluate the alerts now
router.post('/health/check', (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        const dh = require('../matter/device-health');
        dh.check();
        res.json(dh.listHealth());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /she/matter/devices/:nodeId/health
router.get('/devices/:nodeId/health', (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        const h = require('../matter/device-health').nodeHealth(req.params.nodeId);
        if (!h) return res.status(404).json({ error: `no health record for node ${req.params.nodeId}` });
        res.json(h);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Thread datasets (M17) ─────────────────────────────────────────────────────

function getDatasets() {
    return require('../matter/thread-datasets');
}

// GET /she/matter/thread/datasets — the known datasets, redacted (never the network key or PSKc)
router.get('/thread/datasets', (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(getDatasets().list());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /she/matter/thread/datasets — { tlv, source?, note? } import a dataset from its TLV hex
router.post('/thread/datasets', (req, res) => {
    if (!isReady()) return notReady(res);
    const { tlv, source, note } = req.body || {};
    if (typeof tlv !== 'string' || !tlv.trim()) return res.status(400).json({ error: 'body must contain the dataset TLV as hex' });
    try {
        res.status(201).json(getDatasets().add({ tlv, source, note }));
    } catch (err) {
        if (/not available/.test(err.message)) return res.status(503).json({ error: err.message });
        res.status(400).json({ error: err.message });
    }
});

// PUT /she/matter/thread/datasets/:ext — { meshcop } switch the MeshCoP diagnostics for the network
router.put('/thread/datasets/:ext', (req, res) => {
    if (!isReady()) return notReady(res);
    const { meshcop } = req.body || {};
    if (typeof meshcop !== 'boolean') return res.status(400).json({ error: 'body must contain meshcop (boolean)' });
    try {
        res.json(getDatasets().setMeshcop(req.params.ext, meshcop));
    } catch (err) {
        if (/no dataset/.test(err.message)) return res.status(404).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// DELETE /she/matter/thread/datasets/:ext
router.delete('/thread/datasets/:ext', (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(getDatasets().remove(req.params.ext));
    } catch (err) {
        if (/no dataset/.test(err.message)) return res.status(404).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// POST /she/matter/thread/datasets/:ext/reveal — the full TLV (the UI asks for a confirmation first)
router.post('/thread/datasets/:ext/reveal', (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(getDatasets().reveal(req.params.ext));
    } catch (err) {
        if (/no dataset/.test(err.message)) return res.status(404).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// POST /she/matter/thread/routers/:ext/import-dataset — read the active dataset from a border router's REST API
router.post('/thread/routers/:ext/import-dataset', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.status(201).json(await getThread().importDataset(req.params.ext));
    } catch (err) {
        if (/not found/.test(err.message)) return res.status(404).json({ error: err.message });
        if (/no REST API|no active dataset/.test(err.message)) return res.status(409).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// GET /she/matter/thread/health — the Thread health alerts (M26): active ones, the history, the MQTT topic
router.get('/thread/health', (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(require('../matter/thread-health').status());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /she/matter/thread/health/check — evaluate now
router.post('/thread/health/check', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(await require('../matter/thread-health').check());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /she/matter/thread/health/history
router.delete('/thread/health/history', (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(require('../matter/thread-health').clearHistory());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /she/matter/thread/mesh — the mesh graph (M16): Thread nodes, border routers, neighbour links, bindings
router.get('/thread/mesh', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(await require('../matter/thread-mesh').getMesh());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /she/matter/thread/mesh/refresh[/:nodeId] — re-read the neighbour and route tables
router.post(['/thread/mesh/refresh', '/thread/mesh/refresh/:nodeId'], async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(await require('../matter/thread-mesh').refresh(req.params.nodeId));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── The MQTT bridge (M19) ─────────────────────────────────────────────────────

function getBridge() {
    return require('../matter/mqtt-bridge');
}

// GET /she/matter/bridge — settings, defaults, the devices with their MQTT names, status
router.get('/bridge', (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(getBridge().getSettings());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /she/matter/bridge — { enabled?, format?, templates? }
router.put('/bridge', (req, res) => {
    if (!isReady()) return notReady(res);
    const { enabled, format, templates } = req.body || {};
    if (enabled !== undefined && typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    try {
        res.json(getBridge().updateSettings({ enabled, format, templates }));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// PUT /she/matter/bridge/devices/:nodeId — { name?, publish? }
router.put('/bridge/devices/:nodeId', (req, res) => {
    if (!isReady()) return notReady(res);
    const { name, publish } = req.body || {};
    if (name !== undefined && typeof name !== 'string') return res.status(400).json({ error: 'name must be a string' });
    if (publish !== undefined && typeof publish !== 'boolean') return res.status(400).json({ error: 'publish must be a boolean' });
    try {
        res.json(getBridge().setDevice(req.params.nodeId, { name, publish }));
    } catch (err) {
        if (/not found/.test(err.message)) return res.status(404).json({ error: err.message });
        res.status(400).json({ error: err.message });
    }
});

// ── Groups (M23) ──────────────────────────────────────────────────────────────

function groupError(res, err) {
    const msg = err.message || String(err);
    if (/not found/.test(msg)) return res.status(404).json({ error: msg });
    if (/not available|offline|exists|must be|holds at most|no cluster|not a member|missing from the store|refused/.test(msg)) return res.status(409).json({ error: msg });
    return res.status(500).json({ error: msg });
}

// GET /she/matter/groups — she's groups, members, derived state, key sets (never the keys)
router.get('/groups', (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(getController().listGroups());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /she/matter/groups — { name, keySet?: 'shared' | 'own' }
router.post('/groups', async (req, res) => {
    if (!isReady()) return notReady(res);
    const { name, keySet } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'body must contain a name' });
    if (keySet !== undefined && keySet !== 'shared' && keySet !== 'own') return res.status(400).json({ error: "keySet must be 'shared' or 'own'" });
    try {
        res.status(201).json(await getController().createGroup({ name, keySet }));
    } catch (err) {
        groupError(res, err);
    }
});

// PATCH /she/matter/groups/:id — { name }
router.patch('/groups/:id', (req, res) => {
    if (!isReady()) return notReady(res);
    const name = req.body?.name;
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'body must contain a name' });
    try {
        res.json(getController().renameGroup(req.params.id, name));
    } catch (err) {
        groupError(res, err);
    }
});

// DELETE /she/matter/groups/:id
router.delete('/groups/:id', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(await getController().deleteGroup(req.params.id));
    } catch (err) {
        groupError(res, err);
    }
});

// POST /she/matter/groups/:id/members — { nodeId, endpointId, clusters? }
router.post('/groups/:id/members', async (req, res) => {
    if (!isReady()) return notReady(res);
    const { nodeId, endpointId, clusters } = req.body || {};
    if (nodeId === undefined || endpointId === undefined) return res.status(400).json({ error: 'body must contain nodeId and endpointId' });
    try {
        res.status(201).json(await getController().addGroupMember(req.params.id, { nodeId: String(nodeId), endpointId: Number(endpointId), clusters }));
    } catch (err) {
        groupError(res, err);
    }
});

// DELETE /she/matter/groups/:id/members/:nodeId/:endpointId
router.delete('/groups/:id/members/:nodeId/:endpointId', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(await getController().removeGroupMember(req.params.id, req.params.nodeId, Number(req.params.endpointId)));
    } catch (err) {
        groupError(res, err);
    }
});

// POST /she/matter/groups/:id/command — { clusterName, command, args? }
router.post('/groups/:id/command', async (req, res) => {
    if (!isReady()) return notReady(res);
    const { clusterName, command, args } = req.body || {};
    if (!clusterName || !command) return res.status(400).json({ error: 'body must contain clusterName and command' });
    try {
        await getController().sendGroupCommand(req.params.id, clusterName, command, args ?? {});
        res.json({ ok: true });
    } catch (err) {
        groupError(res, err);
    }
});

// ── Firmware updates (M22) ────────────────────────────────────────────────────

function updateError(res, err) {
    const msg = err.message || String(err);
    if (/not found/.test(msg)) return res.status(404).json({ error: msg });
    if (/offline|not available|no update is known|not newer|is busy|already|no OTA requestor|no vendor/.test(msg)) return res.status(409).json({ error: msg });
    return res.status(500).json({ error: msg });
}

// GET /she/matter/updates — every node's firmware state and what the ledger offers
router.get('/updates', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(await getController().listUpdates());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /she/matter/updates/check — ask the ledger for every online node
router.post('/updates/check', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(await getController().checkUpdates());
    } catch (err) {
        updateError(res, err);
    }
});

// POST /she/matter/devices/:nodeId/update/check — ask the ledger for one node
router.post('/devices/:nodeId/update/check', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(await getController().checkUpdates(req.params.nodeId));
    } catch (err) {
        updateError(res, err);
    }
});

// POST /she/matter/devices/:nodeId/update — { softwareVersion? } start the update
router.post('/devices/:nodeId/update', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.status(202).json(await getController().startUpdate(req.params.nodeId, { softwareVersion: req.body?.softwareVersion }));
    } catch (err) {
        updateError(res, err);
    }
});

// DELETE /she/matter/devices/:nodeId/update — cancel
router.delete('/devices/:nodeId/update', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(await getController().cancelUpdate(req.params.nodeId));
    } catch (err) {
        updateError(res, err);
    }
});

// ── Multi-admin (M20) ─────────────────────────────────────────────────────────

function fabricError(res, err) {
    const msg = err.message || String(err);
    if (/not found/.test(msg)) return res.status(404).json({ error: msg });
    if (/offline|own fabric|positive integer/.test(msg)) return res.status(409).json({ error: msg });
    return res.status(500).json({ error: msg });
}

// GET /she/matter/devices/:nodeId/fabrics — the fabrics the device belongs to, and its pairing-window state
router.get('/devices/:nodeId/fabrics', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(await getController().listFabrics(req.params.nodeId));
    } catch (err) {
        fabricError(res, err);
    }
});

// POST /she/matter/devices/:nodeId/commissioning-window — { timeoutSeconds? } → the codes to show
router.post('/devices/:nodeId/commissioning-window', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.status(201).json(await getController().openCommissioningWindow(req.params.nodeId, { timeoutSeconds: req.body?.timeoutSeconds }));
    } catch (err) {
        fabricError(res, err);
    }
});

// DELETE /she/matter/devices/:nodeId/commissioning-window — close it early
router.delete('/devices/:nodeId/commissioning-window', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        await getController().closeCommissioningWindow(req.params.nodeId);
        res.json({ ok: true });
    } catch (err) {
        fabricError(res, err);
    }
});

// DELETE /she/matter/devices/:nodeId/fabrics/:fabricIndex — remove another controller's fabric
router.delete('/devices/:nodeId/fabrics/:fabricIndex', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(await getController().removeFabric(req.params.nodeId, Number(req.params.fabricIndex)));
    } catch (err) {
        fabricError(res, err);
    }
});

// DELETE /she/matter/devices/:nodeId — unpair
router.delete('/devices/:nodeId', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        await getController().unpair(req.params.nodeId);
        res.json({ ok: true });
    } catch (err) {
        if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// POST /she/matter/devices/:nodeId/command — { endpointId, clusterName, command, args? }
router.post('/devices/:nodeId/command', async (req, res) => {
    if (!isReady()) return notReady(res);
    const { endpointId, clusterName, command, args } = req.body || {};
    if (endpointId === undefined || !clusterName || !command) {
        return res.status(400).json({ error: 'body must contain endpointId, clusterName, command' });
    }
    try {
        const result = await getController().sendCommand(req.params.nodeId, Number(endpointId), clusterName, command, args ?? {});
        res.json({ ok: true, result: result ?? null });
    } catch (err) {
        if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ── Bindings (M13) ────────────────────────────────────────────────────────────

function bindingBody(body) {
    const { source, target, clusters } = body || {};
    const ok = (x) => x && typeof x === 'object' && x.nodeId !== undefined && x.endpointId !== undefined;
    const isGroup = target && typeof target === 'object' && target.group !== undefined && target.group !== null;
    if (!ok(source) || !(ok(target) || isGroup) || !Array.isArray(clusters) || clusters.length === 0) {
        return { error: 'body must contain source {nodeId, endpointId}, target {nodeId, endpointId} or {group}, and a non-empty clusters list' };
    }
    return {
        value: {
            source: { nodeId: String(source.nodeId), endpointId: Number(source.endpointId) },
            target: isGroup ? { group: Number(target.group) } : { nodeId: String(target.nodeId), endpointId: Number(target.endpointId) },
            clusters,
        },
    };
}

function bindingError(res, err) {
    const msg = err.message || String(err);
    if (/not found/.test(msg)) return res.status(404).json({ error: msg });
    if (/offline|same fabric|same endpoint|at least one cluster|Unknown cluster|allows only/.test(msg)) return res.status(409).json({ error: msg });
    return res.status(500).json({ error: msg });
}

// GET /she/matter/bindings
router.get('/bindings', async (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(await getController().listBindings());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /she/matter/bindings/candidates
router.get('/bindings/candidates', (req, res) => {
    if (!isReady()) return notReady(res);
    try {
        res.json(getController().bindingCandidates());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /she/matter/bindings — { source, target, clusters }
router.post('/bindings', async (req, res) => {
    if (!isReady()) return notReady(res);
    const parsed = bindingBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    try {
        res.status(201).json(await getController().addBinding(parsed.value));
    } catch (err) {
        bindingError(res, err);
    }
});

// DELETE /she/matter/bindings — { source, target, clusters }
router.delete('/bindings', async (req, res) => {
    if (!isReady()) return notReady(res);
    const parsed = bindingBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    try {
        res.json(await getController().removeBinding(parsed.value));
    } catch (err) {
        bindingError(res, err);
    }
});

module.exports = { router };
