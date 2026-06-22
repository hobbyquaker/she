'use strict';

jest.mock('../../src/web/server');
const { registerRoute } = require('../../src/web/server');

const installStdlib = require('../../src/sandbox/stdlib');

function makeShe(state = {}) {
    const she = {
        _state: { ...state },
        getValue: jest.fn((topic) => she._state[topic]?.val),
        setValue: jest.fn((topic, val) => {
            she._state[topic] = { val, lc: Date.now() };
        }),
        getProp: jest.fn((topic, prop) => she._state[topic]?.[prop]),
        mqttsub: jest.fn(),
        setTimeout: jest.fn((fn, ms) => setTimeout(fn, ms)),
        clearTimeout: jest.fn((id) => clearTimeout(id)),
    };
    installStdlib(she);
    return she;
}

function makeSheWithCtx(state = {}, ctx = {}) {
    const she = {
        _state: { ...state },
        getValue: jest.fn((topic) => she._state[topic]?.val),
        setValue: jest.fn((topic, val) => {
            she._state[topic] = { val, lc: Date.now() };
        }),
        getProp: jest.fn((topic, prop) => she._state[topic]?.[prop]),
        mqttsub: jest.fn(),
        setTimeout: jest.fn((fn, ms) => setTimeout(fn, ms)),
        clearTimeout: jest.fn((id) => clearTimeout(id)),
    };
    installStdlib(she, ctx);
    return she;
}

describe('now()', () => {
    it('returns a number close to Date.now()', () => {
        const she = makeShe();
        const before = Date.now();
        const result = she.now();
        const after = Date.now();
        expect(result).toBeGreaterThanOrEqual(before);
        expect(result).toBeLessThanOrEqual(after);
    });
});

describe('she.mqtt.age()', () => {
    it('returns seconds since last change', () => {
        const lc = Date.now() - 5000;
        const she = makeShe({ 'test/topic': { val: 1, lc } });
        const a = she.mqtt.age('test/topic');
        expect(a).toBeGreaterThanOrEqual(4);
        expect(a).toBeLessThanOrEqual(6);
    });
});

describe('she.mqtt.link()', () => {
    it('subscribes source and publishes its value to target', () => {
        const she = makeShe();
        she.mqtt.link('src/topic', 'dst/topic');
        expect(she.mqttsub).toHaveBeenCalledWith('src/topic', expect.any(Function));
        const cb = she.mqttsub.mock.calls[0][1];
        cb('src/topic', 42);
        expect(she.setValue).toHaveBeenCalledWith('dst/topic', 42);
    });

    it('publishes a fixed value when value arg provided', () => {
        const she = makeShe();
        she.mqtt.link('src/topic', 'dst/topic', 99);
        const cb = she.mqttsub.mock.calls[0][1];
        cb('src/topic', 1);
        expect(she.setValue).toHaveBeenCalledWith('dst/topic', 99);
    });

    it('transforms value through function when function arg provided', () => {
        const she = makeShe();
        she.mqtt.link('src/topic', 'dst/topic', (v) => v * 2);
        const cb = she.mqttsub.mock.calls[0][1];
        cb('src/topic', 5);
        expect(she.setValue).toHaveBeenCalledWith('dst/topic', 10);
    });
});

describe('she.mqtt.and()', () => {
    it('publishes 1 when all sources are truthy', () => {
        const she = makeShe({ a: { val: 1 }, b: { val: 1 } });
        she.mqtt.and(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 1);
    });

    it('publishes 0 when any source is falsy', () => {
        const she = makeShe({ a: { val: 1 }, b: { val: 0 } });
        she.mqtt.and(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 0);
    });

    it('treats "off" as falsy', () => {
        const she = makeShe({ a: { val: 1 }, b: { val: 'off' } });
        she.mqtt.and(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 0);
    });

    it('treats "OFF" as falsy', () => {
        const she = makeShe({ a: { val: 1 }, b: { val: 'OFF' } });
        she.mqtt.and(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 0);
    });

    it('treats "ON" as truthy', () => {
        const she = makeShe({ a: { val: 'ON' }, b: { val: 'ON' } });
        she.mqtt.and(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 1);
    });

    it('re-publishes when sources change', () => {
        const she = makeShe({ a: { val: 1 }, b: { val: 0 } });
        she.mqtt.and(['a', 'b'], 'result');
        const cb = she.mqttsub.mock.calls[0][2];
        she._state.b = { val: 1 };
        cb('b');
        expect(she.setValue).toHaveBeenLastCalledWith('result', 1);
    });

    it('calls callback(topic, result) when a source changes', () => {
        const she = makeShe({ a: { val: 1 }, b: { val: 1 } });
        const cb = jest.fn();
        she.mqtt.and(['a', 'b'], cb);
        cb.mockClear();
        const subCb = she.mqttsub.mock.calls[0][2];
        she._state.b = { val: 0 };
        subCb('b');
        expect(cb).toHaveBeenCalledWith('b', 0);
    });
});

