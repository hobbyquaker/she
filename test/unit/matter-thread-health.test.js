'use strict';

/**
 * Unit tests for src/matter/thread-health.js (roadmap M26): the evaluator against snapshots —
 * leader change, partitions, a border router gone stale or vanished and back, a router that
 * dropped, a degraded link and its recovery; and check() publishing the retained status.
 */

const h = require('../../src/matter/thread-health');

const T0 = 1_000_000_000_000;
const tv = (over = {}) => ({ extAddress: 'AAAA', vendorName: 'Apple', modelName: 'TV', state: { role: 'leader' }, lastSeen: T0, ...over });
const esp = (over = {}) => ({ extAddress: 'BBBB', vendorName: 'Espressif', modelName: 'esp-br', state: { role: 'router' }, lastSeen: T0, ...over });
const net = (routers, over = {}) => ({ extPanId: 'PAN1', networkName: 'Home', partitions: ['1'], borderRouters: routers, ...over });

describe('thread health: evaluate', () => {
    test('a stable network raises nothing; a second partition raises and heals', () => {
        let s = h.emptyState();
        let r = h.evaluate(s, { networks: [net([tv(), esp()])], now: T0 });
        expect(r.raised).toEqual([]);
        s = r.state;
        r = h.evaluate(s, { networks: [net([tv({ partitionId: '1' }), esp({ partitionId: '2' })], { partitions: ['1', '2'] })], now: T0 + 60000 });
        expect(r.raised).toEqual([expect.objectContaining({ kind: 'partition', subject: 'PAN1', message: expect.stringContaining('2 partition IDs') })]);
        s = r.state;
        r = h.evaluate(s, { networks: [net([tv(), esp()])], now: T0 + 120000 });
        expect(r.cleared).toEqual([expect.objectContaining({ kind: 'partition' })]);
        expect(r.state.active.size).toBe(0);
        expect(r.state.history.map((x) => x.event)).toEqual(['cleared', 'raised']);
    });

    test('a leader change is a one-off event with both names', () => {
        let s = h.evaluate(h.emptyState(), { networks: [net([tv(), esp()])], now: T0 }).state;
        const r = h.evaluate(s, { networks: [net([tv({ state: { role: 'router' } }), esp({ state: { role: 'leader' } })])], now: T0 + 60000 });
        expect(r.raised).toEqual([expect.objectContaining({ kind: 'leader_changed', transient: true, message: 'Home: the leader changed from Apple TV to Espressif esp-br' })]);
        expect(r.state.active.size).toBe(0); // transient: not kept active
        expect(h.evaluate(r.state, { networks: [net([tv({ state: { role: 'router' } }), esp({ state: { role: 'leader' } })])], now: T0 + 120000 }).raised).toEqual([]);
    });

    test('a border router not seen for 15 minutes, or gone from mDNS, raises; back again clears', () => {
        let s = h.evaluate(h.emptyState(), { networks: [net([tv(), esp()])], now: T0 }).state;
        let r = h.evaluate(s, { networks: [net([tv(), esp({ lastSeen: T0 - h.ROUTER_STALE_MS - 1 })])], now: T0 });
        expect(r.raised).toEqual([expect.objectContaining({ kind: 'border_router_offline', subject: 'BBBB', message: expect.stringContaining('not seen for') })]);
        s = r.state;
        r = h.evaluate(s, { networks: [net([tv()])], now: T0 + 60000 });
        expect(r.raised).toEqual([]); // still the same alert, now "disappeared" would be a new message but the key is the same
        expect(r.state.active.has('border_router_offline:BBBB')).toBe(true);
        r = h.evaluate(r.state, { networks: [net([tv(), esp({ lastSeen: T0 + 120000 })])], now: T0 + 120000 });
        expect(r.cleared).toEqual([expect.objectContaining({ kind: 'border_router_offline' })]);
    });

    test('a router dropping to a child raises and clears when it is a router again; a link from good to poor raises and recovers', () => {
        const nodes = (role, lqi) => ({
            nodes: [
                {
                    id: 'node:4',
                    kind: 'thread',
                    nodeId: '4',
                    name: 'Bulb',
                    online: true,
                    roleCode: role,
                    role: role === 5 ? 'router' : 'end device',
                    networkName: 'Home',
                    partitionId: 1,
                },
                { id: 'node:2', kind: 'thread', nodeId: '2', name: 'Switch', online: true, roleCode: 2, role: 'sleepy end device', networkName: 'Home', partitionId: 1 },
            ],
            links: [{ kind: 'neighbour', source: 'node:4', target: 'node:2', lqi }],
        });
        let s = h.evaluate(h.emptyState(), { mesh: nodes(5, 3), now: T0 }).state;
        let r = h.evaluate(s, { mesh: nodes(3, 1), now: T0 + 60000 });
        expect(r.raised.map((a) => a.kind).sort()).toEqual(['link_degraded', 'role_dropped']);
        expect(r.raised.find((a) => a.kind === 'role_dropped').message).toBe('Bulb: was a router, is now a end device');
        expect(r.raised.find((a) => a.kind === 'link_degraded').message).toContain('Bulb ↔ Switch');
        s = r.state;
        r = h.evaluate(s, { mesh: nodes(3, 1), now: T0 + 120000 });
        expect(r.raised).toEqual([]);
        expect(r.cleared).toEqual([]);
        r = h.evaluate(r.state, { mesh: nodes(5, 3), now: T0 + 180000 });
        expect(r.cleared.map((a) => a.kind).sort()).toEqual(['link_degraded', 'role_dropped']);
        expect(r.state.active.size).toBe(0);
    });

    test('devices of one network reporting different partition IDs raise', () => {
        const mesh = {
            nodes: [
                { id: 'a', kind: 'thread', nodeId: '4', name: 'A', online: true, roleCode: 5, networkName: 'Home', partitionId: 1 },
                { id: 'b', kind: 'thread', nodeId: '5', name: 'B', online: true, roleCode: 5, networkName: 'Home', partitionId: 2 },
            ],
            links: [],
        };
        const r = h.evaluate(h.emptyState(), { mesh, now: T0 });
        expect(r.raised).toEqual([expect.objectContaining({ kind: 'partition', subject: 'nodes:Home', message: expect.stringContaining('devices report 2 partition IDs') })]);
    });
});

