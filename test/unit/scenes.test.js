/**
 * The scene engine: matching, recall, deactivate, groups, topics, discovery — on the home model's
 * documents and the entity layer, with devices that answer like real ones.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const SheDBCore = require('../../src/lib/shedb-core');
const StateStore = require('../../src/lib/state-store');
const parsePayload = require('../../src/lib/parse-payload');
const { HomeModel } = require('../../src/lib/home-model');
const { HomeEntities } = require('../../src/lib/home-entities');
const { SceneEngine, validateScene, validateGroup, parseSet, slug } = require('../../src/lib/scenes');
const { createAnnouncer } = require('../../src/lib/announce');
const haEntities = require('../../src/lib/ha-entities');
const home = require('../../src/web/home');
const homeEntities = require('../../src/web/home-entities');
const scenesWeb = require('../../src/web/scenes');
const sceneSandbox = require('../../src/sandbox/scene-sandbox');
const { executeTool, TOOL_DEFINITIONS } = require('../../src/web/ai-tools');

const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const J = JSON.stringify;

const A = 'she/entity/lamp_a';
const B = 'she/entity/lamp_b';
const PLUG = 'she/entity/plug';
const BLIND = 'she/entity/blind';
const DOOR = 'she/entity/door';
const CHIME = 'she/entity/chime';
const TEMP = 'she/entity/temp';

const lamp = (id, name) => ({ schema: 'json', name: null, uniq_id: `lamp_${id}`, stat_t: `z/${id}`, cmd_t: `z/${id}/set`, brightness: true, dev: { ids: `d_${id}`, name } });
const CONFIGS = {
    'homeassistant/light/a/config': lamp('a', 'Floor lamp'),
    'homeassistant/light/b/config': { ...lamp('b', 'Ceiling lamp'), avty_t: 'z/b/avail' },
    'homeassistant/switch/plug/config': { name: null, uniq_id: 'plug', stat_t: 'z/plug', cmd_t: 'z/plug/set', dev: { ids: 'd_plug', name: 'Amplifier' } },
    'homeassistant/cover/blind/config': { name: null, uniq_id: 'blind', pos_t: 'z/blind', set_pos_t: 'z/blind/set', dev: { ids: 'd_blind', name: 'Blind' } },
    'homeassistant/lock/door/config': { name: null, uniq_id: 'door', stat_t: 'z/door', cmd_t: 'z/door/set', dev: { ids: 'd_door', name: 'Front door' } },
    'homeassistant/button/chime/config': { name: null, uniq_id: 'chime', cmd_t: 'z/chime/press', dev: { ids: 'd_chime', name: 'Chime' } },
    'homeassistant/sensor/temp/config': { name: null, uniq_id: 'temp', stat_t: 'z/temp', unit_of_meas: '°C', dev: { ids: 'd_temp', name: 'Thermometer' } },
};

let lib, tmpDir, core, store, model, layer, engine, published, logged, answering, connected;

function feed(topic, payload) {
    const text = typeof payload === 'string' ? payload : J(payload);
    if (text === '') return store.delete('mqtt::' + topic);
    const state = parsePayload(text);
    if (!state.ts) state.ts = Date.now();
    if (state.lc === undefined) state.lc = state.ts;
    store.setObject('mqtt::' + topic, state);
}

/** the devices behind the topics: what they are told they report, when `answering` */
function device(topic, payload) {
    if (!answering) return;
    if (topic === 'z/a/set' || topic === 'z/b/set') {
        const state = store.get('mqtt::' + topic.slice(0, -4)) || {};
        feed(topic.slice(0, -4), { ...state, ...JSON.parse(payload) });
    } else if (topic === 'z/plug/set' || topic === 'z/blind/set') feed(topic.slice(0, -4), payload);
    else if (topic === 'z/door/set') feed('z/door', payload === 'LOCK' ? 'LOCKED' : 'UNLOCKED');
}

function publish(topic, payload, options) {
    if (!connected) return false;
    published.push([topic, payload, options]);
    device(topic, payload);
    return true;
}

/** the commands that went to devices, without the engine's own status topics */
const commands = () => published.filter(([topic]) => topic.startsWith('z/')).map(([topic, payload]) => [topic, payload]);
/** the last retained status of a scene or a group */
function status(kind, id) {
    const hit = published.filter(([topic]) => topic === `she/status/${kind}/${id}`).at(-1);
    return hit ? (hit[1] === '' ? '' : JSON.parse(hit[1])) : undefined;
}
const statusCount = (kind, id) => published.filter(([topic]) => topic === `she/status/${kind}/${id}`).length;

function makeEngine(opts = {}) {
    engine = new SceneEngine({
        core,
        layer,
        publish,
        name: 'she',
        log: { ...noop, info: (m) => logged.push(m), warn: (m) => logged.push(m) },
        entityName: (id) => ({ [A]: 'Floor lamp', [B]: 'Ceiling lamp', [PLUG]: 'Amplifier', [BLIND]: 'Blind', [DOOR]: 'Front door' })[id] || null,
        ...opts,
    });
    engine.start();
    return engine;
}

/** let the time pass, and the turn end (the groups are looked at after it) */
async function pass(ms = 1000) {
    jest.advanceTimersByTime(ms);
    await new Promise((resolve) => setImmediate(resolve));
}

/** everything off and closed, as the devices report it */
function quiet() {
    feed('z/a', { state: 'OFF', brightness: 50 });
    feed('z/b', { state: 'OFF', brightness: 50 });
    feed('z/b/avail', 'online');
    feed('z/plug', 'OFF');
    feed('z/blind', '100');
    feed('z/door', 'LOCKED');
    feed('z/temp', '21.5');
}

const MOVIE = {
    name: 'Movie',
    members: [
        { entity: A, attributes: { state: 'ON', brightness: 102 } },
        { entity: B, attributes: { state: 'OFF' } },
        { entity: PLUG, attributes: { state: 'ON' } },
        { entity: BLIND, attributes: { position: 30 } },
    ],
};
const EVENING = {
    name: 'Evening',
    members: [
        { entity: A, attributes: { state: 'ON', brightness: 200 } },
        { entity: B, attributes: { state: 'ON', brightness: 200 } },
    ],
};

beforeAll(async () => {
    lib = await haEntities.load();
});

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-test-'));
    core = new SheDBCore({ dbPath: tmpDir, log: noop });
    await new Promise((resolve) => core.once('ready', resolve));
    store = new StateStore();
    published = [];
    logged = [];
    answering = true;
    connected = true;
    for (const [topic, config] of Object.entries(CONFIGS)) feed(topic, config);
    model = new HomeModel({ core, entries: () => store.mqttEntries(), log: noop, goneDelay: 0 });
    model.enable({ language: 'en' });
    model.start({ authoritative: true });
    layer = new HomeEntities({ lib, core, store, log: noop, publish });
    quiet();
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
});

