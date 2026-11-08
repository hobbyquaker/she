'use strict';

const { EventEmitter } = require('events');
const { SecondaryBroker, parseBrokers, redactUrl, OFFLINE_QUEUE_MAX, OFFLINE_QUEUE_TTL_MS } = require('../../src/lib/secondary-broker');

/** a stand-in for mqtt.connect: an emitter that records publishes and subscriptions */
function fakeConnect() {
    const calls = { connect: [], published: [], subscribed: [], ended: 0 };
    const connect = (url, opts) => {
        const client = new EventEmitter();
        client.publish = (topic, payload, o) => calls.published.push([topic, payload, o]);
        client.subscribe = (f) => calls.subscribed.push(f);
        client.end = () => calls.ended++;
        calls.connect.push({ url, opts, client });
        return client;
    };
    return { connect, calls };
}
const log = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });

describe('parseBrokers — config.brokers', () => {
    it('reads the definitions in config order, with their mirror rules', () => {
        const { brokers, errors } = parseBrokers({
            shed: { url: 'mqtt://shed.local', username: 'u', password: 'p', mqttVersion: 5, mirror: [{ dir: 'in', from: '#', to: 'shed/#' }] },
            cloud: { url: 'mqtts://cloud.example:8883', ca: 'CA', cert: 'CERT', key: 'KEY' },
        });
        expect(errors).toEqual([]);
        expect(brokers.map((b) => b.name)).toEqual(['shed', 'cloud']);
        expect(brokers[0]).toMatchObject({ url: 'mqtt://shed.local', username: 'u', password: 'p', mqttVersion: '5', rules: [{ dir: 'in', from: '#', to: 'shed/#' }] });
        expect(brokers[1]).toMatchObject({ ca: 'CA', cert: 'CERT', key: 'KEY', mqttVersion: '', rules: [] });
        expect(brokers[1].username).toBeUndefined();
    });

    it('rejects bad names, non-objects and a missing url, and reports rule errors', () => {
        const { brokers, errors } = parseBrokers({
            'bad name': { url: 'mqtt://x' },
            'a:b': { url: 'mqtt://x' },
            'nourl': {},
            'str': 'mqtt://x',
            'ok': { url: 'mqtt://x', mirror: [{ dir: 'in', from: 'a/#/b' }] },
        });
        expect(brokers.map((b) => b.name)).toEqual(['ok']);
        expect(errors).toHaveLength(5);
        expect(errors[0]).toMatch(/"bad name" is not a valid broker name/);
        expect(errors[1]).toMatch(/"a:b" is not a valid broker name/);
        expect(errors[2]).toMatch(/brokers\.nourl: url missing/);
        expect(errors[3]).toMatch(/brokers\.str: not an object/);
        expect(errors[4]).toMatch(/brokers\.ok\.mirror\[0\]/);
    });

    it('nothing configured is nothing', () => {
        expect(parseBrokers(undefined)).toEqual({ brokers: [], errors: [] });
        expect(parseBrokers(null)).toEqual({ brokers: [], errors: [] });
        expect(parseBrokers([{ url: 'x' }]).errors[0]).toMatch(/must be an object/);
    });

    it('redactUrl strips credentials from a URL', () => {
        expect(redactUrl('mqtt://user:secret@host:1883')).toBe('mqtt://host:1883');
        expect(redactUrl('mqtts://host')).toBe('mqtts://host');
        expect(redactUrl('not a url with user:pw@x')).toBe('not a url with user:pw@x');
    });
});

