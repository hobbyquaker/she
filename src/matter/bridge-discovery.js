'use strict';

/**
 * The Matter ↔ MQTT bridge's Home Assistant discovery (roadmap M34, mqtt-smarthome SPEC 2.0 §8):
 * one device config per node — and one per bridged endpoint of a Matter bridge, linked to it with
 * `via_device` — whose entities point at the bridge's own `status` and `set` topics.
 *
 * Pure: `buildNodeConfigs()` turns a node's endpoint cache (the controller's `getEndpoints()`)
 * plus the bridge's templates into the retained config payloads. The identity comes from the
 * device (Basic Information `uniqueId`, else vendor id + product id + serial number), never from
 * the node id, so a device that is reset and paired again keeps its discovery id, its Home
 * Assistant entities and whatever the home model hangs on them.
 */

const t = require('./bridge-templates');

const DEFAULT_PREFIX = 'homeassistant';
const ID_PREFIX = 'she_matter_';

/** Matter device type ids (Device Library). */
const DT = Object.freeze({
    ROOT_NODE: 0x0016,
    POWER_SOURCE: 0x0011,
    AGGREGATOR: 0x000e,
    BRIDGED_NODE: 0x0013,
    DOOR_LOCK: 0x000a,
    GENERIC_SWITCH: 0x000f,
    CONTACT_SENSOR: 0x0015,
    FAN: 0x002b,
    AIR_QUALITY_SENSOR: 0x002c,
    WATER_FREEZE_DETECTOR: 0x0041,
    WATER_LEAK_DETECTOR: 0x0043,
    RAIN_SENSOR: 0x0044,
    ROOM_AIR_CONDITIONER: 0x0072,
    ROBOTIC_VACUUM_CLEANER: 0x0074,
    SMOKE_CO_ALARM: 0x0076,
    ON_OFF_LIGHT: 0x0100,
    DIMMABLE_LIGHT: 0x0101,
    ON_OFF_PLUG_IN_UNIT: 0x010a,
    DIMMABLE_PLUG_IN_UNIT: 0x010b,
    COLOR_TEMPERATURE_LIGHT: 0x010c,
    EXTENDED_COLOR_LIGHT: 0x010d,
    MOUNTED_ON_OFF_CONTROL: 0x010f,
    MOUNTED_DIMMABLE_LOAD_CONTROL: 0x0110,
    LIGHT_SENSOR: 0x0106,
    OCCUPANCY_SENSOR: 0x0107,
    WINDOW_COVERING: 0x0202,
    THERMOSTAT: 0x0301,
    TEMPERATURE_SENSOR: 0x0302,
    PRESSURE_SENSOR: 0x0305,
    HUMIDITY_SENSOR: 0x0307,
    ELECTRICAL_SENSOR: 0x0510,
});

const LIGHTS = new Set([DT.ON_OFF_LIGHT, DT.DIMMABLE_LIGHT, DT.COLOR_TEMPERATURE_LIGHT, DT.EXTENDED_COLOR_LIGHT, DT.DIMMABLE_PLUG_IN_UNIT, DT.MOUNTED_DIMMABLE_LOAD_CONTROL]);

/** Window Covering `type` → HA cover device_class. */
const COVER_CLASS = { 0: 'shade', 1: 'shade', 2: 'shade', 3: 'shade', 4: 'curtain', 5: 'awning', 6: 'shutter', 7: 'blind', 8: 'blind', 9: 'shade' };

/** Thermostat `systemMode` ↔ HA hvac mode. */
const MODE_FROM = "{0: 'off', 1: 'auto', 3: 'cool', 4: 'heat', 5: 'heat', 7: 'fan_only', 8: 'dry'}";
const MODE_TO = "{'off': 0, 'auto': 1, 'cool': 3, 'heat': 4, 'fan_only': 7, 'dry': 8}";

const AIR_QUALITY = ['unknown', 'good', 'fair', 'moderate', 'poor', 'very_poor', 'extremely_poor'];

/** Concentration Measurement `measurementUnit` → HA unit. */
const CONC_UNIT = { 0: 'ppm', 1: 'ppb', 2: 'ppt', 3: 'mg/m³', 4: 'µg/m³', 5: 'ng/m³', 6: 'p/m³', 7: 'Bq/m³' };

