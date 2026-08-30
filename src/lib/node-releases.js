'use strict';

/**
 * Which Node.js versions a host could be updated to — the two labels tj/n understands:
 * `lts` (newest Long Term Support release) and `latest` (newest official release).
 *
 * she asks nodejs.org once for all hosts and caches the answer, so the Hosts tab can show
 * what a click would install and hide the button when the host already runs it. Best-effort:
 * every failure yields the last good answer, or nulls — nothing throws.
 */

const INDEX_URL = 'https://nodejs.org/dist/index.json';
const TTL = 6 * 60 * 60 * 1000;

let _fetch = (...args) => fetch(...args);

/** Test hook: replace the fetch implementation. */
function setFetch(fn) {
    _fetch = fn;
}

/** @type {{lts: string|null, ltsName: string|null, latest: string|null, ts: number, ok: boolean}|null} */
let _cache = null;
/** @type {Promise<object>|null} */
let _inflight = null;

function clearCache() {
    _cache = null;
    _inflight = null;
}

/**
 * @param {{force?: boolean, now?: number}} [opts]
 * @returns {Promise<{lts: string|null, ltsName: string|null, latest: string|null, fetchedAt: number|null, stale: boolean}>}
 */
async function releases(opts = {}) {
    const now = opts.now ?? Date.now();
    if (_cache && !opts.force && now - _cache.ts < TTL) {
        return { lts: _cache.lts, ltsName: _cache.ltsName, latest: _cache.latest, fetchedAt: _cache.ts, stale: !_cache.ok };
    }
    if (_inflight) return _inflight;

    _inflight = (async () => {
        try {
            const res = await _fetch(INDEX_URL, { signal: AbortSignal.timeout(15000) });
            if (!res.ok) throw new Error(String(res.status));
            const list = await res.json();
            if (!Array.isArray(list) || list.length === 0) throw new Error('unexpected index.json');
            // index.json is ordered newest first; an LTS entry carries its codename in `lts`
            const latest = typeof list[0].version === 'string' ? list[0].version : null;
            const ltsEntry = list.find((e) => e && e.lts && typeof e.version === 'string') || null;
            _cache = { lts: ltsEntry ? ltsEntry.version : null, ltsName: ltsEntry ? String(ltsEntry.lts) : null, latest, ts: now, ok: true };
        } catch {
            // keep whatever was known before, just mark it stale
            _cache = _cache ? { ..._cache, ts: now, ok: false } : { lts: null, ltsName: null, latest: null, ts: now, ok: false };
        } finally {
            _inflight = null;
        }
        return { lts: _cache.lts, ltsName: _cache.ltsName, latest: _cache.latest, fetchedAt: _cache.ok ? _cache.ts : null, stale: !_cache.ok };
    })();

    return _inflight;
}

module.exports = { releases, setFetch, clearCache, INDEX_URL, TTL };
