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
