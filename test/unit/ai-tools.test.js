'use strict';

const dns = require('dns');
const { executeTool, _internal } = require('../../src/web/ai-tools');
const { isPrivateAddress, isLocalName, parseDuration, valueMatcher, pageOf } = _internal;

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
        for (let i = 0; i < 10; i++) logWs.broadcastLog({ level: 'info', msg: 'paged line ' + i, ts: NOW + i });
        const out = await executeTool('get_script_logs', { script_name: 'paged line', limit: 3, offset: 2 }, {});
        expect(out).toMatch(/^3 of 10 lines \(5 older; offset 5 for them\):/);
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