describe('SecondaryBroker', () => {
    it('connects with the options of its definition and subscribes to # on connect', () => {
        const { connect, calls } = fakeConnect();
        const def = parseBrokers({ shed: { url: 'mqtt://u:p@shed:1883', username: 'u', password: 'p', mqttVersion: '5' } }).brokers[0];
        const b = new SecondaryBroker(def, { connect, log: log() }).start();
        expect(calls.connect[0].url).toBe('mqtt://u:p@shed:1883');
        expect(calls.connect[0].opts).toMatchObject({ username: 'u', password: 'p', protocolVersion: 5, resubscribe: false });
        expect(b.connected).toBe(false);
        const events = [];
        b.on('connect', (e) => events.push(['connect', e]));
        b.on('close', () => events.push(['close']));
        calls.connect[0].client.emit('connect');
        expect(b.connected).toBe(true);
        expect(b.everConnected).toBe(true);
        expect(calls.subscribed).toEqual(['#']);
        expect(events).toEqual([['connect', { first: true }]]);
        calls.connect[0].client.emit('close');
        expect(b.connected).toBe(false);
        expect(events).toHaveLength(2);
        calls.connect[0].client.emit('close'); // a second close while down is nothing new
        expect(events).toHaveLength(2);
        calls.connect[0].client.emit('connect');
        expect(events[2]).toEqual(['connect', { first: false }]);
        b.start(); // idempotent
        expect(calls.connect).toHaveLength(1);
        b.stop();
        expect(calls.ended).toBe(1);
        expect(b.connected).toBe(false);
    });

    it('publishes when connected, queues briefly while offline and flushes on connect', () => {
        const { connect, calls } = fakeConnect();
        let t = 0;
        const def = parseBrokers({ shed: { url: 'mqtt://shed' } }).brokers[0];
        const lg = log();
        const b = new SecondaryBroker(def, { connect, log: lg, now: () => t }).start();
        expect(b.publish('a', '1', { retain: false })).toBe('queued');
        t += OFFLINE_QUEUE_TTL_MS + 1; // the first one is too old by the time the broker comes
        expect(b.publish('b', '2', {})).toBe('queued');
        expect(b.status()).toMatchObject({ name: 'shed', connected: false, queued: 2, url: 'mqtt://shed' });
        calls.connect[0].client.emit('connect');
        expect(calls.published).toEqual([['b', '2', {}]]);
        expect(b.status().queued).toBe(0);
        expect(lg.info.mock.calls.some((c) => /sent 1 message\(s\) queued while offline \(1 dropped\)/.test(c[0]))).toBe(true);
        expect(b.publish('c', '3', { qos: 1 })).toBe('sent');
        expect(calls.published[1]).toEqual(['c', '3', { qos: 1 }]);
    });

    it('the offline queue is bounded: the oldest messages are dropped', () => {
        const { connect } = fakeConnect();
        const def = parseBrokers({ shed: { url: 'mqtt://shed' } }).brokers[0];
        const b = new SecondaryBroker(def, { connect, log: log() }).start();
        for (let i = 0; i <= OFFLINE_QUEUE_MAX; i++) b.publish('t', String(i), {});
        expect(b.queue).toHaveLength(OFFLINE_QUEUE_MAX);
        expect(b.queue[0].payload).toBe('1');
        expect(b.dropped).toBe(1);
    });

    it('logs connection errors once a minute per message and shows the last one in the status', () => {
        const { connect, calls } = fakeConnect();
        let t = 0;
        const lg = log();
        const def = parseBrokers({ shed: { url: 'mqtt://shed' } }).brokers[0];
        const b = new SecondaryBroker(def, { connect, log: lg, now: () => t }).start();
        b.on('error', () => {});
        const client = calls.connect[0].client;
        client.emit('error', new Error('connect ECONNREFUSED'));
        client.emit('error', new Error('connect ECONNREFUSED'));
        t += 30_000;
        client.emit('error', new Error('connect ECONNREFUSED'));
        expect(lg.warn).toHaveBeenCalledTimes(1);
        expect(lg.warn.mock.calls[0][0]).toMatch(/mqtt@shed not connected \(connect ECONNREFUSED\) — retrying in the background/);
        t += 31_000;
        client.emit('error', new Error('connect ECONNREFUSED'));
        expect(lg.warn).toHaveBeenCalledTimes(2);
        expect(b.status().error).toBe('connect ECONNREFUSED');
        client.emit('connect');
        expect(b.status().error).toBeNull();
    });

    it('forwards messages and counts them', () => {
        const { connect, calls } = fakeConnect();
        const def = parseBrokers({ shed: { url: 'mqtt://shed' } }).brokers[0];
        const b = new SecondaryBroker(def, { connect, log: log() }).start();
        const got = [];
        b.on('message', (topic, payload, packet) => got.push([topic, payload.toString(), packet.retain]));
        calls.connect[0].client.emit('message', 'a/b', Buffer.from('1'), { retain: true });
        expect(got).toEqual([['a/b', '1', true]]);
        expect(b.status().messages).toBe(1);
    });
});
