'use strict';

/**
 * Unit tests for src/matter/bridge-discovery.js (the Matter bridge's Home Assistant discovery):
 * the device-type → component table, the unit conversions, the device split of a Matter bridge,
 * the stable ids, the availability — and, against a fake broker and controller, how
 * src/matter/mqtt-bridge.js publishes and clears the configs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const disc = require('../../src/matter/bridge-discovery');
const t = require('../../src/matter/bridge-templates');

const { DT } = disc;
const ORIGIN = { name: 'she', sw_version: '9.9.9', support_url: 'https://github.com/hobbyquaker/she' };

/** An endpoint in the controller's getEndpoints() shape. */
function ep(id, types, clusters = {}, { parts = [], name = null } = {}) {
    return {
        endpointId: id,
        name,
        clusters: [
            { name: 'descriptor', attrs: { deviceTypeList: types.map((d) => ({ deviceType: d, revision: 1 })), partsList: parts } },
            ...Object.entries(clusters).map(([n, attrs]) => ({ name: n, attrs })),
        ],
    };
}

function rootEp(bi = {}, extra = {}, parts = [1]) {
    return ep(
        0,
        [DT.ROOT_NODE],
        {
            basicInformation: {
                vendorId: 0x1234,
                productId: 0x5678,
                vendorName: 'Acme',
                productName: 'Thing',
                uniqueId: 'UID-1',
                serialNumber: 'SN1',
                softwareVersionString: '1.2.3',
                ...bi,
            },
            ...extra,
        },
        { parts },
    );
}

function build(endpoints, opts = {}) {
    return disc.buildNodeConfigs({
        nodeId: '4',
        device: 'thing',
        endpoints,
        templates: { ...t.DEFAULT_TEMPLATES, ...(opts.templates ?? {}) },
        format: opts.format ?? 'basic',
        origin: ORIGIN,
        sheTopic: opts.sheTopic === undefined ? 'she/connected' : opts.sheTopic,
        known: opts.known,
        prefix: opts.prefix,
    });
}

/** The single device's components. */
function comps(endpoints, opts) {
    const { configs } = build(endpoints, opts);
    expect(configs).toHaveLength(1);
    return configs[0].payload.components;
}

