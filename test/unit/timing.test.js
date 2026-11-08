'use strict';

const { createTimingHelpers, subscriptionLimiter } = require('../../src/lib/timing');
const { trackTimeout } = require('../../src/lib/script-timers');

/**
 * What the sandbox gives the helpers: tracked timers in a set, unload hooks, a warn sink. unload()
 * does what unloadScript does — hooks first, then every pending timer is cleared.
 */
function harness() {
    const timers = new Set();
    const hooks = new Set();
    const warn = jest.fn();
    const helpers = createTimingHelpers({
        setTimeout: (fn, ms, meta = {}) => trackTimeout(timers, fn, ms, { warn, kind: meta.kind, name: meta.name }),
        clearTimeout: (id) => {
            timers.delete(id);
            clearTimeout(id);
        },
        onUnload: (fn) => {
            hooks.add(fn);
            return () => hooks.delete(fn);
        },
    });
    const unload = () => {
        for (const hook of hooks) hook();
        hooks.clear();
        timers.forEach((id) => clearTimeout(id));
        timers.clear();
    };
    return { ...helpers, timers, hooks, unload, warn };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('she.debounce', () => {
    it('runs once after the quiet period, with the arguments of the last call', () => {
        const h = harness();
        const fn = jest.fn();
        const d = h.debounce(fn, 300);
        d('a');
        jest.advanceTimersByTime(100);
        d('b');
        jest.advanceTimersByTime(100);
        d('c');
        jest.advanceTimersByTime(299);
        expect(fn).not.toHaveBeenCalled();
        expect(d.pending()).toBe(true);
        jest.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith('c');
        expect(d.pending()).toBe(false);
        expect(h.timers.size).toBe(0);
    });

    it('leading: runs on the first call; a trailing run only when more calls came in', () => {
        const h = harness();
        const fn = jest.fn();
        const d = h.debounce(fn, 300, { leading: true });
        d('one');
        expect(fn).toHaveBeenCalledWith('one');
        jest.advanceTimersByTime(300);
        expect(fn).toHaveBeenCalledTimes(1); // a single call: no trailing run

        d('two');
        expect(fn).toHaveBeenCalledTimes(2);
        d('three');
        jest.advanceTimersByTime(300);
        expect(fn).toHaveBeenCalledTimes(3);
        expect(fn).toHaveBeenLastCalledWith('three');
    });

    it('leading without trailing drops the calls inside the wait', () => {
        const h = harness();
        const fn = jest.fn();
        const d = h.debounce(fn, 300, { leading: true, trailing: false });
        d(1);
        d(2);
        jest.advanceTimersByTime(300);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith(1);
        expect(h.timers.size).toBe(0);
    });

    it('maxWait: constant calls do not starve the callback', () => {
        const h = harness();
        const fn = jest.fn();
        const d = h.debounce(fn, 300, { maxWait: 1000 });
        let n = 0;
        for (let t = 0; t < 2500; t += 100) {
            d(++n);
            jest.advanceTimersByTime(100);
        }
        // first bundle ran at 1000 ms (n = 10 by then), the second at 2000 ms (n = 20)
        expect(fn).toHaveBeenCalledTimes(2);
        expect(fn.mock.calls.map((c) => c[0])).toEqual([10, 20]);
        jest.advanceTimersByTime(300);
        expect(fn).toHaveBeenCalledTimes(3); // the quiet period after the last call
        expect(fn).toHaveBeenLastCalledWith(25);
        expect(h.timers.size).toBe(0);
    });

    it('cancel drops the pending call, flush runs it now', () => {
        const h = harness();
        const fn = jest.fn(() => 'result');
        const d = h.debounce(fn, 300);
        d('x');
        d.cancel();
        expect(d.pending()).toBe(false);
        jest.advanceTimersByTime(1000);
        expect(fn).not.toHaveBeenCalled();
        expect(h.timers.size).toBe(0);

        d('y');
        expect(d.flush()).toBe('result');
        expect(fn).toHaveBeenCalledWith('y');
        jest.advanceTimersByTime(1000);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(d.flush()).toBe('result'); // nothing pending: the last result
    });

    it('an error in fn propagates out of the timer tick and the timer is forgotten', () => {
        const h = harness();
        const d = h.debounce(() => {
            throw new Error('boom');
        }, 100);
        d();
        expect(() => jest.advanceTimersByTime(100)).toThrow('boom');
        expect(h.timers.size).toBe(0);
        expect(d.pending()).toBe(false);
    });

    it('validates its arguments at creation', () => {
        const h = harness();
        expect(() => h.debounce('nope', 100)).toThrow(TypeError);
        expect(() => h.debounce(() => {}, '5')).toThrow(/wait must be a number of milliseconds \(got "5"\)/);
        expect(() => h.debounce(() => {}, undefined)).toThrow(/got undefined/);
        expect(() => h.debounce(() => {}, -1)).toThrow(TypeError);
        expect(() => h.debounce(() => {}, 100, { maxWait: NaN })).toThrow(/opts.maxWait/);
        expect(() => h.debounce(() => {}, 100, { leading: false, trailing: false })).toThrow(/cannot both be false/);
    });

    it('its timers carry the kind and the name for the timer list', () => {
        const h = harness();
        const d = h.debounce(function rebuild() {}, 5000, { maxWait: 15000 });
        d();
        const kinds = [...h.timers].map((t) => `${t.kind}|${t.name}`).sort();
        expect(kinds).toEqual(['debounce maxWait|rebuild', 'debounce|rebuild']);
        const named = h.debounce(() => {}, 100, { name: 'infobox' });
        named();
        expect([...h.timers].some((t) => t.name === 'infobox')).toBe(true);
    });

    it('is cleared by an unload: a pending call never runs', () => {
        const h = harness();
        const fn = jest.fn();
        const d = h.debounce(fn, 300);
        d();
        h.unload();
        jest.advanceTimersByTime(1000);
        expect(fn).not.toHaveBeenCalled();
    });

    it('flushOnUnload runs the pending call once on unload', () => {
        const h = harness();
        const fn = jest.fn();
        const d = h.debounce(fn, 300, { flushOnUnload: true });
        d('last');
        h.unload();
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith('last');
        jest.advanceTimersByTime(1000);
        expect(fn).toHaveBeenCalledTimes(1);

        // nothing pending: the unload runs nothing
        const g = jest.fn();
        const h2 = harness();
        h2.debounce(g, 300, { flushOnUnload: true });
        h2.unload();
        expect(g).not.toHaveBeenCalled();
    });
});

describe('she.debounce.keyed', () => {
    it('keeps a separate state per first argument and forgets idle keys', () => {
        const h = harness();
        const fn = jest.fn();
        const d = h.debounce.keyed(fn, 300);
        d('kitchen', 21);
        jest.advanceTimersByTime(200);
        d('bath', 22);
        d('kitchen', 23);
        expect(d.keys().sort()).toEqual(['bath', 'kitchen']);
        expect(d.pending('kitchen')).toBe(true);
        expect(d.pending('hall')).toBe(false);
        expect(d.pending()).toBe(true);
        jest.advanceTimersByTime(300);
        expect(fn.mock.calls).toEqual([
            ['bath', 22],
            ['kitchen', 23],
        ]);
        expect(d.keys()).toEqual([]);
        expect(d.pending()).toBe(false);
        expect(h.timers.size).toBe(0);
    });

    it('opts.key derives the key, cancel/flush take a key or act on all', () => {
        const h = harness();
        const fn = jest.fn();
        const d = h.debounce.keyed(fn, 300, { key: (topic) => topic.split('/')[1] });
        d('home/a/x', 1);
        d('home/b/x', 2);
        d('home/c/x', 3);
        d.cancel('a');
        expect(d.pending('a')).toBe(false);
        d.flush('b');
        expect(fn).toHaveBeenCalledWith('home/b/x', 2);
        d.cancel();
        jest.advanceTimersByTime(1000);
        expect(fn).toHaveBeenCalledTimes(1);

        d('home/a/x', 4);
        d('home/c/x', 5);
        d.flush();
        expect(fn).toHaveBeenCalledTimes(3);
        expect(h.timers.size).toBe(0);
    });

    it('names the timers after the key and validates at creation', () => {
        const h = harness();
        const d = h.debounce.keyed(() => {}, 300, { name: 'settle' });
        d('kitchen');
        expect([...h.timers][0].name).toBe('settle kitchen');
        const plain = h.debounce.keyed(() => {}, 300);
        plain('bath');
        expect([...h.timers].map((t) => t.name)).toContain('bath');
        expect(() => h.debounce.keyed(() => {}, 'x')).toThrow(TypeError);
        expect(() => h.debounce.keyed(() => {}, 100, { key: 'topic' })).toThrow(/opts.key/);
    });

    it('flushOnUnload flushes every key once', () => {
        const h = harness();
        const fn = jest.fn();
        const d = h.debounce.keyed(fn, 300, { flushOnUnload: true });
        d('a', 1);
        d('b', 2);
        h.unload();
        expect(fn).toHaveBeenCalledTimes(2);
        expect(h.hooks.size).toBe(0);
    });
});

describe('she.throttle', () => {
    it('runs on the first call, then once more with the last arguments when the window ends', () => {
        const h = harness();
        const fn = jest.fn();
        const t = h.throttle(fn, 300);
        t(1);
        expect(fn).toHaveBeenCalledWith(1);
        jest.advanceTimersByTime(100);
        t(2);
        jest.advanceTimersByTime(100);
        t(3);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(t.pending()).toBe(true);
        jest.advanceTimersByTime(100);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(fn).toHaveBeenLastCalledWith(3);
        // the trailing run opened a new window: a call inside it waits for its end
        jest.advanceTimersByTime(50);
        t(4);
        expect(fn).toHaveBeenCalledTimes(2);
        jest.advanceTimersByTime(250);
        expect(fn).toHaveBeenCalledTimes(3);
        expect(fn).toHaveBeenLastCalledWith(4);
        jest.advanceTimersByTime(300);
        expect(h.timers.size).toBe(0);
    });

    it('trailing: false — react at once, then ignore everything for the window', () => {
        const h = harness();
        const fn = jest.fn();
        const t = h.throttle(fn, 60000, { trailing: false });
        t('mail');
        t('mail');
        t('mail');
        jest.advanceTimersByTime(59999);
        t('mail');
        expect(fn).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        expect(h.timers.size).toBe(0);
        t('mail');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('leading: false — the first run waits for the window to end', () => {
        const h = harness();
        const fn = jest.fn();
        const t = h.throttle(fn, 300, { leading: false });
        t(1);
        t(2);
        expect(fn).not.toHaveBeenCalled();
        jest.advanceTimersByTime(300);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith(2);
    });

    it('cancel, flush, pending, validation, kind', () => {
        const h = harness();
        const fn = jest.fn();
        const t = h.throttle(fn, 300, { name: 'mailbox' });
        t(1);
        t(2);
        expect([...h.timers][0]).toMatchObject({ kind: 'throttle', name: 'mailbox' });
        t.cancel();
        expect(t.pending()).toBe(false);
        jest.advanceTimersByTime(300);
        expect(fn).toHaveBeenCalledTimes(1);
        t(3);
        t(4);
        t.flush();
        expect(fn).toHaveBeenLastCalledWith(4);
        expect(h.timers.size).toBe(0);
        expect(() => h.throttle(() => {}, null)).toThrow(TypeError);
        expect(() => h.throttle(() => {}, 100, { leading: false, trailing: false })).toThrow(TypeError);
    });

    it('keyed: one window per key', () => {
        const h = harness();
        const fn = jest.fn();
        const t = h.throttle.keyed(fn, 300);
        t('a', 1);
        t('a', 2);
        t('b', 1);
        expect(fn).toHaveBeenCalledTimes(2);
        jest.advanceTimersByTime(300);
        expect(fn).toHaveBeenCalledTimes(3);
        expect(fn).toHaveBeenLastCalledWith('a', 2);
        jest.advanceTimersByTime(300);
        expect(t.keys()).toEqual([]);
    });
});

describe('she.timeout', () => {
    it('is created idle; restart arms it, another restart starts over, cancel disarms', () => {
        const h = harness();
        const cb = jest.fn();
        const off = h.timeout(1000, cb, { name: 'hall off' });
        expect(off.pending()).toBe(false);
        expect(off.remaining()).toBe(0);
        expect(h.timers.size).toBe(0);

        off.restart();
        expect(off.pending()).toBe(true);
        expect([...h.timers][0]).toMatchObject({ kind: 'timeout', name: 'hall off' });
        jest.advanceTimersByTime(600);
        expect(off.remaining()).toBe(400);
        off.restart();
        jest.advanceTimersByTime(600);
        expect(cb).not.toHaveBeenCalled();
        jest.advanceTimersByTime(400);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(off.pending()).toBe(false);
        expect(h.timers.size).toBe(0);

        off.start();
        off.cancel();
        jest.advanceTimersByTime(2000);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(h.timers.size).toBe(0);
    });

    it('restart(ms) replaces the delay; the callback may re-arm the handle', () => {
        const h = harness();
        let runs = 0;
        const t = h.timeout(1000, () => {
            runs++;
            if (runs < 3) t.restart();
        });
        t.restart(100);
        jest.advanceTimersByTime(100);
        expect(runs).toBe(1);
        expect(t.pending()).toBe(true);
        jest.advanceTimersByTime(200);
        expect(runs).toBe(3);
        expect(t.pending()).toBe(false);
        expect(() => t.restart('5m')).toThrow(TypeError);
        expect(() => h.timeout(undefined, () => {})).toThrow(/ms must be a number of milliseconds/);
        expect(() => h.timeout(10, 'cb')).toThrow(/cb must be a function/);
    });

    it('is cleared by an unload', () => {
        const h = harness();
        const cb = jest.fn();
        h.timeout(100, cb).restart();
        h.unload();
        jest.advanceTimersByTime(1000);
        expect(cb).not.toHaveBeenCalled();
    });
});

describe('she.retry', () => {
    it('resolves with the first success and tells fn the attempt', async () => {
        const h = harness();
        const fn = jest.fn(async (n) => 'ok' + n);
        await expect(h.retry(fn)).resolves.toBe('ok1');
        expect(fn).toHaveBeenCalledWith(1);
        expect(h.hooks.size).toBe(0);
    });

    it('waits delay, then delay·backoff between the attempts', async () => {
        const h = harness();
        let calls = 0;
        const fn = jest.fn(() => {
            calls++;
            if (calls < 3) throw new Error('flaky ' + calls);
            return 'third';
        });
        const p = h.retry(fn, { tries: 3, delay: 1000, backoff: 2, name: 'weather' });
        await jest.advanceTimersByTimeAsync(0);
        expect(fn).toHaveBeenCalledTimes(1);
        expect([...h.timers][0]).toMatchObject({ kind: 'retry', name: 'weather attempt 2/3' });
        await jest.advanceTimersByTimeAsync(999);
        expect(fn).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(fn).toHaveBeenCalledTimes(2);
        expect([...h.timers][0].name).toBe('weather attempt 3/3');
        await jest.advanceTimersByTimeAsync(1999);
        expect(fn).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(1);
        expect(fn).toHaveBeenCalledTimes(3);
        await expect(p).resolves.toBe('third');
        expect(h.timers.size).toBe(0);
        expect(h.hooks.size).toBe(0);
    });

    it('after the last failure: onFail(err, tries) and resolve, or reject without onFail', async () => {
        const h = harness();
        const fail = () => Promise.reject(new Error('down'));
        const onFail = jest.fn(() => 'gave up');
        const p = h.retry(fail, { tries: 2, delay: 10, onFail });
        await jest.advanceTimersByTimeAsync(10);
        await expect(p).resolves.toBe('gave up');
        expect(onFail).toHaveBeenCalledWith(expect.objectContaining({ message: 'down' }), 2);

        const p2 = h.retry(fail, { tries: 2, delay: 10 });
        p2.catch(() => {});
        await jest.advanceTimersByTimeAsync(10);
        await expect(p2).rejects.toThrow('down');
        expect(h.hooks.size).toBe(0);
    });

    it('an unload stops the attempts; the promise never settles', async () => {
        const h = harness();
        const fn = jest.fn(() => Promise.reject(new Error('no')));
        let settled = false;
        h.retry(fn, { tries: 5, delay: 1000 }).then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await jest.advanceTimersByTimeAsync(0);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(h.hooks.size).toBe(1);
        h.unload();
        await jest.advanceTimersByTimeAsync(10000);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);
    });

    it('validates its options', () => {
        const h = harness();
        expect(() => h.retry('fn')).toThrow(TypeError);
        expect(() => h.retry(() => {}, { tries: 0 })).toThrow(/opts.tries/);
        expect(() => h.retry(() => {}, { tries: 2.5 })).toThrow(/opts.tries/);
        expect(() => h.retry(() => {}, { delay: '60s' })).toThrow(/opts.delay/);
        expect(() => h.retry(() => {}, { backoff: -1 })).toThrow(/opts.backoff/);
        expect(() => h.retry(() => {}, { onFail: 'log' })).toThrow(/opts.onFail/);
    });
});

describe('subscriptionLimiter (sub options debounce, maxWait, throttle, perTopic)', () => {
    const ev = (topic, val, prevVal, msg = { topic }) => [topic, val, { val, ts: Date.now() }, { val: prevVal }, msg];

    it('returns null without debounce or throttle and rejects half options', () => {
        const h = harness();
        const deliver = jest.fn();
        expect(subscriptionLimiter({ change: true }, deliver, h, 'a')).toBeNull();
        expect(() => subscriptionLimiter({ maxWait: 5 }, deliver, h, 'a')).toThrow(/opts.maxWait needs opts.debounce/);
        expect(() => subscriptionLimiter({ debounce: 1, throttle: 1 }, deliver, h, 'a')).toThrow(/exclude each other/);
        expect(() => subscriptionLimiter({ throttle: 1, maxWait: 1 }, deliver, h, 'a')).toThrow(/opts.maxWait needs opts.debounce/);
        expect(() => subscriptionLimiter({ debounce: '5' }, deliver, h, 'a')).toThrow(/opts.debounce must be a number of seconds \(got "5"\)/);
        expect(() => subscriptionLimiter({ throttle: -1 }, deliver, h, 'a')).toThrow(/opts.throttle/);
    });

    it('debounce (seconds): the last event, with objPrev from before the first bundled event', () => {
        const h = harness();
        const deliver = jest.fn();
        const limited = subscriptionLimiter({ debounce: 5, maxWait: 15 }, deliver, h, 'home/+/temp');
        limited(...ev('home/a/temp', 20, 19));
        jest.advanceTimersByTime(2000);
        limited(...ev('home/b/temp', 21, 20.5));
        jest.advanceTimersByTime(2000);
        const last = ev('home/a/temp', 22, 20);
        limited(...last);
        expect(deliver).not.toHaveBeenCalled();
        expect([...h.timers].map((t) => `${t.kind}|${t.name}`).sort()).toEqual(['debounce maxWait|home/+/temp', 'debounce|home/+/temp']);
        jest.advanceTimersByTime(5000);
        expect(deliver).toHaveBeenCalledTimes(1);
        const [topic, val, obj, objPrev, msg] = deliver.mock.calls[0];
        expect([topic, val, obj]).toEqual(['home/a/temp', 22, last[2]]);
        expect(objPrev).toEqual({ val: 19 }); // before the first event of the bundle
        expect(msg).toBe(last[4]);

        // the next bundle starts fresh
        limited(...ev('home/a/temp', 23, 22));
        jest.advanceTimersByTime(5000);
        expect(deliver.mock.calls[1][3]).toEqual({ val: 22 });
    });

    it('perTopic keeps a bundle per topic', () => {
        const h = harness();
        const deliver = jest.fn();
        const limited = subscriptionLimiter({ debounce: 1, perTopic: true, name: 'settle' }, deliver, h, 'home/#');
        limited(...ev('home/a', 1, 0));
        limited(...ev('home/b', 10, 9));
        jest.advanceTimersByTime(500);
        limited(...ev('home/a', 2, 1));
        jest.advanceTimersByTime(500);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliver.mock.calls[0].slice(0, 2)).toEqual(['home/b', 10]);
        expect([...h.timers][0].name).toBe('settle home/a');
        jest.advanceTimersByTime(500);
        expect(deliver).toHaveBeenCalledTimes(2);
        expect(deliver.mock.calls[1][1]).toBe(2);
        expect(deliver.mock.calls[1][3]).toEqual({ val: 0 });
    });

    it('throttle (seconds): the first event at once, then one per window with the last values', () => {
        const h = harness();
        const deliver = jest.fn();
        const limited = subscriptionLimiter({ throttle: 60 }, deliver, h, 'mailbox/flap');
        limited(...ev('mailbox/flap', 1, 0));
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliver.mock.calls[0][3]).toEqual({ val: 0 });
        limited(...ev('mailbox/flap', 0, 1));
        limited(...ev('mailbox/flap', 1, 0));
        jest.advanceTimersByTime(59999);
        expect(deliver).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        expect(deliver).toHaveBeenCalledTimes(2);
        expect(deliver.mock.calls[1][1]).toBe(1);
        expect(deliver.mock.calls[1][3]).toEqual({ val: 1 }); // before the first bundled event after the leading one
        expect([...h.timers][0]).toMatchObject({ kind: 'throttle', name: 'mailbox/flap' });
    });

    it('an unload drops a pending bundle; flushOnUnload delivers it', () => {
        const h = harness();
        const deliver = jest.fn();
        subscriptionLimiter({ debounce: 5 }, deliver, h, 'a')(...ev('a', 1, 0));
        h.unload();
        jest.advanceTimersByTime(10000);
        expect(deliver).not.toHaveBeenCalled();

        const h2 = harness();
        const deliver2 = jest.fn();
        subscriptionLimiter({ debounce: 5, flushOnUnload: true }, deliver2, h2, 'a')(...ev('a', 1, 0));
        h2.unload();
        expect(deliver2).toHaveBeenCalledTimes(1);
    });
});
