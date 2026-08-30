'use strict';

/**
 * Which Node.js versions a host could be updated to — the two labels tj/n understands:
 * `lts` (newest Long Term Support release) and `latest` (newest official release).
 *
 * she asks nodejs.org once for all hosts and caches the answer, so the Hosts tab can show
 * what a click would install and hide the button when the host already runs it. Best-effort:
 * every failure yields the last good answer, or nulls — nothing throws.
 *
 * Not every release is built for every machine: an old Raspberry Pi runs armv6l/armv7l, and
 * the newest lines have no build for those at all. index.json lists the files of each release,
 * so `byArch` answers the same two questions per architecture — offering a host a version that
 * does not exist for it is a promise `n install` cannot keep.
 */

const INDEX_URL = 'https://nodejs.org/dist/index.json';
const TTL = 6 * 60 * 60 * 1000;

let _fetch = (...args) => fetch(...args);

/** Test hook: replace the fetch implementation. */
function setFetch(fn) {
    _fetch = fn;
}

/**
 * Node's own name for a machine type, by what `uname -m` calls it — the keys of `byArch` are
 * both, so a host's raw uname string is enough to look its releases up.
 * @type {Record<string, string>}
 */
const UNAME_ALIASES = {
    x86_64: 'x64',
    amd64: 'x64',
    aarch64: 'arm64',
    aarch64_be: 'arm64',
    i386: 'x86',
    i486: 'x86',
    i586: 'x86',
    i686: 'x86',
};

/** @type {{lts: string|null, ltsName: string|null, latest: string|null, byArch: object, ts: number, ok: boolean}|null} */
let _cache = null;
/** @type {Promise<object>|null} */
let _inflight = null;

function clearCache() {
    _cache = null;
    _inflight = null;
}

function answer(c, fetchedAt) {
    return { lts: c.lts, ltsName: c.ltsName, latest: c.latest, byArch: c.byArch ?? {}, fetchedAt, stale: !c.ok };
}

/**
 * The newest release and the newest LTS release *that have a linux build for that machine*,
 * per architecture. A release lists its downloads in `files` ("linux-armv7l", "linux-x64", …),
 * which is exactly what `n install` will look for.
 * @param {object[]} list index.json, newest first
 */
function byArch(list) {
    const out = {};
    for (const entry of list) {
        if (!entry || typeof entry.version !== 'string' || !Array.isArray(entry.files)) continue;
        for (const file of entry.files) {
            if (typeof file !== 'string' || !file.startsWith('linux-')) continue;
            const arch = file.slice('linux-'.length);
            if (!arch || arch.includes('-')) continue; // linux-x64-musl and the like are not n's target
            const seen = (out[arch] ??= { lts: null, latest: null });
            if (!seen.latest) seen.latest = entry.version;
            if (!seen.lts && entry.lts) seen.lts = entry.version;
        }
    }
    // a host reports what uname says; let that name find the same entry
    for (const [uname, arch] of Object.entries(UNAME_ALIASES)) {
        if (out[arch]) out[uname] = out[arch];
    }
    return out;
}

/**
 * @param {{force?: boolean, now?: number}} [opts]
 * @returns {Promise<{lts: string|null, ltsName: string|null, latest: string|null, fetchedAt: number|null, stale: boolean}>}
 */
async function releases(opts = {}) {
    const now = opts.now ?? Date.now();
    if (_cache && !opts.force && now - _cache.ts < TTL) return answer(_cache, _cache.ts);
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
            _cache = {
                lts: ltsEntry ? ltsEntry.version : null,
                ltsName: ltsEntry ? String(ltsEntry.lts) : null,
                latest,
                byArch: byArch(list),
                ts: now,
                ok: true,
            };
        } catch {
            // keep whatever was known before, just mark it stale
            _cache = _cache ? { ..._cache, ts: now, ok: false } : { lts: null, ltsName: null, latest: null, byArch: {}, ts: now, ok: false };
        } finally {
            _inflight = null;
        }
        return answer(_cache, _cache.ok ? _cache.ts : null);
    })();

    return _inflight;
}

module.exports = { releases, byArch, setFetch, clearCache, UNAME_ALIASES, INDEX_URL, TTL };