describe('matter bridge discovery: the device-type table', () => {
    test('extended colour light: brightness 0–254 scaled, colour temperature in mireds with its range, xy command-only', () => {
        const c = comps([
            rootEp(),
            ep(1, [DT.EXTENDED_COLOR_LIGHT], {
                onOff: { onOff: true },
                levelControl: { currentLevel: 200 },
                colorControl: { colorTemperatureMireds: 300, colorTempPhysicalMinMireds: 153, colorTempPhysicalMaxMireds: 500, currentX: 20000, currentY: 20000 },
            }),
        ]);
        expect(c['1_light']).toEqual({
            p: 'light',
            name: null,
            unique_id: 'she_matter_UID-1_1_light',
            state_topic: 'matter/status/thing/1/on_off/on_off',
            state_value_template: "{{ 'ON' if value_json.val else 'OFF' }}",
            command_topic: 'matter/set/thing/1/on_off/on_off',
            on_command_type: 'first',
            brightness_state_topic: 'matter/status/thing/1/level_control/current_level',
            brightness_value_template: '{{ None if value_json.val is none else (value_json.val) }}',
            brightness_command_topic: 'matter/set/thing/1/level_control/current_level',
            brightness_scale: 254,
            color_temp_state_topic: 'matter/status/thing/1/color_control/color_temperature_mireds',
            color_temp_value_template: '{{ None if value_json.val is none else (value_json.val) }}',
            color_temp_command_topic: 'matter/set/thing/1/color_control/color_temperature_mireds',
            min_kelvin: 2000,
            max_kelvin: 6536,
            xy_command_topic: 'matter/set/thing/1/color_control/move_to_color',
            xy_command_template: expect.stringContaining('"colorX": {{ (x * 65536)'),
        });
    });

    test('on/off, dimmable and colour temperature lights', () => {
        expect(comps([rootEp(), ep(1, [DT.ON_OFF_LIGHT], { onOff: { onOff: false } })])['1_light']).not.toHaveProperty('brightness_command_topic');
        const dim = comps([rootEp(), ep(1, [DT.DIMMABLE_LIGHT], { onOff: { onOff: false }, levelControl: { currentLevel: 1 } })])['1_light'];
        expect(dim).toMatchObject({ p: 'light', brightness_scale: 254 });
        expect(dim).not.toHaveProperty('color_temp_command_topic');
        const ct = comps([
            rootEp(),
            ep(1, [DT.COLOR_TEMPERATURE_LIGHT], { onOff: { onOff: false }, levelControl: { currentLevel: 1 }, colorControl: { colorTemperatureMireds: 370 } }),
        ])['1_light'];
        expect(ct).toMatchObject({ color_temp_command_topic: 'matter/set/thing/1/color_control/color_temperature_mireds' });
        expect(ct).not.toHaveProperty('xy_command_topic');
        expect(ct).not.toHaveProperty('min_kelvin');
    });

    test('plug-in unit is an outlet, mounted on/off control a switch', () => {
        expect(comps([rootEp(), ep(1, [DT.ON_OFF_PLUG_IN_UNIT], { onOff: { onOff: true } })])['1_switch']).toEqual({
            p: 'switch',
            device_class: 'outlet',
            name: null,
            unique_id: 'she_matter_UID-1_1_switch',
            state_topic: 'matter/status/thing/1/on_off/on_off',
            value_template: "{{ 'ON' if value_json.val else 'OFF' }}",
            command_topic: 'matter/set/thing/1/on_off/on_off',
        });
        expect(comps([rootEp(), ep(1, [DT.MOUNTED_ON_OFF_CONTROL], { onOff: { onOff: true } })])['1_switch'].device_class).toBe('switch');
    });

    test('window covering: device_class from the type, 0–10000 (0 = open) → 0–100 (100 = open), tilt, OPEN/CLOSE/STOP', () => {
        const c = comps([rootEp(), ep(1, [DT.WINDOW_COVERING], { windowCovering: { type: 6, currentPositionLiftPercent100ths: 2500, currentPositionTiltPercent100ths: 0 } })])[
            '1_cover'
        ];
        expect(c).toMatchObject({
            p: 'cover',
            device_class: 'shutter',
            position_topic: 'matter/status/thing/1/window_covering/current_position_lift_percent100ths',
            position_template: '{{ None if value_json.val is none else (100 - (value_json.val / 100) | round(0) | int) }}',
            set_position_topic: 'matter/set/thing/1/window_covering/current_position_lift_percent100ths',
            set_position_template: '{{ (100 - position) * 100 }}',
            tilt_status_topic: 'matter/status/thing/1/window_covering/current_position_tilt_percent100ths',
            tilt_command_template: '{{ (100 - tilt_position) * 100 }}',
            command_topic: 'matter/set/thing/1/window_covering/operational_status',
        });
        expect(comps([rootEp(), ep(1, [DT.WINDOW_COVERING], { windowCovering: { type: 5, currentPositionLiftPercent100ths: 0 } })])['1_cover'].device_class).toBe('awning');
        expect(comps([rootEp(), ep(1, [DT.WINDOW_COVERING], { windowCovering: { type: 255 } })])['1_cover']).not.toHaveProperty('device_class');
    });

    test('thermostat (heating): centi-degrees → °C, systemMode ↔ hvac modes, the limits', () => {
        const c = comps([
            rootEp(),
            ep(1, [DT.THERMOSTAT], {
                thermostat: { localTemperature: 2150, occupiedHeatingSetpoint: 2000, systemMode: 4, absMinHeatSetpointLimit: 700, absMaxHeatSetpointLimit: 3000 },
            }),
        ])['1_climate'];
        expect(c).toMatchObject({
            p: 'climate',
            temperature_unit: 'C',
            current_temperature_topic: 'matter/status/thing/1/thermostat/local_temperature',
            current_temperature_template: '{{ None if value_json.val is none else (value_json.val / 100) }}',
            temperature_state_topic: 'matter/status/thing/1/thermostat/occupied_heating_setpoint',
            temperature_command_topic: 'matter/set/thing/1/thermostat/occupied_heating_setpoint',
            temperature_command_template: '{{ (value * 100) | round(0) | int }}',
            modes: ['off', 'heat'],
            mode_state_topic: 'matter/status/thing/1/thermostat/system_mode',
            mode_command_topic: 'matter/set/thing/1/thermostat/system_mode',
            min_temp: 7,
            max_temp: 30,
        });
        expect(c).not.toHaveProperty('temperature_low_state_topic');
    });

    test('thermostat with heating and cooling: a range; room air conditioner adds fan_only', () => {
        const c = comps([
            rootEp(),
            ep(1, [DT.ROOM_AIR_CONDITIONER], {
                onOff: { onOff: true },
                thermostat: { localTemperature: 2400, occupiedHeatingSetpoint: 2000, occupiedCoolingSetpoint: 2600, systemMode: 3, minSetpointDeadBand: 20 },
                fanControl: { fanMode: 0 },
            }),
        ])['1_climate'];
        expect(c.modes).toEqual(['off', 'heat', 'cool', 'auto', 'fan_only']);
        expect(c).toMatchObject({
            temperature_low_state_topic: 'matter/status/thing/1/thermostat/occupied_heating_setpoint',
            temperature_high_state_topic: 'matter/status/thing/1/thermostat/occupied_cooling_setpoint',
        });
        expect(c).not.toHaveProperty('temperature_state_topic');
    });

    test('fan: fanMode on/off, percent', () => {
        expect(comps([rootEp(), ep(1, [DT.FAN], { fanControl: { fanMode: 0, percentSetting: 0, percentCurrent: 0 } })])['1_fan']).toMatchObject({
            p: 'fan',
            state_topic: 'matter/status/thing/1/fan_control/fan_mode',
            command_topic: 'matter/set/thing/1/fan_control/fan_mode',
            payload_on: '4',
            payload_off: '0',
            percentage_state_topic: 'matter/status/thing/1/fan_control/percent_current',
            percentage_command_topic: 'matter/set/thing/1/fan_control/percent_setting',
        });
    });

    test('door lock: lockState mapped, OPEN only with unbolting', () => {
        const c = comps([rootEp(), ep(1, [DT.DOOR_LOCK], { doorLock: { lockState: 1, featureMap: { unbolting: true } } })])['1_lock'];
        expect(c).toMatchObject({
            p: 'lock',
            state_topic: 'matter/status/thing/1/door_lock/lock_state',
            command_topic: 'matter/set/thing/1/door_lock/lock_state',
            payload_open: 'OPEN',
        });
        expect(comps([rootEp(), ep(1, [DT.DOOR_LOCK], { doorLock: { lockState: 1 } })])['1_lock']).not.toHaveProperty('payload_open');
    });

    test('binary sensors: contact inverted, occupancy bitmap, leak, freeze, smoke and CO', () => {
        expect(comps([rootEp(), ep(1, [DT.CONTACT_SENSOR], { booleanState: { stateValue: true } })])['1_contact']).toMatchObject({
            p: 'binary_sensor',
            device_class: 'opening',
            state_topic: 'matter/status/thing/1/boolean_state/state_value',
            value_template: "{{ 'OFF' if value_json.val else 'ON' }}",
        });
        expect(comps([rootEp(), ep(1, [DT.OCCUPANCY_SENSOR], { occupancySensing: { occupancy: { occupied: true } } })])['1_occupancy']).toMatchObject({
            device_class: 'occupancy',
            state_topic: 'matter/status/thing/1/occupancy_sensing/occupancy',
        });
        expect(comps([rootEp(), ep(1, [DT.WATER_LEAK_DETECTOR], { booleanState: { stateValue: false } })])['1_leak']).toMatchObject({
            device_class: 'moisture',
            value_template: "{{ 'ON' if value_json.val else 'OFF' }}",
        });
        expect(comps([rootEp(), ep(1, [DT.WATER_FREEZE_DETECTOR], { booleanState: { stateValue: false } })])['1_freeze'].device_class).toBe('cold');
        const smoke = comps([rootEp(), ep(1, [DT.SMOKE_CO_ALARM], { smokeCoAlarm: { smokeState: 0, coState: 0 } })]);
        expect(smoke['1_smoke']).toMatchObject({ device_class: 'smoke', state_topic: 'matter/status/thing/1/smoke_co_alarm/smoke_state', name: 'Smoke' });
        expect(smoke['1_co']).toMatchObject({ device_class: 'carbon_monoxide', state_topic: 'matter/status/thing/1/smoke_co_alarm/co_state' });
    });

    test('measurements from the clusters, with their unit conversions', () => {
        const c = comps([
            rootEp(),
            ep(1, [DT.AIR_QUALITY_SENSOR], {
                temperatureMeasurement: { measuredValue: 2150 },
                relativeHumidityMeasurement: { measuredValue: 4500 },
                pressureMeasurement: { measuredValue: 10130 },
                illuminanceMeasurement: { measuredValue: 30001 },
                airQuality: { airQuality: 1 },
                carbonDioxideConcentrationMeasurement: { measuredValue: 600, measurementUnit: 0 },
                pm25ConcentrationMeasurement: { measuredValue: 5, measurementUnit: 4 },
                totalVolatileOrganicCompoundsConcentrationMeasurement: { measuredValue: 5, measurementUnit: 1 },
            }),
            ep(2, [DT.ELECTRICAL_SENSOR, DT.POWER_SOURCE], {
                electricalPowerMeasurement: { activePower: 12345, voltage: 230000, activeCurrent: 50 },
                electricalEnergyMeasurement: { cumulativeEnergyImported: { energy: 1500000 } },
                powerSource: { batPercentRemaining: 180 },
            }),
        ]);
        expect(c['1_temperature']).toMatchObject({
            p: 'sensor',
            device_class: 'temperature',
            unit_of_measurement: '°C',
            state_class: 'measurement',
            value_template: '{{ None if value_json.val is none else (value_json.val / 100) }}',
        });
        expect(c['1_humidity']).toMatchObject({ device_class: 'humidity', unit_of_measurement: '%' });
        expect(c['1_pressure']).toMatchObject({
            device_class: 'pressure',
            unit_of_measurement: 'hPa',
            value_template: '{{ None if value_json.val is none else (value_json.val) }}',
        });
        expect(c['1_illuminance']).toMatchObject({ device_class: 'illuminance', unit_of_measurement: 'lx' });
        expect(c['1_air_quality']).toMatchObject({ device_class: 'enum', options: ['unknown', 'good', 'fair', 'moderate', 'poor', 'very_poor', 'extremely_poor'] });
        expect(c['1_carbon_dioxide']).toMatchObject({
            device_class: 'carbon_dioxide',
            unit_of_measurement: 'ppm',
            state_topic: 'matter/status/thing/1/carbon_dioxide_concentration_measurement/measured_value',
        });
        expect(c['1_pm25']).toMatchObject({ device_class: 'pm25', unit_of_measurement: 'µg/m³' });
        expect(c['1_total_volatile_organic_compounds']).toMatchObject({ device_class: 'volatile_organic_compounds_parts', unit_of_measurement: 'ppb' });
        expect(c['2_power']).toMatchObject({
            device_class: 'power',
            unit_of_measurement: 'W',
            value_template: '{{ None if value_json.val is none else (value_json.val / 1000) }}',
        });
        expect(c['2_voltage']).toMatchObject({ device_class: 'voltage', unit_of_measurement: 'V' });
        expect(c['2_current']).toMatchObject({ device_class: 'current', unit_of_measurement: 'A' });
        expect(c['2_energy']).toMatchObject({
            device_class: 'energy',
            unit_of_measurement: 'kWh',
            state_class: 'total_increasing',
            state_topic: 'matter/status/thing/2/electrical_energy_measurement/cumulative_energy_imported',
        });
        expect(c['2_battery']).toMatchObject({
            device_class: 'battery',
            entity_category: 'diagnostic',
            value_template: '{{ None if value_json.val is none else ((value_json.val / 2) | round(0) | int) }}',
        });
        // no function of its own: sensors carry a name
        expect(c['1_temperature'].name).toBe('Temperature');
    });

    test('robot vacuum: command-only', () => {
        expect(comps([rootEp(), ep(1, [DT.ROBOTIC_VACUUM_CLEANER], { rvcOperationalState: { operationalState: 0 }, rvcRunMode: { currentMode: 0 } })])['1_vacuum']).toEqual({
            p: 'vacuum',
            name: null,
            unique_id: 'she_matter_UID-1_1_vacuum',
            command_topic: 'matter/set/thing/1/rvc_operational_state/operational_state',
            supported_features: ['start', 'pause', 'stop', 'return_home'],
        });
    });

    test('generic switch: an event entity per supported event, on the (not retained) event topics', () => {
        const c = comps([
            rootEp(),
            ep(1, [DT.GENERIC_SWITCH], {
                switch: { numberOfPositions: 2, multiPressMax: 3, featureMap: { momentarySwitch: true, momentarySwitchLongPress: true, momentarySwitchMultiPress: true } },
            }),
        ]);
        expect(c['1_press']).toMatchObject({
            p: 'event',
            device_class: 'button',
            state_topic: 'matter/status/thing/1/switch/initial_press',
            value_template: '{"event_type": "press"}',
            event_types: ['press'],
        });
        expect(c['1_long_press']).toMatchObject({ state_topic: 'matter/status/thing/1/switch/long_press', event_types: ['long_press'] });
        expect(c['1_multi_press']).toMatchObject({
            state_topic: 'matter/status/thing/1/switch/multi_press_complete',
            value_template: '{"event_type": "multi_press_{{ value_json.val.totalNumberOfPressesCounted }}"}',
            event_types: ['multi_press_1', 'multi_press_2', 'multi_press_3'],
        });
        // without an event template there is nothing to point at
        expect(build([rootEp(), ep(1, [DT.GENERIC_SWITCH], { switch: { featureMap: { momentarySwitch: true } } })], { templates: { event: '' } }).configs).toEqual([]);
    });

    test('several functions on several endpoints: names by endpoint, unique ids by endpoint number', () => {
        const c = comps([rootEp(), ep(1, [DT.ON_OFF_PLUG_IN_UNIT], { onOff: { onOff: true } }), ep(2, [DT.ON_OFF_PLUG_IN_UNIT], { onOff: { onOff: false } }, { name: 'Socket' })]);
        expect(c['1_switch']).toMatchObject({ name: 'Switch 1', unique_id: 'she_matter_UID-1_1_switch' });
        expect(c['2_switch']).toMatchObject({ name: 'Socket 2', unique_id: 'she_matter_UID-1_2_switch' });
    });

    test('without a set template only the read-only entities are announced', () => {
        const c = comps([rootEp(), ep(1, [DT.DIMMABLE_LIGHT], { onOff: { onOff: true }, levelControl: { currentLevel: 1 }, temperatureMeasurement: { measuredValue: 1 } })], {
            templates: { set: '' },
        });
        expect(Object.keys(c)).toEqual(['1_temperature']);
    });

    test('plain format: the templates read the payload itself', () => {
        const c = comps([rootEp(), ep(1, [DT.ON_OFF_PLUG_IN_UNIT], { onOff: { onOff: true } })], { format: 'plain' });
        expect(c['1_switch'].value_template).toBe("{{ 'ON' if value_json else 'OFF' }}");
    });
});

