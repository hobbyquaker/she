'use strict';

const { Runtime, HandlerStats, GaugeHistory, NotFoundError, WINDOW_MS, BUCKET_MS } = require('../../src/lib/runtime');

describe('HandlerStats', () => {
    it('counts fires, time, max and the last fire', () => {
        const s = new HandlerStats();
        s.record(2, false, 1000);
        s.record(5, false, 2000);
        s.record(1, true, 3000);
        const j = s.toJSON(3000);
        expect(j).toMatchObject({ fires: 3, errors: 1, totalMs: 8, maxMs: 5, lastFire: 3000, lastMs: 1, lastError: 3000 });
        expect(j.recent).toEqual({ fires: 3, errors: 1, totalMs: 8 });
    });

    it('the five-minute window forgets old buckets', () => {
        const s = new HandlerStats();
        const t0 = 1_000_000_000;
        s.record(10, false, t0);
        s.record(10, false, t0 + 60_000);
        expect(s.recent(t0 + 61_000)).toEqual({ fires: 2, errors: 0, totalMs: 20 });
        // the first fire leaves the window, the second is still in it
        expect(s.recent(t0 + WINDOW_MS + BUCKET_MS)).toEqual({ fires: 1, errors: 0, totalMs: 10 });
        expect(s.recent(t0 + WINDOW_MS + 70_000)).toEqual({ fires: 0, errors: 0, totalMs: 0 });
        // the totals stay
        expect(s.fires).toBe(2);
    });

    it('a bucket reused after a full turn of the ring starts empty', () => {
        const s = new HandlerStats();
        const t0 = 2_000_000_000;
        s.record(1, false, t0);
        s.record(1, false, t0 + WINDOW_MS); // same bucket index, one window later
        expect(s.recent(t0 + WINDOW_MS)).toEqual({ fires: 1, errors: 0, totalMs: 1 });
    });

    it('fail() records a late error (a rejected promise)', () => {
        const s = new HandlerStats();
        s.record(1, false, 5000);
        s.fail(6000);
        expect(s.errors).toBe(1);
        expect(s.lastError).toBe(6000);
        expect(s.recent(6000).errors).toBe(1);
    });
});

describe('GaugeHistory', () => {
    it('keeps one sample per interval and at most `size`', () => {
        const g = new GaugeHistory({ intervalMs: 10, size: 3 });
        expect(g.push({ ts: 0 })).toBe(true);
        expect(g.push({ ts: 5 })).toBe(false);
        expect(g.push({ ts: 10 })).toBe(true);
        expect(g.push({ ts: 20 })).toBe(true);
        expect(g.push({ ts: 30 })).toBe(true);
        expect(g.list().map((s) => s.ts)).toEqual([10, 20, 30]);
    });

    it('defaults to an hour of 10 s samples', () => {
        const g = new GaugeHistory();
        expect(g.intervalMs * g.size).toBe(60 * 60 * 1000);
    });
});

