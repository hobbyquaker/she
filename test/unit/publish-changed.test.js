'use strict';

const { isRepeat, remember, CAP } = require('../../src/lib/publish-changed');

describe('pub({ changed: true })', () => {
    const storeOf = (entries) => (topic) => entries[topic];

    it('compares with what the script last published to the topic', () => {
        const last = new Map();
        const lookup = storeOf({});
        expect(isRepeat(last, 'home/set/light', '1', lookup)).toBe(false);
        remember(last, 'home/set/light', '1');
        expect(isRepeat(last, 'home/set/light', '1', lookup)).toBe(true);
        expect(isRepeat(last, 'home/set/light', '0', lookup)).toBe(false);
        remember(last, 'home/set/light', '0');
        expect(isRepeat(last, 'home/set/light', '0', lookup)).toBe(true);
        expect(isRepeat(last, 'home/set/light', '1', lookup)).toBe(false);
    });

    it('before the first publish compares with the state store — by value, not by string', () => {
        const last = new Map();
        const lookup = storeOf({ 'home/status/temp': { val: 21.5 }, 'home/status/list': { val: [1, 2] } });
        expect(isRepeat(last, 'home/status/temp', '21.5', lookup)).toBe(true);
        expect(isRepeat(last, 'home/status/temp', '21.50', lookup)).toBe(true);
        expect(isRepeat(last, 'home/status/temp', '22', lookup)).toBe(false);
        expect(isRepeat(last, 'home/status/list', '[1,2]', lookup)).toBe(true);
        expect(isRepeat(last, 'home/status/list', '{"val":[1,2],"ts":5}', lookup)).toBe(true);
        expect(isRepeat(last, 'home/status/unknown', 'x', lookup)).toBe(false);
    });

    it('a command topic falls back to its status sibling (variables, mqtt-smarthome adapters)', () => {
        const last = new Map();
        const lookup = storeOf({ 'var/status/Infobox': { val: '<b>hi</b>' }, 'hm/status/Lamp/STATE': { val: true } });
        expect(isRepeat(last, 'var/set/Infobox', '<b>hi</b>', lookup)).toBe(true);
        expect(isRepeat(last, 'var/set/Infobox', '<b>ho</b>', lookup)).toBe(false);
        expect(isRepeat(last, 'hm/set/Lamp/STATE', 'true', lookup)).toBe(true);
        expect(isRepeat(last, 'hm/set/Lamp/STATE', 'false', lookup)).toBe(false);
        // the script's own last payload wins over the store once there is one
        remember(last, 'var/set/Infobox', '<b>ho</b>');
        expect(isRepeat(last, 'var/set/Infobox', '<b>hi</b>', lookup)).toBe(false);
        expect(isRepeat(last, 'var/set/Infobox', '<b>ho</b>', lookup)).toBe(true);
    });

    it('remembers at most CAP topics per script, known topics always', () => {
        const last = new Map();
        for (let i = 0; i < CAP + 50; i++) remember(last, 't/' + i, 'v');
        expect(last.size).toBe(CAP);
        remember(last, 't/0', 'w');
        expect(last.get('t/0')).toBe('w');
        expect(last.has('t/' + (CAP + 10))).toBe(false);
    });
});
