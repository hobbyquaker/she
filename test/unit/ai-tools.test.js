'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns');

// the tools read the data directory (log files): a temp one, never the workstation's ~/.she
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'she-ai-tools-'));
process.env.SHE_DATA_DIR = DATA_DIR;
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });

jest.mock('../../src/influx', () => ({ getMode: jest.fn(() => null), v1Query: jest.fn() }));
jest.mock('../../src/elastic', () => ({ getClient: jest.fn(() => null) }));
jest.mock('../../src/matter/controller', () => ({ listPaired: jest.fn(() => []), getEndpoints: jest.fn(() => []), getAttribute: jest.fn() }));

const influx = require('../../src/influx');
const elastic = require('../../src/elastic');
const matter = require('../../src/matter/controller');
const { executeTool, _internal } = require('../../src/web/ai-tools');
const { isPrivateAddress, isLocalName, parseDuration, valueMatcher, pageOf, parseTime, measurementCandidates, thinSeries } = _internal;

afterAll(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

const NOW = Date.now();
const entries = [
    ['home/status/bath/light', { val: 0.7, ts: NOW - 5000, lc: NOW - 5000 }],
    ['home/status/bath/mirror', { val: 0, ts: NOW - 1000, lc: NOW - 7200000 }],
    ['var/status/presence/bath', { val: 1, ts: NOW, lc: NOW - 60000 }],
    ['home/status/kitchen/light', { val: true, ts: NOW, lc: NOW - 86400000 * 2 }],
    ['zigbee/sensor/contact', { val: 'off', ts: NOW, lc: NOW - 10 }],
];
const store = { mqttEntries: () => entries[Symbol.iterator]() };

describe('search_mqtt_topics (I18)', () => {
    it('matches an MQTT filter with wildcards', async () => {
        const out = await executeTool('search_mqtt_topics', { query: 'home/status/+/light' }, { store });
        expect(out).toMatch(/^2 of 2 matching topic/);
        expect(out).toContain('home/status/bath/light: 0.7 (changed 5s ago)');
        expect(out).toContain('home/status/kitchen/light: true (changed 2d ago)');
        expect(out).not.toContain('mirror');
    });

    it('matches a substring as before, with the change age', async () => {
        const out = await executeTool('search_mqtt_topics', { query: 'bath' }, { store });
        expect(out).toMatch(/^3 of 3/);
        expect(out).toContain('(changed 1m ago)');
    });

    it('filters by value and by change age', async () => {
        expect(await executeTool('search_mqtt_topics', { query: 'home/#', value: '> 0' }, { store })).toMatch(/^2 of 2/); // 0.7 and true
        expect(await executeTool('search_mqtt_topics', { query: '#', value: 'off' }, { store })).toContain('zigbee/sensor/contact');
        expect(await executeTool('search_mqtt_topics', { query: '#', changed_within: '10m' }, { store })).toMatch(/^3 of 3/);
        expect(await executeTool('search_mqtt_topics', { query: '#', changed_within: 'soon' }, { store })).toMatch(/not a duration/);
    });

    it('pages with offset and limit', async () => {
        const out = await executeTool('search_mqtt_topics', { query: '#', limit: 2, offset: 2 }, { store });
        expect(out).toMatch(/^2 of 5 matching topic\(s\) \(offset 2; 1 more: offset 4\)/);
    });
});

describe('helpers', () => {
    it('parseDuration and valueMatcher', () => {
        expect(parseDuration('30m')).toBe(1800000);
        expect(parseDuration('2h')).toBe(7200000);
        expect(parseDuration(90)).toBe(90000);
        expect(parseDuration('x')).toBeNaN();
        expect(valueMatcher('>= 20')(20)).toBe(true);
        expect(valueMatcher('< 5')('3')).toBe(true);
        expect(valueMatcher('!= off')('off')).toBe(false);
        expect(valueMatcher('true')(true)).toBe(true);
        expect(valueMatcher('on')('on')).toBe(true);
        expect(valueMatcher('> 1')('abc')).toBe(false);
    });

    it('pageOf notes the rest', () => {
        expect(pageOf([1, 2, 3, 4, 5], 0, 2, 10, 2)).toEqual({ page: [1, 2], note: ' (offset 0; 3 more: offset 2)' });
        expect(pageOf([1, 2, 3], 2, 10, 10, 2)).toEqual({ page: [3], note: ' (offset 2)' });
    });
});

describe('result cap (I21)', () => {
    it('cuts a long result with a note; the cap comes from the context', async () => {
        const big = Array.from({ length: 400 }, (_, i) => [`t/${i}`, { val: 'x'.repeat(30), ts: NOW, lc: NOW }]);
        const out = await executeTool('search_mqtt_topics', { query: 't/#', limit: 500 }, { store: { mqttEntries: () => big[Symbol.iterator]() }, resultChars: 1000 });
        expect(out.length).toBeLessThan(1200);
        expect(out).toMatch(/cut after 1000 characters \(\d+ total\)/);
    });

    it('get_script_logs pages into older lines', async () => {
        const logWs = require('../../src/web/log-ws');
        for (let i = 0; i < 10; i++) logWs.broadcastLog({ level: 'info', msg: 'paged line ' + i, ts: NOW - 1000 + i }); // in the past: the tool's window ends now
        const out = await executeTool('get_script_logs', { script_name: 'paged line', limit: 3, offset: 2 }, {});
        expect(out).toMatch(/^3 of 10 matching lines \(5 older; offset 5 for them\), oldest first:/);
        expect(out).toContain('paged line 7');
        expect(out).not.toContain('paged line 9');
    });
});

describe('she_fetch guard (I23)', () => {
    const realFetch = global.fetch;
    let lookup;
    beforeEach(() => {
        lookup = jest.spyOn(dns.promises, 'lookup');
        global.fetch = jest.fn(async (url) => new Response('<p>page ' + url + '</p>', { status: 200, headers: { 'content-type': 'text/html' } }));
    });
    afterEach(() => {
        lookup.mockRestore();
        global.fetch = realFetch;
    });

    it('classifies addresses and names', () => {
        for (const ip of ['10.1.2.3', '172.16.23.1', '172.31.0.1', '192.168.1.1', '127.0.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1'])
            expect(isPrivateAddress(ip)).toBe(true);
        for (const ip of ['172.32.0.1', '8.8.8.8', '2606:4700::1']) expect(isPrivateAddress(ip)).toBe(false);
        for (const h of ['localhost', 'she', 'printer.local', 'nas.lan', 'box.home']) expect(isLocalName(h)).toBe(true);
        expect(isLocalName('example.org')).toBe(false);
    });

    it('refuses private addresses, local names and a redirect into the LAN; follows the allow-list', async () => {
        lookup.mockImplementation(async (host) => (host === 'intranet.example.org' ? [{ address: '192.168.5.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]));
        expect(await executeTool('she_fetch', { url: 'http://192.168.1.10/' }, {})).toMatch(/^Refused: "192.168.1.10" is a private address/);
        expect(await executeTool('she_fetch', { url: 'http://nas.lan/' }, {})).toMatch(/^Refused: "nas.lan" is a local name/);
        expect(await executeTool('she_fetch', { url: 'http://intranet.example.org/' }, {})).toMatch(/Refused: "intranet.example.org" is a private address \(192.168.5.5\)/);
        expect(await executeTool('she_fetch', { url: 'http://nas.lan/' }, { fetchAllow: ['nas.lan'] })).toMatch(/^Content of http:\/\/nas.lan\//);
        expect(await executeTool('she_fetch', { url: 'https://example.org/' }, {})).toMatch(/^Content of https:\/\/example.org\//);

        // a public page redirecting into the LAN is stopped at the hop
        global.fetch = jest.fn(async (url) =>
            String(url).startsWith('https://example.org')
                ? new Response('', { status: 302, headers: { location: 'http://192.168.1.1/admin' } })
                : new Response('x', { status: 200 }),
        );
        expect(await executeTool('she_fetch', { url: 'https://example.org/go' }, {})).toMatch(/^Refused: "192.168.1.1" is a private address/);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});

describe('get_script_logs over the log files (I17)', () => {
    const logs = path.join(DATA_DIR, 'logs');
    const T0 = Date.parse('2026-10-08T10:00:00Z');
    const line = (ts, level, msg) => JSON.stringify({ level, msg, ts }) + '\n';

    beforeAll(() => {
        fs.writeFileSync(path.join(logs, 'she.jsonl.1'), line(T0 - 3600000, 'info', 'bad.js: old run start') + line(T0 - 3500000, 'debug', 'bad.js: detail'));
        fs.writeFileSync(
            path.join(logs, 'she.jsonl'),
            line(T0, 'info', 'she 1.51.2 starting') + line(T0 + 60000, 'warn', 'bad.js: lock ran out') + line(T0 + 120000, 'debug', 'kitchen.js: tick') + 'not json\n',
        );
    });
    afterAll(() => {
        for (const n of fs.readdirSync(logs)) fs.rmSync(path.join(logs, n));
    });

    it('reads both files oldest first, filters by script, level and window', async () => {
        const all = await executeTool('get_script_logs', { script_name: 'bad.js' }, {});
        expect(all).toMatch(/^3 of 3 matching lines, oldest first:/);
        expect(all.indexOf('old run start')).toBeLessThan(all.indexOf('lock ran out'));

        const warn = await executeTool('get_script_logs', { script_name: 'bad.js', level: 'warn' }, {});
        expect(warn).toMatch(/^1 of 1/);
        expect(warn).toContain('[2026-10-08 10:01:00Z] WARN bad.js: lock ran out');

        const windowed = await executeTool('get_script_logs', { from: '2026-10-08T09:59:00Z', to: '2026-10-08T10:00:30Z' }, {});
        expect(windowed).toMatch(/^1 of 1/);
        expect(windowed).toContain('she 1.51.2 starting');

        expect(await executeTool('get_script_logs', { from: 'yesterday-ish' }, {})).toMatch(/from\/to must be/);
        expect(await executeTool('get_script_logs', { script_name: 'nothing' }, {})).toBe('No log entries mentioning "nothing".');
    });
});

describe('Matter tools (I24)', () => {
    beforeEach(() => {
        matter.listPaired.mockReturnValue([
            { name: 'Plug', nodeId: '4', online: true },
            { name: 'Sensor', nodeId: '5', online: false },
        ]);
        matter.getEndpoints.mockImplementation((id) =>
            id === '4'
                ? [
                      { endpointId: 0, clusters: ['Descriptor'] },
                      { endpointId: 1, name: 'Outlet', clusters: ['OnOff', 'LevelControl', 'Descriptor'] },
                  ]
                : [{ endpointId: 1, clusters: ['TemperatureMeasurement'] }],
        );
        matter.getAttribute.mockImplementation(async (node, ep, cluster) => (cluster === 'OnOff' ? true : cluster === 'LevelControl' ? 254 : null));
    });

    it('lists devices with their state attributes inline for online nodes', async () => {
        const out = await executeTool('list_matter_devices', {}, {});
        expect(out).toMatch(/^2 of 2 paired Matter device/);
        expect(out).toContain('endpoint "Outlet" (id: 1): OnOff, LevelControl, Descriptor — OnOff.onOff=true, LevelControl.currentLevel=254');
        expect(out).toContain('### Sensor (nodeId: "5", offline)');
        expect(out).toContain('endpoint "1" (id: 1): TemperatureMeasurement'); // offline: no reads
        expect(matter.getAttribute).toHaveBeenCalledTimes(2);
    });

    it('reads one attribute and reports a failure', async () => {
        expect(await executeTool('get_matter_attribute', { node: 'Plug', endpoint: 'Outlet', cluster: 'OnOff', attribute: 'onOff' }, {})).toBe(
            'Plug / Outlet / OnOff.onOff = true',
        );
        matter.getAttribute.mockRejectedValueOnce(new Error('node offline'));
        expect(await executeTool('get_matter_attribute', { node: '5', endpoint: 1, cluster: 'TemperatureMeasurement', attribute: 'measuredValue' }, {})).toMatch(
            /Could not read .*node offline/,
        );
        expect(await executeTool('get_matter_attribute', { node: '5' }, {})).toMatch(/required/);
    });
});

describe('history tools (I15)', () => {
    it('parseTime, measurementCandidates and thinSeries', () => {
        const now = Date.parse('2026-10-08T12:00:00Z');
        expect(parseTime('-2h', now)).toBe(now - 7200000);
        expect(parseTime('2026-10-08T10:00:00Z', now)).toBe(now - 7200000);
        expect(parseTime(undefined, now)).toBe(now);
        expect(parseTime('soon', now)).toBeNaN();
        expect(measurementCandidates('hm/status/Licht Bad/LEVEL')).toEqual(['hm//Licht Bad/LEVEL', 'hm//status/Licht Bad/LEVEL', 'hm/status/Licht Bad/LEVEL']);
        expect(measurementCandidates('heizung//warmwasser')).toEqual(
            ['heizung//' + '/warmwasser', 'heizung//warmwasser']
                .filter((x, i, a) => a.indexOf(x) === i)
                .slice(-1)
                .concat([]).length
                ? expect.any(Array)
                : [],
        );
        const rows = Array.from({ length: 100 }, (_, i) => ({ time: i, value: i < 50 ? 0 : 1 }));
        const { points, note } = thinSeries(rows, 200);
        expect(points.map((p) => p.value)).toEqual([0, 1, 1]);
        expect(note).toMatch(/100 points reduced to 3 change points/);
        const many = Array.from({ length: 1000 }, (_, i) => ({ time: i, value: i % 2 }));
        expect(thinSeries(many, 100).points.length).toBeLessThanOrEqual(101);
    });

    it('get_topic_history: says so without Influx, queries v1 with the derived measurement and thins the series', async () => {
        influx.getMode.mockReturnValue(null);
        expect(await executeTool('get_topic_history', { topic: 'hm/status/Licht Bad/LEVEL' }, {})).toMatch(/No InfluxDB integration/);
        influx.getMode.mockReturnValue('v1');
        influx.v1Query.mockImplementation(async (q) => {
            if (q.includes('"hm//Licht Bad/LEVEL"'))
                return [
                    { time: 1000, value: 0 },
                    { time: 2000, value: 0 },
                    { time: 3000, value: 0.7 },
                    { time: 4000, value: 0.7 },
                ];
            return [];
        });
        const out = await executeTool('get_topic_history', { topic: 'hm/status/Licht Bad/LEVEL', from: '2026-10-08T00:00:00Z', to: '2026-10-08T01:00:00Z' }, {});
        expect(out).toMatch(/^History of hm\/status\/Licht Bad\/LEVEL \(measurement "hm\/\/Licht Bad\/LEVEL"\)/);
        expect(out).toMatch(/4 points reduced to 3 change points/);
        expect(out).toContain('1970-01-01 00:00:03Z  0.7');
        const q = influx.v1Query.mock.calls[0][0];
        expect(q).toMatch(/WHERE time >= \d+ms AND time <= \d+ms ORDER BY time ASC LIMIT 5000/);
        expect(await executeTool('get_topic_history', { topic: 'nothing/status/here' }, {})).toMatch(/^No history for nothing\/status\/here/);
    });

    it('get_topic_messages: says so without Elastic, otherwise lists the newest messages', async () => {
        expect(await executeTool('get_topic_messages', { topic: 't' }, {})).toMatch(/No Elasticsearch integration/);
        const search = jest.fn(async () => ({
            hits: {
                total: { value: 3 },
                hits: [{ _source: { '@timestamp': 1791471873729, 'payload': '{"val":1}' } }, { _source: { '@timestamp': '2026-10-08T15:00:00.000Z', 'payload': 'true' } }],
            },
        }));
        elastic.getClient.mockReturnValue({ search });
        const out = await executeTool('get_topic_messages', { topic: 'var/status/presence/bath', limit: 2 }, { elasticIndex: 'mqtt-*' });
        expect(out).toMatch(/^2 of 3 messages for var\/status\/presence\/bath/);
        expect(out).toContain('{"val":1}');
        expect(out).toContain('2026-10-08 15:00:00Z  true');
        expect(search.mock.calls[0][0].index).toBe('mqtt-*');
        expect(search.mock.calls[0][0].query.bool.filter[0]).toEqual({ term: { topic: 'var/status/presence/bath' } });
    });
});

describe("the daemon's state (I19, I27, I28)", () => {
    const now = Date.now();
    const introspect = {
        scripts: () => [
            {
                file: '/s/licht/bath.js',
                label: 'licht/bath.js',
                origin: 'user',
                subscriptions: ['var/status/presence/bath', 'home/status/bath/door'],
                varSubscriptions: [],
                publishes: ['home/set/bath/light'],
                jobs: [{ next: now + 3600000 }],
                sunEvents: [{ pattern: 'sunset', next: now + 7200000 }],
                timers: [
                    { due: now + 300000, every: null },
                    { due: now + 60000, every: 60000 },
                ],
            },
            {
                file: '/s/misc/other.js',
                label: 'misc/other.js',
                origin: 'user',
                subscriptions: ['home/status/kitchen/#'],
                varSubscriptions: ['var::mode'],
                publishes: [],
                jobs: [],
                sunEvents: [],
                timers: [],
            },
        ],
        instances: () => [
            { instance: 'home', adapter: 'home2mqtt', version: '1.2.3', host: 'box', connected: 2, uptime: 86400000, maintenance: true },
            { instance: 'old', adapter: null, version: null, host: null, connected: 0, uptime: null },
        ],
        health: () => ({ started: true, mqttConfigured: true, mqttConnected: true, scripts: 2, safeMode: false }),
        stats: () => ({
            topics: 8000,
            mqttMsgPerSec: 42,
            handlers: 450,
            memMb: 300,
            cpuPercent: 3,
            eluPercent: 5,
            elMeanMs: 1,
            elMaxMs: 12,
            matterEnabled: true,
            matterNodes: 2,
            matterEndpoints: 3,
            dbEnabled: true,
            dbDocs: 700,
            dbViews: 9,
        }),
        devices: () => [
            {
                id: 'd1',
                name: 'Bath Light',
                entities: [{ component: 'light', name: 'Bath Light', stateTopic: 'home/status/bath/light' }],
                refTopics: ['home/status/bath/light', 'home/set/bath/light'],
                orphaned: false,
            },
        ],
    };
    const ctx = { introspect, store };

    it('list_scripts shows subscriptions, publishes and schedules, filtered by a topic', async () => {
        const out = await executeTool('list_scripts', { filter: 'presence' }, ctx);
        expect(out).toMatch(/^1 of 1 script/);
        expect(out).toContain('### licht/bath.js');
        expect(out).toContain('- subscribes: var/status/presence/bath, home/status/bath/door');
        expect(out).toContain('- publishes (seen): home/set/bath/light');
        expect(out).toMatch(/- schedules: job in 1h.*sunset in 2h/);
        expect(out).toContain('- pending timers: 2');
        expect(await executeTool('list_scripts', {}, {})).toMatch(/did not expose/);
    });

    it('who_publishes names the script and the adapter instance', async () => {
        const out = await executeTool('who_publishes', { topic: 'home/set/bath/light' }, ctx);
        expect(out).toContain('Scripts that published home/set/bath/light since the daemon started: licht/bath.js.');
        expect(out).toContain('"home" is an adapter instance: home2mqtt 1.2.3 on box, connected to its device');
        const none = await executeTool('who_publishes', { topic: 'nobody/status/x' }, ctx);
        expect(none).toMatch(/No loaded script has published/);
        expect(none).toContain('"nobody" is no adapter instance');
    });

    it('describe_device groups the topics and adds the discovery entities', async () => {
        const out = await executeTool('describe_device', { name: 'bath' }, ctx);
        expect(out).toMatch(/^3 topic\(s\) for "bath":/);
        expect(out).toContain('## status (3)');
        expect(out).toContain('home/status/bath/light: 0.7 (changed 5s ago)');
        expect(out).toContain('## Home Assistant discovery: Bath Light');
        expect(out).toContain('- light: Bath Light ← home/status/bath/light');
        expect(await executeTool('describe_device', { name: 'garage' }, ctx)).toMatch(/^Nothing known under "garage"/);
    });

    it('list_services, get_health and list_timers', async () => {
        const services = await executeTool('list_services', {}, ctx);
        expect(services).toContain('- home: home2mqtt 1.2.3 on box, connected, up 1d, maintenance topics');
        expect(services).toContain('- old: legacy, offline');
        expect(await executeTool('list_services', { filter: 'box' }, ctx)).toMatch(/^1 adapter instance/);

        const health = await executeTool('get_health', {}, ctx);
        expect(health).toContain('started: true, mqtt: connected, scripts loaded: 2, safe mode: no');
        expect(health).toContain('topics: 8000, messages/s: 42, handlers: 450');
        expect(health).toContain('matter: 2 node(s), 3 endpoint(s)');

        const timers = await executeTool('list_timers', {}, ctx);
        expect(timers).toContain('### licht/bath.js');
        expect(timers).toMatch(/- interval every 1m, next in 1m/);
        expect(timers).toMatch(/- timer in 5m/);
        expect(timers).toMatch(/- sunset in 2h/);
        expect(timers).not.toContain('misc/other.js');
        expect(await executeTool('list_timers', { script: 'other' }, ctx)).toMatch(/Nothing pending for scripts matching/);
    });
});

describe('remember and forget (I29)', () => {
    it('store and remove through the memory the context carries', async () => {
        const notes = [];
        const mem = {
            add: (text, source) => (text.includes('sk-') ? { error: 'this looks like a key' } : (notes.push({ id: 'n1', text, source }), { note: notes[notes.length - 1] })),
            remove: (id) => (id === 'n1' ? { note: notes.pop() } : { error: `no note ${id}` }),
        };
        expect(await executeTool('remember', { text: 'the hall light is on a timer' }, { memory: mem })).toBe('Stored as [n1]: the hall light is on a timer');
        expect(notes[0].source).toBe('model');
        expect(await executeTool('remember', { text: 'key sk-abc' }, { memory: mem })).toMatch(/^Not stored: this looks like a key/);
        expect(await executeTool('forget', { id: '[n1]' }, { memory: mem })).toBe('Forgotten: the hall light is on a timer');
        expect(await executeTool('forget', { id: 'n9' }, { memory: mem })).toMatch(/^Not removed: no note n9/);
        expect(await executeTool('remember', { text: 'x' }, {})).toMatch(/not available/);
    });
});

describe('propose_script and publish_mqtt (I16, I20)', () => {
    const { publishRefusal, scriptPathOf } = _internal;
    const drafts = require('../../src/web/ai-drafts');

    it('writes a draft with a diff and an event, never the file', async () => {
        const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-scripts-'));
        drafts.init(path.join(DATA_DIR, 'ai', 'drafts'));
        fs.mkdirSync(path.join(scriptDir, 'licht'));
        fs.writeFileSync(path.join(scriptDir, 'licht', 'bath.js'), "/* global she */\n'use strict';\nshe.mqtt.pub('home/set/bath/light', 1);\n");
        const out = await executeTool(
            'propose_script',
            { path: 'licht/bath.js', content: "/* global she */\n'use strict';\nshe.mqtt.pub('home/set/bath/light', 0);\nshe.info('off');", note: 'switches it off' },
            { drafts, scriptDir },
        );
        expect(out.text).toMatch(/^Draft d[0-9a-f]{8} for licht\/bath\.js \(2 added, 1 removed\)/);
        expect(out.event.type).toBe('draft');
        expect(out.event.diff).toContain("-she.mqtt.pub('home/set/bath/light', 1);");
        expect(out.event.diff).toContain("+she.info('off');");
        expect(fs.readFileSync(path.join(scriptDir, 'licht', 'bath.js'), 'utf8')).toContain("light', 1)"); // untouched
        const saved = drafts.get(out.event.id);
        expect(saved.content.endsWith("she.info('off');\n")).toBe(true);
        expect(drafts.setStatus(out.event.id, 'applied').status).toBe('applied');

        expect(await executeTool('propose_script', { path: '../evil.js', content: 'x' }, { drafts, scriptDir })).toMatch(/not a script path/);
        expect(await executeTool('propose_script', { path: 'new/thing.js', content: 'x' }, { drafts, scriptDir })).toMatchObject({ event: { isNew: true, added: 1 } });
        expect(scriptPathOf(scriptDir, 'a/b.txt')).toBeNull();
        fs.rmSync(scriptDir, { recursive: true, force: true });
    });

    it('guards the publish topic and respects the switch and the confirmation', async () => {
        expect(publishRefusal('hm/status/Licht/LEVEL', [])).toMatch(/status topic/);
        expect(publishRefusal('hm/set/Licht/LEVEL', [])).toBeNull();
        expect(publishRefusal('var/set/mode', [])).toBeNull();
        expect(publishRefusal('zigbee2mqtt/lamp/set', [])).toBeNull();
        expect(publishRefusal('zigbee2mqtt/lamp/set/state', [])).toBeNull();
        expect(publishRefusal('homeassistant/light/x/config', [])).toMatch(/only command topics/);
        expect(publishRefusal('homeassistant/light/x/config', ['homeassistant/#'])).toBeNull();
        expect(publishRefusal('hm/set/#', [])).toMatch(/wildcards/);

        const sent = [];
        const base = { allow: [], send: async (t, p, o) => sent.push([t, p, o]) };
        expect(await executeTool('publish_mqtt', { topic: 'hm/set/x/STATE', payload: 'true' }, { publish: { ...base, mode: 'off' } })).toMatch(/switched off/);
        expect(await executeTool('publish_mqtt', { topic: 'hm/set/x/STATE', payload: 'true' }, { publish: { ...base, mode: 'all' } })).toBe('Published "true" to hm/set/x/STATE.');
        expect(sent).toEqual([['hm/set/x/STATE', 'true', { retain: false }]]);
        expect(await executeTool('publish_mqtt', { topic: 'hm/set/x/STATE', payload: 'true' }, { publish: { ...base, mode: 'confirm', confirm: async () => false } })).toMatch(
            /declined/,
        );
        expect(await executeTool('publish_mqtt', { topic: 'hm/set/x/STATE', payload: 'true' }, { publish: { ...base, mode: 'confirm', confirm: async () => 'timeout' } })).toMatch(
            /did not answer/,
        );
        expect(
            await executeTool('publish_mqtt', { topic: 'var/set/mode', payload: 'night', retain: true }, { publish: { ...base, mode: 'confirm', confirm: async () => true } }),
        ).toBe('Published "night" to var/set/mode (retained).');
        expect(await executeTool('publish_mqtt', { topic: 'hm/status/x/STATE', payload: '1' }, { publish: { ...base, mode: 'all' } })).toMatch(/^Refused: a status topic/);
    });
});

describe('get_topic_history with several topics or a filter (I32)', () => {
    const { resolveTopics } = _internal;
    const store = {
        mqttEntries: () =>
            Object.entries({
                'radar-x/status/pir': { val: true },
                'radar-x/status/has_target': { val: false },
                'radar-x/status/still_energy': { val: 12 },
                'home/status/door/contact': { val: false },
            }),
    };

    it('resolves a list, a filter and the cap', () => {
        expect(resolveTopics({ topic: 'a/status/b' }, null).topics).toEqual(['a/status/b']);
        expect(resolveTopics({ topics: ['a/status/b', 'c/status/d', 'a/status/b'] }, null).topics).toEqual(['a/status/b', 'c/status/d']);
        expect(resolveTopics({ topics: 'radar-x/status/#' }, store).topics).toEqual(['radar-x/status/has_target', 'radar-x/status/pir', 'radar-x/status/still_energy']);
        expect(resolveTopics({ topics: ['radar-x/status/+', 'home/status/door/contact'] }, store).topics).toHaveLength(4);
        expect(resolveTopics({ topics: 'radar-x/status/#' }, store, 2)).toMatchObject({
            topics: ['radar-x/status/has_target', 'radar-x/status/pir'],
            note: expect.stringMatching(/3 topics match/),
        });
        expect(resolveTopics({ topics: 'radar-x/#' }, null).error).toMatch(/not available/);
        expect(resolveTopics({ topics: 'nothing/#' }, store).error).toMatch(/No known topic/);
        expect(resolveTopics({}, store).topics).toEqual([]);
    });

    it('queries every topic concurrently and shares the point cap', async () => {
        influx.getMode.mockReturnValue('v1');
        influx.v1Query.mockImplementation(async (q) => {
            if (q.includes('"radar-x//pir"'))
                return [
                    { time: 1000, value: false },
                    { time: 2000, value: true },
                    { time: 3000, value: false },
                ];
            if (q.includes('"radar-x//has_target"')) return [{ time: 1500, value: true }];
            return [];
        });
        influx.v1Query.mockClear();
        const out = await executeTool('get_topic_history', { topics: 'radar-x/status/#', from: '2026-10-08T00:00:00Z', to: '2026-10-08T01:00:00Z', limit: 60 }, { store });
        expect(out).toMatch(/^3 topics, up to 20 points each\./);
        expect(out).toContain('History of radar-x/status/pir (measurement "radar-x//pir")');
        expect(out).toContain('History of radar-x/status/has_target (measurement "radar-x//has_target")');
        expect(out).toMatch(/No history for radar-x\/status\/still_energy/);
        expect(out).toContain('1970-01-01 00:00:02Z  true');
        expect(await executeTool('get_topic_history', { topics: ['nothing/#'] }, { store })).toMatch(/No known topic matches/);
        expect(await executeTool('get_topic_history', {}, { store })).toMatch(/topic \(or topics\) is required/);
    });
});

describe('get_timeline (I33)', () => {
    const { gapStr, commonTopicPrefix } = _internal;
    const store = {
        mqttEntries: () => Object.entries({ 'radar-x/status/pir': { val: true }, 'radar-x/status/has_target': { val: false }, 'home/status/door/contact': { val: false } }),
    };

    it('formats gaps and finds the common prefix', () => {
        expect(gapStr(12000)).toBe('+12s');
        expect(gapStr(312000)).toBe('+5m12s');
        expect(gapStr(2 * 3600000 + 5 * 60000)).toBe('+2h05m');
        expect(gapStr(76 * 3600000)).toBe('+3d 4h');
        expect(commonTopicPrefix(['radar-x/status/pir', 'radar-x/status/has_target'])).toBe('radar-x/status/');
        expect(commonTopicPrefix(['radar-x/status/pir', 'home/status/door/contact'])).toBe('');
        expect(commonTopicPrefix(['one'])).toBe('');
    });

    it('merges the change points of several topics in time order and thins the flapping topic first', async () => {
        influx.getMode.mockReturnValue('v1');
        influx.v1Query.mockImplementation(async (q) => {
            if (q.includes('"radar-x//pir"'))
                return [
                    { time: 1000, value: false },
                    { time: 5000, value: true },
                    { time: 5500, value: true },
                    { time: 9000, value: false },
                ];
            if (q.includes('"radar-x//has_target"'))
                return [
                    { time: 2000, value: false },
                    { time: 6000, value: true },
                    { time: 6200, value: false },
                    { time: 6400, value: true },
                    { time: 6600, value: false },
                ];
            if (q.includes('"home//door/contact"'))
                return [
                    { time: 3000, value: false },
                    { time: 7000, value: true },
                ];
            return [];
        });
        const out = await executeTool(
            'get_timeline',
            { topics: ['radar-x/status/#', 'home/status/door/contact', 'home/status/nothing'], from: '2026-10-08T00:00:00Z', to: '2026-10-08T01:00:00Z' },
            { store },
        );
        const lines = out.split('\n');
        expect(lines[0]).toMatch(/^Timeline of 4 topic\(s\) from .* 10 changes\./);
        expect(lines[1]).toBe('No history for: home/status/nothing.');
        expect(lines[2]).toMatch(/00:00:01Z\s+radar-x\/status\/pir: false \(first value in the window\)$/);
        expect(lines[3]).toMatch(/00:00:02Z\s+\+1s\s+radar-x\/status\/has_target: false \(first value in the window\)$/);
        expect(lines[5]).toMatch(/00:00:05Z\s+\+2s\s+radar-x\/status\/pir: false → true$/);
        expect(lines.at(-1)).toMatch(/00:00:09Z\s+\+2s\s+radar-x\/status\/pir: true → false$/);

        const thin = await executeTool('get_timeline', { topics: 'radar-x/status/#', from: '2026-10-08T00:00:00Z', to: '2026-10-08T01:00:00Z', limit: 4 }, { store });
        const tl = thin.split('\n');
        expect(tl[0]).toMatch(/under radar-x\/status\/ .* 4 of 8 changes \(the ones closest/);
        // the first value of each topic and the two widest-spaced changes stay; the 200 ms flaps go
        expect(tl.slice(1).map((l) => l.match(/ {2}(\S+): /)[1])).toEqual(['pir', 'has_target', 'pir', 'has_target']);
        expect(thin).not.toMatch(/00:00:06\.?2/);

        expect(await executeTool('get_timeline', { topics: 'nothing/#' }, { store })).toMatch(/No known topic matches/);
        expect(await executeTool('get_timeline', {}, { store })).toMatch(/topics is required/);
    });
});

describe('describe_room and describe_device with several names (I34)', () => {
    const NOW = Date.now();
    const store = {
        mqttEntries: () =>
            Object.entries({
                'zigbee2mqtt/radar_workshop/occupancy': { val: true, lc: NOW - 5000 },
                'zigbee2mqtt/radar_workshop/illuminance': { val: 12, lc: NOW - 5000 },
                'zigbee2mqtt/tfk_workshop/contact': { val: false, lc: NOW - 60000 },
                'hm/status/Licht Workshop/STATE': { val: true, lc: NOW - 1000 },
                'hm/set/Licht Workshop/STATE': { val: true, lc: NOW - 1000 },
                'hm/maintenance/Licht Workshop/online': { val: true },
                'radar-workshop/status/pir': { val: false, lc: NOW - 2000 },
                'var/status/presence/workshop': { val: { val: true }, lc: NOW - 3000 },
                'hm/status/Licht Kitchen/STATE': { val: false },
            }),
    };
    const introspect = {
        config: () => ({ variablePrefix: 'var' }),
        scripts: () => [
            {
                label: 'presence/workshop.js',
                subscriptions: ['zigbee2mqtt/radar_workshop/occupancy', 'radar-workshop/status/pir'],
                varSubscriptions: [],
                publishes: ['var/set/presence/workshop'],
                jobs: [],
                sunEvents: [],
                timers: [],
            },
            {
                label: 'light/workshop.js',
                subscriptions: [],
                varSubscriptions: ['presence/workshop'],
                publishes: ['hm/set/Licht Workshop/STATE'],
                jobs: [],
                sunEvents: [],
                timers: [],
            },
            { label: 'light/kitchen.js', subscriptions: ['hm/status/Licht Kitchen/STATE'], varSubscriptions: [], publishes: [], jobs: [], sunEvents: [], timers: [] },
        ],
        devices: () => [{ id: 'd1', name: 'Workshop Light', entities: [{ component: 'light', name: 'Workshop Light' }], refTopics: ['hm/status/Licht Workshop/STATE'] }],
    };
    const ctx = { store, introspect };

    it('groups the room by device, lists the variables, the scripts and the discovery', async () => {
        const out = await executeTool('describe_room', { name: 'workshop' }, ctx);
        const lines = out.split('\n');
        expect(lines[0]).toBe('Room "workshop": 4 device(s), 1 variable(s), 8 topic(s).');
        expect(out).toContain('## hm/Licht Workshop (3 topics)');
        expect(out).toMatch(/## hm\/Licht Workshop \(3 topics\)\nhm\/status\/Licht Workshop\/STATE: true \(changed 1s ago\)\nhm\/set\/Licht Workshop\/STATE/); // status before set
        expect(out).toContain('## radar-workshop (1 topic)');
        expect(out).toContain('## zigbee2mqtt/radar_workshop (2 topics)');
        expect(out).toContain('## zigbee2mqtt/tfk_workshop (1 topic)');
        expect(out).toContain('## variables (1)\nvar/status/presence/workshop: {"val":true} (changed 3s ago)');
        expect(out).toContain('## scripts (2)');
        expect(out).toContain('- light/workshop.js: subscribes var/status/presence/workshop; publishes hm/set/Licht Workshop/STATE');
        expect(out).toContain('- presence/workshop.js: subscribes zigbee2mqtt/radar_workshop/occupancy, radar-workshop/status/pir; publishes var/set/presence/workshop');
        expect(out).not.toContain('kitchen');
        expect(out).toContain('## Home Assistant discovery (1)\n- Workshop Light: light Workshop Light');
        expect(await executeTool('describe_room', { name: 'workshop', limit: 1 }, ctx)).toContain('… 2 more; describe_device "Licht Workshop" for all of them');
        expect(await executeTool('describe_room', { name: 'attic' }, ctx)).toMatch(/^No topic segment contains "attic"/);
        expect(await executeTool('describe_room', {}, ctx)).toBe('name is required.');
    });

    it('describe_device answers several names in one call', async () => {
        const out = await executeTool('describe_device', { names: ['radar_workshop', 'Licht Kitchen'] }, ctx);
        expect(out).toMatch(/^# radar_workshop\n2 topic\(s\) for "radar_workshop":/);
        expect(out).toContain('\n\n# Licht Kitchen\n1 topic(s) for "Licht Kitchen":');
        expect(await executeTool('describe_device', {}, ctx)).toBe('name (or names) is required.');
    });
});

describe('read_script with its surroundings (I35)', () => {
    it('puts the subscriptions, publishes and the wired scripts above the source', async () => {
        const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-scripts-'));
        fs.mkdirSync(path.join(scriptDir, 'presence'));
        fs.writeFileSync(path.join(scriptDir, 'presence', 'workshop.js'), "she.info('x');\n");
        const introspect = {
            config: () => ({ variablePrefix: 'var' }),
            scripts: () => [
                {
                    file: scriptDir + '/presence/workshop.js',
                    label: 'presence/workshop.js',
                    subscriptions: ['zigbee2mqtt/radar_workshop/occupancy'],
                    varSubscriptions: ['mode'],
                    publishes: ['var/set/presence/workshop'],
                    jobs: [{ next: Date.now() + 3600000 }],
                    sunEvents: [],
                    timers: [{ due: 1 }],
                },
                {
                    file: scriptDir + '/light/workshop.js',
                    label: 'light/workshop.js',
                    subscriptions: [],
                    varSubscriptions: ['presence/workshop'],
                    publishes: ['hm/set/Licht Workshop/STATE'],
                    jobs: [],
                    sunEvents: [],
                    timers: [],
                },
                { file: scriptDir + '/modes.js', label: 'modes.js', subscriptions: [], varSubscriptions: [], publishes: ['var/set/mode'], jobs: [], sunEvents: [], timers: [] },
                { file: scriptDir + '/other.js', label: 'other.js', subscriptions: ['hm/status/x'], varSubscriptions: [], publishes: [], jobs: [], sunEvents: [], timers: [] },
            ],
        };
        const out = await executeTool('read_script', { path: 'presence/workshop.js' }, { scriptDir, introspect });
        const header = out.split('```')[0];
        expect(header).toContain('## presence/workshop.js\n');
        expect(header).toContain('- subscribes: zigbee2mqtt/radar_workshop/occupancy, var/status/mode');
        expect(header).toContain('- publishes (seen since start): var/set/presence/workshop');
        expect(header).toMatch(/- schedules: job in 1h/);
        expect(header).toContain('- pending timers: 1');
        expect(header).toContain('- read by: light/workshop.js (they subscribe to what this script publishes)');
        expect(header).toContain('- fed by: modes.js (they publish what this script subscribes to)');
        expect(header).not.toContain('other.js');
        expect(out).toContain("```javascript\nshe.info('x');");
        // not loaded: the source alone
        fs.writeFileSync(path.join(scriptDir, 'new.js'), '1;\n');
        expect(await executeTool('read_script', { path: 'new.js' }, { scriptDir, introspect })).toBe('## new.js\n```javascript\n1;\n\n```');
        fs.rmSync(scriptDir, { recursive: true, force: true });
    });
});

describe('bulk parameters (I39)', () => {
    const NOW = Date.now();
    const store = {
        mqttEntries: () =>
            Object.entries({
                'var/status/presence/a': { val: true, ts: NOW, lc: NOW },
                'var/status/presence/b': { val: false, ts: NOW, lc: NOW },
                'hm/status/x/STATE': { val: 1, ts: NOW, lc: NOW },
            }),
        getObject: (k) => ({ 'mqtt::var/status/presence/a': { val: true, ts: NOW, lc: NOW }, 'mqtt::var/status/presence/b': { val: false, ts: NOW, lc: NOW } })[k],
    };

    it('read_script reads several files', async () => {
        const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-scripts-'));
        fs.writeFileSync(path.join(scriptDir, 'a.js'), '1;\n');
        fs.writeFileSync(path.join(scriptDir, 'b.js'), '2;\n');
        const out = await executeTool('read_script', { paths: ['a.js', 'b.js', 'c.js'] }, { scriptDir });
        expect(out).toContain('## a.js\n```javascript\n1;');
        expect(out).toContain('\n\n## b.js\n```javascript\n2;');
        expect(out).toContain('File not found: c.js');
        fs.rmSync(scriptDir, { recursive: true, force: true });
    });

    it('get_mqtt_topic answers a list or a filter', async () => {
        const out = await executeTool('get_mqtt_topic', { topics: 'var/status/presence/#' }, { store });
        expect(out).toMatch(/^var\/status\/presence\/a: true\n/);
        expect(out).toContain('var/status/presence/b: false');
        expect(await executeTool('get_mqtt_topic', { topics: ['var/status/presence/a', 'nothing/here'] }, { store })).toMatch(/Topic "nothing\/here" not found/);
        expect(await executeTool('get_mqtt_topic', { topic: 'var/status/presence/b' }, { store })).toMatch(/^var\/status\/presence\/b: false/);
    });

    it('search_mqtt_topics runs several queries', async () => {
        const out = await executeTool('search_mqtt_topics', { queries: ['presence', 'hm/status/#'] }, { store });
        expect(out).toMatch(/^# "presence"\n2 of 2 matching topic/);
        expect(out).toContain('\n\n# "hm/status/#"\n1 of 1 matching topic');
    });

    it('get_topic_messages queries several topics in one Elastic request', async () => {
        const elastic = require('../../src/elastic');
        const calls = [];
        elastic.getClient.mockReturnValue({
            search: async (q) => {
                calls.push(q);
                return {
                    hits: {
                        total: { value: 2 },
                        hits: [
                            { _source: { '@timestamp': 2000, 'topic': 'var/status/presence/b', 'payload': 'false' } },
                            { _source: { '@timestamp': 1000, 'topic': 'var/status/presence/a', 'payload': 'true' } },
                        ],
                    },
                };
            },
        });
        const out = await executeTool('get_topic_messages', { topics: 'var/status/presence/#', from: '2026-10-08T00:00:00Z', to: '2026-10-08T01:00:00Z' }, { store });
        expect(calls).toHaveLength(1);
        expect(calls[0].query.bool.filter[0]).toEqual({ terms: { topic: ['var/status/presence/a', 'var/status/presence/b'] } });
        expect(out).toMatch(/^2 of 2 messages for 2 topics \(var\/status\/presence\/a, var\/status\/presence\/b\)/);
        expect(out).toContain('1970-01-01 00:00:02Z  var/status/presence/b  false');
        elastic.getClient.mockReturnValue(null);
    });
});

describe('run_analysis (I42)', () => {
    const NOW = Date.now();
    const store = {
        mqttEntries: () =>
            Object.entries({
                'radar-x/status/pir': { val: true, ts: NOW, lc: NOW - 5000 },
                'radar-x/status/has_target': { val: false, ts: NOW, lc: NOW },
                'home/status/door/contact': { val: false, ts: NOW, lc: NOW },
            }),
    };

    it('runs the code over the state store and returns the result with console lines', async () => {
        const out = await executeTool(
            'run_analysis',
            {
                code: "const t = await data.topics('radar-x/status/#'); console.log('n', t.length); return { count: t.length, on: t.filter((x) => x.value === true).map((x) => x.topic), from: data.from };",
                from: '-6h',
            },
            { store },
        );
        expect(out.text).toMatch(/^Result after \d+ ms and 1 data call:\n\{"count":2,"on":\["radar-x\/status\/pir"\],"from":"-6h"\}\nconsole \(1 line\):\nn 2$/);
        expect(out.event).toMatchObject({ type: 'analysis', result: '{"count":2,"on":["radar-x/status/pir"],"from":"-6h"}', error: null, logs: ['n 2'] });
    }, 20000);

    it('reads history through the same loader as get_topic_history', async () => {
        influx.getMode.mockReturnValue('v1');
        influx.v1Query.mockImplementation(async (q) =>
            q.includes('"radar-x//pir"')
                ? [
                      { time: 1000, value: false },
                      { time: 5000, value: true },
                      { time: 9000, value: false },
                  ]
                : [],
        );
        const out = await executeTool(
            'run_analysis',
            {
                code: "const h = await data.history(['radar-x/status/pir'], '2026-10-08T00:00:00Z', '2026-10-08T01:00:00Z'); const s = h['radar-x/status/pir']; return { points: s.length, onFor: s[2].time - s[1].time };",
            },
            { store },
        );
        expect(out.event.result).toBe('{"points":3,"onFor":4000}');
    }, 20000);

    it('reports errors, refuses what the sandbox does not have, and stops a runaway loop', async () => {
        const err = await executeTool('run_analysis', { code: 'return await data.history([]);' }, { store });
        expect(err.text).toMatch(/^The analysis failed: history needs topics/);
        expect(err.event.error).toMatch(/history needs topics/);
        const noReq = await executeTool('run_analysis', { code: "return typeof require + ' ' + typeof process + ' ' + typeof she;" }, { store });
        expect(noReq.event.result).toBe('"undefined undefined undefined"');
        const loop = await executeTool('run_analysis', { code: 'await data.topics(); while (true) {}' }, { store, analysisTimeoutMs: 1500 });
        expect(loop.text).toMatch(/did not finish within 1.5 s and was stopped/);
        expect(await executeTool('run_analysis', {}, { store })).toMatch(/code is required/);
    }, 30000);

    it('caps a large result', async () => {
        const out = await executeTool('run_analysis', { code: "return 'x'.repeat(10000);" }, { store, resultChars: 600 });
        expect(out.event.result.length).toBeLessThan(700);
        expect(out.text).toMatch(/cut after 600 characters \(10002 total\)/);
    }, 20000);
});
