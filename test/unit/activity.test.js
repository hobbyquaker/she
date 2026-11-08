'use strict';

const { EventEmitter } = require('events');
const activity = require('../../src/lib/activity');

describe("the heartbeat's attribution of the daemon's own work", () => {
    beforeEach(() => activity.reset());

    it('says so when nothing is tracked', () => {
        expect(activity.describe(1000, 1050)).toBe('no HTTP request or child process active');
    });

    it('names the HTTP request in flight with its age', () => {
        activity.routeStarted('GET', '/she/services/hosts', 1000);
        expect(activity.describe(1400, 1450)).toBe('HTTP GET /she/services/hosts in flight for 450ms');
    });

    it('names a request that ended since the previous beat, and forgets one that ended before it', () => {
        const id = activity.routeStarted('POST', '/she/mqtt/publish', 1000);
        activity.routeEnded(id, 1420);
        expect(activity.describe(1400, 1450)).toBe('HTTP POST /she/mqtt/publish ended 30ms ago after 420ms');
        expect(activity.describe(1430, 1480)).toBe('no HTTP request or child process active');
    });

    it('lists at most three requests in flight and counts the rest', () => {
        for (let i = 0; i < 5; i++) activity.routeStarted('GET', '/she/r' + i, 1000);
        const d = activity.describe(1400, 1500);
        expect(d).toBe('HTTP GET /she/r0 in flight for 500ms; HTTP GET /she/r1 in flight for 500ms; HTTP GET /she/r2 in flight for 500ms; 2 more HTTP request(s) in flight');
    });

    it('names the last child: spawned since the beat, running, exited', () => {
        const rec = activity.childSpawned('sudo -n she-servicectl list', 1000);
        expect(activity.describe(900, 1300)).toBe('child sudo -n she-servicectl list spawned 300ms ago');
        expect(activity.describe(1100, 1300)).toBe('child sudo -n she-servicectl list running since 300ms');
        activity.childExited(rec, 0, 1297);
        expect(activity.describe(1100, 1300)).toBe('child sudo -n she-servicectl list exited 3ms ago after 297ms');
        expect(activity.describe(900, 1300)).toBe('child sudo -n she-servicectl list spawned 300ms ago, exited 3ms ago');
        // long gone: not mentioned
        expect(activity.describe(1298, 1400)).toBe('no HTTP request or child process active');
    });

    it('combines the request and the child the way the Services poll looks', () => {
        activity.routeStarted('GET', '/she/services/hosts', 1000);
        activity.childSpawned('sudo -n she-servicectl list', 1005);
        expect(activity.describe(950, 1430)).toBe('HTTP GET /she/services/hosts in flight for 430ms; child sudo -n she-servicectl list spawned 425ms ago');
    });

    it('track() records a ChildProcess from spawn to exit', () => {
        const child = new EventEmitter();
        expect(activity.track(child, 'git status')).toBe(child);
        expect(activity.describe(0)).toMatch(/^child git status spawned \d+ms ago$/);
        child.emit('exit', 0);
        expect(activity.describe(0)).toMatch(/^child git status spawned \d+ms ago, exited \d+ms ago$/);
    });

    it('middleware() records a request until the response finished', () => {
        const mw = activity.middleware();
        const res = new EventEmitter();
        const next = jest.fn();
        mw({ method: 'GET', originalUrl: '/she/status?x=1' }, res, next);
        expect(next).toHaveBeenCalled();
        expect(activity.describe(0)).toMatch(/^HTTP GET \/she\/status in flight for \d+ms$/);
        res.emit('finish');
        res.emit('close'); // a second end event is harmless
        expect(activity.describe(0)).toMatch(/^HTTP GET \/she\/status ended \d+ms ago after \d+ms$/);
    });

    it('commandLabel() keeps four words with basenames', () => {
        expect(activity.commandLabel('sudo', ['-n', '/usr/local/bin/she-servicectl', 'list', 'extra'])).toBe('sudo -n she-servicectl list');
        expect(activity.commandLabel('/usr/bin/git', ['status'])).toBe('git status');
        expect(activity.commandLabel('x', ['y'.repeat(100)])).toHaveLength(78);
    });
});
