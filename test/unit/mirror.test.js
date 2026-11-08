'use strict';

const { createMirror, normalizeRules, mapTopic, isValidFilter, PRESETS } = require('../../src/lib/mirror');

describe('mirror rules — validation', () => {
    it('accepts valid filters and rejects malformed ones', () => {
        expect(isValidFilter('#')).toBe(true);
        expect(isValidFilter('a/+/b/#')).toBe(true);
        expect(isValidFilter('a/b')).toBe(true);
        expect(isValidFilter('')).toBe(false);
        expect(isValidFilter('a/#/b')).toBe(false);
        expect(isValidFilter('a/b+')).toBe(false);
        expect(isValidFilter('a#')).toBe(false);
        expect(isValidFilter(42)).toBe(false);
    });

    it('normalises a rule list: to defaults to from, errors are collected per rule', () => {
        const { rules, errors } = normalizeRules(
            [
                { dir: 'in', from: 'tele/#', to: 'shed/tele/#' },
                { dir: 'out', from: 'shed/set/#' },
                { dir: 'sideways', from: 'x' },
                { dir: 'in', from: 'a/#/b' },
                { dir: 'in', from: 'a/+', to: 'b/+/+' },
                { dir: 'in', from: 'a/+', to: 'b/#' },
                'nope',
            ],
            'shed',
        );
        expect(rules).toEqual([
            { dir: 'in', from: 'tele/#', to: 'shed/tele/#' },
            { dir: 'out', from: 'shed/set/#', to: 'shed/set/#' },
        ]);
        expect(errors).toHaveLength(5);
        expect(errors[0]).toMatch(/mirror\[2\]: dir/);
        expect(errors[1]).toMatch(/mirror\[3\]: from "a\/#\/b"/);
        expect(errors[2]).toMatch(/more \+ wildcards/);
        expect(errors[3]).toMatch(/# wildcard but from/);
        expect(errors[4]).toMatch(/not a rule object/);
    });

    it('tolerates a missing list and rejects a non-list', () => {
        expect(normalizeRules(undefined, 'x')).toEqual({ rules: [], errors: [] });
        expect(normalizeRules({ dir: 'in' }, 'x').errors[0]).toMatch(/must be a list/);
    });
});

describe('mapTopic — prefix mapping with the matched wildcards carried over', () => {
    it('maps # tails', () => {
        expect(mapTopic('tele/sensor/temp', 'tele/#', 'shed/tele/#')).toBe('shed/tele/sensor/temp');
        expect(mapTopic('anything/at/all', '#', 'shed/#')).toBe('shed/anything/at/all');
        expect(mapTopic('shed/set/lamp', 'shed/set/#', 'set/#')).toBe('set/lamp');
        expect(mapTopic('other/set/lamp', 'shed/set/#', 'set/#')).toBeNull();
    });
    it('maps + segments positionally and keeps literal targets', () => {
        expect(mapTopic('hm/status/lamp/LEVEL', '+/status/#', 'remote/+/status/#')).toBe('remote/hm/status/lamp/LEVEL');
        expect(mapTopic('a/x/b/y', 'a/+/b/+', 'c/+/d/+')).toBe('c/x/d/y');
        expect(mapTopic('a/x/b/y', 'a/+/b/+', 'c/+')).toBe('c/x');
        expect(mapTopic('a/x', 'a/+', 'fixed/topic')).toBe('fixed/topic');
    });
    it('an empty # remainder drops the trailing segment', () => {
        expect(mapTopic('tele', 'tele/#', 'shed/tele/#')).toBe('shed/tele');
    });
    it('the same topic on both sides when to equals from', () => {
        expect(mapTopic('inst/status/x', 'inst/status/#', 'inst/status/#')).toBe('inst/status/x');
    });
});

describe('the presets', () => {
    it('everything in under <name>/ and the mqtt-smarthome adapter', () => {
        expect(PRESETS.everythingIn('shed')).toEqual([{ dir: 'in', from: '#', to: 'shed/#' }]);
        const adapter = PRESETS.smarthomeAdapter('hm');
        expect(adapter.map((r) => r.dir)).toEqual(['in', 'in', 'out']);
        expect(normalizeRules(adapter, 'x').errors).toEqual([]);
        expect(normalizeRules(PRESETS.everythingIn('shed'), 'x').errors).toEqual([]);
    });
});

/** a mirror over two fake brokers that record what was published */
function harness(opts = {}) {
    let t = 1000;
    const primary = [];
    const secondary = [];
    const log = { debug: jest.fn(), warn: jest.fn() };
    const m = createMirror({
        publishPrimary: (topic, payload, o) => {
            if (opts.primaryOffline) return false;
            primary.push([topic, payload.toString(), o]);
            return true;
        },
        publishSecondary: (name, topic, payload, o) => {
            secondary.push([name, topic, payload.toString(), o]);
            return true;
        },
        log,
        now: () => t,
        echoTtlMs: 1000,
    });
    return { m, primary, secondary, log, tick: (ms) => (t += ms) };
}
const msg = (retain = false, qos = 0) => ({ retain, qos });
const buf = (s) => Buffer.from(s);

describe('createMirror — forwarding', () => {
    it('in: a secondary message is published on the primary under the mapped topic, retain and qos kept', () => {
        const { m, primary } = harness();
        m.setRules('shed', normalizeRules([{ dir: 'in', from: 'tele/#', to: 'shed/tele/#' }], 'shed').rules);
        m.fromSecondary('shed', 'tele/temp', buf('21.5'), msg(true, 1));
        m.fromSecondary('shed', 'cmnd/other', buf('x'), msg());
        expect(primary).toEqual([['shed/tele/temp', '21.5', { retain: true, qos: 1 }]]);
        expect(m.stats('shed')).toEqual({ in: 1, out: 0 });
    });

    it('out: a primary message is published on every secondary whose out rule matches', () => {
        const { m, secondary } = harness();
        m.setRules('a', normalizeRules([{ dir: 'out', from: 'a/set/#', to: 'set/#' }], 'a').rules);
        m.setRules('b', normalizeRules([{ dir: 'out', from: '#' }], 'b').rules);
        m.fromPrimary('a/set/lamp', buf('1'), msg());
        expect(secondary).toEqual([
            ['a', 'set/lamp', '1', { retain: false, qos: 0 }],
            ['b', 'a/set/lamp', '1', { retain: false, qos: 0 }],
        ]);
        expect(m.stats('a')).toEqual({ in: 0, out: 1 });
        expect(m.stats('b')).toEqual({ in: 0, out: 1 });
    });

    it('the first matching rule of a broker wins; $SYS topics are never mirrored', () => {
        const { m, primary } = harness();
        m.setRules(
            'x',
            normalizeRules(
                [
                    { dir: 'in', from: 'a/#', to: 'first/#' },
                    { dir: 'in', from: '#', to: 'second/#' },
                ],
                'x',
            ).rules,
        );
        m.fromSecondary('x', 'a/1', buf('v'), msg());
        m.fromSecondary('x', '$SYS/broker/uptime', buf('v'), msg());
        expect(primary.map((p) => p[0])).toEqual(['first/1']);
    });

    it('a broker without rules forwards nothing; removeBroker forgets it', () => {
        const { m, primary, secondary } = harness();
        m.fromSecondary('nobody', 'a', buf('1'), msg());
        m.setRules('x', normalizeRules([{ dir: 'out', from: '#' }], 'x').rules);
        m.removeBroker('x');
        m.fromPrimary('a', buf('1'), msg());
        expect(primary).toEqual([]);
        expect(secondary).toEqual([]);
        expect(m.rules('x')).toEqual([]);
    });

    it('a retained message that arrives again with the same payload is not sent twice', () => {
        const { m, primary } = harness();
        m.setRules('shed', normalizeRules([{ dir: 'in', from: '#', to: 'shed/#' }], 'shed').rules);
        m.fromSecondary('shed', 'tele/temp', buf('21.5'), msg(true));
        m.fromSecondary('shed', 'tele/temp', buf('21.5'), msg(true)); // the reconnect's retained burst
        m.fromSecondary('shed', 'tele/temp', buf('22.0'), msg(true));
        m.fromSecondary('shed', 'tele/temp', buf('22.0'), msg(false)); // a live repeat is a message
        expect(primary.map((p) => p[1])).toEqual(['21.5', '22.0', '22.0']);
    });

    it('a publish the target refused expects no echo', () => {
        const { m, primary } = harness({ primaryOffline: true });
        m.setRules('shed', normalizeRules([{ dir: 'in', from: '#', to: 'shed/#' }], 'shed').rules);
        m.fromSecondary('shed', 'tele/temp', buf('1'), msg(true));
        expect(primary).toEqual([]);
        expect(m._pendingEchoes()).toBe(0);
        expect(m.stats('shed')).toEqual({ in: 0, out: 0 });
    });
});

describe('createMirror — loop protection', () => {
    it('the echo of a mirrored publish is recognised once and never mirrored on', () => {
        const { m, primary, secondary } = harness();
        m.setRules(
            'shed',
            normalizeRules(
                [
                    { dir: 'in', from: '#', to: 'shed/#' },
                    { dir: 'out', from: 'shed/#', to: '#' },
                ],
                'shed',
            ).rules,
        );
        // a message on the secondary goes in …
        m.fromSecondary('shed', 'tele/temp', buf('21.5'), msg());
        expect(primary).toEqual([['shed/tele/temp', '21.5', { retain: false, qos: 0 }]]);
        // … the primary echoes it: consumed, and the out rule (which would match) is not applied
        expect(m.consumeEcho(null, 'shed/tele/temp', buf('21.5'))).toBe(true);
        expect(m.consumeEcho(null, 'shed/tele/temp', buf('21.5'))).toBe(false); // only once
        expect(secondary).toEqual([]);
        expect(m._pendingEchoes()).toBe(0);
    });

    it('two rules that form a cycle do not loop: in → echo consumed; out → echo consumed', () => {
        const { m, primary, secondary } = harness();
        m.setRules(
            'shed',
            normalizeRules(
                [
                    { dir: 'in', from: '#', to: 'shed/#' },
                    { dir: 'out', from: 'shed/#', to: '#' },
                ],
                'shed',
            ).rules,
        );
        // simulate the daemon: every publish comes back on its broker as a message
        const deliverPrimary = (topic, payload) => {
            if (!m.consumeEcho(null, topic, payload)) m.fromPrimary(topic, payload, msg());
        };
        const deliverSecondary = (topic, payload) => {
            if (!m.consumeEcho('shed', topic, payload)) m.fromSecondary('shed', topic, payload, msg());
        };
        // a real client publishes on the primary
        deliverPrimary('shed/set/lamp', buf('1'));
        expect(secondary).toEqual([['shed', 'set/lamp', '1', { retain: false, qos: 0 }]]);
        deliverSecondary('set/lamp', buf('1')); // the echo on the secondary
        expect(primary).toEqual([]); // not mirrored back in
        // a real client publishes on the secondary
        deliverSecondary('tele/temp', buf('5'));
        expect(primary).toEqual([['shed/tele/temp', '5', { retain: false, qos: 0 }]]);
        deliverPrimary('shed/tele/temp', buf('5')); // the echo on the primary
        expect(secondary).toHaveLength(1); // not mirrored back out
        expect(m._pendingEchoes()).toBe(0);
    });

    it('a genuine second publish with the same payload is mirrored again after the echo was consumed', () => {
        const { m, primary } = harness();
        m.setRules('shed', normalizeRules([{ dir: 'in', from: '#', to: 'shed/#' }], 'shed').rules);
        m.fromSecondary('shed', 'a', buf('1'), msg());
        expect(m.consumeEcho(null, 'shed/a', buf('1'))).toBe(true);
        m.fromSecondary('shed', 'a', buf('1'), msg());
        expect(primary).toHaveLength(2);
        expect(m.consumeEcho(null, 'shed/a', buf('1'))).toBe(true);
    });

    it('an expected echo expires', () => {
        const { m, tick } = harness();
        m.setRules('shed', normalizeRules([{ dir: 'in', from: '#', to: 'shed/#' }], 'shed').rules);
        m.fromSecondary('shed', 'a', buf('1'), msg());
        tick(2000);
        expect(m.consumeEcho(null, 'shed/a', buf('1'))).toBe(false);
        expect(m._pendingEchoes()).toBe(0);
    });

    it('binary payloads are compared byte for byte', () => {
        const { m } = harness();
        m.setRules('shed', normalizeRules([{ dir: 'in', from: '#' }], 'shed').rules);
        m.fromSecondary('shed', 'bin', Buffer.from([0xff, 0xfe]), msg());
        expect(m.consumeEcho(null, 'bin', Buffer.from([0xff, 0xfd]))).toBe(false);
        expect(m.consumeEcho(null, 'bin', Buffer.from([0xff, 0xfe]))).toBe(true);
    });
});
