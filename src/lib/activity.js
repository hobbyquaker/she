'use strict';

/**
 * What the daemon itself is doing — for the event-loop heartbeat's attribution.
 *
 * The heartbeat knows which *script* dispatched a callback since the previous beat. When none did,
 * the lag came from the daemon's own work, and the two kinds that are cheap to track are the HTTP
 * requests in flight (an Express middleware records start and end) and the child processes it
 * spawns (the services helper, ssh, npm, git — `track()` records spawn and exit). `describe()`
 * turns what was active or ended since the previous beat into one phrase for the warning line:
 *
 *   event loop lag 430ms — no script active; HTTP GET /she/services/hosts in flight for 612ms;
 *   child sudo -n she-servicectl list spawned 430ms ago, exited 3ms ago
 *
 * Nothing here looks at the work itself; it only names it.
 */

const path = require('path');

const routes = new Map(); // id → { method, path, since }
let nextRouteId = 1;
let lastRoute = null; // the most recently ended request: { method, path, since, endedAt }
let lastChild = null; // the most recently spawned child: { label, since, endedAt, code }
const MAX_LISTED = 3;

/** @returns {number} a token for routeEnded() */
function routeStarted(method, urlPath, now = Date.now()) {
    const id = nextRouteId++;
    routes.set(id, { method, path: urlPath, since: now });
    return id;
}

function routeEnded(id, now = Date.now()) {
    const r = routes.get(id);
    if (!r) return;
    routes.delete(id);
    lastRoute = { ...r, endedAt: now };
}

/** Express middleware: one entry per request from arrival to the end of the response. */
function middleware() {
    return (req, res, next) => {
        const id = routeStarted(req.method, (req.originalUrl || req.url || '').split('?')[0]);
        let done = false;
        const end = () => {
            if (done) return;
            done = true;
            routeEnded(id);
        };
        res.on('finish', end);
        res.on('close', end);
        next();
    };
}

/** A short label for a command line: the basenames of the first four words. */
function commandLabel(cmd, argv = []) {
    const words = [cmd, ...argv].slice(0, 4).map((w) => (typeof w === 'string' && w.startsWith('/') ? path.basename(w) : String(w)));
    const label = words.join(' ');
    return label.length > 80 ? label.slice(0, 77) + '…' : label;
}

/** @returns {{label: string, since: number, endedAt: number|null, code: number|null}} the record, for childExited() */
function childSpawned(label, now = Date.now()) {
    lastChild = { label, since: now, endedAt: null, code: null };
    return lastChild;
}

function childExited(record, code = null, now = Date.now()) {
    if (!record || record.endedAt !== null) return;
    record.endedAt = now;
    record.code = code;
}

/**
 * Record a ChildProcess: spawned now, exited when it exits (or fails to start).
 * @template T
 * @param {T} child a ChildProcess (or anything with `on`)
 * @param {string} label
 * @returns {T} the child, for chaining
 */
function track(child, label) {
    const record = childSpawned(label);
    if (child && typeof child.on === 'function') {
        child.on('exit', (code) => childExited(record, code));
        child.on('error', () => childExited(record, null));
    }
    return child;
}

/**
 * One phrase naming the daemon activity since `since` (the previous beat): the HTTP requests in
 * flight or ended since then, the last child process when it was spawned, running or exited since
 * then. Without any: "no HTTP request or child process active".
 * @param {number} since ms since the epoch
 * @param {number} [now]
 */
function describe(since, now = Date.now()) {
    const parts = [];
    const inFlight = [...routes.values()];
    for (const r of inFlight.slice(0, MAX_LISTED)) parts.push(`HTTP ${r.method} ${r.path} in flight for ${now - r.since}ms`);
    if (inFlight.length > MAX_LISTED) parts.push(`${inFlight.length - MAX_LISTED} more HTTP request(s) in flight`);
    if (lastRoute && lastRoute.endedAt >= since && !inFlight.length) {
        parts.push(`HTTP ${lastRoute.method} ${lastRoute.path} ended ${now - lastRoute.endedAt}ms ago after ${lastRoute.endedAt - lastRoute.since}ms`);
    }
    const c = lastChild;
    if (c && (c.endedAt === null || c.endedAt >= since || c.since >= since)) {
        const bits = [];
        if (c.since >= since) bits.push(`spawned ${now - c.since}ms ago`);
        else if (c.endedAt === null) bits.push(`running since ${now - c.since}ms`);
        if (c.endedAt !== null) bits.push(`exited ${now - c.endedAt}ms ago${c.since < since ? ` after ${c.endedAt - c.since}ms` : ''}`);
        parts.push(`child ${c.label} ${bits.join(', ')}`);
    }
    return parts.length ? parts.join('; ') : 'no HTTP request or child process active';
}

/** Test hook. */
function reset() {
    routes.clear();
    nextRouteId = 1;
    lastRoute = null;
    lastChild = null;
}

module.exports = { middleware, routeStarted, routeEnded, track, childSpawned, childExited, commandLabel, describe, reset };
