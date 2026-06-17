'use strict';

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
    };
    installStdlib(she);
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

describe('age()', () => {
    it('returns seconds since last change', () => {
        const lc = Date.now() - 5000;
        const she = makeShe({ 'test/topic': { val: 1, lc } });
        const a = she.age('test/topic');
        expect(a).toBeGreaterThanOrEqual(4);
        expect(a).toBeLessThanOrEqual(6);
    });
});

describe('link()', () => {
    it('subscribes source and publishes its value to target', () => {
        const she = makeShe();
        she.link('src/topic', 'dst/topic');
        expect(she.mqttsub).toHaveBeenCalledWith('src/topic', expect.any(Function));
        const cb = she.mqttsub.mock.calls[0][1];
        cb('src/topic', 42);
        expect(she.setValue).toHaveBeenCalledWith('dst/topic', 42);
    });

    it('publishes a fixed value when value arg provided', () => {
        const she = makeShe();
        she.link('src/topic', 'dst/topic', 99);
        const cb = she.mqttsub.mock.calls[0][1];
        cb('src/topic', 1);
        expect(she.setValue).toHaveBeenCalledWith('dst/topic', 99);
    });

    it('transforms value through function when function arg provided', () => {
        const she = makeShe();
        she.link('src/topic', 'dst/topic', (v) => v * 2);
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
