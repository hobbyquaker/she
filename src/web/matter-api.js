'use strict';

/**
 * Matter controller REST API — Express router mounted at /she/matter
 *
 * Routes:
 *   GET    /she/matter/devices                          → list paired nodes
 *   POST   /she/matter/commission                       → commission a device
 *   GET    /she/matter/devices/:nodeId                  → node detail (endpoints + clusters)
 *   GET    /she/matter/devices/:nodeId/dcl              → vendor and product details from the CSA ledger
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
    if (!ok(source) || !ok(target) || !Array.isArray(clusters) || clusters.length === 0) {
        return { error: 'body must contain source {nodeId, endpointId}, target {nodeId, endpointId} and a non-empty clusters list' };
    }
    return {
        value: {
            source: { nodeId: String(source.nodeId), endpointId: Number(source.endpointId) },
            target: { nodeId: String(target.nodeId), endpointId: Number(target.endpointId) },
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
