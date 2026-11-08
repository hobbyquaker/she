'use strict';

/**
 * The daemon's own process statistics — what every mqtt-smarthome adapter publishes as
 * `<name>/maintenance/stats` (retained, every --stats-interval seconds) so that the Services page,
 * InfluxDB and Elasticsearch keep the trend without anyone running a sampler:
 *
 *   rss, heapUsed, heapTotal (bytes), cpu (% of one core since the previous sample),
 *   eventLoopLag (worst delay in ms since the previous sample), uptime (s), ts (ms)
 *
 * she adds what an adapter does not have: external and arrayBuffers (bytes, from
 * process.memoryUsage()), the counts of scripts, topics, handlers, pending timers and schedules,
 * and — on Linux — the split of the RSS read from /proc/self/smaps: `heapArena` is the glibc brk
 * heap (`[heap]` mapping: retained after free, the figure that creeps when the allocator keeps
 * pages), `anonymous` is every anonymous page (V8's heap and code space included). The RSS
 * breathes with the GC and carries that retained heap; heapUsed is the figure that shows a leak.
 *
 * The module is pure apart from the injected readers, so the payload shape is unit-tested.
 */

const fs = require('fs');

/**
 * Sum the Rss of the `[heap]` mappings and the Anonymous pages over a /proc/<pid>/smaps text.
 * @param {string} text
 * @returns {{heapArena: number, anonymous: number, rss: number}|null} bytes; null when the text has no mapping
 */
function parseSmaps(text) {
    let heapArena = 0;
    let anonymous = 0;
    let rss = 0;
    let inHeap = false;
    let seen = false;
    for (const line of text.split('\n')) {
        // a mapping header: "7f…-7f… rw-p 00000000 00:00 0   [heap]"
        if (/^[0-9a-f]+-[0-9a-f]+ /.test(line)) {
            seen = true;
            inHeap = line.endsWith('[heap]');
            continue;
        }
        const m = /^(Rss|Anonymous):\s+(\d+) kB/.exec(line);
        if (!m) continue;
        const bytes = Number(m[2]) * 1024;
        if (m[1] === 'Rss') {
            rss += bytes;
            if (inHeap) heapArena += bytes;
        } else {
            anonymous += bytes;
        }
    }
    return seen ? { heapArena, anonymous, rss } : null;
}

/** The smaps split of this process, or null where /proc/self/smaps is not available. */
function readSmaps() {
    if (process.platform !== 'linux') return null;
    try {
        return parseSmaps(fs.readFileSync('/proc/self/smaps', 'utf8'));
    } catch {
        return null;
    }
}

/**
 * @param {object} [deps] injected for tests
 * @param {() => NodeJS.MemoryUsage} [deps.memoryUsage]
 * @param {(prev?: NodeJS.CpuUsage) => NodeJS.CpuUsage} [deps.cpuUsage]
 * @param {() => number} [deps.now] ms since the epoch
 * @param {() => number} [deps.uptime] seconds
 * @param {() => number} [deps.takeLagMax] the worst event-loop lag (ms) since the previous call, which resets it
 * @param {() => object} [deps.counts] the daemon's counts (scripts, topics, handlers, timers, schedules)
 * @param {() => ({heapArena: number, anonymous: number}|null)} [deps.smaps]
 */
function createProcessStats(deps = {}) {
    const memoryUsage = deps.memoryUsage || (() => process.memoryUsage());
    const cpuUsage = deps.cpuUsage || ((prev) => process.cpuUsage(prev));
    const now = deps.now || (() => Date.now());
    const uptime = deps.uptime || (() => process.uptime());
    const takeLagMax = deps.takeLagMax || (() => 0);
    const counts = deps.counts || (() => ({}));
    const smaps = deps.smaps || readSmaps;

    let lastCpu = cpuUsage();
    let lastAt = now();

    /** One sample: the fleet's fields first, she's extras after them. */
    function sample() {
        const ts = now();
        const cpu = cpuUsage(lastCpu);
        const elapsedUs = (ts - lastAt) * 1000;
        lastCpu = cpuUsage();
        lastAt = ts;
        const mem = memoryUsage();
        const payload = {
            rss: mem.rss,
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            cpu: elapsedUs > 0 ? Math.round(((cpu.user + cpu.system) / elapsedUs) * 1000) / 10 : 0,
            eventLoopLag: Math.round(takeLagMax()),
            uptime: Math.round(uptime()),
            ts,
            external: mem.external,
            arrayBuffers: mem.arrayBuffers,
        };
        for (const [k, v] of Object.entries(counts())) if (typeof v === 'number' && Number.isFinite(v)) payload[k] = v;
        const split = smaps();
        if (split) {
            payload.heapArena = split.heapArena;
            payload.anonymous = split.anonymous;
        }
        return payload;
    }

    return { sample };
}

/** process.getActiveResourcesInfo() counted by type: { Timeout: 12, TCPSocketWrap: 3, … }. */
function activeResources(list = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : []) {
    const out = {};
    for (const r of list) out[r] = (out[r] || 0) + 1;
    return out;
}

module.exports = { createProcessStats, parseSmaps, readSmaps, activeResources };