/** The concentration clusters: HA device_class and the unit HA expects for it. */
const CONCENTRATIONS = [
    ['carbonDioxideConcentrationMeasurement', 'carbon_dioxide', 'Carbon dioxide', ['ppm']],
    ['carbonMonoxideConcentrationMeasurement', 'carbon_monoxide', 'Carbon monoxide', ['ppm']],
    ['pm1ConcentrationMeasurement', 'pm1', 'PM1', ['µg/m³']],
    ['pm25ConcentrationMeasurement', 'pm25', 'PM2.5', ['µg/m³']],
    ['pm10ConcentrationMeasurement', 'pm10', 'PM10', ['µg/m³']],
    ['totalVolatileOrganicCompoundsConcentrationMeasurement', null, 'VOC', []],
    ['nitrogenDioxideConcentrationMeasurement', 'nitrogen_dioxide', 'Nitrogen dioxide', ['µg/m³']],
    ['ozoneConcentrationMeasurement', 'ozone', 'Ozone', ['µg/m³']],
    ['formaldehydeConcentrationMeasurement', null, 'Formaldehyde', []],
    ['radonConcentrationMeasurement', null, 'Radon', []],
];

/** A discovery id or topic segment: everything outside `[A-Za-z0-9_-]` becomes `_` (SPEC §8). */
function cleanId(s) {
    return String(s).replace(/[^A-Za-z0-9_-]/g, '_');
}

function hex4(n) {
    return Number(n).toString(16).padStart(4, '0');
}