describe('she.mqtt.and()', () => {
    it('publishes 1 when all sources are truthy', () => {
        const she = makeShe({ a: { val: 1 }, b: { val: 1 } });
        she.mqtt.and(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 1);
    });

    it('publishes 0 when any source is falsy', () => {
        const she = makeShe({ a: { val: 1 }, b: { val: 0 } });
        she.mqtt.and(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 0);
    });

    it('re-publishes when sources change', () => {
        const she = makeShe({ a: { val: 1 }, b: { val: 0 } });
        she.mqtt.and(['a', 'b'], 'result');
        const cb = she.mqttsub.mock.calls[0][2];
        she._state.b = { val: 1 };
        cb('b');
        expect(she.setValue).toHaveBeenLastCalledWith('result', 1);
    });

    it('calls callback(topic, result) when a source changes', () => {
        const she = makeShe({ a: { val: 1 }, b: { val: 1 } });
        const cb = jest.fn();
        she.mqtt.and(['a', 'b'], cb);
        cb.mockClear();
        const subCb = she.mqttsub.mock.calls[0][2];
        she._state.b = { val: 0 };
        subCb('b');
        expect(cb).toHaveBeenCalledWith('b', 0);
    });
});

describe('she.mqtt.or()', () => {
    it('publishes 1 when any source is truthy', () => {
        const she = makeShe({ a: { val: 0 }, b: { val: 1 } });
        she.mqtt.or(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 1);
    });

    it('publishes 0 when all sources are falsy', () => {
        const she = makeShe({ a: { val: 0 }, b: { val: 0 } });
        she.mqtt.or(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 0);
    });

    it('treats "off" as falsy', () => {
        const she = makeShe({ a: { val: 'off' }, b: { val: 'OFF' } });
        she.mqtt.or(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 0);
    });

    it('treats "ON" as truthy', () => {
        const she = makeShe({ a: { val: 'off' }, b: { val: 'ON' } });
        she.mqtt.or(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 1);
    });

    it('re-publishes when a subscribed topic changes to truthy', () => {
        const she = makeShe({ a: { val: 0 }, b: { val: 0 } });
        she.mqtt.or(['a', 'b'], 'result');
        const cb = she.mqttsub.mock.calls[0][2];
        she._state.a = { val: 1, lc: Date.now() };
        cb('a');
        expect(she.setValue).toHaveBeenLastCalledWith('result', 1);
    });

    it('re-publishes 0 when a subscribed topic changes to falsy', () => {
        const she = makeShe({ a: { val: 1 }, b: { val: 0 } });
        she.mqtt.or(['a', 'b'], 'result');
        const cb = she.mqttsub.mock.calls[0][2];
        she._state.a = { val: 0, lc: Date.now() };
        cb('a');
        expect(she.setValue).toHaveBeenLastCalledWith('result', 0);
    });

    it('calls callback(null, result) on initial evaluation', () => {
        const she = makeShe({ a: { val: 1 } });
        const cb = jest.fn();
        she.mqtt.or(['a'], cb);
        expect(cb).toHaveBeenCalledWith(null, 1);
    });

    it('calls callback(topic, result) when a source changes', () => {
        const she = makeShe({ a: { val: 0 } });
        const cb = jest.fn();
        she.mqtt.or(['a'], cb);
        cb.mockClear();
        const subCb = she.mqttsub.mock.calls[0][2];
        she._state.a = { val: 1 };
        subCb('a');
        expect(cb).toHaveBeenCalledWith('a', 1);
    });
});

