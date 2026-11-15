'use strict';

const { createAnnouncer, validateAnnouncement } = require('../../src/lib/announce');
const { analyzeDiscovery } = require('../../src/lib/ha-discovery');
const { scanPublishTopics, scanAnnouncedTopics } = require('../../src/lib/command-topics');

/** an announcer with a fake broker, a manual flush queue and manual timers */
function setup({ connected = true, graceMs = 5000 } = {}) {
    const sent = [];
    const retained = new Map();
    const state = { connected };
    let queued = [];
    const timers = new Set();
    const a = createAnnouncer({
        instance: 'she',
        origin: { name: 'she', sw_version: '9.9.9' },
        graceMs,
        publish: (topic, payload) => {
            if (!state.connected) return false;
            sent.push({ topic, payload });
            if (payload === '') retained.delete(topic);
            else retained.set(topic, payload);
            return true;
        },
        defer: (fn) => queued.push(fn),
        setTimer: (fn, ms) => {
            const t = { fn, ms };
            timers.add(t);
            return t;
        },
        clearTimer: (t) => timers.delete(t),
    });
    return {
        a,
        sent,
        retained,
        state,
        tick() {
            const q = queued;
            queued = [];
            q.forEach((fn) => fn());
        },
        elapse() {
            const ts = [...timers];
            timers.clear();
            ts.forEach((t) => t.fn());
        },
        timers,
        config: (topic) => JSON.parse(retained.get(topic)),
    };
}

const LAMP = { component: 'switch', name: 'Garden light', state_topic: 'garden/status/light', command_topic: 'garden/set/light' };
const TOPIC = 'homeassistant/device/she_she_script_lights_garden/config';

describe('she.mqtt.announce — announce', () => {
    it('publishes one retained device config: the script as device, origin she, she availability, the entity', () => {
        const t = setup();
        const h = t.a.announce('/scripts/lights/garden.js', 'lights/garden', LAMP);
        expect(h).toMatchObject({ id: 'she_she_script_lights_garden_garden_light', device: 'she_she_script_lights_garden', topic: TOPIC });
        expect(t.sent).toHaveLength(0); // coalesced to the next tick
        t.tick();
        expect(t.sent).toHaveLength(1);
        expect(t.config(TOPIC)).toEqual({
            device: { identifiers: ['she_she_script_lights_garden'], name: 'lights/garden', manufacturer: 'she', model: 'Script' },
            origin: { name: 'she', sw_version: '9.9.9' },
            availability: [{ topic: 'she/connected', value_template: "{{ 'online' if (value | int(0)) >= 2 else 'offline' }}" }],
            components: {
                garden_light: {
                    platform: 'switch',
                    name: 'Garden light',
                    state_topic: 'garden/status/light',
                    command_topic: 'garden/set/light',
                    unique_id: 'she_she_script_lights_garden_garden_light',
                },
            },
        });
    });

    it('availability entries carry only the four keys Home Assistant accepts in a list', () => {
        const t = setup();
        t.a.announce('/s/a.js', 'a', { ...LAMP, availability: [{ topic: 'garden/connected', payload_available: '2', payload_not_available: '0' }] });
        t.tick();
        const cfg = t.config('homeassistant/device/she_she_script_a/config');
        for (const e of [...cfg.availability, ...cfg.components.garden_light.availability]) {
            expect(Object.keys(e).every((k) => ['topic', 'payload_available', 'payload_not_available', 'value_template'].includes(k))).toBe(true);
        }
        expect(cfg.components.garden_light.availability.map((e) => e.topic)).toEqual(['she/connected', 'garden/connected']);
        expect(cfg.components.garden_light.availability_mode).toBe('all');
    });

    it('several entities of a script in one tick: one publish with all of them', () => {
        const t = setup();
        t.a.announce('/s/garden.js', 'garden', LAMP);
        t.a.announce('/s/garden.js', 'garden', { component: 'sensor', name: 'Soil moisture', state_topic: 'garden/status/soil', unit_of_measurement: '%' });
        t.tick();
        expect(t.sent).toHaveLength(1);
        expect(Object.keys(t.config('homeassistant/device/she_she_script_garden/config').components)).toEqual(['garden_light', 'soil_moisture']);
    });

    it('a named device, shared by two scripts; rooms → suggested_area', () => {
        const t = setup();
        t.a.announce('/s/a.js', 'a', { ...LAMP, device: { name: 'Garden', model: 'Pump controller' }, rooms: ['Garten', 'Terrasse'] });
        t.a.announce('/s/b.js', 'b', { component: 'binary_sensor', name: 'Rain', state_topic: 'garden/status/rain', device: 'Garden' });
        t.tick();
        const cfg = t.config('homeassistant/device/she_she_garden/config');
        expect(cfg.device).toEqual({ identifiers: ['she_she_garden'], name: 'Garden', manufacturer: 'she', model: 'Pump controller', suggested_area: 'Garten' });
        expect(Object.keys(cfg.components)).toEqual(['garden_light', 'rain']);
        // device.rooms wins over an entity's rooms; device.id names the device
        t.a.announce('/s/c.js', 'c', { ...LAMP, device: { name: 'Pump', id: 'pump-1', rooms: 'Keller' }, rooms: 'Garten' });
        t.tick();
        expect(t.config('homeassistant/device/she_she_pump-1/config').device.suggested_area).toBe('Keller');
    });

    it("is read back by she's own discovery analysis as one device with its topics", () => {
        const t = setup();
        t.a.announce('/s/garden.js', 'garden', LAMP);
        t.tick();
        const entries = [...t.retained].map(([topic, payload]) => [topic, { val: JSON.parse(payload), payload }]);
        const { devices } = analyzeDiscovery(entries);
        expect(devices).toHaveLength(1);
        expect(devices[0].name).toBe('garden');
    });

    it('the discovery prefix is configurable', () => {
        const sent = [];
        const a = createAnnouncer({ prefix: 'ha/', instance: 'she2', origin: { name: 'she' }, publish: (topic) => sent.push(topic) && true, defer: (fn) => fn() });
        a.announce('/s/x.js', 'x', LAMP);
        expect(sent).toEqual(['ha/device/she_she2_script_x/config']);
    });
});

