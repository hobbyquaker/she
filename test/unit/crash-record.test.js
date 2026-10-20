'use strict';

/**
 * Unit tests for src/lib/crash-record.js (roadmap A10): the safe-mode decision — one late crash
 * starts normally, three early crashes in a row within the window enter safe mode, an early crash
 * after a healthy run starts normally, the window and the count, a pre-A10 sentinel, the file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cr = require('../../src/lib/crash-record');

const T0 = 1_000_000_000_000;
const MIN = 60 * 1000;

describe('crash record: the decision', () => {
    test('one crash after days of uptime starts normally and says so', () => {
        const r = cr.evaluate({ pid: 1, startMs: T0 - 12 * 24 * 60 * MIN }, [], { now: T0 });
        expect(r.safeMode).toBe(false);
        expect(r.early).toBe(false);
        expect(r.message).toBe('the previous run was killed after 12 d of uptime — not an early crash; starting normally');
        expect(r.crashes).toEqual([{ start: T0 - 12 * 24 * 60 * MIN, end: T0, early: false }]);
    });

    test('three early crashes in a row within the window enter safe mode, two do not', () => {
        let crashes = [];
        let r = cr.evaluate({ pid: 1, startMs: T0 - 10000 }, crashes, { now: T0 });
        expect(r.safeMode).toBe(false);
        expect(r.message).toContain('early crash 1 of 3');
        crashes = r.crashes;
        r = cr.evaluate({ pid: 2, startMs: T0 + 5000 }, crashes, { now: T0 + 20000 });
        expect(r.safeMode).toBe(false);
        expect(r.message).toContain('early crash 2 of 3');
        crashes = r.crashes;
        r = cr.evaluate({ pid: 3, startMs: T0 + 25000 }, crashes, { now: T0 + 40000 });
        expect(r.safeMode).toBe(true);
        expect(r.reason).toBe('3 crashes within 5 min of start (last 40 s)');
        expect(r.message).toContain('the 3. early crash in a row');
    });

    test('an early crash after a healthy run starts normally; a crash outside the window does not count', () => {
        // two early crashes, then a run of an hour (not early), then an early crash
        let crashes = [
            { start: T0, end: T0 + 10000, early: true },
            { start: T0 + 15000, end: T0 + 25000, early: true },
            { start: T0 + 30000, end: T0 + 60 * MIN, early: false },
        ];
        let r = cr.evaluate({ pid: 9, startMs: T0 + 61 * MIN }, crashes, { now: T0 + 62 * MIN });
        expect(r.safeMode).toBe(false);
        // three early crashes, but the first one 40 minutes ago → outside the 30 min window
        crashes = [
            { start: T0, end: T0 + 10000, early: true },
            { start: T0 + 39 * MIN, end: T0 + 39 * MIN + 10000, early: true },
        ];
        r = cr.evaluate({ pid: 9, startMs: T0 + 40 * MIN }, crashes, { now: T0 + 40 * MIN + 10000 });
        expect(r.safeMode).toBe(false);
        // the same with a wide window → safe mode
        r = cr.evaluate({ pid: 9, startMs: T0 + 40 * MIN }, crashes, { now: T0 + 40 * MIN + 10000, windowSec: 3600 });
        expect(r.safeMode).toBe(true);
        // crashCount 1: any early crash is enough
        r = cr.evaluate({ pid: 9, startMs: T0 }, [], { now: T0 + 1000, crashCount: 1 });
        expect(r.safeMode).toBe(true);
    });

    test('a sentinel from before 2.0 (no start time) counts as early once', () => {
        expect(cr.parseSentinel('1234\n')).toEqual({ pid: 1234, startMs: null });
        expect(cr.parseSentinel('1234 1000000000000')).toEqual({ pid: 1234, startMs: 1000000000000 });
        expect(cr.parseSentinel('garbage')).toEqual({ pid: null, startMs: null });
        expect(cr.formatSentinel(42, 7)).toBe('42 7\n');
        const r = cr.evaluate({ pid: 1234, startMs: null }, [], { now: T0 });
        expect(r.early).toBe(true);
        expect(r.safeMode).toBe(false);
        expect(r.message).toContain('uptime unknown');
    });

    test('the record is read and written, keeps ten entries, and an empty list removes the file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-crash-'));
        const file = path.join(dir, '.she-crashes.json');
        expect(cr.readCrashes(file)).toEqual([]);
        const many = Array.from({ length: 14 }, (_, i) => ({ start: i, end: i + 1, early: true }));
        cr.writeCrashes(file, many);
        expect(cr.readCrashes(file).length).toBe(10);
        expect(cr.readCrashes(file)[0].start).toBe(4);
        fs.writeFileSync(file, 'not json');
        expect(cr.readCrashes(file)).toEqual([]);
        cr.writeCrashes(file, []);
        expect(fs.existsSync(file)).toBe(false);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
