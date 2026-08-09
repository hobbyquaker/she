'use strict';

/**
 * Unit tests for src/influx.js (v1/v2 mode detection, line protocol, v1 HTTP
 * API) and the v1 paths of she.influx.* (src/sandbox/influx-sandbox.js).
 * The v1 HTTP transport is tested against a mocked global fetch.
 */

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

describe('src/influx', () => {
    let influx;

    beforeEach(() => {
        jest.resetModules();
        influx = require('../../src/influx');
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('mode detection', () => {
        it('stays unconfigured without opts or url', () => {
            influx.init(undefined);
            expect(influx.getMode()).toBeNull();
            influx.init({ token: 't' });
            expect(influx.getMode()).toBeNull();
        });

        it('detects v1 when database is set and token is not', () => {
            influx.init({ url: 'http://localhost:8086', database: 'she' });
            expect(influx.getMode()).toBe('v1');
            expect(influx.getClient()).toBeNull();
        });

        it('honours an explicit version: 1', () => {
            influx.init({ url: 'http://localhost:8086', database: 'she', version: 1, token: 'ignored-in-v1' });
            expect(influx.getMode()).toBe('v1');
        });

        it('requires database in v1 mode', () => {
            influx.init({ url: 'http://localhost:8086', version: 1 });
            expect(influx.getMode()).toBeNull();
        });

        it('detects v2 when token is set', () => {
            influx.init({ url: 'http://localhost:8086', token: 't', org: 'o', bucket: 'b' });
            expect(influx.getMode()).toBe('v2');
            expect(influx.getClient()).not.toBeNull();
        });

        it('requires token in v2 mode', () => {
            influx.init({ url: 'http://localhost:8086', org: 'o', bucket: 'b' });
            expect(influx.getMode()).toBeNull();
        });
    });

    describe('buildLine (line protocol)', () => {
        it('builds a minimal line', () => {
            expect(influx.buildLine('temp', { value: 21.5 })).toBe('temp value=21.5');
        });

        it('appends tags and a ms timestamp', () => {
            expect(influx.buildLine('temp', { value: 1 }, { room: 'living' }, 1700000000000)).toBe('temp,room=living value=1 1700000000000');
            expect(influx.buildLine('temp', { value: 1 }, undefined, new Date(1700000000000))).toBe('temp value=1 1700000000000');
        });

        it('serialises booleans, numbers and strings', () => {
            expect(influx.buildLine('m', { on: true, n: 2, s: 'text' })).toBe('m on=true,n=2,s="text"');
        });

        it('escapes measurement, tags, field keys and string values', () => {
            expect(influx.buildLine('my measure,ment', { 'field key': 'a "quoted" \\ value' }, { 'tag key': 'tag,val=x' })).toBe(
                'my\\ measure\\,ment,tag\\ key=tag\\,val\\=x field\\ key="a \\"quoted\\" \\\\ value"',
            );
        });

        it('quotes non-finite numbers as strings', () => {
            expect(influx.buildLine('m', { v: Infinity })).toBe('m v="Infinity"');
        });
    });

    describe('v1Write', () => {
        beforeEach(() => {
            influx.init({ url: 'http://influx:8086/', database: 'she', username: 'u', password: 'p', retentionPolicy: 'autogen' });
        });

        it('POSTs line protocol to /write with db, rp, precision and Basic auth', async () => {
            const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({}, 204));
            await influx.v1Write('temp value=1');
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, opts] = fetchMock.mock.calls[0];
            expect(url).toMatch(/^http:\/\/influx:8086\/write\?/);
            const params = new URL(url).searchParams;
            expect(params.get('db')).toBe('she');
            expect(params.get('rp')).toBe('autogen');
            expect(params.get('precision')).toBe('ms');
            expect(opts.method).toBe('POST');
            expect(opts.body).toBe('temp value=1');
            expect(opts.headers.Authorization).toBe('Basic ' + Buffer.from('u:p').toString('base64'));
        });

        it('throws on a non-2xx response', async () => {
            jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ error: 'database not found' }, 404));
            await expect(influx.v1Write('temp value=1')).rejects.toThrow(/HTTP 404/);
        });
    });

    describe('v1Query', () => {
        beforeEach(() => {
            influx.init({ url: 'http://influx:8086', database: 'she' });
        });

        it('GETs /query with db, q and epoch=ms, without auth header when no username', async () => {
            const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ results: [] }));
            await influx.v1Query('SELECT * FROM temp');
            const [url, opts] = fetchMock.mock.calls[0];
            const params = new URL(url).searchParams;
            expect(params.get('db')).toBe('she');
            expect(params.get('q')).toBe('SELECT * FROM temp');
            expect(params.get('epoch')).toBe('ms');
            expect(opts.headers.Authorization).toBeUndefined();
        });

        it('flattens series into row objects with measurement and tags', async () => {
            jest.spyOn(global, 'fetch').mockResolvedValue(
                jsonResponse({
                    results: [
                        {
                            series: [
                                {
                                    name: 'mqtt',
                                    tags: { topic: 'home/temp' },
                                    columns: ['time', 'value'],
                                    values: [
                                        [1700000000000, 21.5],
                                        [1700000060000, 21.7],
                                    ],
                                },
                            ],
                        },
                    ],
                }),
            );
            const rows = await influx.v1Query('SELECT ...');
            expect(rows).toEqual([
                { _measurement: 'mqtt', topic: 'home/temp', time: 1700000000000, value: 21.5 },
                { _measurement: 'mqtt', topic: 'home/temp', time: 1700000060000, value: 21.7 },
            ]);
        });

        it('throws on a statement-level error', async () => {
            jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ results: [{ error: 'invalid query' }] }));
            await expect(influx.v1Query('BOGUS')).rejects.toThrow(/invalid query/);
        });
    });

    describe('escapeQL', () => {
        it('escapes single quotes and backslashes', () => {
            expect(influx.escapeQL("it's a \\ topic")).toBe("it\\'s a \\\\ topic");
        });
    });
});

