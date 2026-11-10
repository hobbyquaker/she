'use strict';
/**
 * The daemon's runtime model: what every script has registered — subscriptions, variable listeners,
 * schedules, sun events, timers (grouped by kind, name and the line that created them) and pending
 * commands — with per-handler statistics, the timers pending under each handler, and two ring
 * buffers of the daemon's gauges: one sample per 10 s for the last hour, one per minute for the
 * last day.
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
    /** @param {{fires: number, errors: number}} [totals] a counter shared by every handler, counted along */
    constructor(totals) {
        this._totals = totals || null;
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
        if (this._totals) this._totals.fires++;
        if (failed) {
            this.errors++;
            this.lastError = now;
            b.errors++;
            if (this._totals) this._totals.errors++;
        }
    }

    /** An error that showed up after the run was recorded (a rejected promise). */
    fail(now = Date.now()) {
        this.errors++;
        this.lastError = now;
        this._bucket(now).errors++;
        if (this._totals) this._totals.errors++;
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

/**
 * The gauges folded into one sample per minute, for the last day: 1440 small objects, in memory,
 * gone with a restart. Every sample offered is folded into the minute it falls into — a spike
 * between two kept samples must survive, which is why this is not a second GaugeHistory with a
 * longer interval. How a field is folded: the highest value for the fields in `max` (load: a peak
 * is what the reader looks for), the mean for those in `mean`, the sum for those in `sum` (counts
 * since the previous sample); every other numeric field keeps its last value (levels: memory,
 * counts of things).
 */
class MinuteHistory {
    /**
     * @param {object} [opts]
     * @param {number} [opts.intervalMs=60000] the length of a bucket
     * @param {number} [opts.size=1440] buckets kept (1440 × 1 min = one day)
     * @param {string[]} [opts.max] fields that keep their highest value
     * @param {string[]} [opts.mean] fields that keep their mean, to one decimal
     * @param {string[]} [opts.sum] fields that are added up
     */
    constructor(opts = {}) {
        this.intervalMs = opts.intervalMs || 60_000;
        this.size = opts.size || 1440;
        this._max = new Set(opts.max || []);
        this._mean = new Set(opts.mean || []);
        this._sum = new Set(opts.sum || []);
        this._closed = [];
        this._open = null; // { ts, n, values }
    }

    /**
     * Fold a sample into its minute; a sample of a later minute closes the open one.
     * @param {object} sample must carry `ts`; non-numeric fields are ignored
     */
    push(sample) {
        const start = Math.floor(sample.ts / this.intervalMs) * this.intervalMs;
        // a clock that stepped back: the sample goes into the open minute rather than behind it
        if (!this._open || start > this._open.ts) {
            if (this._open) {
                this._closed.push(this._render(this._open));
                if (this._closed.length > this.size - 1) this._closed.splice(0, this._closed.length - (this.size - 1));
            }
            this._open = { ts: start, n: 0, values: {} };
        }
        const o = this._open;
        o.n++;
        for (const [key, v] of Object.entries(sample)) {
            if (key === 'ts' || typeof v !== 'number' || !Number.isFinite(v)) continue;
            const prev = o.values[key];
            if (prev === undefined) o.values[key] = v;
            else if (this._max.has(key)) o.values[key] = Math.max(prev, v);
            else if (this._mean.has(key) || this._sum.has(key)) o.values[key] = prev + v;
            else o.values[key] = v;
        }
    }

    _render(o) {
        const out = { ts: o.ts };
        for (const [key, v] of Object.entries(o.values)) out[key] = this._mean.has(key) ? Math.round((v / o.n) * 10) / 10 : v;
        return out;
    }

    /**
     * The minutes kept, oldest first; the last one is the minute still being filled.
     * @param {number} [since] only the minutes that start at or after this time (ms)
     */
    list(since) {
        const all = this._open ? [...this._closed, this._render(this._open)] : this._closed.slice();
        return typeof since === 'number' && Number.isFinite(since) ? all.filter((s) => s.ts >= since) : all;
    }
}

/** How the daemon's gauges are folded into a minute; what is not named keeps its last value. */
const MINUTE_RULES = {
    max: ['mqttMsgPerSec', 'cpuPercent', 'eluPercent', 'elMaxMs'],
    mean: ['elMeanMs'],
    sum: ['callbacks', 'errors'],
};

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
        this.minutes = new MinuteHistory(MINUTE_RULES);
        /** callbacks run and errors seen since the start, over every script — reloads included */
        this.totals = { fires: 0, errors: 0 };
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
            stats: new HandlerStats(this.totals),
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

module.exports = { Runtime, HandlerStats, GaugeHistory, MinuteHistory, MINUTE_RULES, NotFoundError, WINDOW_MS, BUCKET_MS };
