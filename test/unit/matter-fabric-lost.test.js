'use strict';

/**
 * Unit tests for src/matter/fabric-lost.js: the state of a node that answers with
 * NoSharedTrustRoots — the threshold, the time of the first answer, the pause, the hourly probe,
 * the clearing when the node comes back, and the file across a restart.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTracker, THRESHOLD, PROBE_INTERVAL_MS, PROBE_WINDOW_MS } = require('../../src/matter/fabric-lost');

describe('matter fabric-lost tracker', () => {
    const T0 = 1_700_000_000_000;

    test('the constants: three answers, one probe an hour, a two-minute window', () => {
        expect(THRESHOLD).toBe(3);
        expect(PROBE_INTERVAL_MS).toBe(3600000);
        expect(PROBE_WINDOW_MS).toBe(120000);
    });

    test('a node is lost after THRESHOLD consecutive answers, since the first one', () => {
        const t = createTracker();
        expect(t.record('1', T0)).toEqual({ lost: false, justLost: false, count: 1, since: T0 });
        expect(t.isLost('1')).toBe(false);
        expect(t.since('1')).toBeNull();
        expect(t.record('1', T0 + 1000)).toMatchObject({ lost: false, count: 2 });
        const r = t.record('1', T0 + 2000);
        expect(r).toEqual({ lost: true, justLost: true, count: 3, since: T0 });
        expect(t.isLost('1')).toBe(true);
        expect(t.since('1')).toBe(T0);
        // further answers keep the first time and do not report "just lost" again
        expect(t.record('1', T0 + 3000)).toEqual({ lost: true, justLost: false, count: 4, since: T0 });
        expect(t.list()).toEqual([expect.objectContaining({ nodeId: '1', since: T0, count: 4, paused: false })]);
        // another node is independent
        expect(t.isLost('2')).toBe(false);
    });

    test('the node coming back clears the state and says whether it was lost', () => {
        const t = createTracker();
        t.record('1', T0);
        expect(t.clear('1')).toBe(false); // below the threshold: nothing to report
        expect(t.record('1', T0).count).toBe(1); // the run starts over
        t.record('1', T0);
        t.record('1', T0);
        expect(t.isLost('1')).toBe(true);
        expect(t.clear('1')).toBe(true);
        expect(t.isLost('1')).toBe(false);
        expect(t.clear('1')).toBe(false);
    });

    test('a paused node is probed once an hour, not while a probe runs, and not before the threshold', () => {
        const t = createTracker();
        t.record('1', T0);
        t.markPaused('1', T0); // ignored: not lost yet
        expect(t.get('1')).toBeNull();
        expect(t.dueProbes(T0 + 10 * PROBE_INTERVAL_MS)).toEqual([]);
        t.record('1', T0);
        t.record('1', T0);
        // lost but not paused yet: no probe (the controller is disabling the node)
        expect(t.dueProbes(T0 + 2 * PROBE_INTERVAL_MS)).toEqual([]);
        t.markPaused('1', T0 + 5000);
        expect(t.get('1')).toMatchObject({ paused: true, pausedAt: T0 + 5000, probes: 0, lastProbeAt: null });
        expect(t.dueProbes(T0 + 5000 + PROBE_INTERVAL_MS - 1)).toEqual([]);
        expect(t.dueProbes(T0 + 5000 + PROBE_INTERVAL_MS)).toEqual(['1']);
        t.startProbe('1', T0 + 5000 + PROBE_INTERVAL_MS);
        expect(t.isProbing('1')).toBe(true);
        expect(t.get('1')).toMatchObject({ probes: 1, lastProbeAt: T0 + 5000 + PROBE_INTERVAL_MS });
        // while probing: never due, however long it takes
        expect(t.dueProbes(T0 + 5000 + 3 * PROBE_INTERVAL_MS)).toEqual([]);
        // the probe ends with the node paused again: the next probe an hour after the last one
        t.markPaused('1', T0 + 5000 + PROBE_INTERVAL_MS + PROBE_WINDOW_MS);
        expect(t.isProbing('1')).toBe(false);
        expect(t.get('1').pausedAt).toBe(T0 + 5000); // the first pause stays
        expect(t.dueProbes(T0 + 5000 + 2 * PROBE_INTERVAL_MS - 1)).toEqual([]);
        expect(t.dueProbes(T0 + 5000 + 2 * PROBE_INTERVAL_MS)).toEqual(['1']);
    });

    test('the threshold and the interval are configurable', () => {
        const t = createTracker({ threshold: 1, probeIntervalMs: 1000 });
        expect(t.record('9', T0).justLost).toBe(true);
        t.markPaused('9', T0);
        expect(t.dueProbes(T0 + 999)).toEqual([]);
        expect(t.dueProbes(T0 + 1000)).toEqual(['9']);
    });

    test('the state survives a restart through the file; a corrupt or missing file is tolerated', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-fl-'));
        const file = path.join(dir, 'fabric-lost.json');
        try {
            const warn = jest.fn();
            const t = createTracker({ file, log: { warn, debug: jest.fn() } });
            t.record('1', T0);
            t.record('1', T0 + 1);
            expect(fs.existsSync(file)).toBe(false); // nothing worth keeping below the threshold
            t.record('1', T0 + 2);
            t.markPaused('1', T0 + 3);
            t.startProbe('1', T0 + 4);
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            expect(raw.nodes['1']).toEqual({ count: 3, since: T0, lastAt: T0 + 2, paused: true, pausedAt: T0 + 3, probes: 1, lastProbeAt: T0 + 4 });
            expect(raw.nodes['1'].probing).toBeUndefined(); // a probe does not outlive the process

            const again = createTracker({ file, log: { warn, debug: jest.fn() } });
            expect(again.get('1')).toMatchObject({ since: T0, count: 3, paused: true, probes: 1, lastProbeAt: T0 + 4, probing: false });
            // after the restart the probe is due an hour after the last one
            expect(again.dueProbes(T0 + 4 + PROBE_INTERVAL_MS - 1)).toEqual([]);
            expect(again.dueProbes(T0 + 4 + PROBE_INTERVAL_MS)).toEqual(['1']);
            again.clear('1');
            expect(JSON.parse(fs.readFileSync(file, 'utf8')).nodes).toEqual({});

            fs.writeFileSync(file, 'not json');
            const broken = createTracker({ file, log: { warn, debug: jest.fn() } });
            expect(broken.list()).toEqual([]);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot read'));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
