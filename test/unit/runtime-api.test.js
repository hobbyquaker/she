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
            history: () => ({ intervalMs: 10_000, samples: rt.gauges.list() }),
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
        expect(res.body).toEqual({ intervalMs: 10_000, samples: [{ ts: 1_000_000, memMb: 50 }] });
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
