'use strict';

/**
 * Matter controller REST API — Express router mounted at /she/matter
 *
 * Routes:
 *   GET    /she/matter/devices                          → list paired nodes
 *   POST   /she/matter/commission                       → commission a device
 *   GET    /she/matter/devices/:nodeId                  → node detail (endpoints + clusters)
 *   DELETE /she/matter/devices/:nodeId                  → unpair a device
 *   POST   /she/matter/devices/:nodeId/command          → invoke a cluster command
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

module.exports = { router };
