'use strict';

const { createProcessStats, parseSmaps, activeResources } = require('../../src/lib/process-stats');

const SMAPS = `
5555dead0000-5555deaf0000 rw-p 00000000 00:00 0                          [heap]
Size:                128 kB
Rss:                 100 kB
Pss:                 100 kB
Anonymous:           100 kB
7f0000000000-7f0000100000 r-xp 00000000 08:01 1234                       /usr/bin/node
Size:               1024 kB
Rss:                 600 kB
Anonymous:             0 kB
7f1000000000-7f1000400000 rw-p 00000000 00:00 0
Size:               4096 kB
Rss:                 300 kB
Anonymous:           300 kB
7ffd00000000-7ffd00021000 rw-p 00000000 00:00 0                          [stack]
Rss:                  20 kB
Anonymous:            20 kB
`;

describe('parseSmaps()', () => {
    it('sums the [heap] mapping and the anonymous pages in bytes', () => {
        expect(parseSmaps(SMAPS)).toEqual({ heapArena: 100 * 1024, anonymous: 420 * 1024, rss: 1020 * 1024 });
    });
    it('is null for a text without mappings', () => {
        expect(parseSmaps('')).toBeNull();
        expect(parseSmaps('Rss: 5 kB\n')).toBeNull();
    });
});

describe('createProcessStats().sample()', () => {
    const FLEET_FIELDS = ['rss', 'heapUsed', 'heapTotal', 'cpu', 'eventLoopLag', 'uptime', 'ts'];

    function fakes() {
        let t = 1_000_000;
        let cpu = { user: 0, system: 0 };
        let lagMax = 0;
        return {
            deps: {
                memoryUsage: () => ({ rss: 400e6, heapUsed: 60e6, heapTotal: 90e6, external: 5e6, arrayBuffers: 1e6 }),
                cpuUsage: (prev) => (prev ? { user: cpu.user - prev.user, system: cpu.system - prev.system } : { ...cpu }),
                now: () => t,
                uptime: () => 3600.4,
                takeLagMax: () => {
                    const v = lagMax;
                    lagMax = 0;
                    return v;
                },
                counts: () => ({ scripts: 12, topics: 3400, handlers: 80, timers: 7, schedules: 9, ignored: 'x' }),
                smaps: () => ({ heapArena: 200e6, anonymous: 350e6, rss: 400e6 }),
            },
            advance(ms, cpuUs, lag) {
                t += ms;
                cpu = { user: cpu.user + cpuUs, system: cpu.system };
                if (lag > lagMax) lagMax = lag;
            },
        };
    }

    it('has the mqtt-smarthome maintenance/stats fields first, as numbers, plus the extras', () => {
        const f = fakes();
        const stats = createProcessStats(f.deps);
        f.advance(60_000, 6_000_000, 412.6); // 6 s of CPU in 60 s = 10 % of one core
        const p = stats.sample();
        expect(Object.keys(p).slice(0, FLEET_FIELDS.length)).toEqual(FLEET_FIELDS);
        for (const [k, v] of Object.entries(p)) expect([k, typeof v]).toEqual([k, 'number']);
        expect(p).toEqual({
            rss: 400e6,
            heapUsed: 60e6,
            heapTotal: 90e6,
            cpu: 10,
            eventLoopLag: 413,
            uptime: 3600,
            ts: 1_060_000,
            external: 5e6,
            arrayBuffers: 1e6,
            scripts: 12,
            topics: 3400,
            handlers: 80,
            timers: 7,
            schedules: 9,
            heapArena: 200e6,
            anonymous: 350e6,
        });
        expect(JSON.parse(JSON.stringify(p))).toEqual(p); // what goes on the wire
    });

    it('cpu and lag are per interval: the second sample starts over', () => {
        const f = fakes();
        const stats = createProcessStats(f.deps);
        f.advance(60_000, 6_000_000, 400);
        stats.sample();
        f.advance(30_000, 300_000, 0); // 0.3 s in 30 s = 1 %
        const p = stats.sample();
        expect(p.cpu).toBe(1);
        expect(p.eventLoopLag).toBe(0);
    });

    it('leaves the smaps split out where it is not available', () => {
        const f = fakes();
        f.deps.smaps = () => null;
        const p = createProcessStats(f.deps).sample();
        expect(p).not.toHaveProperty('heapArena');
        expect(p).not.toHaveProperty('anonymous');
    });

    it('works with the real process (no injected readers)', () => {
        const p = createProcessStats().sample();
        for (const k of FLEET_FIELDS) expect(typeof p[k]).toBe('number');
        expect(p.rss).toBeGreaterThan(0);
        expect(p.heapUsed).toBeGreaterThan(0);
        if (process.platform === 'linux') expect(p.heapArena).toBeGreaterThanOrEqual(0);
    });
});

describe('activeResources()', () => {
    it('counts by type', () => {
        expect(activeResources(['Timeout', 'TCPSocketWrap', 'Timeout', 'FSReqCallback'])).toEqual({ Timeout: 2, TCPSocketWrap: 1, FSReqCallback: 1 });
        expect(typeof activeResources()).toBe('object');
    });
});
