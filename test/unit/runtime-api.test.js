'use strict';

const http = require('http');
const express = require('express');
const { Runtime } = require('../../src/lib/runtime');
const runtimeApi = require('../../src/web/runtime-api');

function request(port, method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request(
            { host: '127.0.0.1', port, path, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
            (res) => {
                let raw = '';
                res.on('data', (c) => (raw += c));
                res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
            },
        );
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

describe('runtime API', () => {
    let server, port, rt, logged;

    beforeAll((done) => {
        rt = new Runtime();
        logged = [];
        runtimeApi.init({
            runtime: rt,
            snapshot: (label) => rt.snapshot({ script: label ? '/s/' + label : undefined, label: (f) => f.slice(3) }),
            history: (since) => ({ intervalMs: 10_000, samples: rt.gauges.list(), minutes: { intervalMs: rt.minutes.intervalMs, samples: rt.minutes.list(since) } }),
            log: (file, msg) => logged.push([file, msg]),
        });
        const app = express();
        app.use(express.json());
        app.use('/she/runtime', runtimeApi.router);
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            done();
        });
    });
    afterAll((done) => {
        server.close(done);
    });

    it('GET /she/runtime returns the model, filtered by ?script=<label>', async () => {
        rt.handler('/s/a.js', { kind: 'sub', name: 'x' });
        rt.handler('/s/b.js', { kind: 'sub', name: 'y' });
        const all = await request(port, 'GET', '/she/runtime');
        expect(all.status).toBe(200);
        expect(all.body.scripts.map((s) => s.label)).toEqual(['a.js', 'b.js']);
        expect(all.body).toHaveProperty('gauges');
        expect(all.body).toHaveProperty('commandsFailed', 0);
        const one = await request(port, 'GET', '/she/runtime?script=b.js');
        expect(one.body.scripts.map((s) => s.label)).toEqual(['b.js']);
    });

    it('GET /she/runtime/history returns the gauge ring', async () => {
        rt.gauges.push({ ts: 1_000_000, memMb: 50 });
        const res = await request(port, 'GET', '/she/runtime/history');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ intervalMs: 10_000, samples: [{ ts: 1_000_000, memMb: 50 }], minutes: { intervalMs: 60_000, samples: [] } });
    });

    it('GET /she/runtime/history carries the day at one sample per minute, ?since= limits it', async () => {
        const MIN = 60_000;
        for (let i = 0; i < 4; i++) rt.minutes.push({ ts: 100 * MIN + i * MIN + 5000, cpuPercent: i, elMaxMs: 20 + i, memMb: 150, callbacks: 2, errors: 0 });
        rt.minutes.push({ ts: 103 * MIN + 30_000, cpuPercent: 50, elMaxMs: 400, memMb: 160, callbacks: 3, errors: 1 });
        const res = await request(port, 'GET', '/she/runtime/history');
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(['intervalMs', 'minutes', 'samples']);
        expect(res.body.intervalMs).toBe(10_000);
        expect(Array.isArray(res.body.samples)).toBe(true);
        expect(res.body.minutes.intervalMs).toBe(MIN);
        expect(res.body.minutes.samples.map((s) => s.ts)).toEqual([100 * MIN, 101 * MIN, 102 * MIN, 103 * MIN]);
        // the minute still open is the last one: the worst lag and CPU of its samples, the counts added up
        expect(res.body.minutes.samples[3]).toEqual({ ts: 103 * MIN, cpuPercent: 50, elMaxMs: 400, memMb: 160, callbacks: 5, errors: 1 });

        const since = await request(port, 'GET', '/she/runtime/history?since=' + 102 * MIN);
        expect(since.body.minutes.samples.map((s) => s.ts)).toEqual([102 * MIN, 103 * MIN]);
        expect(since.body.samples).toEqual(res.body.samples);
        const junk = await request(port, 'GET', '/she/runtime/history?since=abc');
        expect(junk.body.minutes.samples).toHaveLength(4);
    });

    it('POST /she/runtime/action cancels and runs a pending timer and logs it to the script', async () => {
        const g = rt.timerGroup('/s/a.js', { kind: 'timeout', name: 'hall off' });
        const fire = jest.fn();
        const cancel = jest.fn();
        const p = rt.addPending(g, { due: 1, fire, cancel });
        let res = await request(port, 'POST', '/she/runtime/action', { id: p.id, action: 'run' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, kind: 'timeout', name: 'hall off', what: 'timer' });
        expect(fire).toHaveBeenCalledTimes(1);
        res = await request(port, 'POST', '/she/runtime/action', { id: p.id, action: 'cancel' });
        expect(res.status).toBe(200);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(logged).toEqual([
            ['/s/a.js', 'timeout "hall off" run now from the editor'],
            ['/s/a.js', 'timeout "hall off" cancelled from the editor'],
        ]);
    });

    it('runs a schedule once (the schedule stays) and refuses to cancel it', async () => {
        const run = jest.fn();
        const h = rt.handler('/s/a.js', { kind: 'schedule', name: '0 7 * * *', run, next: () => 123 });
        let res = await request(port, 'POST', '/she/runtime/action', { id: h.id, action: 'run' });
        expect(res.status).toBe(200);
        expect(run).toHaveBeenCalledTimes(1);
        expect(rt.handlers.has(h.id)).toBe(true);
        res = await request(port, 'POST', '/she/runtime/action', { id: h.id, action: 'cancel' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/not possible/);
    });

    it('404 for an id of a script that was reloaded in between, 400 for a bad body', async () => {
        const g = rt.timerGroup('/s/c.js', { kind: 'timer' });
        const p = rt.addPending(g, { due: 1, fire: () => {}, cancel: () => {} });
        rt.removeScript('/s/c.js');
        let res = await request(port, 'POST', '/she/runtime/action', { id: p.id, action: 'cancel' });
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/reloaded/);
        res = await request(port, 'POST', '/she/runtime/action', { id: 5, action: 'cancel' });
        expect(res.status).toBe(400);
        res = await request(port, 'POST', '/she/runtime/action', { id: 't1', action: 'flush' });
        expect(res.status).toBe(400);
    });
});
