'use strict';

const FakeTimers = require('@sinonjs/fake-timers');
const { createCommander, CommandError } = require('../../src/lib/command');

/** a tiny daemon: a state store, a broker that may echo, the script's timers and unload hook */
function harness(initial = {}) {
    const clock = FakeTimers.createClock(0);
    const state = { ...initial };
    const watchers = new Map();
    const published = [];
    const warnings = [];
    const unloadHooks = new Set();
    const timers = new Set();
    let failed = 0;
    const h = {
        clock,
        state,
        published,
        warnings,
        timers,
        failed: () => failed,
        /** the broker delivers a status value: stored, then every watcher told */
        status(topic, val) {
            state[topic] = val;
            for (const cb of [...(watchers.get(topic) || [])]) cb(val);
        },
        unload() {
            for (const fn of [...unloadHooks]) fn();
        },
        metas: [],
    };
    h.command = createCommander({
        publish: (topic, payload) => published.push([topic, payload]),
        get: (t) => state[t],
        has: (t) => t in state,
        watch: (topic, cb) => {
            if (!watchers.has(topic)) watchers.set(topic, new Set());
            watchers.get(topic).add(cb);
            return () => watchers.get(topic)?.delete(cb);
        },
        setTimeout: (fn, ms, meta) => {
            h.metas.push(meta);
            const id = clock.setTimeout(() => {
                timers.delete(id);
                fn();
            }, ms);
            timers.add(id);
            return id;
        },
        clearTimeout: (id) => {
            timers.delete(id);
            clock.clearTimeout(id);
        },
        onUnload: (fn) => {
            unloadHooks.add(fn);
            return () => unloadHooks.delete(fn);
        },
        warn: (m) => warnings.push(m),
        onFail: () => failed++,
        now: () => clock.now,
        line: () => 42,
    });
    return h;
}

const flush = () => new Promise((r) => setImmediate(r));