describe('she.mqtt.max()', () => {
    it('publishes the maximum value across sources', () => {
        const she = makeShe({ a: { val: 3 }, b: { val: 7 }, c: { val: 2 } });
        she.mqtt.max(['a', 'b', 'c'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 7);
    });

    it('publishes 0 when all sources are 0', () => {
        const she = makeShe({ a: { val: 0 }, b: { val: 0 } });
        she.mqtt.max(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 0);
    });

    it('re-publishes when a subscribed topic changes to a new maximum', () => {
        const she = makeShe({ a: { val: 3 }, b: { val: 7 } });
        she.mqtt.max(['a', 'b'], 'result');
        const cb = she.mqttsub.mock.calls[0][2];
        she._state.a = { val: 10, lc: Date.now() };
        cb('a');
        expect(she.setValue).toHaveBeenLastCalledWith('result', 10);
    });

    it('re-publishes the remaining max when a top value decreases', () => {
        const she = makeShe({ a: { val: 10 }, b: { val: 7 } });
        she.mqtt.max(['a', 'b'], 'result');
        const cb = she.mqttsub.mock.calls[0][2];
        she._state.a = { val: 2, lc: Date.now() };
        cb('a');
        expect(she.setValue).toHaveBeenLastCalledWith('result', 7);
    });

    it('calls callback(topic, result) when a source changes', () => {
        const she = makeShe({ a: { val: 3 }, b: { val: 7 } });
        const cb = jest.fn();
        she.mqtt.max(['a', 'b'], cb);
        cb.mockClear();
        const subCb = she.mqttsub.mock.calls[0][2];
        she._state.a = { val: 10 };
        subCb('a');
        expect(cb).toHaveBeenCalledWith('a', 10);
    });
});

describe('she.mqtt.min()', () => {
    it('publishes the minimum value across sources', () => {
        const she = makeShe({ a: { val: 3 }, b: { val: 7 }, c: { val: 1 } });
        she.mqtt.min(['a', 'b', 'c'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 1);
    });

    it('publishes 0 when all sources are undefined', () => {
        const she = makeShe({});
        she.mqtt.min(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 0);
    });

    it('re-publishes the new minimum when a source decreases', () => {
        const she = makeShe({ a: { val: 3 }, b: { val: 7 } });
        she.mqtt.min(['a', 'b'], 'result');
        const cb = she.mqttsub.mock.calls[0][2];
        she._state.b = { val: 1 };
        cb('b');
        expect(she.setValue).toHaveBeenLastCalledWith('result', 1);
    });

    it('calls callback(topic, result) when a source changes', () => {
        const she = makeShe({ a: { val: 5 }, b: { val: 8 } });
        const cb = jest.fn();
        she.mqtt.min(['a', 'b'], cb);
        cb.mockClear();
        const subCb = she.mqttsub.mock.calls[0][2];
        she._state.a = { val: 2 };
        subCb('a');
        expect(cb).toHaveBeenCalledWith('a', 2);
    });
});

describe('she.mqtt.timer()', () => {
    it('subscribes to src and publishes 1 to target when src goes truthy', () => {
        const she = makeShe({ 'home/motion': { val: 0 } });
        she.mqtt.timer('home/motion', 5000, 'home/light');
        const subCb = she.mqttsub.mock.calls[0][2];
        subCb('home/motion', 1);
        expect(she.setValue).toHaveBeenCalledWith('home/light', 1);
    });

    it('does not publish 1 when src is falsy', () => {
        const she = makeShe();
        she.mqtt.timer('home/motion', 5000, 'home/light');
        she.setValue.mockClear();
        const subCb = she.mqttsub.mock.calls[0][2];
        subCb('home/motion', 0);
        expect(she.setValue).not.toHaveBeenCalledWith('home/light', 1);
    });

    it('does not publish 1 when src is "off"', () => {
        const she = makeShe();
        she.mqtt.timer('home/motion', 5000, 'home/light');
        she.setValue.mockClear();
        const subCb = she.mqttsub.mock.calls[0][2];
        subCb('home/motion', 'off');
        expect(she.setValue).not.toHaveBeenCalledWith('home/light', 1);
    });

    it('does not publish 1 when src is "OFF"', () => {
        const she = makeShe();
        she.mqtt.timer('home/motion', 5000, 'home/light');
        she.setValue.mockClear();
        const subCb = she.mqttsub.mock.calls[0][2];
        subCb('home/motion', 'OFF');
        expect(she.setValue).not.toHaveBeenCalledWith('home/light', 1);
    });

    it('calls callback(topic, 1) when src goes truthy', () => {
        const she = makeShe();
        const cb = jest.fn();
        she.mqtt.timer('home/motion', 5000, cb);
        const subCb = she.mqttsub.mock.calls[0][2];
        subCb('home/motion', 1);
        expect(cb).toHaveBeenCalledWith('home/motion', 1);
    });

    it('does not set an initial cleanup timeout for callback targets', () => {
        const she = makeShe();
        const cb = jest.fn();
        she.mqtt.timer('home/motion', 5000, cb);
        // Only the src subscription should be registered; no initial setTimeout
        expect(she.setTimeout).not.toHaveBeenCalled();
    });

    it('sets an initial cleanup timeout for topic targets', () => {
        const she = makeShe({ 'home/light': { val: 1 } });
        she.mqtt.timer('home/motion', 5000, 'home/light');
        expect(she.setTimeout).toHaveBeenCalled();
    });
});

// ── she.mqtt.link() — array sources and targets ─────────────────────────────

describe('she.mqtt.link() — array sources and targets', () => {
    it('passes array source directly to mqttsub', () => {
        const she = makeShe();
        she.mqtt.link(['src/a', 'src/b'], 'dst/out');
        // link() forwards the array to mqttsub verbatim; the MQTT client handles multi-subscribe
        expect(she.mqttsub).toHaveBeenCalledWith(['src/a', 'src/b'], expect.any(Function));
    });

    it('passes array target directly to setValue when source fires', () => {
        const she = makeShe();
        she.mqtt.link('src/in', ['dst/x', 'dst/y']);
        const cb = she.mqttsub.mock.calls[0][1];
        cb('src/in', 7);
        // link() forwards the array to setValue verbatim
        expect(she.setValue).toHaveBeenCalledWith(['dst/x', 'dst/y'], 7);
    });

    it('applies a transform and passes array target to setValue', () => {
        const she = makeShe();
        she.mqtt.link('src/in', ['dst/x', 'dst/y'], (v) => v + 1);
        const cb = she.mqttsub.mock.calls[0][1];
        cb('src/in', 3);
        expect(she.setValue).toHaveBeenCalledWith(['dst/x', 'dst/y'], 4);
    });
});

// ── she.http.fetch() ─────────────────────────────────────────────────────────

function mockFetchResponse({ ok = true, status = 200, statusText = 'OK', contentType = 'text/plain', body = '' } = {}) {
    const hdrs = new Map([['content-type', contentType]]);
    return {
        ok,
        status,
        statusText,
        headers: {
            get: (k) => hdrs.get(k) ?? null,
            forEach: (fn) => hdrs.forEach((v, k) => fn(v, k)),
        },
        json: async () => (typeof body === 'object' ? body : JSON.parse(body)),
        text: async () => String(body ?? ''),
    };
}

describe('she.http.fetch()', () => {
    let she;

    beforeEach(() => {
        global.fetch = jest.fn();
        she = makeShe();
    });

    afterEach(() => {
        delete global.fetch;
    });

    it('returns parsed JSON body when Content-Type is application/json', async () => {
        global.fetch.mockResolvedValue(mockFetchResponse({ contentType: 'application/json', body: { x: 1 } }));
        const res = await she.http.fetch('http://example.com/api');
        expect(res.body).toEqual({ x: 1 });
        expect(res.code).toBe(200);
    });

    it('returns text body when Content-Type is text/plain', async () => {
        global.fetch.mockResolvedValue(mockFetchResponse({ contentType: 'text/plain', body: 'hello world' }));
        const res = await she.http.fetch('http://example.com');
        expect(res.body).toBe('hello world');
    });

    it('throws on non-2xx status with code attached to error', async () => {
        global.fetch.mockResolvedValue(mockFetchResponse({ ok: false, status: 404, statusText: 'Not Found', body: 'no' }));
        await expect(she.http.fetch('http://example.com')).rejects.toMatchObject({
            message: expect.stringContaining('404'),
            code: 404,
        });
    });

    it('calls callback(null, res) on success', (done) => {
        global.fetch.mockResolvedValue(mockFetchResponse({ body: 'ok' }));
        she.http.fetch('http://example.com', (err, res) => {
            expect(err).toBeNull();
            expect(res.code).toBe(200);
            done();
        });
    });

    it('calls callback(err, null) on network failure', (done) => {
        global.fetch.mockRejectedValue(new Error('network error'));
        she.http.fetch('http://example.com', (err) => {
            expect(err).toBeInstanceOf(Error);
            expect(err.message).toMatch('network error');
            done();
        });
    });

    it('aborts the request and rejects with timeout error after 30 s', async () => {
        jest.useFakeTimers();
        global.fetch.mockImplementation((_url, { signal }) => {
            return new Promise((_, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason));
            });
        });
        const p = she.http.fetch('http://example.com/slow');
        jest.advanceTimersByTime(30_000);
        await expect(p).rejects.toThrow(/timed out/);
        jest.useRealTimers();
    });
});