describe('thread health: check()', () => {
    test('publishes the retained status with lc, logs raised alerts at warn, broadcasts', async () => {
        jest.resetModules();
        const health = require('../../src/matter/thread-health');
        health._reset();
        const published = [];
        const log = { warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
        const broadcast = jest.fn();
        let networks = [net([tv(), esp()])];
        const thread = { listNetworks: () => ({ networks }) };
        const mesh = { getMesh: async () => ({ nodes: [], links: [] }) };
        health.start({
            publish: (topic, payload, opts) => published.push({ topic, payload: JSON.parse(payload), retain: opts.retain }),
            name: 'she',
            log,
            broadcast,
            thread,
            mesh,
        });
        let st = await health.check({ now: T0 });
        expect(st.val).toBe('ok');
        expect(published[0]).toEqual({ topic: 'she/status/thread/health', payload: { val: 'ok', ts: T0, lc: T0, alerts: [] }, retain: true });
        networks = [net([tv(), esp()], { partitions: ['1', '2'] })];
        st = await health.check({ now: T0 + 60000 });
        expect(st.val).toBe('warning');
        expect(st.active[0].kind).toBe('partition');
        expect(published[1].payload).toMatchObject({ val: 'warning', ts: T0 + 60000, lc: T0 + 60000, alerts: [{ kind: 'partition', network: 'Home' }] });
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('partition IDs'));
        expect(broadcast).toHaveBeenCalledWith({ type: 'matter:thread-health' });
        // nothing changed → nothing published
        await health.check({ now: T0 + 120000 });
        expect(published.length).toBe(2);
        expect(health.clearHistory().history).toEqual([]);
        health.stop();
    });
});