describe('she.mqtt.announce — re-announce', () => {
    it('announcing the same id again replaces the entity; an identical announcement publishes nothing', () => {
        const t = setup();
        t.a.announce('/s/garden.js', 'garden', LAMP);
        t.tick();
        t.a.announce('/s/garden.js', 'garden', LAMP);
        t.tick();
        expect(t.sent).toHaveLength(1);
        t.a.announce('/s/garden.js', 'garden', { ...LAMP, icon: 'mdi:lightbulb' });
        t.tick();
        expect(t.sent).toHaveLength(2);
        expect(t.config('homeassistant/device/she_she_script_garden/config').components.garden_light.icon).toBe('mdi:lightbulb');
    });

    it('every config again on a broker connect, also the ones that could not go out while disconnected', () => {
        const t = setup({ connected: false });
        t.a.announce('/s/garden.js', 'garden', LAMP);
        t.tick();
        expect(t.sent).toHaveLength(0);
        t.state.connected = true;
        t.a.republish();
        expect(t.sent.map((m) => m.topic)).toEqual(['homeassistant/device/she_she_script_garden/config']);
        t.a.republish(); // a reconnect publishes again although nothing changed
        expect(t.sent).toHaveLength(2);
    });

    it('another script cannot take over an entity id of a shared device', () => {
        const t = setup();
        t.a.announce('/s/a.js', 'a', { ...LAMP, device: 'Garden' });
        expect(() => t.a.announce('/s/b.js', 'b', { ...LAMP, device: 'Garden' })).toThrow(/announced by another script/);
    });
});