describe('she.mqtt.command', () => {
    it('resolves when the status echoes the value, with the time it took and one try', async () => {
        const h = harness();
        const p = h.command('hm/set/lamp/STATE', true);
        expect(h.published).toEqual([['hm/set/lamp/STATE', 'true']]);
        h.clock.tick(300);
        h.status('hm/status/lamp/STATE', true);
        await expect(p).resolves.toEqual({ val: true, ms: 300, tries: 1 });
        expect(h.timers.size).toBe(0); // the attempt timer is cleared
        expect(h.warnings).toEqual([]);
    });

    it('an echo that comes too late: the command has failed with reason timeout and a warning naming topic and payload', async () => {
        const h = harness();
        const p = h.command('hm/set/lamp/STATE', 1);
        h.clock.tick(5000);
        await expect(p).rejects.toMatchObject({ reason: 'timeout', topic: 'hm/set/lamp/STATE', payload: '1', tries: 1 });
        expect(h.warnings).toHaveLength(1);
        expect(h.warnings[0]).toMatch(/she\.mqtt\.command hm\/set\/lamp\/STATE ← 1: no confirmation within 5 s — nothing matching on hm\/status\/lamp\/STATE/);
        expect(h.failed()).toBe(1);
        h.status('hm/status/lamp/STATE', 1); // late — nothing happens
        await flush();
    });

    it('never an echo, with retries: republishes per attempt and fails after the last', async () => {
        const h = harness();
        const p = h.command('hm/set/lamp/STATE', 1, { timeout: 2, retries: 2 });
        h.clock.tick(2000);
        expect(h.published).toHaveLength(2);
        h.clock.tick(2000);
        expect(h.published).toHaveLength(3);
        h.clock.tick(2000);
        await expect(p).rejects.toMatchObject({ reason: 'timeout', tries: 3 });
        expect(h.warnings[0]).toMatch(/within 2 s \(3 attempts\)/);
    });

    it('a retry that is confirmed resolves with the attempt count', async () => {
        const h = harness();
        const p = h.command('hm/set/lamp/STATE', 1, { timeout: 1, retries: 3 });
        h.clock.tick(1000);
        h.clock.tick(500);
        h.status('hm/status/lamp/STATE', { val: 1 }.val);
        await expect(p).resolves.toEqual({ val: 1, ms: 1500, tries: 2 });
        expect(h.failed()).toBe(0);
    });

    it('fails fast with reason offline when the adapter reports connected < 2', async () => {
        const h = harness({ 'hm/connected': 1 });
        const p = h.command('hm/set/lamp/STATE', 1);
        await expect(p).rejects.toMatchObject({ reason: 'offline' });
        expect(h.published).toEqual([]);
        expect(h.warnings[0]).toMatch(/device offline \(hm\/connected = 1\)/);
        expect(h.failed()).toBe(1);
    });

    it('a newer command to the same topic supersedes the running one, silently', async () => {
        const h = harness();
        const first = h.command('hm/set/lamp/LEVEL', 0.2);
        const second = h.command('hm/set/lamp/LEVEL', 0.8);
        await expect(first).rejects.toMatchObject({ reason: 'superseded' });
        h.status('hm/status/lamp/LEVEL', 0.8);
        await expect(second).resolves.toMatchObject({ val: 0.8, tries: 1 });
        expect(h.warnings).toEqual([]);
        expect(h.failed()).toBe(0);
    });

    it('status already at the target: sends anyway and resolves at once with already: true', async () => {
        const h = harness({ 'hm/status/lamp/STATE': true });
        const p = h.command('hm/set/lamp/STATE', 1);
        await expect(p).resolves.toEqual({ val: true, ms: 0, tries: 1, already: true });
        expect(h.published).toEqual([['hm/set/lamp/STATE', '1']]);
        expect(h.timers.size).toBe(0);
    });

    it('zigbee2mqtt: the JSON state object confirms the field; the offline availability fails fast', async () => {
        const h = harness({ 'zigbee2mqtt/lamp': { state: 'OFF', brightness: 10 } });
        const p = h.command('zigbee2mqtt/lamp/set', { state: 'ON' });
        expect(h.published).toEqual([['zigbee2mqtt/lamp/set', '{"state":"ON"}']]);
        h.status('zigbee2mqtt/lamp', { state: 'OFF', brightness: 10, linkquality: 40 }); // not yet
        h.status('zigbee2mqtt/lamp', { state: 'ON', brightness: 10, linkquality: 40 });
        await expect(p).resolves.toMatchObject({ val: 'ON', tries: 1 });
        h.state['zigbee2mqtt/lamp/availability'] = 'offline';
        await expect(h.command('zigbee2mqtt/lamp/set', { state: 'OFF' })).rejects.toMatchObject({ reason: 'offline' });
    });

    it('a hot reload (unload) rejects the pending command with reason unloaded, no warning, no counter', async () => {
        const h = harness();
        const p = h.command('hm/set/lamp/STATE', 1);
        h.unload();
        await expect(p).rejects.toMatchObject({ reason: 'unloaded' });
        expect(h.warnings).toEqual([]);
        expect(h.failed()).toBe(0);
        expect(h.timers.size).toBe(0);
    });

    it('the editor cancels the pending attempt through the timer meta', async () => {
        const h = harness();
        const p = h.command('hm/set/lamp/STATE', 1);
        const meta = h.metas[0];
        expect(meta).toMatchObject({
            kind: 'command',
            name: 'hm/set/lamp/STATE',
            line: 42,
            actions: { run: false },
            extra: { topic: 'hm/set/lamp/STATE', payload: '1', tries: 1, confirm: 'hm/status/lamp/STATE' },
        });
        meta.onCancel();
        await expect(p).rejects.toMatchObject({ reason: 'cancelled' });
    });

    it('opts.expect as a value or a function, opts.tolerance for numbers, opts.confirm and opts.path for other conventions', async () => {
        const h = harness();
        const a = h.command('hm/set/thermostat/SET_TEMPERATURE', 21.5, { tolerance: 0.5 });
        h.status('hm/status/thermostat/SET_TEMPERATURE', 21.0);
        await expect(a).resolves.toMatchObject({ val: 21 });
        const b = h.command('hm/set/blind/LEVEL', 0, { expect: (v) => v <= 0.05 });
        h.status('hm/status/blind/LEVEL', 0.03);
        await expect(b).resolves.toMatchObject({ val: 0.03 });
        const c = h.command('tasmota/cmnd/POWER', 'ON', { confirm: 'tasmota/tele/STATE', path: 'POWER' });
        h.status('tasmota/tele/STATE', { POWER: 'ON', Wifi: {} });
        await expect(c).resolves.toMatchObject({ val: 'ON' });
        const d = h.command('hm/set/lamp/STATE', 'on', { expect: true });
        h.status('hm/status/lamp/STATE', true);
        await expect(d).resolves.toMatchObject({ val: true });
    });

    it('opts.quiet keeps the warning out of the log; the promise still rejects and the counter counts', async () => {
        const h = harness();
        const p = h.command('hm/set/lamp/STATE', 1, { quiet: true, timeout: 1 });
        h.clock.tick(1000);
        await expect(p).rejects.toBeInstanceOf(CommandError);
        expect(h.warnings).toEqual([]);
        expect(h.failed()).toBe(1);
    });

    it('a rejection nobody handles is not an unhandled rejection', async () => {
        const h = harness({ 'hm/connected': 0 });
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);
        h.command('hm/set/lamp/STATE', 1); // not awaited, not caught
        await flush();
        await flush();
        process.off('unhandledRejection', unhandled);
        expect(unhandled).not.toHaveBeenCalled();
        expect(h.warnings).toHaveLength(1);
    });

    it('the a//b shorthand is a set topic; bad arguments throw synchronously', () => {
        const h = harness();
        h.command('hm//lamp/STATE', 1);
        expect(h.published[0][0]).toBe('hm/set/lamp/STATE');
        expect(() => h.command('shelly/relay/0/command', 'on')).toThrow(/cannot derive the status topic.*opts\.confirm/);
        expect(() => h.command(5, 1)).toThrow(TypeError);
        expect(() => h.command('hm/set/x/y')).toThrow(/payload missing/);
        expect(() => h.command('hm/set/x/y', 1, { timeout: '5' })).toThrow(/opts\.timeout/);
        expect(() => h.command('hm/set/x/y', 1, { retries: 1.5 })).toThrow(/opts\.retries/);
    });
});

describe('an additional broker that is not connected', () => {
    it('fails at once with reason offline and the broker in the message, before any device check', async () => {
        const h = harness({ 'hm/connected': 2 });
        let online = false;
        const command = createCommander({
            publish: (topic, payload) => h.published.push([topic, payload]),
            get: (t) => h.state[t],
            has: (t) => t in h.state,
            offline: () => (online ? null : 'broker "shed" not connected'),
            watch: () => () => {},
            setTimeout: (fn, ms) => h.clock.setTimeout(fn, ms),
            clearTimeout: (id) => h.clock.clearTimeout(id),
            warn: (m) => h.warnings.push(m),
        });
        const p = command('hm/set/lamp/STATE', 1);
        await expect(p).rejects.toMatchObject({ reason: 'offline', topic: 'hm/set/lamp/STATE' });
        expect(h.published).toEqual([]);
        expect(h.warnings[0]).toBe('she.mqtt.command hm/set/lamp/STATE ← 1: broker "shed" not connected');
        online = true;
        const p2 = command('hm/set/lamp/STATE', 1);
        expect(h.published).toEqual([['hm/set/lamp/STATE', '1']]);
        h.clock.tick(6000);
        await expect(p2).rejects.toMatchObject({ reason: 'timeout' });
    });
});
