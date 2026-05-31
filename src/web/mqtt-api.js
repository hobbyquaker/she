'use strict';

/**
 * MQTT state REST API — Express router mounted at /she/mqtt
 *
 * Routes:
 *   GET  /she/mqtt/state    → snapshot of all retained MQTT topic values
 *   POST /she/mqtt/publish  → publish a message to a topic
 *
 * Call init(store, getMqttClient) once after the state store is created.
 * The getMqttClient callback is a zero-arg function returning the live mqtt client
 * (or null when no broker is configured).
 *
 * State changes for mqtt:: keys are automatically broadcast to WebSocket clients
 * as { type: 'mqtt', topic, val, ts }.
 */

const express = require('express');
const { broadcast } = require('./log-ws');

const router = express.Router();

let _store = null;
let _getMqtt = () => null;

/**
 * Initialise the MQTT API with the state store and an MQTT client getter.
 * @param {import('../lib/state-store')} store
 * @param {() => import('mqtt').MqttClient | null} getMqttClient
 */
function init(store, getMqttClient) {
    _store = store;
    _getMqtt = getMqttClient;

    // Forward every mqtt:: state change to connected WebSocket clients
    store.on('change', (key, val, obj) => {
        if (!key.startsWith('mqtt::')) return;
        broadcast({ type: 'mqtt', topic: key.slice(6), val: obj.val, ts: obj.ts });
    });
}

// GET /she/mqtt/state — sorted snapshot of all retained MQTT topic values
router.get('/state', (req, res) => {
    if (!_store) return res.json([]);
    const result = [];
    for (const [topic, obj] of _store.mqttEntries()) {
        result.push({ topic, val: obj.val, ts: obj.ts });
    }
    result.sort((a, b) => a.topic.localeCompare(b.topic));
    res.json(result);
});

// POST /she/mqtt/publish — { topic, payload, retain?, qos? }
router.post('/publish', (req, res) => {
    const mqtt = _getMqtt();
    if (!mqtt) return res.status(503).json({ error: 'MQTT not connected' });
    const { topic, payload, retain = false, qos = 0 } = req.body || {};
    if (!topic) return res.status(400).json({ error: 'topic required' });
    mqtt.publish(topic, String(payload ?? ''), { retain, qos }, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true });
    });
});

module.exports = { router, init };
