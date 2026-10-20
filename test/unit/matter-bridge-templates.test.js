'use strict';

/**
 * Unit tests for src/matter/bridge-templates.js (roadmap M19): template fill, pattern and match
 * (with ${device} as name or node ID, an empty template = off), validation, the payload formats,
 * name sanitising and uniqueness, the deny-list and the set → command/write resolution.
 */

const t = require('../../src/matter/bridge-templates');

describe('bridge templates', () => {
    test('fill, pattern and match round-trip under the defaults', () => {
        const vars = { device: 'bad_licht', nodeId: '4', endpoint: '1', cluster: 'on_off', attribute: 'on_off', event: 'initial_press', attributeOrCommand: 'on_off' };
        expect(t.fill(t.DEFAULT_TEMPLATES.attribute, vars)).toBe('matter/status/bad_licht/1/on_off/on_off');
        expect(t.fill(t.DEFAULT_TEMPLATES.online, vars)).toBe('matter/status/bad_licht/online');
        expect(t.toPattern(t.DEFAULT_TEMPLATES.set)).toBe('matter/set/+/+/+/#');
        expect(t.toPattern(t.DEFAULT_TEMPLATES.online)).toBe('matter/status/+/online');
        expect(t.toPattern('x/${device}_suffix/y')).toBe('x/+/y');
        expect(t.match(t.DEFAULT_TEMPLATES.set, 'matter/set/bad_licht/1/on_off/on_off')).toEqual({
            device: 'bad_licht',
            endpoint: '1',
            cluster: 'on_off',
            attributeOrCommand: 'on_off',
        });
        // the node id works where the name does — the bridge resolves either
        expect(t.match(t.DEFAULT_TEMPLATES.set, 'matter/set/4/1/level_control/move_to_level')).toEqual({
            device: '4',
            endpoint: '1',
            cluster: 'level_control',
            attributeOrCommand: 'move_to_level',
        });
        expect(t.match(t.DEFAULT_TEMPLATES.set, 'matter/status/bad_licht/1/on_off/on_off')).toBeNull();
        expect(t.match('matter/get/${nodeId}/${endpoint}/${cluster}/${attribute}', 'matter/get/4/1/on_off/on_off')).toEqual({
            nodeId: '4',
            endpoint: '1',
            cluster: 'on_off',
            attribute: 'on_off',
        });
        expect(t.match('', 'anything')).toBeNull();
    });

    test('validate: unknown placeholders, wildcards, an inbound template overlapping an outbound one', () => {
        expect(t.validate(t.DEFAULT_TEMPLATES)).toEqual([]);
        expect(t.validate({ attribute: '' })).toEqual([]);
        expect(t.validate({ attribute: 'x/${nope}' })).toEqual([expect.stringContaining('unknown placeholder ${nope}')]);
        expect(t.validate({ set: 'matter/+/${device}/${endpoint}/${cluster}/${attributeOrCommand}' })).toEqual([expect.stringContaining('no MQTT wildcards')]);
        expect(t.validate({ set: 'matter/status/${device}/${endpoint}/${cluster}/${attributeOrCommand}' })).toEqual(
            expect.arrayContaining([expect.stringContaining('set overlaps attribute')]),
        );
        expect(t.validate({ set: 'matter/set/${endpoint}/${cluster}/${attributeOrCommand}' })).toEqual([expect.stringContaining('needs ${device} or ${nodeId}')]);
        expect(t.validate({ bogus: 'x' })).toEqual([expect.stringContaining('unknown template')]);
        expect(t.validate({ attribute: '/x/${device}' })).toEqual([expect.stringContaining('empty topic segment')]);
    });

    test('payload formats and inbound parsing', () => {
        expect(t.formatPayload('plain', true)).toBe('true');
        expect(t.formatPayload('plain', 'on')).toBe('on');
        expect(t.formatPayload('plain', { a: 1 })).toBe('{"a":1}');
        expect(JSON.parse(t.formatPayload('basic', 128, { ts: 10, lc: 5 }))).toEqual({ val: 128, ts: 10, lc: 5 });
        expect(JSON.parse(t.formatPayload('extended', false, { ts: 10, lc: 5, matter: { nodeId: '4', cluster: 'onOff' } }))).toEqual({
            val: false,
            ts: 10,
            lc: 5,
            matter: { nodeId: '4', cluster: 'onOff' },
        });
        expect(t.parseInbound(Buffer.from('true'))).toBe(true);
        expect(t.parseInbound('{"val": 42}')).toBe(42);
        expect(t.parseInbound('{"level": 3}')).toEqual({ level: 3 });
        expect(t.parseInbound('toggle')).toBe('toggle');
        expect(t.parseInbound('')).toBe('');
    });

    test('names: sanitised to snake_case, made unique; snake/camel', () => {
        expect(t.mqttName('Bad Licht')).toBe('bad_licht');
        expect(t.mqttName('Küche/Ost #2')).toBe('kueche_ost_2');
        expect(t.mqttName('  ')).toBe('device');
        expect(t.uniqueName('bulb', ['bulb', 'bulb_2'])).toBe('bulb_3');
        expect(t.snake('levelControl')).toBe('level_control');
        expect(t.snake('currentPositionLiftPercent100ths')).toBe('current_position_lift_percent100ths');
        expect(t.snake('onOff')).toBe('on_off');
        expect(t.camel('on_off')).toBe('onOff');
        expect(t.camel('move_to_level_with_on_off')).toBe('moveToLevelWithOnOff');
    });

    test('the deny-list keeps diagnostics and plumbing out', () => {
        for (const c of [
            'descriptor',
            'binding',
            'accessControl',
            'groups',
            'groupKeyManagement',
            'threadNetworkDiagnostics',
            'otaSoftwareUpdateRequestor',
            'identify',
            'fixedLabel',
            'userLabel',
        ])
            expect(t.DENY_CLUSTERS.has(c)).toBe(true);
        for (const c of ['onOff', 'levelControl', 'switch', 'temperatureMeasurement', 'windowCovering', 'powerSource', 'bridgedDeviceBasicInformation'])
            expect(t.DENY_CLUSTERS.has(c)).toBe(false);
        expect(t.DENY_ATTRIBUTES.has('featureMap')).toBe(true);
    });

    test('resolveSet: mapped commands, a command by name, an attribute write, else an error', () => {
        const def = { commands: { on: {}, off: {}, toggle: {}, moveToLevel: {} }, attributes: { onOff: {}, onTime: {} } };
        expect(t.resolveSet('onOff', 'onOff', true, def)).toEqual({ kind: 'command', command: 'on' });
        expect(t.resolveSet('onOff', 'onOff', 'off', def)).toEqual({ kind: 'command', command: 'off' });
        expect(t.resolveSet('onOff', 'onOff', '0', def)).toEqual({ kind: 'command', command: 'off' });
        expect(t.resolveSet('onOff', 'onOff', 'toggle', def)).toEqual({ kind: 'command', command: 'toggle' });
        expect(t.resolveSet('levelControl', 'currentLevel', '128', def)).toEqual({ kind: 'command', command: 'moveToLevel', args: { level: 128, transitionTime: 0 } });
        expect(t.resolveSet('windowCovering', 'currentPositionLiftPercent100ths', 5000, def)).toEqual({
            kind: 'command',
            command: 'goToLiftPercentage',
            args: { liftPercent100thsValue: 5000 },
        });
        expect(t.resolveSet('onOff', 'toggle', '', def)).toEqual({ kind: 'command', command: 'toggle', args: {} });
        expect(t.resolveSet('levelControl', 'moveToLevel', { level: 10 }, def)).toEqual({ kind: 'command', command: 'moveToLevel', args: { level: 10 } });
        expect(t.resolveSet('onOff', 'onTime', 30, def)).toEqual({ kind: 'write', attribute: 'onTime', value: 30 });
        expect(() => t.resolveSet('onOff', 'nope', 1, def)).toThrow('neither a command nor an attribute');
    });
});
