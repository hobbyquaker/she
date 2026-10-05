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