describe('she.mqtt.announce — clear', () => {
    it('remove(): the entity goes, a device left empty is cleared at once', () => {
        const t = setup();
        const lamp = t.a.announce('/s/garden.js', 'garden', LAMP);
        const soil = t.a.announce('/s/garden.js', 'garden', { component: 'sensor', name: 'Soil', state_topic: 'garden/status/soil' });
        t.tick();
        expect(lamp.remove()).toBe(true);
        expect(lamp.remove()).toBe(false);
        t.tick();
        expect(Object.keys(t.config(TOPIC.replace('lights_garden', 'garden')).components)).toEqual(['soil']);
        soil.remove();
        t.tick();
        expect(t.sent.at(-1)).toEqual({ topic: 'homeassistant/device/she_she_script_garden/config', payload: '' });
        expect(t.a.list()).toEqual([]);
    });

    it('script stop: cleared after the grace period', () => {
        const t = setup();
        t.a.announce('/s/garden.js', 'garden', LAMP);
        t.tick();
        t.a.unload('/s/garden.js');
        t.tick();
        expect(t.sent).toHaveLength(1); // nothing yet
        expect([...t.timers][0].ms).toBe(5000);
        t.elapse();
        expect(t.sent.at(-1)).toEqual({ topic: 'homeassistant/device/she_she_script_garden/config', payload: '' });
        expect(t.retained.size).toBe(0);
    });

    it('a reload that announces the same entities again publishes nothing; one that drops an entity removes it', () => {
        const t = setup();
        t.a.announce('/s/garden.js', 'garden', LAMP);
        t.a.announce('/s/garden.js', 'garden', { component: 'sensor', name: 'Soil', state_topic: 'garden/status/soil' });
        t.tick();
        // reload with the same code
        t.a.unload('/s/garden.js');
        t.a.announce('/s/garden.js', 'garden', LAMP);
        t.a.announce('/s/garden.js', 'garden', { component: 'sensor', name: 'Soil', state_topic: 'garden/status/soil' });
        t.tick();
        expect(t.timers.size).toBe(0);
        expect(t.sent).toHaveLength(1);
        // reload without the sensor
        t.a.unload('/s/garden.js');
        t.a.announce('/s/garden.js', 'garden', LAMP);
        t.tick();
        expect(t.sent).toHaveLength(2);
        expect(Object.keys(t.config('homeassistant/device/she_she_script_garden/config').components)).toEqual(['garden_light']);
    });

    it('a shared device keeps the entities of the scripts that still run', () => {
        const t = setup({ graceMs: 0 });
        t.a.announce('/s/a.js', 'a', { ...LAMP, device: 'Garden' });
        t.a.announce('/s/b.js', 'b', { component: 'binary_sensor', name: 'Rain', state_topic: 'garden/status/rain', device: 'Garden' });
        t.tick();
        t.a.unload('/s/a.js');
        t.tick();
        expect(Object.keys(t.config('homeassistant/device/she_she_garden/config').components)).toEqual(['rain']);
    });

    it('a reconnect during the grace period does not clear early; stop() keeps the configs retained', () => {
        const t = setup();
        t.a.announce('/s/garden.js', 'garden', LAMP);
        t.tick();
        t.a.unload('/s/garden.js');
        t.a.republish();
        expect(t.sent).toHaveLength(1);
        t.a.stop();
        expect(t.timers.size).toBe(0);
        expect(t.retained.size).toBe(1);
    });

    it('a device never published is not cleared', () => {
        const t = setup({ graceMs: 0 });
        t.a.announce('/s/garden.js', 'garden', LAMP);
        t.a.unload('/s/garden.js');
        t.tick();
        expect(t.sent).toHaveLength(0);
    });
});