describe('Runtime registry', () => {
    it("lists a script's handlers with their statistics and pending timers", () => {
        const rt = new Runtime();
        const sub = rt.handler('/s/a.js', { kind: 'sub', name: 'x/y', detail: 'change', line: 3 });
        sub.stats.record(1.234, false, 100);
        const group = rt.timerGroup('/s/a.js', { kind: 'timer', line: 7 });
        rt.addPending(group, { due: 5000, start: 1000 });
        rt.addPending(group, { due: 3000, start: 1000 });
        const snap = rt.snapshot({ now: 200, label: (f) => f.slice(3), origin: () => 'user' });
        expect(snap.ts).toBe(200);
        expect(snap.scripts).toHaveLength(1);
        const [script] = snap.scripts;
        expect(script).toMatchObject({ file: '/s/a.js', label: 'a.js', origin: 'user' });
        expect(script.handlers).toHaveLength(2);
        const [h1, h2] = script.handlers;
        expect(h1).toMatchObject({ kind: 'sub', name: 'x/y', detail: 'change', line: 3, fires: 1, totalMs: 1.23, pending: [] });
        expect(h1.actions).toEqual({ run: false, cancel: false });
        expect(h2).toMatchObject({ kind: 'timer', line: 7 });
        // pending timers sorted by due
        expect(h2.pending.map((p) => p.due)).toEqual([3000, 5000]);
        expect(h2.pending[0].id).toMatch(/^t\d+$/);
    });

    it('timerGroup() returns the same group for kind, name and line and a new one otherwise', () => {
        const rt = new Runtime();
        const a = rt.timerGroup('f', { kind: 'debounce', name: 'infobox', line: 10 });
        expect(rt.timerGroup('f', { kind: 'debounce', name: 'infobox', line: 10 })).toBe(a);
        expect(rt.timerGroup('f', { kind: 'debounce', name: 'other', line: 10 })).not.toBe(a);
        expect(rt.timerGroup('g', { kind: 'debounce', name: 'infobox', line: 10 })).not.toBe(a);
        expect(rt.handlers.size).toBe(3);
    });

    it('a timer that fired or was cleared leaves the pending list; a removed group comes back fresh', () => {
        const rt = new Runtime();
        const g = rt.timerGroup('f', { kind: 'timer', line: 1 });
        const p = rt.addPending(g, { due: 1, start: 0 });
        expect(rt.pending.size).toBe(1);
        rt.removePending(p);
        expect(rt.pending.size).toBe(0);
        expect(g.pending.size).toBe(0);
        rt.removeHandler(g);
        expect(rt.timerGroup('f', { kind: 'timer', line: 1 })).not.toBe(g);
    });

    it('removeScript() drops every handler and pending entry of the script, nothing of the others', () => {
        const rt = new Runtime();
        const a = rt.handler('a', { kind: 'sub', name: 't' });
        rt.addPending(rt.timerGroup('a', { kind: 'timer' }), { due: 1 });
        const b = rt.handler('b', { kind: 'sub', name: 't' });
        rt.removeScript('a');
        expect(rt.handlers.has(a.id)).toBe(false);
        expect(rt.handlers.has(b.id)).toBe(true);
        expect(rt.pending.size).toBe(0);
        expect(rt.snapshot().scripts.map((s) => s.file)).toEqual(['b']);
        rt.removeScript('nobody'); // harmless
    });

    it('snapshot({ script }) filters to one script and calls next()', () => {
        const rt = new Runtime();
        rt.handler('a', { kind: 'schedule', name: '* * * * *', next: () => 42, run: () => {} });
        rt.handler('b', { kind: 'sub', name: 't' });
        const snap = rt.snapshot({ script: 'a' });
        expect(snap.scripts).toHaveLength(1);
        expect(snap.scripts[0].handlers[0]).toMatchObject({ kind: 'schedule', next: 42, actions: { run: true, cancel: false } });
        // a next() that throws is null, not an exception
        rt.handler('c', {
            kind: 'schedule',
            name: 'x',
            next: () => {
                throw new Error('gone');
            },
        });
        expect(rt.snapshot({ script: 'c' }).scripts[0].handlers[0].next).toBeNull();
    });

    it('snapshot() carries the latest gauges and the failed-command counter', () => {
        const rt = new Runtime();
        rt.latestGauges = { ts: 1, memMb: 100 };
        rt.commandsFailed = 3;
        expect(rt.snapshot()).toMatchObject({ gauges: { memMb: 100 }, commandsFailed: 3, scripts: [] });
    });

    describe('action()', () => {
        it('fires or cancels a pending timer through its closures and names what it did', () => {
            const rt = new Runtime();
            const g = rt.timerGroup('f', { kind: 'timeout', name: 'hall off' });
            const fire = jest.fn();
            const cancel = jest.fn();
            const p = rt.addPending(g, { due: 1, fire, cancel });
            expect(rt.action(p.id, 'run')).toEqual({ script: 'f', kind: 'timeout', name: 'hall off', what: 'timer' });
            expect(fire).toHaveBeenCalledTimes(1);
            expect(rt.action(p.id, 'cancel')).toMatchObject({ what: 'timer' });
            expect(cancel).toHaveBeenCalledTimes(1);
        });

        it('runs a schedule once, cancels an interval, refuses what a handler does not offer', () => {
            const rt = new Runtime();
            const run = jest.fn();
            const sched = rt.handler('f', { kind: 'schedule', name: '0 7 * * *', run });
            expect(rt.action(sched.id, 'run')).toEqual({ script: 'f', kind: 'schedule', name: '0 7 * * *', what: 'handler' });
            expect(run).toHaveBeenCalledTimes(1);
            expect(() => rt.action(sched.id, 'cancel')).toThrow(TypeError);
            const cancel = jest.fn();
            const iv = rt.handler('f', { kind: 'interval', name: 'every 1000 ms', run, cancel });
            rt.action(iv.id, 'cancel');
            expect(cancel).toHaveBeenCalledTimes(1);
            const sub = rt.handler('f', { kind: 'sub', name: 't' });
            expect(() => rt.action(sub.id, 'run')).toThrow(/not possible/);
        });

        it('an unknown id — the script was reloaded in between — is a NotFoundError', () => {
            const rt = new Runtime();
            const g = rt.timerGroup('f', { kind: 'timer' });
            const p = rt.addPending(g, { due: 1, fire: () => {}, cancel: () => {} });
            rt.removeScript('f');
            expect(() => rt.action(p.id, 'run')).toThrow(NotFoundError);
            expect(() => rt.action('h999', 'run')).toThrow(/reloaded/);
            expect(() => rt.action(p.id, 'flush')).toThrow(TypeError);
        });
    });
});
