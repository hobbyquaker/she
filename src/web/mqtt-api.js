'use strict';

/**
 * MQTT state REST API — Express router mounted at /she/mqtt
 *
 * Routes:
 *   GET  /she/mqtt/state    → snapshot of all retained MQTT topic values
 *   POST /she/mqtt/publish  → publish a message to a topic
 *   GET  /she/mqtt/ha-discovery?prefix= → Home Assistant discovery devices (grouped announcements)
 *   DELETE /she/mqtt/ha-discovery { topics } → clear retained messages on the given topics
 *
 * Call init(store, getMqttClient) once after the state store is created.
 * The getMqttClient callback is a zero-arg function returning the live mqtt client
 * (or null when no broker is configured).
 *
 * State changes for mqtt:: keys are automatically broadcast to WebSocket clients
 * as { type: 'mqtt', topic, val, ts }; deletions (retained message cleared via
 * an empty retained publish) as { type: 'mqtt', topic, deleted: true, ts }.
 */

const express = require('express');
const { broadcast, broadcastBrokerLog } = require('./log-ws');
const { analyzeDiscovery, DEFAULT_PREFIX } = require('../lib/ha-discovery');
const StateStore = require('../lib/state-store');

const BROKER_LOG_TOPICS = new Set(['D', 'I', 'N', 'W', 'E'].map((l) => `$SYS/broker/log/${l}`));

const router = express.Router();

let _store = null;
let _getMqtt = () => null;
let _getBroker = () => null;

/**
 * Initialise the MQTT API with the state store and an MQTT client getter.
 * @param {import('../lib/state-store')} store
 * @param {() => import('mqtt').MqttClient | null} getMqttClient
 * @param {(name: string) => import('../lib/secondary-broker').SecondaryBroker | null} [getBroker] an
 *   additional broker by name (roadmap M2); its topics are served with `?broker=<name>` and arrive on
 *   the WebSocket with a `broker` field — messages of the primary carry none, as before
 */
function init(store, getMqttClient, getBroker) {
    _store = store;
    _getMqtt = getMqttClient;
    if (typeof getBroker === 'function') _getBroker = getBroker;

    // Forward every mqtt:: (and mqtt@<broker>::) state change to connected WebSocket clients
    store.on('change', (key, val, obj) => {
        const parsed = StateStore.parseMqttKey(key);
        if (!parsed) return;
        const { broker, topic } = parsed;
        if (broker) {
            broadcast({ type: 'mqtt', broker, topic, val: obj.val, ts: obj.ts });
            return;
        }
        broadcast({ type: 'mqtt', topic, val: obj.val, ts: obj.ts });
        if (BROKER_LOG_TOPICS.has(topic)) {
            broadcastBrokerLog(topic.slice('$SYS/broker/log/'.length), String(obj.val), obj.ts);
        }
    });

    // Forward deletions (retained message cleared) so clients drop the topic
    store.on('delete', (key) => {
        const parsed = StateStore.parseMqttKey(key);
        if (!parsed) return;
        if (parsed.broker) broadcast({ type: 'mqtt', broker: parsed.broker, topic: parsed.topic, deleted: true, ts: Date.now() });
        else broadcast({ type: 'mqtt', topic: parsed.topic, deleted: true, ts: Date.now() });
    });
}

/** the `broker` query or body parameter: null for the primary, a SecondaryBroker, or an error response */
function brokerParam(req, res, value) {
    if (value === undefined || value === null || value === '') return null;
    const b = _getBroker(String(value));
    if (!b) {
        res.status(404).json({ error: `no additional broker "${value}" is configured` });
        return undefined;
    }
    return b;
}

// GET /she/mqtt/state[?broker=<name>] — sorted snapshot of all retained MQTT topic values
router.get('/state', (req, res) => {
    if (!_store) return res.json([]);
    const b = brokerParam(req, res, req.query.broker);
    if (b === undefined) return;
    const result = [];
    for (const [topic, obj] of _store.mqttEntries(b ? b.name : null)) {
        result.push({ topic, val: obj.val, ts: obj.ts });
    }
    result.sort((a, b) => a.topic.localeCompare(b.topic));
    res.json(result);
});

// POST /she/mqtt/publish — { topic, payload, retain?, qos?, broker? }
router.post('/publish', (req, res) => {
    const { topic, payload, retain = false, qos = 0, broker } = req.body || {};
    const b = brokerParam(req, res, broker);
    if (b === undefined) return;
    if (!topic) return res.status(400).json({ error: 'topic required' });
    if (b) {
        if (!b.connected) return res.status(503).json({ error: `broker "${b.name}" not connected` });
        b.client.publish(topic, String(payload ?? ''), { retain, qos }, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
        return;
    }
    const mqtt = _getMqtt();
    if (!mqtt) return res.status(503).json({ error: 'MQTT not connected' });
    mqtt.publish(topic, String(payload ?? ''), { retain, qos }, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true });
    });
});

// GET /she/mqtt/ha-discovery?prefix=homeassistant — devices announced via HA MQTT discovery
router.get('/ha-discovery', (req, res) => {
    if (!_store) return res.json({ prefix: DEFAULT_PREFIX, devices: [], entityCount: 0 });
    const prefix = typeof req.query.prefix === 'string' && req.query.prefix.trim() ? req.query.prefix.trim() : DEFAULT_PREFIX;
    if (/[+#]/.test(prefix)) return res.status(400).json({ error: 'prefix must not contain wildcards' });
    res.json(analyzeDiscovery(_store.mqttEntries(), { prefix }));
});

// DELETE /she/mqtt/ha-discovery — { topics: string[] } → clear the retained message on each topic
router.delete('/ha-discovery', async (req, res) => {
    const mqtt = _getMqtt();
    if (!mqtt) return res.status(503).json({ error: 'MQTT not connected' });
    const topics = req.body && req.body.topics;
    if (!Array.isArray(topics) || topics.length === 0) return res.status(400).json({ error: 'topics[] required' });
    const bad = topics.find((t) => typeof t !== 'string' || !t || /[+#]/.test(t));
    if (bad !== undefined) return res.status(400).json({ error: 'invalid topic: ' + String(bad) });

    const unique = [...new Set(topics)];
    const errors = [];
    for (const t of unique) {
        await new Promise((resolve) => {
            mqtt.publish(t, '', { retain: true, qos: 0 }, (err) => {
                if (err) errors.push({ topic: t, error: err.message });
                resolve();
            });
        });
    }
    res.json({ ok: errors.length === 0, cleared: unique.length - errors.length, errors });
});

module.exports = { router, init };