describe('she.influx sandbox (v1 mode)', () => {
    let she;
    let influx;

    beforeEach(() => {
        jest.resetModules();
        influx = require('../../src/influx');
        influx.init({ url: 'http://influx:8086', database: 'she' });
        she = {};
        require('../../src/sandbox/influx-sandbox')(she);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('query() passes InfluxQL through to the v1 API', async () => {
        const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ results: [] }));
        await she.influx.query('SELECT value FROM mqtt WHERE "topic" = \'x\'');
        const params = new URL(fetchMock.mock.calls[0][0]).searchParams;
        expect(params.get('q')).toBe('SELECT value FROM mqtt WHERE "topic" = \'x\'');
    });

    it('write() sends line protocol', async () => {
        const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({}, 204));
        await she.influx.write('temp', { value: 21.5 }, { room: 'living' }, 1700000000000);
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toContain('/write?');
        expect(opts.body).toBe('temp,room=living value=21.5 1700000000000');
    });

    it('getLast() escapes the topic, merges series, trims to n and sorts ascending', async () => {
        const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
            jsonResponse({
                results: [
                    {
                        series: [
                            {
                                name: 'a',
                                columns: ['time', 'value', 'topic'],
                                values: [
                                    [3000, 3, "it's/temp"],
                                    [1000, 1, "it's/temp"],
                                ],
                            },
                            {
                                name: 'b',
                                columns: ['time', 'value', 'topic'],
                                values: [[2000, 2, "it's/temp"]],
                            },
                        ],
                    },
                ],
            }),
        );
        const pts = await she.influx.getLast("it's/temp", 2);
        const params = new URL(fetchMock.mock.calls[0][0]).searchParams;
        expect(params.get('q')).toBe("SELECT * FROM /.*/ WHERE \"topic\" = 'it\\'s/temp' ORDER BY time DESC LIMIT 2");
        // newest two (ts 2000, 3000), oldest first
        expect(pts).toEqual([
            { ts: 2000, val: 2 },
            { ts: 3000, val: 3 },
        ]);
    });

    it('getRange() bounds the time range in ms and sorts ascending', async () => {
        const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
            jsonResponse({
                results: [
                    {
                        series: [
                            {
                                name: 'mqtt',
                                columns: ['time', 'value', 'topic'],
                                values: [
                                    [2000, 'b', 'home/x'],
                                    [1000, 'a', 'home/x'],
                                ],
                            },
                        ],
                    },
                ],
            }),
        );
        const pts = await she.influx.getRange('home/x', 1000, 2000);
        const params = new URL(fetchMock.mock.calls[0][0]).searchParams;
        expect(params.get('q')).toBe('SELECT * FROM /.*/ WHERE "topic" = \'home/x\' AND time >= 1000ms AND time <= 2000ms');
        expect(pts).toEqual([
            { ts: 1000, val: 'a' },
            { ts: 2000, val: 'b' },
        ]);
    });

    it('falls back to the first data column when no value/val field exists', async () => {
        jest.spyOn(global, 'fetch').mockResolvedValue(
            jsonResponse({
                results: [
                    {
                        series: [
                            {
                                name: 'mqtt',
                                columns: ['time', 'temperature', 'topic'],
                                values: [[1000, 21.5, 'home/x']],
                            },
                        ],
                    },
                ],
            }),
        );
        const pts = await she.influx.getRange('home/x', 0, 2000);
        expect(pts).toEqual([{ ts: 1000, val: 21.5 }]);
    });

    it('resolves empty when influx is not configured', async () => {
        jest.resetModules();
        const she2 = {};
        require('../../src/sandbox/influx-sandbox')(she2);
        await expect(she2.influx.query('x')).resolves.toEqual([]);
        await expect(she2.influx.getLast('t', 5)).resolves.toEqual([]);
        await expect(she2.influx.write('m', { v: 1 })).resolves.toBeUndefined();
    });
});
