'use strict';

/**
 * Adapter catalog (roadmap I7): the npm packages of the publishers the user trusts whose latest
 * version depends on mqtt-interfaces-core. No keyword, no registration — depending on the core
 * is the membership criterion.
 *
 *   1. registry search `maintainer:<publisher>` (official, one request per publisher)
 *   2. abbreviated packument per hit (`application/vnd.npm.install-v1+json`, small) → keep the
 *      package when `versions[dist-tags.latest].dependencies` has mqtt-interfaces-core
 *   3. full packument for the members only → description, homepage, repository, `mqttInterfaces`
 *
 * Cached for 24 h in memory and on disk (the data dir), answered from the cache at once and
 * refreshed in the background — see catalog(); the last good result is kept on failure.
 * Best effort throughout: a publisher that fails is reported in `errors`, the rest still lists.
 */

const fs = require('fs');
const path = require('path');

const CORE = 'mqtt-interfaces-core';
const REGISTRY = 'https://registry.npmjs.org';
const TTL = 24 * 60 * 60 * 1000;

let _fetch = (...args) => fetch(...args);
function setFetch(fn) {
    _fetch = fn;
}

/** @type {{key: string, ts: number, result: object|null, promise?: Promise<object>} | null} */
let _cache = null;
let _file = null;
function clearCache() {
    _cache = null;
}

/** Persist the catalog under the data dir so a restarted daemon answers at once (best effort). */
function init({ file } = {}) {
    _file = file || null;
    _cache = null;
    if (!_file) return;
    try {
        const saved = JSON.parse(fs.readFileSync(_file, 'utf8'));
        if (saved && typeof saved.key === 'string' && saved.result && Array.isArray(saved.result.packages)) _cache = { key: saved.key, ts: saved.ts || 0, result: saved.result };
    } catch {
        /* no cache yet */
    }
}
function persist() {
    if (!_file || !_cache || !_cache.result) return;
    try {
        fs.mkdirSync(path.dirname(_file), { recursive: true });
        fs.writeFileSync(_file, JSON.stringify({ key: _cache.key, ts: _cache.ts, result: _cache.result }), 'utf8');
    } catch {
        /* read-only data dir — the in-memory copy still works */
    }
}

function validPublisher(p) {
    return typeof p === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(p);
}

async function getJson(url, headers = {}) {
    const res = await _fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
}

/** Package names a publisher maintains (registry search; 250 is the API's page maximum). */
async function packagesOf(publisher) {
    const data = await getJson(`${REGISTRY}/-/v1/search?text=${encodeURIComponent('maintainer:' + publisher)}&size=250`);
    return (data.objects || [])
        .map((o) => o.package)
        .filter((p) => p && typeof p.name === 'string' && p.name !== CORE && !p.name.startsWith('@'))
        .map((p) => ({ name: p.name, version: p.version, description: p.description || '', date: p.date || null, publisher: (p.publisher && p.publisher.username) || publisher }));
}

/** Does the latest version depend on the core? Returns the range or null. */
async function coreDependency(name) {
    const data = await getJson(`${REGISTRY}/${name}`, { accept: 'application/vnd.npm.install-v1+json' });
    const latest = data['dist-tags'] && data['dist-tags'].latest;
    const v = latest && data.versions && data.versions[latest];
    if (!v) return null;
    const range = (v.dependencies && v.dependencies[CORE]) || null;
    return range ? { range, version: latest } : null;
}

/** Details of a member from the full packument. */
async function details(name, version) {
    const data = await getJson(`${REGISTRY}/${name}`);
    const v = (data.versions && data.versions[version]) || {};
    const repo = typeof data.repository === 'object' && data.repository ? data.repository.url : data.repository;
    return {
        description: v.description || data.description || '',
        homepage: v.homepage || data.homepage || null,
        repository: typeof repo === 'string' ? repo.replace(/^git\+/, '').replace(/\.git$/, '') : null,
        mqttInterfaces: v.mqttInterfaces && typeof v.mqttInterfaces === 'object' ? v.mqttInterfaces : null,
        deprecated: typeof v.deprecated === 'string' ? v.deprecated : null,
        maintainers: Array.isArray(data.maintainers) ? data.maintainers.map((m) => m.name).filter(Boolean) : [],
        published: data.time && data.time[version] ? data.time[version] : null,
    };
}

