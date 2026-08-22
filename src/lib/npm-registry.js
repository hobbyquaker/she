'use strict';

/**
 * Small npm registry client with a 24 h cache — "is there a newer version of
 * <package>?" for the Services page (roadmap I4) and, later, the adapter
 * catalog (I7). Best-effort: every failure yields null, nothing throws.
 */

const semverCompare = require('semantic-compare');

const REGISTRY = 'https://registry.npmjs.org';
const TTL = 24 * 60 * 60 * 1000;

/** @type {Map<string, {version: string|null, ts: number, promise?: Promise<string|null>}>} */
const _cache = new Map();

let _fetch = (...args) => fetch(...args);

/** Test hook: replace the fetch implementation. */
function setFetch(fn) {
    _fetch = fn;
}

function clearCache() {
    _cache.clear();
}

function validName(name) {
    return typeof name === 'string' && /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name);
}

/**
 * Latest published version of a package (dist-tag `latest`), cached for 24 h.
 * @param {string} name
 * @param {{force?: boolean, now?: number}} [opts]
 * @returns {Promise<string|null>}
 */
async function latestVersion(name, opts = {}) {
    if (!validName(name)) return null;
    const now = opts.now ?? Date.now();
    const hit = _cache.get(name);
    if (hit && !opts.force) {
        if (hit.promise) return hit.promise;
        if (now - hit.ts < TTL) return hit.version;
    }
    const promise = (async () => {
        try {
            const res = await _fetch(`${REGISTRY}/${name}/latest`, { signal: AbortSignal.timeout(10000) });
            if (!res.ok) throw new Error(String(res.status));
            const data = await res.json();
            return typeof data.version === 'string' ? data.version : null;
        } catch {
            return hit ? hit.version : null; // keep the last good answer
        }
    })();
    _cache.set(name, { version: hit ? hit.version : null, ts: now, promise });
    const version = await promise;
    _cache.set(name, { version, ts: now });
    return version;
}

/**
 * Newer version available? null when unknown.
 * @param {string} name
 * @param {string|null} installed
 * @returns {Promise<{latest: string|null, updateAvailable: boolean|null}>}
 */
async function updateInfo(name, installed) {
    const latest = await latestVersion(name);
    if (!latest || !installed) return { latest, updateAvailable: null };
    let updateAvailable = null;
    try {
        updateAvailable = semverCompare(installed, latest) < 0;
    } catch {
        /* unparsable version */
    }
    return { latest, updateAvailable };
}

module.exports = { latestVersion, updateInfo, validName, setFetch, clearCache, REGISTRY };