afterEach(async () => {
    jest.useRealTimers();
    if (engine) engine.stop();
    if (layer) layer.stop();
    if (model) model.stop();
    engine = null;
    scenesWeb.reset();
    homeEntities.reset();
    home.reset();
    clearTimeout(core._saveTimer);
    clearTimeout(core._saveViewsTimer);
    if (core._worker) await core._worker.terminate();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('documents', () => {
    test('validateScene: the stored form, and what is wrong by name', () => {
        expect(validateScene({ name: ' Movie ', members: [{ entity: A }] })).toEqual({
            schema: 1,
            kind: 'scene',
            name: 'Movie',
            deactivate: 'none',
            settle: 10,
            members: [{ entity: A, attributes: {}, role: 'recall+match' }],
        });
        expect(validateScene({ name: 'x', deactivate: 'scene:evening', settle: 0, members: [] })).toMatchObject({ deactivate: 'scene:evening', settle: 0 });
        expect(() => validateScene(null)).toThrow(/must be an object/);
        expect(() => validateScene({ members: [] })).toThrow(/name is required/);
        expect(() => validateScene({ name: 'x' })).toThrow(/members must be a list/);
        expect(() => validateScene({ name: 'x', members: [], deactivate: 'undo' })).toThrow(/deactivate must be one of none, restore, off or scene:<id>/);
        expect(() => validateScene({ name: 'x', members: [], settle: -1 })).toThrow(/settle/);
        expect(() => validateScene({ name: 'x', members: [{ entity: 'lamp' }] })).toThrow(/members\[0\]\.entity must be an entity document id/);
        expect(() => validateScene({ name: 'x', members: [{ entity: A }, { entity: A }] })).toThrow(/is a member twice/);
        expect(() => validateScene({ name: 'x', members: [{ entity: A, role: 'both' }] })).toThrow(/role must be one of/);
        expect(() => validateScene({ name: 'x', members: [{ entity: A, delay: -1 }] })).toThrow(/delay must be a number of seconds/);
        expect(() => validateScene({ name: 'x', members: [{ entity: A, tolerance: 2 }] })).toThrow(/tolerance must be an object/);
        expect(() => validateScene({ name: 'x', members: [{ entity: A, off: true }] })).toThrow(/off must be an object/);
    });

    test('validateGroup, parseSet, slug', () => {
        expect(validateGroup({ name: 'Living room', scenes: ['off', 'movie'] })).toEqual({
            schema: 1,
            kind: 'scenegroup',
            name: 'Living room',
            scenes: ['off', 'movie'],
            default: null,
        });
        expect(() => validateGroup({ name: 'x', scenes: ['a', 'a'] })).toThrow(/listed twice/);
        expect(() => validateGroup({ name: 'x', scenes: ['a'], default: 'b' })).toThrow(/default must be one of its scenes/);
        expect(() => validateGroup({ name: 'x', scenes: ['a/b'] })).toThrow(/list of scene ids/);
        expect(parseSet(true)).toEqual({ action: 'recall', force: false });
        expect(parseSet('ON')).toEqual({ action: 'recall', force: false });
        expect(parseSet(0)).toEqual({ action: 'deactivate', force: false });
        expect(parseSet('toggle')).toEqual({ action: 'toggle', force: false });
        expect(parseSet({ val: true, force: true })).toEqual({ action: 'recall', force: true });
        expect(parseSet('maybe')).toBeNull();
        expect(parseSet(null)).toBeNull();
        expect(slug('Wohnzimmer Abend & Größe')).toBe('wohnzimmer-abend-grosse');
    });

    test('a scene written into sheDB is followed; a broken one is not active and says why', () => {
        makeEngine();
        core.set('she/scene/movie', MOVIE);
        expect(engine.list().map((s) => s.id)).toEqual(['movie']);
        expect(status('scene', 'movie')).toMatchObject({ val: false, total: 4 });
        core.set('she/scene/broken', { name: 'Broken', members: 'none' });
        expect(engine.state('broken')).toBeNull();
        expect(logged).toContain('scene broken: scene: members must be a list — the scene is not active');
        core.set('she/scene/movie', { ...MOVIE, members: 'none' });
        expect(engine.state('movie')).toBeNull();
        expect(status('scene', 'movie')).toBe('');
        core.set('she/scene/movie', MOVIE);
        core.del('she/scene/movie');
        expect(engine.list()).toEqual([]);
        expect(status('scene', 'movie')).toBe('');
        expect(published.at(-1)).toEqual(['she/status/scene/movie', '', { retain: true }]);
    });

    test('save keeps created, sets modified, refuses a bad id; remove takes the scene out of its groups', () => {
        makeEngine({ now: () => 1000 });
        const saved = engine.save('movie', MOVIE);
        expect(saved).toMatchObject({ kind: 'scene', created: 1000, modified: 1000, sensitive: false });
        engine.now = () => 2000;
        expect(engine.save('movie', { ...MOVIE, name: 'Film' })).toMatchObject({ name: 'Film', created: 1000, modified: 2000 });
        expect(core.get('she/scene/movie').name).toBe('Film');
        expect(() => engine.save('a/b', MOVIE)).toThrow(/the id must consist of/);
        engine.save('evening', EVENING);
        engine.saveGroup('living', { name: 'Living room', scenes: ['evening', 'movie'], default: 'movie' });
        expect(engine.remove('movie')).toBe(true);
        expect(engine.remove('movie')).toBe(false);
        expect(core.get('she/scenegroup/living')).toMatchObject({ scenes: ['evening'], default: null });
        expect(engine.removeGroup('living')).toBe(true);
        expect(engine.groups()).toEqual([]);
        expect(status('scenegroup', 'living')).toBe('');
    });
});

describe('matching', () => {
    test('true while every member is in the stored state, whoever brought it there', () => {
        makeEngine({ now: () => 5000 });
        engine.save('movie', MOVIE);
        expect(status('scene', 'movie')).toEqual({
            val: false,
            ts: 5000,
            lc: 5000,
            matched: 1,
            total: 4,
            mismatch: [
                { entity: A, name: 'Floor lamp', attribute: 'state', is: 'OFF', want: 'ON' },
                { entity: A, name: 'Floor lamp', attribute: 'brightness', is: 50, want: 102 },
                { entity: PLUG, name: 'Amplifier', attribute: 'state', is: 'OFF', want: 'ON' },
                { entity: BLIND, name: 'Blind', attribute: 'position', is: 100, want: 30 },
            ],
            unknown: [],
        });
        expect(published.at(-1)[2]).toEqual({ retain: true });
        // by hand, not by a recall
        feed('z/a', { state: 'ON', brightness: 101 });
        feed('z/plug', 'ON');
        feed('z/blind', '31');
        jest.advanceTimersByTime(1000);
        expect(status('scene', 'movie')).toMatchObject({ val: true, matched: 4, total: 4, mismatch: [] });
        expect(engine.state('movie')).toMatchObject({ id: 'movie', name: 'Movie', val: true, recalled: null, settling: false });
        feed('z/a', { state: 'ON', brightness: 60 });
        jest.advanceTimersByTime(1000);
        expect(status('scene', 'movie')).toMatchObject({ val: false, matched: 3, mismatch: [{ attribute: 'brightness', is: 60, want: 102 }] });
    });

    test('a tolerance of the member; a member that only counts for the recall; a condition', () => {
        makeEngine();
        engine.save('s', {
            name: 'S',
            members: [
                { entity: A, attributes: { state: 'OFF', brightness: 80 }, tolerance: { brightness: 40 } },
                { entity: BLIND, attributes: { position: 30 }, role: 'recall' },
                { entity: TEMP, attributes: { value: 21.5 }, role: 'match' },
            ],
        });
        // the lamp is off: its brightness is not asked; the blind does not decide; the thermometer does
        expect(status('scene', 's')).toMatchObject({ val: true, matched: 2, total: 2 });
        feed('z/temp', '25');
        jest.advanceTimersByTime(1000);
        expect(status('scene', 's')).toMatchObject({ val: false, mismatch: [{ entity: TEMP, attribute: 'value', is: 25, want: 21.5 }] });
    });

    test('unknown counts as not matching: no value, offline, not announced any more', () => {
        feed('z/plug', '');
        makeEngine();
        engine.save('s', {
            name: 'S',
            members: [
                { entity: A, attributes: { state: 'OFF' } },
                { entity: B, attributes: { state: 'OFF' } },
                { entity: PLUG, attributes: { state: 'OFF' } },
                { entity: 'she/entity/gone', attributes: { state: 'OFF' } },
            ],
        });
        expect(status('scene', 's')).toMatchObject({
            val: false,
            matched: 2,
            total: 4,
            mismatch: [],
            unknown: [
                { entity: PLUG, name: 'Amplifier', attribute: 'state', reason: 'no value' },
                { entity: 'she/entity/gone', name: 'gone', reason: 'missing' },
            ],
        });
        feed('z/b/avail', 'offline');
        jest.advanceTimersByTime(1000);
        expect(status('scene', 's').unknown).toContainEqual({ entity: B, name: 'Ceiling lamp', reason: 'unavailable' });
        expect(status('scene', 's').matched).toBe(1);
    });

    test('a scene without members that count is never true', () => {
        makeEngine();
        engine.save('s', { name: 'S', members: [{ entity: A, attributes: { state: 'OFF' }, role: 'recall' }] });
        expect(status('scene', 's')).toMatchObject({ val: false, matched: 0, total: 0 });
    });

    test('debounce: a state is told after a second of quiet, a flicker not at all', () => {
        makeEngine();
        engine.save('s', { name: 'S', members: [{ entity: A, attributes: { state: 'OFF' } }] });
        expect(statusCount('scene', 's')).toBe(1);
        expect(status('scene', 's').val).toBe(true);
        feed('z/a', { state: 'ON' });
        jest.advanceTimersByTime(900);
        expect(statusCount('scene', 's')).toBe(1);
        // every change starts the second again
        feed('z/a', { state: 'ON', brightness: 3 });
        jest.advanceTimersByTime(900);
        expect(statusCount('scene', 's')).toBe(1);
        feed('z/a', { state: 'OFF' });
        jest.advanceTimersByTime(1000);
        // back where it was: nothing to tell
        expect(statusCount('scene', 's')).toBe(1);
        feed('z/a', { state: 'ON' });
        jest.advanceTimersByTime(1000);
        expect(statusCount('scene', 's')).toBe(2);
        expect(status('scene', 's').val).toBe(false);
    });

    test('lc is the last change of val, ts the time of the message', () => {
        let t = 1000;
        makeEngine({ now: () => t });
        engine.save('s', {
            name: 'S',
            members: [
                { entity: A, attributes: { state: 'OFF' } },
                { entity: B, attributes: { state: 'OFF' } },
            ],
        });
        t = 2000;
        feed('z/a', { state: 'ON' });
        jest.advanceTimersByTime(1000);
        expect(status('scene', 's')).toMatchObject({ val: false, ts: 2000, lc: 2000, matched: 1 });
        t = 3000;
        feed('z/b', { state: 'ON' });
        jest.advanceTimersByTime(1000);
        expect(status('scene', 's')).toMatchObject({ val: false, ts: 3000, lc: 2000, matched: 0 });
    });

    test('not connected: nothing is published, the next connect tells it', () => {
        makeEngine();
        connected = false;
        engine.save('s', { name: 'S', members: [{ entity: A, attributes: { state: 'OFF' } }] });
        expect(published).toEqual([]);
        connected = true;
        engine.republish();
        expect(status('scene', 's').val).toBe(true);
    });
});

describe('recall', () => {
    test('only the members that differ are commanded; the scene becomes true when they answered', () => {
        makeEngine();
        engine.save('movie', MOVIE);
        const r = engine.recall('movie');
        expect(r).toEqual({ ok: true, sent: 3, skipped: 1, problems: [] });
        // the ceiling lamp is off already
        expect(commands()).toEqual([
            ['z/a/set', '{"state":"ON","brightness":102}'],
            ['z/plug/set', 'ON'],
            ['z/blind/set', '30'],
        ]);
        expect(published.find(([topic]) => topic === 'z/a/set')[2]).toEqual({ retain: false, qos: 0 });
        jest.advanceTimersByTime(1000);
        expect(status('scene', 'movie')).toMatchObject({ val: true, matched: 4 });
        expect(typeof status('scene', 'movie').recalled).toBe('number');
        expect(logged).toContain('scene movie: recalled: 3 commanded, 1 already there');
    });

    test('force, and a recall of a scene that is already true, command every member', () => {
        makeEngine();
        engine.save('movie', MOVIE);
        expect(engine.recall('movie', { force: true })).toMatchObject({ sent: 4, skipped: 0 });
        jest.advanceTimersByTime(11000);
        published.length = 0;
        expect(engine.state('movie').val).toBe(true);
        expect(engine.recall('movie')).toMatchObject({ sent: 4, skipped: 0 });
        expect(commands().length).toBe(4);
    });

    test('order and delay: the amplifier first, a pause, then the rest', () => {
        makeEngine();
        engine.save('s', {
            name: 'S',
            members: [
                { entity: A, attributes: { state: 'ON' }, order: 2, delay: 3 },
                { entity: PLUG, attributes: { state: 'ON' }, order: 1 },
                { entity: BLIND, attributes: { position: 30 }, order: 2 },
            ],
        });
        engine.recall('s');
        expect(commands()).toEqual([['z/plug/set', 'ON']]);
        jest.advanceTimersByTime(2999);
        expect(commands().length).toBe(1);
        jest.advanceTimersByTime(1);
        expect(commands()).toEqual([
            ['z/plug/set', 'ON'],
            ['z/a/set', '{"state":"ON"}'],
            ['z/blind/set', '30'],
        ]);
    });

    test('a button is a step of the recall, a condition is never commanded', () => {
        makeEngine();
        engine.save('s', {
            name: 'S',
            members: [
                { entity: CHIME, attributes: {} },
                { entity: PLUG, attributes: { state: 'ON' }, role: 'match' },
                { entity: A, attributes: { state: 'ON' } },
            ],
        });
        engine.recall('s');
        expect(commands()).toEqual([
            ['z/chime/press', 'PRESS'],
            ['z/a/set', '{"state":"ON"}'],
        ]);
        // the chime tells nothing and never matches; the scene is decided by the lamp and the plug
        expect(engine.state('s')).toMatchObject({ total: 3, unknown: [], mismatch: [{ entity: PLUG, attribute: 'state', is: 'OFF', want: 'ON' }] });
    });

    test('settle: while the devices have not answered the scene is not told false; then every mismatch is logged', () => {
        answering = false;
        makeEngine();
        engine.save('s', {
            name: 'S',
            settle: 5,
            members: [
                { entity: A, attributes: { state: 'ON', brightness: 102 } },
                { entity: PLUG, attributes: { state: 'ON' } },
            ],
        });
        expect(statusCount('scene', 's')).toBe(1);
        engine.recall('s');
        expect(engine.state('s').settling).toBe(true);
        // the lamp answers with the wrong level, the plug not at all
        feed('z/a', { state: 'ON', brightness: 80 });
        jest.advanceTimersByTime(4999);
        expect(statusCount('scene', 's')).toBe(1);
        jest.advanceTimersByTime(1);
        expect(statusCount('scene', 's')).toBe(2);
        expect(status('scene', 's')).toMatchObject({
            val: false,
            matched: 0,
            mismatch: [
                { attribute: 'brightness', is: 80, want: 102 },
                { attribute: 'state', is: 'OFF', want: 'ON' },
            ],
        });
        expect(logged).toContain('scene s: Floor lamp brightness is 80, expected 102');
        expect(logged).toContain('scene s: Amplifier state is "OFF", expected "ON"');
        expect(engine.state('s').settling).toBe(false);
    });

    test('once the scene was there, the settle time is over: a change by hand is told after the debounce', () => {
        makeEngine();
        engine.save('s', { name: 'S', settle: 60, members: [{ entity: A, attributes: { state: 'ON' } }] });
        engine.recall('s');
        jest.advanceTimersByTime(1000);
        expect(status('scene', 's').val).toBe(true);
        expect(engine.state('s').settling).toBe(false);
        feed('z/a', { state: 'OFF' });
        jest.advanceTimersByTime(1000);
        expect(status('scene', 's').val).toBe(false);
    });

    test('a member that is gone or offline is a problem of the recall, not an exception', () => {
        makeEngine();
        engine.save('s', {
            name: 'S',
            members: [
                { entity: 'she/entity/gone', attributes: { state: 'ON' } },
                { entity: A, attributes: { state: 'ON' } },
            ],
        });
        expect(engine.recall('s')).toEqual({ ok: true, sent: 1, skipped: 0, problems: ['she/entity/gone: not announced any more'] });
        expect(engine.recall('nope')).toMatchObject({ ok: false, reason: 'no scene "nope"' });
    });

    test('the loop guard: the sixth recall within ten seconds is dropped', () => {
        let t = 0;
        makeEngine({ now: () => t });
        engine.save('s', { name: 'S', members: [{ entity: A, attributes: { state: 'ON' } }] });
        for (let i = 0; i < 5; i++) {
            t += 1000;
            expect(engine.recall('s').ok).toBe(true);
        }
        t += 1000;
        const dropped = engine.recall('s');
        expect(dropped.ok).toBe(false);
        expect(dropped.reason).toMatch(/recalled 5 times within 10 s — dropped/);
        expect(logged.at(-1)).toMatch(/^scene s: recalled 5 times/);
        t += 10000;
        expect(engine.recall('s').ok).toBe(true);
    });
});

describe('deactivate', () => {
    test('none, the default: set false is ignored and the log says so', () => {
        makeEngine();
        engine.save('movie', MOVIE);
        engine.recall('movie');
        published.length = 0;
        expect(engine.deactivate('movie')).toEqual({ ok: true, mode: 'none', reason: 'the scene has no deactivation', sent: 0 });
        expect(commands()).toEqual([]);
        expect(logged.at(-1)).toBe('scene movie: set false ignored: the scene has no deactivation');
        expect(engine.deactivate('nope').ok).toBe(false);
    });

    test('restore: back to the state before the recall', () => {
        makeEngine();
        engine.save('movie', { ...MOVIE, deactivate: 'restore' });
        engine.recall('movie');
        expect(core.get('she/scene/movie/restore')).toMatchObject({
            members: [
                { entity: A, before: { state: 'OFF', brightness: 50 }, scene: { state: 'ON', brightness: 102 } },
                { entity: B, before: { state: 'OFF', brightness: 50 }, scene: { state: 'OFF' } },
                { entity: PLUG, before: { state: 'OFF' }, scene: { state: 'ON' } },
                { entity: BLIND, before: { position: 100 }, scene: { position: 30 } },
            ],
        });
        jest.advanceTimersByTime(1000);
        expect(status('scene', 'movie').val).toBe(true);
        published.length = 0;
        expect(engine.deactivate('movie')).toEqual({ ok: true, mode: 'restore', sent: 4 });
        expect(commands()).toEqual([
            ['z/a/set', '{"state":"OFF"}'],
            ['z/b/set', '{"state":"OFF"}'],
            ['z/plug/set', 'OFF'],
            ['z/blind/set', '100'],
        ]);
        expect(core.get('she/scene/movie/restore')).toBeUndefined();
        jest.advanceTimersByTime(1000);
        expect(status('scene', 'movie').val).toBe(false);
    });

    test('restore leaves alone what somebody changed since the recall', () => {
        makeEngine();
        engine.save('movie', { ...MOVIE, deactivate: 'restore' });
        engine.recall('movie');
        // dimmed during the movie, and the blind opened by hand
        feed('z/a', { state: 'ON', brightness: 20 });
        feed('z/blind', '60');
        published.length = 0;
        expect(engine.deactivate('movie')).toMatchObject({ mode: 'restore', sent: 2 });
        expect(commands()).toEqual([
            ['z/b/set', '{"state":"OFF"}'],
            ['z/plug/set', 'OFF'],
        ]);
        expect(logged.at(-1)).toBe('scene movie: deactivated: 2 of 4 restored');
    });

    test('restore without a recall has nothing to go back to; a second deactivate neither', () => {
        makeEngine();
        engine.save('movie', { ...MOVIE, deactivate: 'restore' });
        expect(engine.deactivate('movie')).toMatchObject({ ok: true, sent: 0, reason: 'there is nothing to restore (the scene was not recalled)' });
        engine.recall('movie');
        engine.deactivate('movie');
        published.length = 0;
        expect(engine.deactivate('movie').sent).toBe(0);
        expect(commands()).toEqual([]);
    });

    test('the restore point survives a restart, and is not replaced by a recall of the scene while it holds', () => {
        makeEngine();
        engine.save('movie', { ...MOVIE, deactivate: 'restore' });
        engine.recall('movie');
        jest.advanceTimersByTime(11000);
        const point = core.get('she/scene/movie/restore');
        // recalled again while true (a repair): the way back stays the one from before the movie
        engine.recall('movie');
        expect(core.get('she/scene/movie/restore')).toEqual(point);
        engine.stop();
        makeEngine();
        published.length = 0;
        expect(engine.deactivate('movie').sent).toBe(4);
        expect(commands()[0]).toEqual(['z/a/set', '{"state":"OFF"}']);
    });

    test('a changed scene drops its restore point', () => {
        makeEngine();
        engine.save('movie', { ...MOVIE, deactivate: 'restore' });
        engine.recall('movie');
        engine.save('movie', { ...MOVIE, deactivate: 'restore', name: 'Film' });
        expect(core.get('she/scene/movie/restore')).toBeUndefined();
    });

    test('off: lights, switches and fans off, the rest left alone; a member can say otherwise', () => {
        makeEngine();
        engine.save('movie', { ...MOVIE, deactivate: 'off' });
        engine.recall('movie');
        published.length = 0;
        expect(engine.deactivate('movie')).toEqual({ ok: true, mode: 'off', sent: 2 });
        // the ceiling lamp is off already, the blind has no "off"
        expect(commands()).toEqual([
            ['z/a/set', '{"state":"OFF"}'],
            ['z/plug/set', 'OFF'],
        ]);
        engine.save('s', {
            name: 'S',
            deactivate: 'off',
            members: [
                { entity: A, attributes: { state: 'ON' }, off: false },
                { entity: BLIND, attributes: { position: 30 }, off: { position: 100 } },
                { entity: PLUG, attributes: { state: 'ON' }, role: 'match' },
            ],
        });
        engine.recall('s');
        feed('z/plug', 'ON');
        published.length = 0;
        expect(engine.deactivate('s').sent).toBe(1);
        expect(commands()).toEqual([['z/blind/set', '100']]);
    });

    test('scene:<id>: the fallback is recalled — only while the scene is true', () => {
        makeEngine();
        engine.save('evening', EVENING);
        engine.save('movie', { ...MOVIE, deactivate: 'scene:evening' });
        // not active: false does nothing
        expect(engine.deactivate('movie')).toEqual({ ok: true, mode: 'scene:evening', reason: 'the scene is not active', sent: 0 });
        expect(commands()).toEqual([]);
        engine.recall('movie');
        jest.advanceTimersByTime(1000);
        published.length = 0;
        expect(engine.deactivate('movie')).toEqual({ ok: true, mode: 'scene:evening', sent: 2 });
        expect(commands()).toEqual([
            ['z/a/set', '{"state":"ON","brightness":200}'],
            ['z/b/set', '{"state":"ON","brightness":200}'],
        ]);
        jest.advanceTimersByTime(1000);
        expect(status('scene', 'evening').val).toBe(true);
        expect(status('scene', 'movie').val).toBe(false);
    });

    test('a fallback that does not exist, or is the scene itself', () => {
        makeEngine();
        engine.save('a', { name: 'A', deactivate: 'scene:nope', members: [{ entity: A, attributes: { state: 'OFF' } }] });
        expect(engine.deactivate('a')).toMatchObject({ ok: false, reason: 'no scene "nope"' });
        engine.save('b', { name: 'B', deactivate: 'scene:b', members: [{ entity: A, attributes: { state: 'OFF' } }] });
        expect(engine.deactivate('b')).toMatchObject({ ok: true, sent: 0, reason: 'the fallback is the scene itself' });
    });

    test('toggle: recall when false, deactivate when true', () => {
        makeEngine();
        engine.save('movie', { ...MOVIE, deactivate: 'off' });
        expect(engine.toggle('movie')).toMatchObject({ ok: true, sent: 3, skipped: 1 });
        expect(engine.toggle('movie')).toMatchObject({ ok: true, mode: 'off', sent: 2 });
        expect(engine.toggle('nope').ok).toBe(false);
    });

    test('deactivate drops what the recall has not sent yet', () => {
        makeEngine();
        engine.save('s', {
            name: 'S',
            members: [
                { entity: PLUG, attributes: { state: 'ON' } },
                { entity: A, attributes: { state: 'ON' }, delay: 5 },
            ],
        });
        engine.recall('s');
        engine.deactivate('s');
        jest.advanceTimersByTime(6000);
        expect(commands()).toEqual([['z/plug/set', 'ON']]);
    });
});

describe('groups', () => {
    beforeEach(() => {
        makeEngine();
        engine.save('off', {
            name: 'Off',
            members: [
                { entity: A, attributes: { state: 'OFF' } },
                { entity: B, attributes: { state: 'OFF' } },
            ],
        });
        engine.save('evening', EVENING);
        engine.save('movie', MOVIE);
        engine.saveGroup('living', { name: 'Living room', area: 'living-room', scenes: ['off', 'evening', 'movie'] });
    });

    test('the group shows the scene that matches', async () => {
        expect(status('scenegroup', 'living')).toMatchObject({ val: 'off' });
        expect(engine.groupState('living')).toEqual({ id: 'living', name: 'Living room', area: 'living-room', scenes: ['off', 'evening', 'movie'], default: null, val: 'off' });
        engine.recall('evening');
        await pass();
        expect(status('scenegroup', 'living').val).toBe('evening');
        feed('z/a', { state: 'ON', brightness: 10 });
        await pass();
        expect(status('scenegroup', 'living')).toMatchObject({ val: '' });
        expect(engine.list().find((s) => s.id === 'movie').groups).toEqual(['living']);
    });

    test('when two match, the first of the list wins', async () => {
        engine.save('dark', { name: 'Dark', members: [{ entity: A, attributes: { state: 'OFF' } }] });
        engine.saveGroup('g', { name: 'G', scenes: ['dark', 'off'] });
        expect(engine.groupState('g').val).toBe('dark');
        engine.saveGroup('g', { name: 'G', scenes: ['off', 'dark'] });
        expect(engine.groupState('g').val).toBe('off');
        expect(status('scenegroup', 'g').val).toBe('off');
    });

    test('setting the group recalls a scene of it; another scene is refused', async () => {
        expect(engine.setGroup('living', 'movie')).toMatchObject({ ok: true, sent: 3 });
        await pass();
        expect(status('scenegroup', 'living').val).toBe('movie');
        expect(engine.setGroup('living', 'nope')).toMatchObject({ ok: false, reason: '"nope" is not a scene of the group living' });
        expect(engine.setGroup('nope', 'movie').ok).toBe(false);
    });

    test("the group's deactivation: its default scene, else the deactivation of the active scene", async () => {
        engine.recall('movie');
        await pass();
        // no default, and movie ignores false
        published.length = 0;
        expect(engine.setGroup('living', '')).toMatchObject({ ok: true, mode: 'none', sent: 0 });
        engine.saveGroup('living', { name: 'Living room', scenes: ['off', 'evening', 'movie'], default: 'off' });
        // the ceiling lamp is off already
        expect(engine.setGroup('living', 'none')).toMatchObject({ ok: true, sent: 1, skipped: 1 });
        await pass();
        expect(status('scenegroup', 'living').val).toBe('off');
        // nothing active, no default
        engine.saveGroup('other', { name: 'Other', scenes: ['movie'] });
        expect(engine.setGroup('other', false)).toEqual({ ok: true, reason: 'no scene of the group is active', sent: 0 });
    });

    test('a newer recall in the group drops what the older one has not sent yet', async () => {
        engine.save('slow', {
            name: 'Slow',
            members: [
                { entity: PLUG, attributes: { state: 'ON' } },
                { entity: BLIND, attributes: { position: 30 }, delay: 5 },
            ],
        });
        engine.saveGroup('living', { name: 'Living room', scenes: ['off', 'evening', 'movie', 'slow'] });
        engine.recall('slow');
        await pass(2000);
        engine.recall('evening');
        await pass(10000);
        expect(commands().map(([topic]) => topic)).toEqual(['z/plug/set', 'z/a/set', 'z/b/set']);
        expect(logged).toContain('scene slow: 1 pending command dropped, evening was recalled');
        // … but not across groups
        engine.save('alone', { name: 'Alone', members: [{ entity: CHIME, attributes: {} }] });
        engine.recall('slow', { force: true });
        engine.recall('alone');
        await pass(6000);
        expect(
            commands()
                .map(([topic]) => topic)
                .slice(-2),
        ).toEqual(['z/chime/press', 'z/blind/set']);
    });

    test('for the room aggregates: the groups of a room, and an event when one changes', async () => {
        expect(engine.groups({ area: 'living-room' }).map((g) => [g.id, g.val])).toEqual([['living', 'off']]);
        expect(engine.groups({ area: 'kitchen' })).toEqual([]);
        const heard = [];
        engine.on('group', (id, state) => heard.push([id, state && state.val]));
        engine.recall('evening');
        await pass();
        expect(heard).toEqual([['living', 'evening']]);
        engine.removeGroup('living');
        expect(heard.at(-1)).toEqual(['living', null]);
    });
});

describe('locks and alarm panels', () => {
    test('a scene that commands a lock has to be confirmed; then it is marked', () => {
        makeEngine();
        const leave = {
            name: 'Leave',
            members: [
                { entity: DOOR, attributes: { state: 'LOCKED' } },
                { entity: A, attributes: { state: 'OFF' } },
            ],
        };
        expect(() => engine.save('leave', leave)).toThrow('scene: Front door is a lock — a scene that commands it has to be confirmed');
        expect(core.get('she/scene/leave')).toBeUndefined();
        const saved = engine.save('leave', leave, { confirmSensitive: true });
        expect(saved.sensitive).toBe(true);
        expect(saved.members[0].confirmed).toBe(true);
        expect(saved.members[1].confirmed).toBeUndefined();
        expect(engine.list()[0].sensitive).toBe(true);
        feed('z/door', 'UNLOCKED');
        engine.recall('leave');
        expect(commands()).toEqual([['z/door/set', 'LOCK']]);
    });

    test('a lock as a condition needs no confirmation', () => {
        makeEngine();
        const saved = engine.save('night', { name: 'Night', members: [{ entity: DOOR, attributes: { state: 'LOCKED' }, role: 'match' }] });
        expect(saved.sensitive).toBe(false);
        expect(status('scene', 'night').val).toBe(true);
    });

    test('a member that was written without the confirmation is never commanded: recall, restore, off', () => {
        makeEngine();
        core.set('she/scene/open', {
            name: 'Open',
            deactivate: 'restore',
            members: [
                { entity: DOOR, attributes: { state: 'UNLOCKED' } },
                { entity: A, attributes: { state: 'ON' } },
            ],
        });
        const r = engine.recall('open');
        expect(r.problems).toEqual(['Front door: a lock is only commanded when the member is confirmed']);
        expect(commands()).toEqual([['z/a/set', '{"state":"ON"}']]);
        // somebody unlocks by hand: the door now has the scene's state, and still is not locked by the restore
        feed('z/door', 'UNLOCKED');
        published.length = 0;
        engine.deactivate('open');
        expect(commands()).toEqual([['z/a/set', '{"state":"OFF"}']]);
        core.set('she/scene/open', { name: 'Open', deactivate: 'off', members: [{ entity: DOOR, attributes: { state: 'UNLOCKED' }, off: { state: 'LOCKED' } }] });
        published.length = 0;
        engine.deactivate('open');
        expect(commands()).toEqual([]);
    });
});

describe('topics', () => {
    beforeEach(() => {
        makeEngine();
        engine.save('movie', { ...MOVIE, deactivate: 'off' });
        engine.saveGroup('living', { name: 'Living room', scenes: ['movie'] });
    });

    test('<name>/set/scene/<id>: true, false, toggle, {val, force}', () => {
        expect(engine.onMessage('she/set/scene/movie', true)).toBe(true);
        expect(commands().length).toBe(3);
        engine.onMessage('she/set/scene/movie', { val: true, force: true });
        expect(commands().length).toBe(7);
        engine.onMessage('she/set/scene/movie', false);
        expect(commands().slice(-2)).toEqual([
            ['z/a/set', '{"state":"OFF"}'],
            ['z/plug/set', 'OFF'],
        ]);
        published.length = 0;
        engine.onMessage('she/set/scene/movie', 'toggle');
        expect(commands().length).toBe(2);
    });

    test("what is not understood is said, another topic is not the engine's", () => {
        expect(engine.onMessage('she/set/scene/movie', 'maybe')).toBe(true);
        expect(logged.at(-1)).toBe('scene movie: set "maybe" is not understood — true, false or "toggle"');
        expect(engine.onMessage('she/set/scene/nope', true)).toBe(true);
        expect(logged.at(-1)).toBe('scene nope: no scene "nope"');
        expect(engine.onMessage('she/set/other', true)).toBe(false);
        expect(engine.onMessage('she/status/scene/movie', true)).toBe(false);
        expect(engine.onMessage('other/set/scene/movie', true)).toBe(false);
        expect(commands()).toEqual([]);
    });

    test('<name>/set/scenegroup/<id>: a scene id, or none', async () => {
        engine.onMessage('she/set/scenegroup/living', 'movie');
        expect(commands().length).toBe(3);
        await pass();
        published.length = 0;
        engine.onMessage('she/set/scenegroup/living', 'none');
        expect(commands().length).toBe(2);
        engine.onMessage('she/set/scenegroup/living', { val: 'nope' });
        expect(logged.at(-1)).toBe('scene group living: "nope" is not a scene of the group living');
    });

    test('another instance name', () => {
        engine.stop();
        published.length = 0;
        makeEngine({ name: 'she-dev' });
        expect(published.map(([topic]) => topic).sort()).toEqual(['she-dev/status/scene/movie', 'she-dev/status/scenegroup/living']);
        expect(engine.onMessage('she/set/scene/movie', true)).toBe(false);
        expect(engine.onMessage('she-dev/set/scene/movie', true)).toBe(true);
    });
});

describe('Home Assistant discovery', () => {
    let configs, announcer;

    beforeEach(() => {
        configs = new Map();
        announcer = createAnnouncer({
            instance: 'she',
            origin: { name: 'she', sw_version: '0.0.0' },
            graceMs: 0,
            defer: (fn) => fn(),
            publish: (topic, payload) => {
                configs.set(topic, payload === '' ? '' : JSON.parse(payload));
                return true;
            },
        });
        makeEngine({ announcer });
    });

    test('a scene is a switch with its matching state, a group a select', () => {
        engine.save('movie', MOVIE);
        engine.saveGroup('living', { name: 'Living room', scenes: ['movie'] });
        const config = configs.get('homeassistant/device/she_she_scenes/config');
        expect(config.device).toMatchObject({ identifiers: ['she_she_scenes'], name: 'Scenes', manufacturer: 'she', model: 'Scene controller' });
        expect(config.origin.name).toBe('she');
        expect(config.availability[0].topic).toBe('she/connected');
        expect(config.components.scene_movie).toEqual({
            platform: 'switch',
            name: 'Movie',
            icon: 'mdi:palette',
            state_topic: 'she/status/scene/movie',
            value_template: "{{ 'ON' if value_json.val else 'OFF' }}",
            state_on: 'ON',
            state_off: 'OFF',
            command_topic: 'she/set/scene/movie',
            payload_on: 'true',
            payload_off: 'false',
            json_attributes_topic: 'she/status/scene/movie',
            unique_id: 'she_she_scenes_scene_movie',
        });
        expect(config.components.scenegroup_living).toEqual({
            platform: 'select',
            name: 'Living room',
            icon: 'mdi:palette-swatch',
            options: ['none', 'movie'],
            state_topic: 'she/status/scenegroup/living',
            value_template: "{{ value_json.val if value_json.val else 'none' }}",
            command_topic: 'she/set/scenegroup/living',
            unique_id: 'she_she_scenes_scenegroup_living',
        });
    });

    test('the announced switch and select read and command the scene through the entity layer itself', async () => {
        engine.save('movie', MOVIE);
        engine.saveGroup('living', { name: 'Living room', scenes: ['movie'] });
        const config = configs.get('homeassistant/device/she_she_scenes/config');
        const entities = lib.parseDiscovery('homeassistant/device/she_she_scenes/config', config).entities;
        const sw = entities.find((e) => e.component === 'switch');
        const select = entities.find((e) => e.component === 'select');
        const messages = { 'she/status/scene/movie': J(status('scene', 'movie')), 'she/status/scenegroup/living': J(status('scenegroup', 'living')) };
        expect(sw.readState(messages)).toEqual({ state: 'OFF' });
        expect(select.readState(messages)).toEqual({ option: 'none' });
        expect(sw.command({ state: 'ON' })[0]).toMatchObject({ topic: 'she/set/scene/movie', payload: 'true' });
        expect(select.command({ option: 'movie' })[0]).toMatchObject({ topic: 'she/set/scenegroup/living', payload: 'movie' });
        engine.recall('movie');
        await pass();
        expect(sw.readState({ 'she/status/scene/movie': J(status('scene', 'movie')) })).toEqual({ state: 'ON' });
        expect(select.readState({ 'she/status/scenegroup/living': J(status('scenegroup', 'living')) })).toEqual({ option: 'movie' });
    });

    test('a renamed scene is announced again, a deleted one is taken out, the last one clears the device', () => {
        engine.save('movie', MOVIE);
        engine.save('evening', EVENING);
        engine.save('movie', { ...MOVIE, name: 'Film', icon: 'mdi:movie' });
        let config = configs.get('homeassistant/device/she_she_scenes/config');
        expect(config.components.scene_movie).toMatchObject({ name: 'Film', icon: 'mdi:movie' });
        engine.remove('movie');
        config = configs.get('homeassistant/device/she_she_scenes/config');
        expect(Object.keys(config.components)).toEqual(['scene_evening']);
        engine.remove('evening');
        expect(configs.get('homeassistant/device/she_she_scenes/config')).toBe('');
    });
});

describe('snapshot', () => {
    test('a scene from the present state of entities; what only tells is a condition', () => {
        feed('z/a', { state: 'ON', brightness: 102 });
        makeEngine();
        const scene = engine.snapshot('now', ['lamp_a', 'z/plug', BLIND, TEMP, CHIME], { name: 'Now', area: 'living-room', deactivate: 'restore' });
        expect(scene).toMatchObject({ name: 'Now', area: 'living-room', deactivate: 'restore' });
        expect(scene.members).toEqual([
            { entity: A, attributes: { state: 'ON', brightness: 102 }, role: 'recall+match' },
            { entity: PLUG, attributes: { state: 'OFF' }, role: 'recall+match' },
            { entity: BLIND, attributes: { position: 100 }, role: 'recall+match' },
            { entity: TEMP, attributes: {}, role: 'match' },
            { entity: CHIME, attributes: {}, role: 'recall+match' },
        ]);
        expect(engine.state('now').val).toBe(true);
    });

    test('taken again: the members keep their role, order and tolerance and get the present state', () => {
        makeEngine();
        engine.save('s', {
            name: 'S',
            members: [
                { entity: A, attributes: { state: 'OFF' }, order: 2, tolerance: { brightness: 9 } },
                { entity: PLUG, attributes: { state: 'ON' }, role: 'recall' },
            ],
        });
        feed('z/a', { state: 'ON', brightness: 77 });
        const scene = engine.snapshot('s');
        expect(scene.name).toBe('S');
        expect(scene.members).toEqual([
            { entity: A, attributes: { state: 'ON', brightness: 77 }, order: 2, tolerance: { brightness: 9 }, role: 'recall+match' },
            { entity: PLUG, attributes: { state: 'OFF' }, role: 'recall' },
        ]);
    });

    test('what cannot be taken says why', () => {
        makeEngine();
        expect(() => engine.snapshot('s')).toThrow('scene: snapshot needs entities');
        expect(() => engine.snapshot('s', ['nope'])).toThrow('scene: no entity "nope"');
        expect(() => engine.snapshot('s', [DOOR])).toThrow(/has to be confirmed/);
        expect(engine.snapshot('s', [DOOR], {}, { confirmSensitive: true }).members[0]).toMatchObject({ entity: DOOR, attributes: { state: 'LOCKED' }, confirmed: true });
    });
});

describe('in the daemon', () => {
    let she, unload, warned;

    /** the web modules as index.js wires them, and a script's she.scene */
    function daemon() {
        home.init({ core, store, log: noop });
        homeEntities.init({ core, store, log: noop, publish });
        scenesWeb.init({ core, publish, name: 'she', log: { ...noop, info: (m) => logged.push(m), warn: (m) => logged.push(m) } });
        scenesWeb.start();
        she = {};
        unload = [];
        warned = [];
        sceneSandbox(she, { onUnload: (fn) => unload.push(fn), warn: (m) => warned.push(m) });
        return scenesWeb.getEngine();
    }

    test('without sheDB the script API says what is missing', () => {
        she = {};
        sceneSandbox(she, {});
        expect(scenesWeb.getEngine()).toBeNull();
        expect(() => she.scene.list()).toThrow("she.scene.list: scenes need sheDB (--db-path) and the home model's entity layer");
    });

    test('the engine starts with the scenes that are stored, and names the members after the home model', () => {
        core.set('she/scene/movie', MOVIE);
        const e = daemon();
        expect(logged).toContain('scenes: 1 scene, 0 groups');
        expect(e.state('movie').mismatch[0]).toMatchObject({ entity: A, name: 'Floor lamp' });
        expect(status('scene', 'movie').val).toBe(false);
    });

    test('she.scene: snapshot, recall, state, list, deactivate, toggle, groups, remove', () => {
        daemon();
        feed('z/a', { state: 'ON', brightness: 102 });
        expect(she.scene.snapshot('reading', ['lamp_a', 'lamp_b'], { name: 'Reading', deactivate: 'off' }).members.length).toBe(2);
        expect(she.scene.get('reading').name).toBe('Reading');
        expect(she.scene.state('reading')).toMatchObject({ val: true, matched: 2, total: 2 });
        expect(she.scene.state('nope')).toBeNull();
        feed('z/a', { state: 'OFF' });
        expect(she.scene.recall('reading')).toMatchObject({ ok: true, sent: 1, skipped: 1 });
        expect(she.scene.list()).toEqual([
            { id: 'reading', name: 'Reading', area: null, icon: null, deactivate: 'off', sensitive: false, groups: [], members: 2, val: true, matched: 2, total: 2 },
        ]);
        expect(she.scene.deactivate('reading')).toMatchObject({ mode: 'off', sent: 1 });
        expect(she.scene.toggle('reading')).toMatchObject({ ok: true, sent: 1 });
        scenesWeb.getEngine().saveGroup('room', { name: 'Room', scenes: ['reading'] });
        expect(she.scene.groups()).toEqual([{ id: 'room', name: 'Room', area: null, scenes: ['reading'], default: null, val: 'reading' }]);
        expect(she.scene.setGroup('room', 'reading').ok).toBe(true);
        expect(she.scene.group('room').id).toBe('room');
        // taken again without naming entities
        expect(she.scene.snapshot('reading', { name: 'Read' }).name).toBe('Read');
        expect(she.scene.remove('reading')).toBe(true);
        expect(she.scene.list()).toEqual([]);
    });

    test('she.scene.sub hears the published state until the script is unloaded', () => {
        daemon();
        she.scene.snapshot('s', ['lamp_a']);
        const heard = [];
        she.scene.sub('s', (id, state) => heard.push([id, state.val]));
        she.scene.sub((id) => heard.push(['any', id]));
        expect(() => she.scene.sub('s')).toThrow(TypeError);
        feed('z/a', { state: 'ON', brightness: 1 });
        jest.advanceTimersByTime(1000);
        expect(heard).toEqual([
            ['s', false],
            ['any', 's'],
        ]);
        for (const fn of unload) fn();
        feed('z/a', { state: 'OFF', brightness: 50 });
        jest.advanceTimersByTime(1000);
        expect(heard.length).toBe(2);
    });

    test('the assistant: which scenes are active, and why one is off', async () => {
        expect(TOOL_DEFINITIONS.map((t) => t.function.name)).toContain('list_scenes');
        expect(await executeTool('list_scenes', {}, {})).toBe('Scenes are not available: they need sheDB and the home model.');
        const e = daemon();
        expect(await executeTool('list_scenes', {}, {})).toBe('There are no scenes yet.');
        e.save('movie', { ...MOVIE, area: 'living-room' });
        e.save('off', { name: 'Off', members: [{ entity: A, attributes: { state: 'OFF' } }] });
        e.saveGroup('living', { name: 'Living room', scenes: ['off', 'movie'], default: 'off' });
        const list = await executeTool('list_scenes', {}, {});
        expect(list).toContain('2 scenes (set topic she/set/scene/<id>: true, false or "toggle"):');
        expect(list).toContain('  movie "Movie": not active (1/4), room living-room, deactivate: none, group living');
        expect(list).toContain('  off "Off": ACTIVE (1/1), deactivate: none, group living');
        expect(list).toContain('  living "Living room": active scene off; scenes off, movie; default off');
        const why = await executeTool('list_scenes', { id: 'movie' }, {});
        expect(why).toContain('Scene movie "Movie": not active (1 of 4 members match)');
        expect(why).toContain('set topic: she/set/scene/movie');
        expect(why).toContain('  Floor lamp (she/entity/lamp_a): brightness is 50, the scene wants 102');
        expect(why).toContain('  she/entity/blind {"position":30}');
        expect(await executeTool('list_scenes', { id: 'nope' }, {})).toBe('No scene "nope". Scenes: movie, off.');
    });
});
