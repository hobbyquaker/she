'use strict';

/**
 * mosquitto-probe — one MQTT connection to see whether a broker answers.
 *
 * Used twice by the Bridges page: "Test connection" against the remote broker a bridge
 * is meant for (with the bridge's address, TLS files and credentials), and the liveness
 * probe of the managed broker after a config reload (with she's own connection settings),
 * which decides whether the previous mosquitto.conf has to be restored.
 */

const mqtt = require('mqtt');
const net = require('net');

/**
 * Open a TCP connection and close it again — mqtt.js reports a refused or unreachable port only
 * as "connack timeout" after the full connect timeout, so this runs first and names the reason.
 * Resolves with null on success, with the error text otherwise.
 */
function tcpCheck(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const sock = net.connect({ host, port });
        const timer = setTimeout(() => {
            sock.destroy();
            resolve(`no TCP connection to ${host}:${port} within ${timeoutMs} ms`);
        }, timeoutMs);
        sock.once('connect', () => {
            clearTimeout(timer);
            sock.destroy();
            resolve(null);
        });
        sock.once('error', (err) => {
            clearTimeout(timer);
            sock.destroy();
            resolve(describeError(err));
        });
    });
}

/**
 * Connect once and disconnect. Resolves with { ok: true, durationMs } or
 * { ok: false, error, durationMs } — never rejects.
 *
 * @param {string} url            mqtt://host:port or mqtts://host:port
 * @param {object} [opts]         mqtt.js connect options (username, password, ca, cert, key, …)
 * @param {number} [timeoutMs]    overall timeout for TCP + TLS + CONNACK
 */
async function connectOnce(url, opts = {}, timeoutMs = 5000) {
    const started = Date.now();
    let target = null;
    try {
        target = new URL(url);
    } catch {
        return { ok: false, error: `not a broker URL: ${url}`, durationMs: 0 };
    }
    const port = Number(target.port) || (target.protocol.startsWith('mqtts') || target.protocol.startsWith('ssl') || target.protocol.startsWith('tls') ? 8883 : 1883);
    const tcpError = await tcpCheck(target.hostname.replace(/^\[|\]$/g, ''), port, Math.min(timeoutMs, 3000));
    if (tcpError) return { ok: false, error: tcpError, durationMs: Date.now() - started };
    return mqttOnce(url, opts, timeoutMs, started);
}

function mqttOnce(url, opts, timeoutMs, started) {
    return new Promise((resolve) => {
        let done = false;
        let client;
        const finish = (result) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try {
                client?.end(true);
            } catch {
                /* ignore */
            }
            resolve({ ...result, durationMs: Date.now() - started });
        };
        const timer = setTimeout(() => finish({ ok: false, error: `no answer within ${timeoutMs} ms` }), timeoutMs);
        try {
            client = mqtt.connect(url, {
                connectTimeout: timeoutMs,
                reconnectPeriod: 0,
                clean: true,
                ...opts,
            });
        } catch (err) {
            return finish({ ok: false, error: err.message });
        }
        client.on('connect', () => finish({ ok: true }));
        client.on('error', (err) => finish({ ok: false, error: describeError(err) }));
        client.on('close', () => {
            if (!done) finish({ ok: false, error: 'connection closed before CONNACK' });
        });
    });
}

/** A readable one-liner for mqtt.js / net / tls errors. */
function describeError(err) {
    if (!err) return 'unknown error';
    if (err.code === 'ECONNREFUSED') return `connection refused (${err.address || ''}:${err.port || ''})`.replace(' (:)', '');
    if (err.code === 'ENOTFOUND') return `host not found: ${err.hostname || ''}`;
    if (err.code === 'ETIMEDOUT') return 'connection timed out';
    if (err.code === 'ECONNRESET') return 'connection reset by the broker';
    if (typeof err.code === 'number') return `broker refused: ${err.message}`; // CONNACK return codes
    return err.message || String(err);
}

/**
 * Probe a broker repeatedly until it answers or the time is up.
 *
 * @param {string} url
 * @param {object} opts         mqtt.js connect options
 * @param {{ totalMs?: number, intervalMs?: number, attemptMs?: number }} [timing]
 * @returns {Promise<{ ok: boolean, attempts: number, durationMs: number, error?: string }>}
 */
async function waitForBroker(url, opts = {}, { totalMs = 8000, intervalMs = 1000, attemptMs = 3000 } = {}) {
    const started = Date.now();
    let attempts = 0;
    let lastError = null;
    while (Date.now() - started < totalMs) {
        attempts++;
        const r = await connectOnce(url, opts, Math.min(attemptMs, Math.max(500, totalMs - (Date.now() - started))));
        if (r.ok) return { ok: true, attempts, durationMs: Date.now() - started };
        lastError = r.error;
        const left = totalMs - (Date.now() - started);
        if (left <= 0) break;
        await new Promise((res) => setTimeout(res, Math.min(intervalMs, left)));
    }
    return { ok: false, attempts, durationMs: Date.now() - started, error: lastError || 'no answer' };
}

/**
 * she's own connection options for the managed broker (mirrors index.js), for the liveness probe.
 * @param {object} config  she config
 */
function sheConnectOptions(config) {
    const o = {};
    if (config.mqttUsername) o.username = config.mqttUsername;
    if (config.mqttPassword) o.password = config.mqttPassword;
    if (config.mqttCa) o.ca = config.mqttCa;
    if (config.mqttCert) o.cert = config.mqttCert;
    if (config.mqttKey) o.key = config.mqttKey;
    if (config.mqttVersion === '5') o.protocolVersion = 5;
    return o;
}

module.exports = { connectOnce, tcpCheck, waitForBroker, describeError, sheConnectOptions };
