'use strict';

/**
 * Unit tests for src/matter/device-health.js (roadmap M21): battery folding, last seen and the
 * offline history from the controller's events, the alerts (low battery, long offline), the
 * retained status and the file across a restart.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

describe('matter device health', () => {
    let dh;
    let dir;
    let controller;
    let published;
    const log = { warn: jest.fn(), info: jest.fn(), debug: jest.fn() };

    function makeController() {
        const events = new EventEmitter();
        return {
            events,
            listPaired: () => [
                { nodeId: '4', online: true, name: 'Bulb' },
                { nodeId: '7', online: false, name: 'Button' },
            ],
            getEndpoints: (id) =>
                id === '7'
                    ? [{ endpointId: 1, clusters: [{ name: 'powerSource', attrs: { batPercentRemaining: 180, batChargeLevel: 0 } }] }]
                    : [{ endpointId: 0, clusters: [{ name: 'threadNetworkDiagnostics', attrs: { routingRole: 5 } }] }],
        };
    }

    beforeEach(() => {
        jest.resetModules();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-dh-'));
        dh = require('../../src/matter/device-health');
        dh._reset();
        controller = makeController();
        published = [];
        dh.start({
            publish: (topic, payload, opts) => published.push({ topic, payload: JSON.parse(payload), retain: opts.retain }),
            name: 'she',
            log,
            broadcast: jest.fn(),
            controller,
            storageDir: dir,
        });
    });
    afterEach(() => {
        dh.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('applyBatteryAttr folds the Power Source attributes', () => {
        let b = dh.applyBatteryAttr(null, 'batPercentRemaining', 150);
        expect(b.percent).toBe(75);
        b = dh.applyBatteryAttr(b, 'batChargeLevel', 2);
        expect(b.level).toBe('critical');
        b = dh.applyBatteryAttr(b, 'batChargeState', 1);
        expect(b.state).toBe('charging');
        expect(dh.applyBatteryAttr(b, 'description', 'x')).toBe(b);
    });

    test('the initial scan reads battery and role; events keep last seen, battery, roles and the offline history', () => {
        const h7 = dh.nodeHealth('7');
        expect(h7.battery).toMatchObject({ percent: 90, level: 'ok' });
        expect(dh.nodeHealth('4').roles).toEqual([{ role: 5, ts: expect.any(Number) }]);
        controller.events.emit('attr', { nodeId: '7', endpointId: 1, clusterName: 'powerSource', attrName: 'batPercentRemaining', value: 30, ts: 1000 });
        controller.events.emit('attr', { nodeId: '4', endpointId: 0, clusterName: 'threadNetworkDiagnostics', attrName: 'routingRole', value: 3, ts: 2000 });
        controller.events.emit('event', { nodeId: '4', endpointId: 1, clusterName: 'switch', eventName: 'initialPress', value: {}, ts: 3000 });
        expect(dh.nodeHealth('7').battery.percent).toBe(15);
        expect(dh.nodeHealth('4').roles.map((r) => r.role)).toEqual([5, 3]);
        expect(dh.nodeHealth('4').lastSeen).toBe(3000);
        controller.events.emit('status', { nodeId: '4', online: false });
        expect(dh.nodeHealth('4').online).toBe(false);
        controller.events.emit('status', { nodeId: '4', online: true });
        const h4 = dh.nodeHealth('4');
        expect(h4.online).toBe(true);
        expect(h4.offlineCount7d).toBe(1);
        expect(h4.lastOffline).toMatchObject({ ms: expect.any(Number) });
    });

    test('alerts: a low battery and a long offline period raise, publish retained and clear again', () => {
        const now = Date.now();
        controller.events.emit('attr', { nodeId: '7', clusterName: 'powerSource', attrName: 'batPercentRemaining', value: 30, ts: now });
        let r = dh.check({ now });
        expect(r.raised).toEqual([expect.objectContaining({ kind: 'low_battery', nodeId: '7', message: 'Button: battery 15 %' })]);
        expect(log.warn).toHaveBeenCalledWith('matter health: Button: battery 15 %');
        expect(published[0]).toMatchObject({ topic: 'she/status/matter/health', retain: true, payload: { val: 'warning', alerts: [{ kind: 'low_battery', nodeId: '7' }] } });
        // node 7 is offline since start → offline alert once an hour has passed
        r = dh.check({ now: now + dh.OFFLINE_ALERT_MS + 1000 });
        expect(r.raised).toEqual([expect.objectContaining({ kind: 'offline', nodeId: '7' })]);
        expect(dh.listHealth().alerts.length).toBe(2);
        controller.events.emit('attr', { nodeId: '7', clusterName: 'powerSource', attrName: 'batPercentRemaining', value: 180, ts: now });
        controller.events.emit('status', { nodeId: '7', online: true });
        r = dh.check({ now: now + dh.OFFLINE_ALERT_MS + 2000 });
        expect(r.cleared.map((a) => a.kind).sort()).toEqual(['low_battery', 'offline']);
        expect(dh.listHealth().val).toBe('ok');
        expect(published[published.length - 1].payload.val).toBe('ok');
    });

    test('the record survives a restart', async () => {
        controller.events.emit('attr', { nodeId: '7', clusterName: 'powerSource', attrName: 'batPercentRemaining', value: 30, ts: 5 });
        await new Promise((r) => setTimeout(r, 2200)); // the debounced save
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'device-health.json'), 'utf8')).nodes['7'].battery.percent).toBe(15);
        jest.resetModules();
        const again = require('../../src/matter/device-health');
        again._reset();
        again.start({ log, controller: makeController(), storageDir: dir });
        expect(again.nodeHealth('7').battery.percent).toBe(15);
        again.stop();
    });
});
