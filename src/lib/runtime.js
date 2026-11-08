'use strict';
/**
 * The daemon's runtime model: what every script has registered — subscriptions, variable listeners,
 * schedules, sun events, timers (grouped by kind, name and the line that created them) and pending
 * commands — with per-handler statistics, the timers pending under each handler, and a ring buffer
 * of the daemon's gauges for the last hour.
 *
 * The Runtime page reads the whole model about once a second over the WebSocket while it is open;
 * the script editor's Runtime panel reads one script's part of it. Neither changes the model: the
 * actions (cancel a timer, run it now, run a schedule once) go through the closures the
 * registration site stored on the entry, so the model never reaches into the sandbox itself.
 *
 * Statistics are kept since the script's load and as a sliding five-minute window of thirty 10 s
 * buckets, so a handler firing a hundred times a second costs thirty small objects, not a list of
 * every fire.
 */

const WINDOW_MS = 5 * 60 * 1000;
const BUCKET_MS = 10_000;
const BUCKETS = WINDOW_MS / BUCKET_MS;

/** Fires, errors and time of one handler: totals since load and the last five minutes. */
class HandlerStats {
    constructor() {
        this.fires = 0;
        this.errors = 0;
        this.totalMs = 0;
        this.maxMs = 0;
        this.lastFire = null;
        this.lastMs = null;
        this.lastError = null;
        this._buckets = [];
        for (let i = 0; i < BUCKETS; i++) this._buckets.push({ start: 0, fires: 0, errors: 0, ms: 0 });
    }

    _bucket(now) {
        const start = Math.floor(now / BUCKET_MS) * BUCKET_MS;
        const b = this._buckets[(start / BUCKET_MS) % BUCKETS];
        if (b.start !== start) {
            b.start = start;
            b.fires = 0;
            b.errors = 0;
            b.ms = 0;
        }
        return b;
    }

    /**
     * One callback run.
     * @param {number} ms how long it took
     * @param {boolean} [failed] it threw or rejected
     * @param {number} [now]
     */
    record(ms, failed = false, now = Date.now()) {
        this.fires++;
        this.totalMs += ms;
        if (ms > this.maxMs) this.maxMs = ms;
        this.lastFire = now;
        this.lastMs = ms;
        const b = this._bucket(now);
        b.fires++;
        b.ms += ms;
        if (failed) {
            this.errors++;
            this.lastError = now;
            b.errors++;
        }
    }

    /** An error that showed up after the run was recorded (a rejected promise). */
    fail(now = Date.now()) {
        this.errors++;
        this.lastError = now;
        this._bucket(now).errors++;
    }

    /** The last five minutes. */
    recent(now = Date.now()) {
        const since = now - WINDOW_MS;
        const r = { fires: 0, errors: 0, totalMs: 0 };
        for (const b of this._buckets) {
            if (b.start <= since || b.start > now) continue;
            r.fires += b.fires;
            r.errors += b.errors;
            r.totalMs += b.ms;
        }
        return r;
    }

    toJSON(now = Date.now()) {
        return {
            fires: this.fires,
            errors: this.errors,
            totalMs: Math.round(this.totalMs * 100) / 100,
            maxMs: Math.round(this.maxMs * 100) / 100,
            lastFire: this.lastFire,
            lastMs: this.lastMs === null ? null : Math.round(this.lastMs * 100) / 100,
            lastError: this.lastError,
            recent: (() => {
                const r = this.recent(now);
                r.totalMs = Math.round(r.totalMs * 100) / 100;
                return r;
            })(),
        };
    }
}

/** The daemon's gauges, one sample per interval, for the last hour. */
class GaugeHistory {
    /**
     * @param {object} [opts]
     * @param {number} [opts.intervalMs=10000] how often a sample is kept
     * @param {number} [opts.size=360] samples kept (360 × 10 s = one hour)
     */
    constructor(opts = {}) {
        this.intervalMs = opts.intervalMs || 10_000;
        this.size = opts.size || 360;
        this._samples = [];
        this._lastKept = null;
    }