describe('matter bridge discovery: device, identity, availability', () => {
    test('the device block and the origin; the config topic from the uniqueId', () => {
        const { configs, fallback } = build([rootEp({ nodeLabel: 'Bad Licht', hardwareVersionString: 'B' }), ep(1, [DT.ON_OFF_LIGHT], { onOff: { onOff: true } })]);
        expect(fallback).toBe(false);
        expect(configs[0].id).toBe('she_matter_UID-1');
        expect(configs[0].topic).toBe('homeassistant/device/she_matter_UID-1/config');
        expect(configs[0].payload.device).toEqual({
            identifiers: ['she_matter_UID-1'],
            name: 'Bad Licht',
            manufacturer: 'Acme',
            model: 'Thing',
            sw_version: '1.2.3',
            hw_version: 'B',
            serial_number: 'SN1',
        });
        expect(configs[0].payload.origin).toEqual(ORIGIN);
        expect(build([rootEp(), ep(1, [DT.ON_OFF_LIGHT], { onOff: { onOff: true } })], { prefix: 'ha' }).configs[0].topic).toBe('ha/device/she_matter_UID-1/config');
    });

    test('stable across a re-commissioning: another node id and MQTT name, the same ids', () => {
        const endpoints = [rootEp({ uniqueId: 'abc/def 1' }), ep(1, [DT.ON_OFF_LIGHT], { onOff: { onOff: true } })];
        const a = build(endpoints).configs[0];
        const b = disc.buildNodeConfigs({ nodeId: '17', device: 'thing_2', endpoints, templates: t.DEFAULT_TEMPLATES, format: 'basic', origin: ORIGIN }).configs[0];
        expect(a.id).toBe('she_matter_abc_def_1');
        expect(b.id).toBe(a.id);
        expect(b.payload.device.identifiers).toEqual(a.payload.device.identifiers);
        expect(b.payload.components['1_light'].unique_id).toBe(a.payload.components['1_light'].unique_id);
        // the topics follow the bridge's names
        expect(b.payload.components['1_light'].state_topic).toBe('matter/status/thing_2/1/on_off/on_off');
        expect(JSON.stringify(a)).not.toContain('"4"');
    });

    test('no uniqueId: vendor id + product id + serial; neither: the node id, flagged', () => {
        const light = ep(1, [DT.ON_OFF_LIGHT], { onOff: { onOff: true } });
        expect(build([rootEp({ uniqueId: undefined }), light]).configs[0].id).toBe('she_matter_1234_5678_SN1');
        const none = build([rootEp({ uniqueId: undefined, serialNumber: undefined }), light]);
        expect(none.configs[0].id).toBe('she_matter_node_4');
        expect(none.fallback).toBe(true);
    });

    test('availability: the bridge, she and the node — only the four keys, all of them required', () => {
        const { configs } = build([rootEp(), ep(1, [DT.ON_OFF_LIGHT], { onOff: { onOff: true } })]);
        const p = configs[0].payload;
        expect(p.availability_mode).toBe('all');
        expect(p.availability).toEqual([
            { topic: 'matter/connected', payload_available: 'online', payload_not_available: 'offline', value_template: "{{ 'online' if value | int(0) >= 2 else 'offline' }}" },
            { topic: 'she/connected', payload_available: 'online', payload_not_available: 'offline', value_template: "{{ 'online' if value | int(0) >= 2 else 'offline' }}" },
            {
                topic: 'matter/status/thing/online',
                payload_available: 'online',
                payload_not_available: 'offline',
                value_template: "{{ 'online' if value_json.val else 'offline' }}",
            },
        ]);
        for (const a of p.availability) expect(Object.keys(a).sort()).toEqual(['payload_available', 'payload_not_available', 'topic', 'value_template']);
        // a topic without a value yet is left out (SPEC: it would keep the device unavailable)
        const unknown = build([rootEp(), ep(1, [DT.ON_OFF_LIGHT], { onOff: { onOff: true } })], { known: (topic) => !topic.endsWith('/online'), sheTopic: null }).configs[0]
            .payload;
        expect(unknown.availability.map((a) => a.topic)).toEqual(['matter/connected']);
        expect(unknown).not.toHaveProperty('availability_mode');
    });

    test('a Matter bridge: one device per bridged endpoint with via_device, identity from its own basic information', () => {
        const { configs } = build([
            rootEp({ nodeLabel: 'Hub', uniqueId: 'HUB' }, {}, [1, 2, 3, 4]),
            ep(1, [DT.AGGREGATOR], {}, { parts: [2, 3, 4] }),
            ep(2, [DT.BRIDGED_NODE, DT.ON_OFF_LIGHT], {
                bridgedDeviceBasicInformation: { nodeLabel: 'Lamp', uniqueId: 'L1', reachable: true, vendorName: 'Ikea' },
                onOff: { onOff: true },
            }),
            ep(3, [DT.BRIDGED_NODE], { bridgedDeviceBasicInformation: { nodeLabel: 'Sensor', serialNumber: 'S9', reachable: true } }, { parts: [4] }),
            ep(4, [DT.TEMPERATURE_SENSOR], { temperatureMeasurement: { measuredValue: 2000 }, relativeHumidityMeasurement: { measuredValue: 5000 } }),
        ]);
        expect(configs.map((c) => c.id)).toEqual(['she_matter_HUB', 'she_matter_L1', 'she_matter_1234_x_S9']);
        const [hub, lamp, sensor] = configs.map((c) => c.payload);
        // the bridge has no function of its own: a connectivity entity, available while the bridge runs
        expect(hub.components).toEqual({
            connectivity: expect.objectContaining({
                p: 'binary_sensor',
                device_class: 'connectivity',
                state_topic: 'matter/status/thing/online',
                unique_id: 'she_matter_HUB_connectivity',
            }),
        });
        expect(hub.availability.map((a) => a.topic)).toEqual(['matter/connected', 'she/connected']);
        expect(lamp.device).toMatchObject({ identifiers: ['she_matter_L1'], name: 'Lamp', manufacturer: 'Ikea', via_device: 'she_matter_HUB' });
        // the bridged endpoint's own position, not its number
        expect(lamp.components['0_light']).toMatchObject({ unique_id: 'she_matter_L1_0_light', state_topic: 'matter/status/thing/2/on_off/on_off', name: null });
        expect(lamp.availability.map((a) => a.topic)).toEqual([
            'matter/connected',
            'she/connected',
            'matter/status/thing/online',
            'matter/status/thing/2/bridged_device_basic_information/reachable',
        ]);
        expect(sensor.device).toMatchObject({ name: 'Sensor', via_device: 'she_matter_HUB' });
        expect(Object.keys(sensor.components)).toEqual(['1_temperature', '1_humidity']);
        expect(sensor.components['1_temperature'].state_topic).toBe('matter/status/thing/4/temperature_measurement/measured_value');
    });

    test('a bridged endpoint without any identity: the bridge id and the endpoint', () => {
        const { configs } = build([
            rootEp({ uniqueId: 'HUB' }, {}, [1, 2]),
            ep(1, [DT.AGGREGATOR], {}, { parts: [2] }),
            ep(2, [DT.BRIDGED_NODE, DT.ON_OFF_PLUG_IN_UNIT], { bridgedDeviceBasicInformation: { nodeLabel: 'Plug' }, onOff: { onOff: true } }),
        ]);
        expect(configs.map((c) => c.id)).toEqual(['she_matter_HUB', 'she_matter_HUB_2']);
    });

    test('a room from a "room" label', () => {
        const { configs } = build([rootEp({}, { userLabel: { labelList: [{ label: 'Room', value: 'Bad' }] } }), ep(1, [DT.ON_OFF_LIGHT], { onOff: { onOff: true } })]);
        expect(configs[0].payload.device.suggested_area).toBe('Bad');
    });

    test('nothing to announce: no root endpoint, no attribute template, no entities', () => {
        expect(build([ep(1, [DT.ON_OFF_LIGHT], { onOff: { onOff: true } })]).configs).toEqual([]);
        expect(build([rootEp(), ep(1, [DT.ON_OFF_LIGHT], { onOff: { onOff: true } })], { templates: { attribute: '' } }).configs).toEqual([]);
        expect(build([rootEp(), ep(1, [0x9999], {})]).configs).toEqual([]);
    });

    test('ourConfigId: only our ids under the prefix', () => {
        expect(disc.ourConfigId('homeassistant/device/she_matter_X/config')).toBe('she_matter_X');
        expect(disc.ourConfigId('homeassistant/device/z2m_X/config')).toBeNull();
        expect(disc.ourConfigId('ha/device/she_matter_X/config')).toBeNull();
        expect(disc.ourConfigId('ha/device/she_matter_X/config', 'ha')).toBe('she_matter_X');
    });
});