// ── she.http.sub() ───────────────────────────────────────────────────────────

function mockRes() {
    const res = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
}

describe('she.http.sub()', () => {
    beforeEach(() => registerRoute.mockClear());

    it('throws TypeError when path is not a string', () => {
        const she = makeSheWithCtx({}, { scriptName: 's' });
        expect(() => she.http.sub(123, () => {})).toThrow(TypeError);
    });

    it('throws TypeError when callback is not a function', () => {
        const she = makeSheWithCtx({}, { scriptName: 's' });
        expect(() => she.http.sub('/hook', 'notafn')).toThrow(TypeError);
    });

    it('registers a POST route at /api/<scriptName><path>', () => {
        const she = makeSheWithCtx({}, { scriptName: 'myscript' });
        she.http.sub('/webhook', () => {});
        expect(registerRoute).toHaveBeenCalledWith('post', '/api/myscript/webhook', expect.any(Function));
    });

    it('responds { ok: true } (200) when callback resolves', async () => {
        const she = makeSheWithCtx({}, { scriptName: 's' });
        she.http.sub('/hook', () => 'ignored');
        const handler = registerRoute.mock.calls[0][2];
        const req = { body: { v: 1 }, params: {}, query: {}, headers: {} };
        const res = mockRes();
        handler(req, res);
        await new Promise((r) => setTimeout(r, 10));
        expect(res.json).toHaveBeenCalledWith({ ok: true });
    });

    it('responds { error } (500) when callback throws synchronously', () => {
        const she = makeSheWithCtx({}, { scriptName: 's' });
        she.http.sub('/throw', () => {
            throw new Error('boom');
        });
        const handler = registerRoute.mock.calls[0][2];
        const req = { body: {}, params: {}, query: {}, headers: {} };
        const res = mockRes();
        handler(req, res);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'boom' });
    });

    it('responds { error } (500) when callback returns a rejected promise', async () => {
        const she = makeSheWithCtx({}, { scriptName: 's' });
        she.http.sub('/async-throw', async () => {
            throw new Error('async boom');
        });
        const handler = registerRoute.mock.calls[0][2];
        const req = { body: {}, params: {}, query: {}, headers: {} };
        const res = mockRes();
        handler(req, res);
        await new Promise((r) => setTimeout(r, 10));
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'async boom' });
    });

    it('passes body and context to the callback', () => {
        const cb = jest.fn(() => 'ok');
        const she = makeSheWithCtx({}, { scriptName: 's' });
        she.http.sub('/data', cb);
        const handler = registerRoute.mock.calls[0][2];
        const req = { body: { key: 'val' }, params: { id: '1' }, query: { q: 'x' }, headers: { 'x-foo': 'bar' } };
        handler(req, mockRes());
        expect(cb).toHaveBeenCalledWith({ key: 'val' }, { params: { id: '1' }, query: { q: 'x' }, headers: { 'x-foo': 'bar' } });
    });
});