    /**
     * Offer a sample; it is kept when the interval since the last kept one has passed.
     * @param {object} sample must carry `ts`
     * @returns {boolean} kept
     */
    push(sample) {
        if (this._lastKept !== null && sample.ts - this._lastKept < this.intervalMs) return false;
        this._lastKept = sample.ts;
        this._samples.push(sample);
        if (this._samples.length > this.size) this._samples.shift();
        return true;
    }

    list() {
        return this._samples.slice();
    }
}

class NotFoundError extends Error {
    constructor(id) {
        super(`unknown runtime id ${id} — the script may have been reloaded`);
        this.code = 'ENOENT';
    }
}

/**
 * The registry of handlers and their pending timers.
 */
class Runtime {
    constructor() {
        this._nextId = 1;
        /** @type {Map<string, object>} handler id → handler */
        this.handlers = new Map();
        /** @type {Map<string, object>} pending id → pending (timer, command) */
        this.pending = new Map();
        /** @type {Map<string, Set<object>>} script file → its handlers */
        this.byScript = new Map();
        /** @type {Map<string, object>} `${script}\0${group key}` → timer group handler */
        this._groups = new Map();
        this.gauges = new GaugeHistory();
        this.latestGauges = null;
        this.commandsFailed = 0;
    }

    /**
     * Register a handler.
     * @param {string} script the script file
     * @param {object} info
     * @param {string} info.kind `sub`, `var`, `schedule`, `sun`, or a timer kind
     * @param {string} [info.name] what the UI shows: the topic, the pattern, the timer's name
     * @param {string} [info.detail] a second line: the options, the other topics
     * @param {number|null} [info.line] the script line that registered it
     * @param {Function} [info.run] runs the handler once now (a schedule, an interval)
     * @param {Function} [info.cancel] removes the handler (an interval)
     * @param {Function} [info.next] → ms timestamp of the next run, or null
     * @returns {object} the handler
     */
    handler(script, info) {
        const h = {
            id: 'h' + this._nextId++,
            script,
            kind: info.kind,
            name: info.name ?? null,
            detail: info.detail ?? null,
            line: info.line ?? null,
            stats: new HandlerStats(),
            pending: new Map(),
            run: info.run || null,
            cancel: info.cancel || null,
            next: info.next || null,
            groupKey: info.groupKey || null,
        };
        this.handlers.set(h.id, h);
        let set = this.byScript.get(script);
        if (!set) {
            set = new Set();
            this.byScript.set(script, set);
        }
        set.add(h);
        return h;
    }

    /**
     * The group handler for timers of one kind, name and line in a script — found or created. Its
     * statistics accumulate over every timer that fired under it; the timers pending right now are
     * its `pending`.
     * @param {string} script
     * @param {{kind: string, name?: string, line?: number|null}} meta
     */
    timerGroup(script, meta) {
        const key = `${meta.kind}\0${meta.name ?? ''}\0${meta.line ?? ''}`;
        const mapKey = `${script}\0${key}`;
        let h = this._groups.get(mapKey);
        if (!h) {
            h = this.handler(script, { kind: meta.kind, name: meta.name, line: meta.line, groupKey: key });
            this._groups.set(mapKey, h);
        }
        return h;
    }

    /**
     * A timer (or command) pending under a handler.
     * @param {object} handler
     * @param {object} info
     * @param {number} info.due ms timestamp when it fires
     * @param {number} [info.start] ms timestamp when it was armed (default now)
     * @param {number} [info.every] an interval's period
     * @param {Function} [info.fire] fires it now (removes it, runs the callback)
     * @param {Function} [info.cancel] removes it without running
     * @param {object} [info.extra] shown as is (a command's topic, payload, tries)
     * @returns {object} the pending entry
     */
    addPending(handler, info) {
        const p = {
            id: 't' + this._nextId++,
            handler,
            due: info.due,
            start: info.start ?? Date.now(),
            every: info.every ?? null,
            fire: info.fire || null,
            cancel: info.cancel || null,
            extra: info.extra || null,
        };
        handler.pending.set(p.id, p);
        this.pending.set(p.id, p);
        return p;
    }