describe('matter bridge: set mappings for the announced entities', () => {
    test('cover OPEN/CLOSE/STOP, lock LOCK/UNLOCK/OPEN, vacuum commands', () => {
        expect(t.resolveSet('windowCovering', 'operationalStatus', 'OPEN', {})).toEqual({ kind: 'command', command: 'upOrOpen' });
        expect(t.resolveSet('windowCovering', 'operationalStatus', 'CLOSE', {})).toEqual({ kind: 'command', command: 'downOrClose' });
        expect(t.resolveSet('windowCovering', 'operationalStatus', 'STOP', {})).toEqual({ kind: 'command', command: 'stopMotion' });
        expect(() => t.resolveSet('windowCovering', 'operationalStatus', 'sideways', {})).toThrow(/OPEN, CLOSE or STOP/);
        expect(t.resolveSet('doorLock', 'lockState', 'LOCK', {})).toEqual({ kind: 'command', command: 'lockDoor' });
        expect(t.resolveSet('doorLock', 'lockState', 'UNLOCK', {})).toEqual({ kind: 'command', command: 'unlockDoor' });
        expect(t.resolveSet('doorLock', 'lockState', 'OPEN', {})).toEqual({ kind: 'command', command: 'unboltDoor' });
        expect(t.resolveSet('rvcOperationalState', 'operationalState', 'start', {})).toEqual({ kind: 'command', command: 'resume' });
        expect(t.resolveSet('rvcOperationalState', 'operationalState', 'return_to_base', {})).toEqual({ kind: 'command', command: 'goHome' });
    });
});