describe('she.mqtt.announce — validation', () => {
    const bad = (cfg) => () => validateAnnouncement(cfg);

    it('needs an object with a known component', () => {
        expect(bad(null)).toThrow(/expects an object/);
        expect(bad('switch')).toThrow(/expects an object/);
        expect(bad({ ...LAMP, component: 'media_player' })).toThrow(/component must be a Home Assistant MQTT platform/);
        expect(bad({ name: 'x', state_topic: 'a/b' })).toThrow(/component/);
    });

    it('needs a name or an id; null names the device main entity', () => {
        expect(bad({ component: 'sensor', state_topic: 'a/status/b' })).toThrow(/needs a name/);
        expect(bad({ component: 'sensor', name: '', state_topic: 'a/status/b' })).toThrow(/name must be/);
        expect(bad({ component: 'sensor', name: '!!!', state_topic: 'a/status/b' })).toThrow(/pass an id/);
        expect(validateAnnouncement({ component: 'sensor', name: null, id: 'main', state_topic: 'a/status/b' }).objectId).toBe('main');
        expect(validateAnnouncement({ component: 'sensor', name: 'Größe Ü', state_topic: 'a/status/b' }).objectId).toBe('grosse_u');
    });

    it('the topic a platform needs, no wildcards, topics are strings', () => {
        expect(bad({ component: 'sensor', name: 'x' })).toThrow(/needs a state_topic/);
        expect(bad({ component: 'switch', name: 'x', state_topic: 'a/status/b' })).toThrow(/needs a command_topic/);
        expect(bad({ ...LAMP, state_topic: 'garden/status/#' })).toThrow(/wildcard/);
        expect(bad({ ...LAMP, json_attributes_topic: 5 })).toThrow(/json_attributes_topic must be a non-empty topic/);
        expect(bad({ 'component': 'sensor', 'name': 'x', '~': 'g/+', 'stat_t': '~/status/x' })).toThrow(/wildcard/);
    });

    it('keys she sets itself are refused', () => {
        expect(bad({ ...LAMP, unique_id: 'x' })).toThrow(/"unique_id" is not allowed/);
        expect(bad({ ...LAMP, platform: 'switch' })).toThrow(/use component/);
        expect(bad({ ...LAMP, origin: {} })).toThrow(/origin is she/);
        expect(bad({ ...LAMP, availability_topic: 'x/connected' })).toThrow(/availability list/);
        expect(bad({ ...LAMP, avty_tpl: '{{ value }}' })).toThrow(/single-topic form/);
        expect(bad({ ...LAMP, device: { name: 'G', identifiers: ['x'] } })).toThrow(/device\.identifiers is not allowed/);
    });

    it('an availability entry with another key would make Home Assistant reject the whole device', () => {
        expect(bad({ ...LAMP, availability: [{ topic: 'x/connected', availability_template: '{{ 1 }}' }] })).toThrow(/may only carry/);
        expect(bad({ ...LAMP, availability: [{ payload_available: '1' }] })).toThrow(/topic must be/);
        expect(bad({ ...LAMP, availability: ['x/connected'] })).toThrow(/must be an object/);
    });

    it('device and rooms', () => {
        expect(bad({ ...LAMP, device: '' })).toThrow(/device must be/);
        expect(bad({ ...LAMP, device: { model: 'x' } })).toThrow(/device\.name/);
        expect(bad({ ...LAMP, device: 5 })).toThrow(/device must be/);
        expect(bad({ ...LAMP, rooms: [''] })).toThrow(/rooms must be/);
        expect(bad({ ...LAMP, rooms: 3 })).toThrow(/rooms must be/);
        expect(validateAnnouncement({ ...LAMP, rooms: ' Bad ' }).rooms).toEqual(['Bad']);
    });

    it('only JSON values', () => {
        expect(bad({ ...LAMP, icon: () => 'x' })).toThrow(/cannot be sent as JSON/);
        expect(bad({ ...LAMP, min: Infinity })).toThrow(/finite/);
    });

    it('takes objects made in a script context (another realm)', () => {
        const cfg = require('vm').runInNewContext(
            "({ component: 'switch', name: 'Pump', command_topic: 'g/set/pump', device: { name: 'G' }, availability: [{ topic: 'g/connected' }] })",
        );
        expect(validateAnnouncement(cfg).objectId).toBe('pump');
        expect(() => validateAnnouncement(new Map())).toThrow(/expects an object/);
    });

    it('the announcer throws the same errors and publishes nothing', () => {
        const t = setup();
        expect(() => t.a.announce('/s/a.js', 'a', { component: 'switch' })).toThrow(TypeError);
        t.tick();
        expect(t.sent).toHaveLength(0);
    });
});

describe('she.mqtt.announce — the status-topic lint', () => {
    it('an announced state topic counts as deliberate; the command topic does not', () => {
        const t = setup();
        t.a.announce('/s/garden.js', 'garden', { ...LAMP, json_attributes_topic: 'garden/status/light_attrs' });
        expect(t.a.isAnnouncedState('garden/status/light')).toBe(true);
        expect(t.a.isAnnouncedState('garden/status/light_attrs')).toBe(true);
        expect(t.a.isAnnouncedState('garden/set/light')).toBe(false);
        expect(t.a.isAnnouncedState('other/status/light')).toBe(false);
    });

    it('the ~ base is applied', () => {
        const t = setup();
        t.a.announce('/s/garden.js', 'garden', { 'component': 'sensor', 'name': 'Soil', '~': 'garden', 'state_topic': '~/status/soil' });
        expect(t.a.isAnnouncedState('garden/status/soil')).toBe(true);
    });

    it('the load-time scan leaves out a literal state topic the script announces', () => {
        const src = [
            "she.mqtt.announce({ component: 'switch', name: 'Pump', state_topic: 'garden/status/pump', command_topic: 'garden/set/pump' });",
            "she.mqtt.pub('garden/status/pump', true);",
            "she.mqtt.pub('other/status/x', 1);",
        ].join('\n');
        expect([...scanAnnouncedTopics(src)]).toEqual(['garden/status/pump']);
        expect(scanPublishTopics(src).map((h) => h.topic)).toEqual(['other/status/x']);
    });
});
