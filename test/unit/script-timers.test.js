'use strict';

const { trackTimeout } = require('../../src/lib/script-timers');

describe('trackTimeout()', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('tracks a pending timeout and forgets it once it has fired', () => {
        const timers = new Set();
        const fn = jest.fn();
        const id = trackTimeout(timers, fn, 1000);
        expect(timers.has(id)).toBe(true);
        expect(id.due).toBeGreaterThanOrEqual(Date.now() + 999); // for list_timers

        jest.advanceTimersByTime(1000);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(timers.size).toBe(0);
    });

    it('does not accumulate timeouts that fired', () => {
        const timers = new Set();
        for (let i = 0; i < 500; i++) trackTimeout(timers, () => {}, 10);
        expect(timers.size).toBe(500);
        jest.advanceTimersByTime(10);
        expect(timers.size).toBe(0);
    });

    it('forgets the timeout even when the callback throws', () => {
        const timers = new Set();
        trackTimeout(
            timers,
            () => {
                throw new Error('script error');
            },
            5,
        );
        expect(() => jest.advanceTimersByTime(5)).toThrow('script error');
        expect(timers.size).toBe(0);
    });

    it('lets an unload clear what is still pending', () => {
        const timers = new Set();
        const fired = jest.fn();
        const pending = jest.fn();
        trackTimeout(timers, fired, 10);
        trackTimeout(timers, pending, 60000);
        jest.advanceTimersByTime(10);
        expect(timers.size).toBe(1);

        // what unloadScript() does with the set
        timers.forEach((id) => clearTimeout(id));
        jest.advanceTimersByTime(60000);
        expect(fired).toHaveBeenCalledTimes(1);
        expect(pending).not.toHaveBeenCalled();
    });

    it('passes the delay to setTimeout', () => {
        const calls = [];
        const fake = (cb, delay) => {
            calls.push(delay);
            return { id: calls.length };
        };
        trackTimeout(new Set(), () => {}, 4321, fake);
        expect(calls).toEqual([4321]);
    });
});

describe('trackTimeout() delay validation', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it.each([
        [NaN, 'NaN'],
        ['300000', '"300000"'],
        [undefined, 'undefined'],
        [null, 'null'],
        [-5, '-5'],
        [Infinity, 'Infinity'],
        [{ ms: 5 }, 'an object'],
    ])('reports %p through warn and fires at once instead of in 1 ms', (delay, shown) => {
        const timers = new Set();
        const fn = jest.fn();
        const warn = jest.fn();
        trackTimeout(timers, fn, delay, { warn, api: 'she.setTimeout' });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(`she.setTimeout: delay is not a number of milliseconds (got ${shown}), using 0`);
        jest.advanceTimersByTime(0);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(timers.size).toBe(0);
    });

    it('accepts 0 and positive numbers silently', () => {
        const warn = jest.fn();
        trackTimeout(new Set(), () => {}, 0, { warn });
        trackTimeout(new Set(), () => {}, 2.5, { warn });
        expect(warn).not.toHaveBeenCalled();
    });

    it('tags the timer with kind and name for the timer list', () => {
        const id = trackTimeout(new Set(), () => {}, 100, { kind: 'debounce', name: 'infobox' });
        expect(id).toMatchObject({ kind: 'debounce', name: 'infobox' });
        const plain = trackTimeout(new Set(), () => {}, 100);
        expect(plain.kind).toBeUndefined();
    });

    it('emits no TimeoutNaNWarning from Node for an invalid delay', async () => {
        jest.useRealTimers();
        const warnings = [];
        const onWarning = (w) => warnings.push(w.name);
        process.on('warning', onWarning);
        try {
            const timers = new Set();
            await new Promise((resolve) => trackTimeout(timers, resolve, NaN, { warn: () => {} }));
            await new Promise((resolve) => setImmediate(resolve));
            expect(warnings).toEqual([]);
        } finally {
            process.removeListener('warning', onWarning);
        }
    });
});

describe('isValidDelay()', () => {
    const { isValidDelay } = require('../../src/lib/script-timers');
    it('is true for finite non-negative numbers only', () => {
        expect(isValidDelay(0)).toBe(true);
        expect(isValidDelay(1500)).toBe(true);
        expect(isValidDelay(-1)).toBe(false);
        expect(isValidDelay(NaN)).toBe(false);
        expect(isValidDelay('5')).toBe(false);
        expect(isValidDelay(undefined)).toBe(false);
    });
});