describe('matter bridge: publishing and clearing the discovery configs', () => {
    let bridge;
    let dir;
    let published;
    let store;
    let controller;
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    function lightNode(nodeId, uniqueId, label) {
        return [
            ep(0, [DT.ROOT_NODE], { basicInformation: { uniqueId, nodeLabel: label, vendorName: 'Acme', productName: 'Bulb' } }, { parts: [1] }),
            ep(1, [DT.DIMMABLE_LIGHT], { onOff: { onOff: true }, levelControl: { currentLevel: 100 } }),
        ];
    }

    function makeController() {
        const events = new EventEmitter();
        const nodes = [{ nodeId: '4', online: true, name: 'Bad Licht' }];
        const endpoints = { 4: lightNode('4', 'UID-4', 'Bad Licht') };
        return {
            events,
            listPaired: jest.fn(() => nodes.map((n) => ({ ...n }))),
            getEndpoints: jest.fn((id) => endpoints[id] ?? []),
            sendCommand: jest.fn().mockResolvedValue(null),
            setAttribute: jest.fn().mockResolvedValue(undefined),
            getAttribute: jest.fn().mockResolvedValue(42),
            nodes,
            endpoints,
        };
    }

    function setup({ settings = { enabled: true, discovery: true }, entries = {} } = {}) {
        jest.resetModules();
        bridge = require('../../src/matter/mqtt-bridge');
        bridge._reset();
        published = [];
        const map = new Map(Object.entries(entries));
        store = {
            *mqttEntries() {
                for (const [k, v] of map) yield [k, v];
            },
            map,
        };
        controller = makeController();
        fs.writeFileSync(path.join(dir, 'mqtt-bridge.json'), JSON.stringify(settings));
        bridge.init({
            publish: (topic, payload, opts) => {
                published.push({ topic, payload, retain: !!opts?.retain });
                if (opts?.retain) {
                    if (payload === '') map.delete(topic);
                    else map.set(topic, payload);
                }
            },
            isConnected: () => true,
            store,
            log,
            storageDir: dir,
            controller,
            sheTopic: 'she/connected',
        });
    }
    const CFG = 'homeassistant/device/she_matter_UID-4/config';
    const last = (topic) => published.filter((p) => p.topic === topic).pop();

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-bridge-disc-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('off by default, also with the bridge on', () => {
        setup({ settings: { enabled: true } });
        bridge.start();
        expect(published.some((p) => p.topic.startsWith('homeassistant/'))).toBe(false);
        expect(bridge.getSettings().discovery).toMatchObject({ enabled: false, prefix: 'homeassistant', active: false });
    });

    test('on: the config published retained after the state, with the node online in its availability; unchanged → not again', () => {
        setup();
        bridge.start();
        const cfg = last(CFG);
        expect(cfg.retain).toBe(true);
        const payload = JSON.parse(cfg.payload);
        expect(payload.components['1_light'].state_topic).toBe('matter/status/bad_licht/1/on_off/on_off');
        expect(payload.availability.map((a) => a.topic)).toEqual(['matter/connected', 'she/connected', 'matter/status/bad_licht/online']);
        expect(published.findIndex((p) => p.topic === CFG)).toBeGreaterThan(published.findIndex((p) => p.topic === 'matter/status/bad_licht/online'));
        expect(bridge.getSettings().discovery).toMatchObject({ enabled: true, active: true, announced: 1 });
        expect(bridge.getSettings().devices[0].announced).toBe(1);
        const n = published.length;
        controller.events.emit('deviceList', []);
        expect(published.slice(n).some((p) => p.topic === CFG)).toBe(false);
    });

    test('with the bridge off nothing is announced, even with the switch on', () => {
        setup({ settings: { enabled: false, discovery: true } });
        bridge.start();
        expect(published).toEqual([]);
    });

    test('switching the announcement off clears the configs; on again announces', () => {
        setup();
        bridge.start();
        bridge.updateSettings({ discovery: false });
        expect(last(CFG)).toEqual({ topic: CFG, payload: '', retain: true });
        expect(store.map.has(CFG)).toBe(false);
        bridge.updateSettings({ discovery: true });
        expect(last(CFG).payload).not.toBe('');
    });

    test('switching the bridge off clears the configs too', () => {
        setup();
        bridge.start();
        bridge.updateSettings({ enabled: false });
        expect(last(CFG).payload).toBe('');
        expect(bridge.getSettings().discovery.active).toBe(false);
    });

    test('a node that is removed gets its config cleared', () => {
        setup();
        bridge.start();
        controller.nodes.length = 0;
        controller.events.emit('deviceList', []);
        expect(last(CFG).payload).toBe('');
    });

    test('a node switched off on MQTT gets its config cleared, back on announced', () => {
        setup();
        bridge.start();
        bridge.setDevice('4', { publish: false });
        expect(last(CFG).payload).toBe('');
        bridge.setDevice('4', { publish: true });
        expect(JSON.parse(last(CFG).payload).device.name).toBe('Bad Licht');
    });

    test('a rename moves the entities to the new topics under the same id', () => {
        setup();
        bridge.start();
        bridge.setDevice('4', { name: 'licht_bad' });
        expect(JSON.parse(last(CFG).payload).components['1_light'].state_topic).toBe('matter/status/licht_bad/1/on_off/on_off');
    });

    test('re-commissioned (new node id, same uniqueId): the same config, never cleared in between', () => {
        setup();
        bridge.start();
        controller.nodes.splice(0, 1, { nodeId: '9', online: true, name: 'Bad Licht' });
        controller.endpoints[9] = lightNode('9', 'UID-4', 'Bad Licht');
        delete controller.endpoints[4];
        const n = published.length;
        controller.events.emit('deviceList', []);
        const after = published.slice(n).filter((p) => p.topic === CFG);
        expect(after.every((p) => p.payload !== '')).toBe(true);
        expect(JSON.parse(last(CFG).payload).components['1_light'].state_topic).toBe('matter/status/bad_licht_2/1/on_off/on_off');
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'mqtt-bridge.json'), 'utf8')).devices['9'].announced).toEqual(['she_matter_UID-4']);
    });

    test('at start, configs of ours that nobody claims are cleared; others are left alone', () => {
        setup({ entries: { 'homeassistant/device/she_matter_OLD/config': '{}', 'homeassistant/device/z2m_x/config': '{}' } });
        bridge.start();
        expect(last('homeassistant/device/she_matter_OLD/config').payload).toBe('');
        expect(last('homeassistant/device/z2m_x/config')).toBeUndefined();
    });

    test('a node whose endpoints cannot be read keeps the config it announced before', () => {
        setup({
            settings: { enabled: true, discovery: true, devices: { 4: { name: 'bad_licht', publish: true, announced: ['she_matter_UID-4'] } } },
            entries: { [CFG]: '{"x":1}' },
        });
        controller.getEndpoints.mockImplementation(() => []);
        bridge.start();
        expect(last(CFG)).toBeUndefined();
    });

    test('a changed prefix clears the old configs and announces under the new one', () => {
        setup();
        bridge.start();
        bridge.updateSettings({ discoveryPrefix: 'ha' });
        expect(last(CFG).payload).toBe('');
        expect(JSON.parse(last('ha/device/she_matter_UID-4/config').payload).device.identifiers).toEqual(['she_matter_UID-4']);
        expect(() => bridge.updateSettings({ discoveryPrefix: 'ha/#' })).toThrow(/wildcards/);
    });

    test('a changed format re-announces with the matching templates', () => {
        setup();
        bridge.start();
        bridge.updateSettings({ format: 'plain' });
        expect(JSON.parse(last(CFG).payload).components['1_light'].state_value_template).toBe("{{ 'ON' if value_json else 'OFF' }}");
    });

    test('a bridged device appearing (descriptor change) is announced', () => {
        setup();
        bridge.start();
        controller.endpoints[4] = [
            ep(0, [DT.ROOT_NODE], { basicInformation: { uniqueId: 'UID-4', nodeLabel: 'Bad Licht' } }, { parts: [1, 2, 3] }),
            ep(1, [DT.DIMMABLE_LIGHT], { onOff: { onOff: true }, levelControl: { currentLevel: 100 } }),
            ep(2, [DT.AGGREGATOR], {}, { parts: [3] }),
            ep(3, [DT.BRIDGED_NODE, DT.CONTACT_SENSOR], { bridgedDeviceBasicInformation: { uniqueId: 'B3', nodeLabel: 'Door' }, booleanState: { stateValue: true } }),
        ];
        controller.events.emit('attr', { nodeId: '4', endpointId: 0, clusterName: 'descriptor', attrName: 'partsList', value: [1, 2, 3], ts: 1 });
        expect(JSON.parse(last('homeassistant/device/she_matter_B3/config').payload).device.via_device).toBe('she_matter_UID-4');
    });
});