    /** A pending entry fired or was cleared. */
    removePending(p) {
        if (!p) return;
        p.handler.pending.delete(p.id);
        this.pending.delete(p.id);
    }

    /** A handler is gone (the subscription removed, the interval cleared). */
    removeHandler(h) {
        if (!h || !this.handlers.has(h.id)) return;
        for (const p of h.pending.values()) this.pending.delete(p.id);
        h.pending.clear();
        this.handlers.delete(h.id);
        this.byScript.get(h.script)?.delete(h);
        if (h.groupKey) this._groups.delete(`${h.script}\0${h.groupKey}`);
    }

    /** Everything a script registered — on unload. */
    removeScript(script) {
        const set = this.byScript.get(script);
        if (!set) return;
        for (const h of [...set]) this.removeHandler(h);
        this.byScript.delete(script);
    }

    /**
     * An action from the editor: `cancel` or `run` on a pending timer, `run` (once) or `cancel` on a
     * handler that offers it.
     * @param {string} id
     * @param {'cancel'|'run'} action
     * @returns {{script: string, kind: string, name: string|null, what: 'timer'|'handler'}}
     */
    action(id, action) {
        if (action !== 'cancel' && action !== 'run') throw new TypeError(`unknown action ${action}`);
        const p = this.pending.get(id);
        if (p) {
            const fn = action === 'run' ? p.fire : p.cancel;
            if (!fn) throw new TypeError(`${action} is not possible for a pending ${p.handler.kind}`);
            fn();
            return { script: p.handler.script, kind: p.handler.kind, name: p.handler.name, what: 'timer' };
        }
        const h = this.handlers.get(id);
        if (h) {
            const fn = action === 'run' ? h.run : h.cancel;
            if (!fn) throw new TypeError(`${action} is not possible for a ${h.kind}`);
            fn();
            return { script: h.script, kind: h.kind, name: h.name, what: 'handler' };
        }
        throw new NotFoundError(id);
    }

    /**
     * The model as JSON.
     * @param {object} [opts]
     * @param {string} [opts.script] only this script file
     * @param {Function} [opts.label] script file → label shown in the UI
     * @param {Function} [opts.origin] script file → `builtin` | `user`
     * @param {number} [opts.now]
     */
    snapshot(opts = {}) {
        const now = opts.now ?? Date.now();
        const label = opts.label || ((f) => f);
        const origin = opts.origin || (() => 'user');
        const scripts = [];
        for (const [file, set] of this.byScript) {
            if (opts.script !== undefined && file !== opts.script) continue;
            const handlers = [];
            for (const h of set) {
                let next = null;
                if (h.next) {
                    try {
                        next = h.next();
                    } catch {
                        next = null;
                    }
                }
                const pending = [];
                for (const p of h.pending.values()) {
                    pending.push({ id: p.id, due: p.due, start: p.start, every: p.every, ...(p.extra || {}) });
                }
                pending.sort((a, b) => a.due - b.due);
                handlers.push({
                    id: h.id,
                    kind: h.kind,
                    name: h.name,
                    detail: h.detail,
                    line: h.line,
                    next,
                    actions: { run: !!h.run, cancel: !!h.cancel },
                    ...h.stats.toJSON(now),
                    pending,
                });
            }
            scripts.push({ file, label: label(file), origin: origin(file), handlers });
        }
        scripts.sort((a, b) => a.label.localeCompare(b.label));
        return { ts: now, gauges: this.latestGauges, commandsFailed: this.commandsFailed, scripts };
    }
}

module.exports = { Runtime, HandlerStats, GaugeHistory, NotFoundError, WINDOW_MS, BUCKET_MS };