/**
 * Sweep the registry for the trusted publishers' adapters.
 * @param {string[]} publishers
 * @returns {Promise<{packages: object[], publishers: string[], errors: object[], fetchedAt: number}>}
 */
async function sweep(publishers, now) {
    const errors = [];
    const seen = new Map();
    for (const publisher of publishers) {
        let list;
        try {
            list = await packagesOf(publisher);
        } catch (err) {
            errors.push({ publisher, error: err.message });
            continue;
        }
        for (const p of list) {
            if (seen.has(p.name)) continue;
            try {
                const dep = await coreDependency(p.name);
                if (!dep) continue;
                const d = await details(p.name, dep.version);
                if (d.deprecated) continue;
                seen.set(p.name, { name: p.name, version: dep.version, coreRange: dep.range, publisher, ...d });
            } catch (err) {
                errors.push({ package: p.name, error: err.message });
            }
        }
    }
    const packages = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { packages, publishers, errors, fetchedAt: now };
}

/** A sweep in the background; the last good list survives a failed one. */
function startSweep(list, key, now) {
    const previous = _cache && _cache.key === key ? _cache.result : null;
    const promise = sweep(list, now)
        .then((r) => {
            // keep the last good list when the whole sweep produced nothing but errors
            if (r.packages.length === 0 && r.errors.length > 0 && previous && previous.packages.length > 0) return { ...previous, errors: r.errors, stale: true };
            return r;
        })
        .then((result) => {
            _cache = { key, ts: now, result };
            persist();
            return result;
        })
        .catch((err) => {
            _cache = previous ? { key, ts: now, result: previous } : null;
            if (previous) return { ...previous, errors: [{ error: err.message }], stale: true };
            throw err;
        });
    _cache = { key, ts: now, result: previous, promise };
    promise.finally(() => {
        if (_cache && _cache.promise === promise) delete _cache.promise;
    });
    return promise;
}

/**
 * The catalog for the given trusted publishers. Answers from the cache (memory, or the file from a
 * previous run) at once and refreshes in the background when the cache is older than a day or
 * `force` is set — `refreshing: true` tells the caller to ask again. Only the very first sweep (no
 * cache at all) or `wait: true` makes the call wait for the registry.
 * @param {string[]} publishers
 * @param {{force?: boolean, wait?: boolean, now?: number}} [opts]
 */
async function catalog(publishers, opts = {}) {
    const list = [...new Set((publishers || []).filter(validPublisher).map((p) => p.toLowerCase()))];
    const now = opts.now ?? Date.now();
    const key = list.join(',');
    if (list.length === 0) return { packages: [], publishers: [], errors: [], fetchedAt: now, cached: false, refreshing: false };
    const entry = _cache && _cache.key === key ? _cache : null;
    const fresh = entry && entry.result && now - entry.ts < TTL;
    if ((!fresh || opts.force) && !(entry && entry.promise)) startSweep(list, key, now);
    const cur = _cache;
    if (cur.result && !opts.wait) return { ...cur.result, cached: true, refreshing: Boolean(cur.promise) };
    const result = await (cur.promise || Promise.resolve(cur.result));
    return { ...result, cached: !cur.promise, refreshing: false };
}

/** Whether a background sweep is running. */
function refreshing() {
    return Boolean(_cache && _cache.promise);
}

module.exports = { catalog, sweep, packagesOf, coreDependency, details, validPublisher, setFetch, clearCache, init, refreshing, CORE, REGISTRY, TTL };