function str(v) {
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * The stable identity of a device from its (bridged) basic information: `uniqueId`, else
 * vendor id + product id + serial number. Null when the device carries neither.
 * @param {object} bi  basicInformation or bridgedDeviceBasicInformation attributes
 * @param {object} [parent]  the node's basic information, for a bridged device without its own vendor/product id
 */
function identityOf(bi, parent) {
    if (!bi) return null;
    const uid = str(bi.uniqueId);
    if (uid) return uid;
    const serial = str(bi.serialNumber);
    if (!serial) return null;
    const vid = bi.vendorId ?? parent?.vendorId;
    const pid = bi.productId;
    return `${vid === undefined || vid === null ? 'x' : hex4(vid)}_${pid === undefined || pid === null ? 'x' : hex4(pid)}_${serial}`;
}

/** The endpoint cache as a map endpointId → { id, types:Set, clusters:{ name: attrs }, name }. */
function indexEndpoints(endpoints) {
    const eps = new Map();
    for (const ep of endpoints ?? []) {
        const clusters = {};
        for (const c of ep.clusters ?? []) clusters[c.name] = c.attrs ?? {};
        const types = new Set((clusters.descriptor?.deviceTypeList ?? []).map((d) => Number(d?.deviceType ?? d)));
        eps.set(Number(ep.endpointId), { id: Number(ep.endpointId), types, clusters, name: ep.name ?? null });
    }
    return eps;
}

function partsOf(ep) {
    return (ep?.clusters.descriptor?.partsList ?? []).map(Number);
}

/** A room from the fixed or user labels ("room" / "area"), else null. Semantic tags: not read yet. */
function areaOf(...eps) {
    for (const ep of eps) {
        for (const cl of ['userLabel', 'fixedLabel']) {
            for (const l of ep?.clusters[cl]?.labelList ?? []) {
                if (/^(room|area|raum)$/i.test(String(l?.label ?? '').trim()) && str(l?.value)) return str(l.value);
            }
        }
    }
    return null;
}

/**
 * Split a node into the devices it announces: the node itself (its application endpoints that are
 * no bridged device's) and one device per Bridged Node endpoint with its sub-endpoints.
 * @returns {{ root: number|null, endpoints: number[] }[]}  root null = the node's own device
 */
function groupDevices(eps) {
    const owner = new Map();
    const bridged = [];
    for (const ep of eps.values()) {
        if (ep.id === 0 || !ep.types.has(DT.BRIDGED_NODE)) continue;
        const members = [ep.id];
        const queue = partsOf(ep);
        while (queue.length) {
            const id = queue.shift();
            if (members.includes(id) || !eps.has(id)) continue;
            members.push(id);
            queue.push(...partsOf(eps.get(id)));
        }
        members.sort((a, b) => a - b);
        for (const id of members) owner.set(id, ep.id);
        bridged.push({ root: ep.id, endpoints: members });
    }
    const own = [...eps.keys()].filter((id) => id !== 0 && !owner.has(id) && !eps.get(id).types.has(DT.AGGREGATOR)).sort((a, b) => a - b);
    return [{ root: null, endpoints: own }, ...bridged.sort((a, b) => a.root - b.root)];
}

/**
 * The entities of one endpoint. `ctx` gives the topics and the value expression.
 * @returns {{ item: string, label: string, main: boolean, cfg: object }[]}
 */
function endpointEntities(ep, ctx) {
    const out = [];
    const c = ep.clusters;
    const has = (cluster, attr) => c[cluster] !== undefined && c[cluster][attr] !== undefined;
    const V = ctx.V;
    const st = (cluster, attr) => ctx.status(ep.id, cluster, attr);
    const cmd = (cluster, name) => ctx.set(ep.id, cluster, name);
    const ev = (cluster, name) => ctx.event(ep.id, cluster, name);
    const bool = (onExpr) => `{{ 'ON' if ${onExpr} else 'OFF' }}`;
    const num = (expr) => `{{ None if ${V} is none else (${expr}) }}`;
    const types = ep.types;
    const canSet = ctx.canSet;
    const add = (item, label, main, cfg) => out.push({ item, label, main, cfg });

    // ── the endpoint's own function, from its device type ──
    const isLight = [...types].some((d) => LIGHTS.has(d));
    if (isLight && canSet && has('onOff', 'onOff')) {
        const cfg = {
            p: 'light',
            state_topic: st('onOff', 'onOff'),
            state_value_template: bool(V),
            command_topic: cmd('onOff', 'onOff'),
            // on first, then the level: moveToLevel leaves a light that is off dark
            on_command_type: 'first',
        };
        if (has('levelControl', 'currentLevel')) {
            Object.assign(cfg, {
                brightness_state_topic: st('levelControl', 'currentLevel'),
                brightness_value_template: num(V),
                brightness_command_topic: cmd('levelControl', 'currentLevel'),
                // Matter's level is 0–254: Home Assistant scales its 0–255
                brightness_scale: 254,
            });
        }
        const cc = c.colorControl;
        if (cc && cc.colorTemperatureMireds !== undefined) {
            Object.assign(cfg, {
                color_temp_state_topic: st('colorControl', 'colorTemperatureMireds'),
                color_temp_value_template: num(V),
                color_temp_command_topic: cmd('colorControl', 'colorTemperatureMireds'),
            });
            const lo = Number(cc.colorTempPhysicalMinMireds);
            const hi = Number(cc.colorTempPhysicalMaxMireds);
            if (lo > 0 && hi > lo) {
                cfg.min_kelvin = Math.round(1e6 / hi);
                cfg.max_kelvin = Math.round(1e6 / lo);
            }
        }
        if (cc && (types.has(DT.EXTENDED_COLOR_LIGHT) || cc.currentX !== undefined)) {
            // x and y are two attributes on two topics: Home Assistant cannot read a colour from
            // them, so the colour is command-only (it keeps the last colour it sent)
            Object.assign(cfg, {
                xy_command_topic: cmd('colorControl', 'moveToColor'),
                xy_command_template: '{"colorX": {{ (x * 65536) | round(0) | int }}, "colorY": {{ (y * 65536) | round(0) | int }}, "transitionTime": 0}',
            });
        }
        add('light', 'Light', true, cfg);
    } else if ((types.has(DT.ON_OFF_PLUG_IN_UNIT) || types.has(DT.MOUNTED_ON_OFF_CONTROL)) && canSet && has('onOff', 'onOff')) {
        add('switch', 'Switch', true, {
            p: 'switch',
            device_class: types.has(DT.ON_OFF_PLUG_IN_UNIT) ? 'outlet' : 'switch',
            state_topic: st('onOff', 'onOff'),
            value_template: bool(V),
            command_topic: cmd('onOff', 'onOff'),
        });
    }

    if (types.has(DT.WINDOW_COVERING) && c.windowCovering) {
        const wc = c.windowCovering;
        const cfg = { p: 'cover' };
        const cls = COVER_CLASS[Number(wc.type)];
        if (cls) cfg.device_class = cls;
        // Matter: 0 = open, 10000 = closed (1/100 %); Home Assistant: 100 = open
        if (wc.currentPositionLiftPercent100ths !== undefined) {
            cfg.position_topic = st('windowCovering', 'currentPositionLiftPercent100ths');
            cfg.position_template = num(`100 - (${V} / 100) | round(0) | int`);
            if (canSet) {
                cfg.set_position_topic = cmd('windowCovering', 'currentPositionLiftPercent100ths');
                cfg.set_position_template = '{{ (100 - position) * 100 }}';
            }
        }
        if (wc.currentPositionTiltPercent100ths !== undefined) {
            cfg.tilt_status_topic = st('windowCovering', 'currentPositionTiltPercent100ths');
            cfg.tilt_status_template = num(`100 - (${V} / 100) | round(0) | int`);
            if (canSet) {
                cfg.tilt_command_topic = cmd('windowCovering', 'currentPositionTiltPercent100ths');
                cfg.tilt_command_template = '{{ (100 - tilt_position) * 100 }}';
            }
        }
        // OPEN / CLOSE / STOP on one topic: the bridge maps them to upOrOpen / downOrClose / stopMotion
        if (canSet) cfg.command_topic = cmd('windowCovering', 'operationalStatus');
        add('cover', 'Cover', true, cfg);
    }

    if ((types.has(DT.THERMOSTAT) || types.has(DT.ROOM_AIR_CONDITIONER)) && c.thermostat) {
        const th = c.thermostat;
        const heat = th.occupiedHeatingSetpoint !== undefined;
        const cool = th.occupiedCoolingSetpoint !== undefined;
        const cfg = { p: 'climate', temperature_unit: 'C', precision: 0.1, temp_step: 0.5 };
        if (th.localTemperature !== undefined) {
            cfg.current_temperature_topic = st('thermostat', 'localTemperature');
            cfg.current_temperature_template = num(`${V} / 100`);
        }
        const modes = ['off'];
        if (heat) modes.push('heat');
        if (cool) modes.push('cool');
        if (heat && cool && (th.featureMap?.autoMode || th.minSetpointDeadBand !== undefined)) modes.push('auto');
        if (types.has(DT.ROOM_AIR_CONDITIONER) && c.fanControl) modes.push('fan_only');
        if (th.systemMode !== undefined) {
            cfg.modes = modes;
            cfg.mode_state_topic = st('thermostat', 'systemMode');
            cfg.mode_state_template = `{{ ${MODE_FROM}.get(${V}, 'off') }}`;
            if (canSet) {
                cfg.mode_command_topic = cmd('thermostat', 'systemMode');
                cfg.mode_command_template = `{{ ${MODE_TO}[value] }}`;
            }
        }
        const setpoint = (prefix, attr) => {
            cfg[`${prefix}_state_topic`] = st('thermostat', attr);
            cfg[`${prefix}_state_template`] = num(`${V} / 100`);
            if (canSet) {
                cfg[`${prefix}_command_topic`] = cmd('thermostat', attr);
                cfg[`${prefix}_command_template`] = '{{ (value * 100) | round(0) | int }}';
            }
        };
        if (heat && cool) {
            setpoint('temperature_low', 'occupiedHeatingSetpoint');
            setpoint('temperature_high', 'occupiedCoolingSetpoint');
        } else if (heat) setpoint('temperature', 'occupiedHeatingSetpoint');
        else if (cool) setpoint('temperature', 'occupiedCoolingSetpoint');
        const lim = (...names) =>
            names
                .map((n) => th[n])
                .filter((v) => typeof v === 'number')
                .map((v) => v / 100);
        const mins = lim(heat && 'absMinHeatSetpointLimit', heat && 'minHeatSetpointLimit', cool && 'absMinCoolSetpointLimit', cool && 'minCoolSetpointLimit');
        const maxs = lim(heat && 'absMaxHeatSetpointLimit', heat && 'maxHeatSetpointLimit', cool && 'absMaxCoolSetpointLimit', cool && 'maxCoolSetpointLimit');
        if (mins.length) cfg.min_temp = Math.min(...mins);
        if (maxs.length) cfg.max_temp = Math.max(...maxs);
        add('climate', 'Climate', true, cfg);
    }

    if (types.has(DT.FAN) && c.fanControl && canSet) {
        const fc = c.fanControl;
        const cfg = {
            p: 'fan',
            // fanMode 0 = off; 4 = "on" (the device picks its speed, Matter: the highest)
            state_topic: st('fanControl', 'fanMode'),
            state_value_template: `{{ '0' if ${V} == 0 else '4' }}`,
            command_topic: cmd('fanControl', 'fanMode'),
            payload_on: '4',
            payload_off: '0',
        };
        if (fc.percentSetting !== undefined || fc.percentCurrent !== undefined) {
            cfg.percentage_state_topic = st('fanControl', fc.percentCurrent !== undefined ? 'percentCurrent' : 'percentSetting');
            cfg.percentage_value_template = num(V);
            cfg.percentage_command_topic = cmd('fanControl', 'percentSetting');
        }
        add('fan', 'Fan', true, cfg);
    }

    if (types.has(DT.DOOR_LOCK) && has('doorLock', 'lockState') && canSet) {
        const cfg = {
            p: 'lock',
            state_topic: st('doorLock', 'lockState'),
            value_template: `{{ {0: 'JAMMED', 1: 'LOCKED', 2: 'UNLOCKED', 3: 'OPEN'}.get(${V}, 'None') }}`,
            // LOCK / UNLOCK / OPEN: the bridge maps them to lockDoor / unlockDoor / unboltDoor
            command_topic: cmd('doorLock', 'lockState'),
        };
        if (c.doorLock.featureMap?.unbolting) cfg.payload_open = 'OPEN';
        add('lock', 'Lock', true, cfg);
    }

    if (types.has(DT.CONTACT_SENSOR) && has('booleanState', 'stateValue')) {
        // Matter's true is the closed contact; Home Assistant's "on" the open one
        add('contact', 'Contact', true, {
            p: 'binary_sensor',
            device_class: 'opening',
            state_topic: st('booleanState', 'stateValue'),
            value_template: `{{ 'OFF' if ${V} else 'ON' }}`,
        });
    }
    for (const [dt, cls, item, label] of [
        [DT.WATER_LEAK_DETECTOR, 'moisture', 'leak', 'Leak'],
        [DT.RAIN_SENSOR, 'moisture', 'rain', 'Rain'],
        [DT.WATER_FREEZE_DETECTOR, 'cold', 'freeze', 'Freeze'],
    ]) {
        if (types.has(dt) && has('booleanState', 'stateValue'))
            add(item, label, true, { p: 'binary_sensor', device_class: cls, state_topic: st('booleanState', 'stateValue'), value_template: bool(V) });
    }
    if (types.has(DT.OCCUPANCY_SENSOR) && has('occupancySensing', 'occupancy')) {
        add('occupancy', 'Occupancy', true, {
            p: 'binary_sensor',
            device_class: 'occupancy',
            state_topic: st('occupancySensing', 'occupancy'),
            // a bitmap: { occupied } from matter.js, a number from elsewhere
            value_template: bool(`(${V}.occupied if ${V} is mapping else (${V} | int(0)) % 2 == 1)`),
        });
    }
    if (types.has(DT.SMOKE_CO_ALARM) && c.smokeCoAlarm) {
        if (c.smokeCoAlarm.smokeState !== undefined)
            add('smoke', 'Smoke', true, { p: 'binary_sensor', device_class: 'smoke', state_topic: st('smokeCoAlarm', 'smokeState'), value_template: bool(`${V} != 0`) });
        if (c.smokeCoAlarm.coState !== undefined)
            add('co', 'Carbon monoxide', true, {
                p: 'binary_sensor',
                device_class: 'carbon_monoxide',
                state_topic: st('smokeCoAlarm', 'coState'),
                value_template: bool(`${V} != 0`),
            });
    }

    if (types.has(DT.ROBOTIC_VACUUM_CLEANER) && canSet && (c.rvcOperationalState || c.rvcRunMode)) {
        // Home Assistant's MQTT vacuum reads its state only as its own JSON — command-only here
        add('vacuum', 'Vacuum', true, {
            p: 'vacuum',
            command_topic: cmd('rvcOperationalState', 'operationalState'),
            supported_features: ['start', 'pause', 'stop', 'return_home'],
        });
    }

    if (types.has(DT.GENERIC_SWITCH) && c.switch && ctx.hasEvents) {
        const f = c.switch.featureMap ?? {};
        const evs = [];
        if (f.latchingSwitch)
            evs.push([
                'latched',
                'switchLatched',
                '{"event_type": "position_{{ V.newPosition }}"}',
                Array.from({ length: Number(c.switch.numberOfPositions ?? 2) }, (_, i) => `position_${i}`),
            ]);
        if (f.momentarySwitch || !f.latchingSwitch) evs.push(['press', 'initialPress', '{"event_type": "press"}', ['press']]);
        if (f.momentarySwitchRelease) evs.push(['release', 'shortRelease', '{"event_type": "release"}', ['release']]);
        if (f.momentarySwitchLongPress) evs.push(['long_press', 'longPress', '{"event_type": "long_press"}', ['long_press']]);
        if (f.momentarySwitchMultiPress) {
            const max = Math.max(2, Number(c.switch.multiPressMax ?? 2));
            evs.push([
                'multi_press',
                'multiPressComplete',
                '{"event_type": "multi_press_{{ V.totalNumberOfPressesCounted }}"}',
                Array.from({ length: max }, (_, i) => `multi_press_${i + 1}`),
            ]);
        }
        for (const [item, event, tpl, eventTypes] of evs) {
            add(item, item === 'press' ? 'Button' : `Button ${item.replace('_', ' ')}`, item === 'press' || item === 'latched', {
                p: 'event',
                device_class: 'button',
                state_topic: ev('switch', event),
                value_template: tpl.replace(/\bV\b/g, V),
                event_types: eventTypes,
            });
        }
    }

    // ── measurements: from the clusters, whatever the device type ──
    const sensor = (item, label, cluster, attr, extra) => {
        if (!has(cluster, attr)) return;
        add(item, label, false, { p: 'sensor', state_topic: st(cluster, attr), state_class: 'measurement', ...extra });
    };
    sensor('temperature', 'Temperature', 'temperatureMeasurement', 'measuredValue', { device_class: 'temperature', unit_of_measurement: '°C', value_template: num(`${V} / 100`) });
    sensor('humidity', 'Humidity', 'relativeHumidityMeasurement', 'measuredValue', { device_class: 'humidity', unit_of_measurement: '%', value_template: num(`${V} / 100`) });
    // 0.1 kPa = 1 hPa
    sensor('pressure', 'Pressure', 'pressureMeasurement', 'measuredValue', { device_class: 'pressure', unit_of_measurement: 'hPa', value_template: num(V) });
    sensor('illuminance', 'Illuminance', 'illuminanceMeasurement', 'measuredValue', {
        device_class: 'illuminance',
        unit_of_measurement: 'lx',
        // 10000 × log10(lx) + 1
        value_template: num(`(10 ** ((${V} - 1) / 10000)) | round(1) if ${V} > 0 else 0`),
    });
    if (has('airQuality', 'airQuality')) {
        add('air_quality', 'Air quality', false, {
            p: 'sensor',
            device_class: 'enum',
            options: AIR_QUALITY,
            state_topic: st('airQuality', 'airQuality'),
            value_template: `{{ ${JSON.stringify(AIR_QUALITY).replace(/"/g, "'")}[${V}] if ${V} is number and ${V} < ${AIR_QUALITY.length} else 'unknown' }}`,
        });
    }
    for (const [cluster, cls, label, units] of CONCENTRATIONS) {
        if (!has(cluster, 'measuredValue')) continue;
        const unit = CONC_UNIT[Number(c[cluster].measurementUnit)] ?? null;
        const extra = { value_template: num(V) };
        if (unit) extra.unit_of_measurement = unit;
        if (cls && unit && units.includes(unit)) extra.device_class = cls;
        else if (cluster === 'totalVolatileOrganicCompoundsConcentrationMeasurement' && unit === 'µg/m³') extra.device_class = 'volatile_organic_compounds';
        else if (cluster === 'totalVolatileOrganicCompoundsConcentrationMeasurement' && (unit === 'ppm' || unit === 'ppb')) extra.device_class = 'volatile_organic_compounds_parts';
        sensor(t.snake(cluster.replace(/ConcentrationMeasurement$/, '')), label, cluster, 'measuredValue', extra);
    }
    sensor('power', 'Power', 'electricalPowerMeasurement', 'activePower', { device_class: 'power', unit_of_measurement: 'W', value_template: num(`${V} / 1000`) });
    sensor('voltage', 'Voltage', 'electricalPowerMeasurement', 'voltage', { device_class: 'voltage', unit_of_measurement: 'V', value_template: num(`${V} / 1000`) });
    sensor('current', 'Current', 'electricalPowerMeasurement', 'activeCurrent', { device_class: 'current', unit_of_measurement: 'A', value_template: num(`${V} / 1000`) });
    sensor('energy', 'Energy', 'electricalEnergyMeasurement', 'cumulativeEnergyImported', {
        device_class: 'energy',
        unit_of_measurement: 'kWh',
        state_class: 'total_increasing',
        // { energy } in mWh
        value_template: `{{ None if ${V} is none or ${V}.energy is not defined else (${V}.energy / 1000000) }}`,
    });
    sensor('energy_exported', 'Energy exported', 'electricalEnergyMeasurement', 'cumulativeEnergyExported', {
        device_class: 'energy',
        unit_of_measurement: 'kWh',
        state_class: 'total_increasing',
        value_template: `{{ None if ${V} is none or ${V}.energy is not defined else (${V}.energy / 1000000) }}`,
    });
    // battery on an application endpoint (endpoint 0 is not bridged): 0–200 → %
    sensor('battery', 'Battery', 'powerSource', 'batPercentRemaining', {
        device_class: 'battery',
        unit_of_measurement: '%',
        entity_category: 'diagnostic',
        value_template: num(`(${V} / 2) | round(0) | int`),
    });
    return out;
}

/** An availability entry: the four keys of SPEC §8, nothing else. */
function availabilityEntry(topic, valueTemplate) {
    return { topic, payload_available: 'online', payload_not_available: 'offline', value_template: valueTemplate };
}

/**
 * The discovery configs of one node.
 *
 * @param {object} o
 * @param {string} o.nodeId
 * @param {string} o.device                the node's MQTT name (fills `${device}`)
 * @param {{ endpointId: number, clusters: { name: string, attrs: object }[], name?: string|null }[]} o.endpoints
 * @param {object} o.templates             the bridge's topic templates
 * @param {string} o.format                'plain' | 'basic' | 'extended'
 * @param {string} [o.prefix]              the discovery prefix
 * @param {{ name: string, sw_version?: string, support_url?: string }} o.origin
 * @param {string|null} [o.sheTopic]       she's own `<name>/connected` (her last will)
 * @param {(topic: string) => boolean} [o.known]  whether a topic has a retained value already
 * @returns {{ configs: { id: string, topic: string, payload: object }[], fallback: boolean }}
 *   `fallback`: the node carries no uniqueId and no serial number — its id is the node id
 */
function buildNodeConfigs({ nodeId, device, endpoints, templates, format, prefix = DEFAULT_PREFIX, origin, sheTopic = null, known = () => true }) {
    const eps = indexEndpoints(endpoints);
    const root = eps.get(0);
    if (!root || !templates?.attribute) return { configs: [], fallback: false };
    const bi = root.clusters.basicInformation ?? {};
    const nodeIdentity = identityOf(bi, bi);
    const nodeKey = nodeIdentity ?? `node_${nodeId}`;
    const nodeDevId = cleanId(ID_PREFIX + nodeKey);
    const V = format === 'plain' ? 'value_json' : 'value_json.val';
    const vars = (endpoint, cluster, name) => ({
        device,
        nodeId: String(nodeId),
        endpoint: String(endpoint),
        cluster: t.snake(cluster),
        attribute: t.snake(name),
        event: t.snake(name),
        attributeOrCommand: t.snake(name),
    });
    const ctx = {
        V,
        status: (ep, cluster, attr) => t.fill(templates.attribute, vars(ep, cluster, attr)),
        set: (ep, cluster, name) => t.fill(templates.set, vars(ep, cluster, name)),
        event: (ep, cluster, name) => t.fill(templates.event, vars(ep, cluster, name)),
        canSet: !!templates.set,
        hasEvents: !!templates.event,
    };

    const baseAvailability = [];
    if (templates.connected) baseAvailability.push(availabilityEntry(templates.connected, "{{ 'online' if value | int(0) >= 2 else 'offline' }}"));
    if (sheTopic) baseAvailability.push(availabilityEntry(sheTopic, "{{ 'online' if value | int(0) >= 2 else 'offline' }}"));
    const onlineTopic = templates.online ? t.fill(templates.online, vars(0, '', '')) : null;
    const boolAvail = `{{ 'online' if ${V} else 'offline' }}`;
    const nodeAvailability = [...baseAvailability];
    if (onlineTopic && known(onlineTopic)) nodeAvailability.push(availabilityEntry(onlineTopic, boolAvail));

    const configs = [];
    const groups = groupDevices(eps);
    const hasBridged = groups.length > 1;
    for (const g of groups) {
        const bridgedEp = g.root === null ? null : eps.get(g.root);
        const bbi = bridgedEp?.clusters.bridgedDeviceBasicInformation ?? {};
        let devId;
        let devBlock;
        const availability = [...nodeAvailability];
        if (g.root === null) {
            devId = nodeDevId;
            devBlock = {
                identifiers: [devId],
                name: str(bi.nodeLabel) ?? str(bi.productName) ?? `Matter node ${nodeId}`,
                manufacturer: str(bi.vendorName),
                model: str(bi.productName),
                sw_version: str(bi.softwareVersionString),
                hw_version: str(bi.hardwareVersionString),
                serial_number: str(bi.serialNumber),
                suggested_area: areaOf(root, ...g.endpoints.map((id) => eps.get(id))),
            };
        } else {
            const ident = identityOf(bbi, bi);
            devId = cleanId(ident ? ID_PREFIX + ident : `${nodeDevId}_${g.root}`);
            devBlock = {
                identifiers: [devId],
                name: str(bbi.nodeLabel) ?? str(bbi.productName) ?? bridgedEp.name ?? `${str(bi.nodeLabel) ?? str(bi.productName) ?? `Matter node ${nodeId}`} ${g.root}`,
                manufacturer: str(bbi.vendorName),
                model: str(bbi.productName),
                sw_version: str(bbi.softwareVersionString),
                hw_version: str(bbi.hardwareVersionString),
                serial_number: str(bbi.serialNumber),
                suggested_area: areaOf(...g.endpoints.map((id) => eps.get(id))),
                via_device: nodeDevId,
            };
            if (bbi.reachable !== undefined) {
                const reach = ctx.status(g.root, 'bridgedDeviceBasicInformation', 'reachable');
                if (known(reach)) availability.push(availabilityEntry(reach, boolAvail));
            }
        }
        for (const k of Object.keys(devBlock)) if (devBlock[k] === null || devBlock[k] === undefined) delete devBlock[k];

        // entities: endpoint numbers for the node's own endpoints (fixed by its firmware), the
        // position within the device for a bridged one (a bridge may renumber after a reset)
        const entities = [];
        g.endpoints.forEach((epId, i) => {
            const epKey = g.root === null ? String(epId) : String(i);
            for (const e of endpointEntities(eps.get(epId), ctx)) entities.push({ ...e, epId, epKey });
        });
        if (g.root === null && entities.length === 0 && !hasBridged) continue;
        if (g.root !== null && entities.length === 0) continue;
        const mains = entities.filter((e) => e.main).length;
        const counts = {};
        for (const e of entities) counts[e.item] = (counts[e.item] ?? 0) + 1;
        const components = {};
        for (const e of entities) {
            const objectId = `${e.epKey}_${e.item}`;
            let name;
            if (e.main && mains === 1) name = null;
            else if (counts[e.item] > 1) name = `${eps.get(e.epId).name ?? e.label} ${e.epKey}`;
            else name = e.label;
            components[objectId] = { ...e.cfg, name, unique_id: `${devId}_${objectId}` };
        }
        let deviceAvailability = availability;
        if (g.root === null && hasBridged && entities.length === 0 && onlineTopic && known(onlineTopic)) {
            // a bridge node without functions of its own: one connectivity entity, so the bridged
            // devices' via_device has a device to point at; available while the bridge runs
            components.connectivity = {
                p: 'binary_sensor',
                device_class: 'connectivity',
                entity_category: 'diagnostic',
                name: 'Connectivity',
                state_topic: onlineTopic,
                value_template: `{{ 'ON' if ${V} else 'OFF' }}`,
                unique_id: `${devId}_connectivity`,
            };
            deviceAvailability = baseAvailability;
        }
        if (!Object.keys(components).length) continue;
        const payload = { device: devBlock, origin, components };
        if (deviceAvailability.length) {
            payload.availability = deviceAvailability;
            if (deviceAvailability.length > 1) payload.availability_mode = 'all';
        }
        configs.push({ id: devId, topic: `${prefix}/device/${devId}/config`, payload });
    }
    return { configs, fallback: nodeIdentity === null };
}

/** Whether a retained topic is one of our discovery configs under the prefix (its id, or null). */
function ourConfigId(topic, prefix = DEFAULT_PREFIX) {
    const m = String(topic).match(/^(.*)\/device\/([^/]+)\/config$/);
    if (!m || m[1] !== prefix || !m[2].startsWith(ID_PREFIX)) return null;
    return m[2];
}

module.exports = { DEFAULT_PREFIX, ID_PREFIX, DT, buildNodeConfigs, identityOf, groupDevices, indexEndpoints, ourConfigId, cleanId };
