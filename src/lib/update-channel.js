'use strict';
/**
 * Which version the update check offers — by channel, from the GitHub releases, or from npm's
 * dist-tags when GitHub does not answer.
 *
 * `stable` offers the newest release that is not a pre-release; `beta` offers the newest of all
 * releases, so a beta tester gets `3.0.0-beta.1` after `3.0.0-beta.0` and `3.0.0` once it is
 * out, and nobody is ever offered a downgrade: switching back to `stable` on a beta shows an
 * update only when a stable release is newer than what runs. The version is installed exactly
 * (`smart-home-engine@<version>`), so npm's dist-tags play no part — but the version has to exist
 * on npm: a GitHub release whose npm job failed is not offered.
 *
 * GitHub's API allows 60 unauthenticated requests an hour per public address, shared with every
 * other machine behind it. When it refuses (403, 429), fails or cannot be reached, the check takes
 * npm's dist-tags instead — `latest` is the stable release, `next` the pre-release; the registry
 * has no such limit and is where the update installs from anyway. The result then says
 * `source: 'npm'` and carries the reason in `error`. A release list GitHub did deliver is reused
 * for a minute, so repeated checks cannot use the quota up by themselves.
 *
 * Best-effort: every failure yields "no update known" and the reason, nothing throws.
 */

const semverCompare = require('semantic-compare');

const REPO = 'hobbyquaker/she';
const PACKAGE = 'smart-home-engine';
const GITHUB_RELEASES = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const NPM_REGISTRY = 'https://registry.npmjs.org';
const NPM_DIST_TAGS = `${NPM_REGISTRY}/-/package/${PACKAGE}/dist-tags`;
/** how long a release list from GitHub is reused */
const RELEASES_TTL = 60 * 1000;
const CHANNELS = ['stable', 'beta'];

let _fetch = (...args) => fetch(...args);

/** Test hook: replace the fetch implementation. */
function setFetch(fn) {
    _fetch = fn;
}

/** 'stable' or 'beta'; anything else is 'stable'. */
function normalizeChannel(channel) {
    return CHANNELS.includes(channel) ? channel : 'stable';
}

const VERSION_RX = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The version of a release tag (`v3.0.0-beta.0` → `3.0.0-beta.0`), or null when it is not one. */
function versionOfTag(tag) {
    if (typeof tag !== 'string') return null;
    const v = tag.replace(/^v/, '');
    return VERSION_RX.test(v) ? v : null;
}

function isPrerelease(version) {
    return typeof version === 'string' && version.includes('-');
}

function compare(a, b) {
    try {
        return semverCompare(a, b);
    } catch {
        return 0;
    }
}

function newest(versions) {
    return versions.reduce((best, v) => (best === null || compare(v, best) > 0 ? v : best), null);
}

/**
 * The newest stable release and the newest pre-release of a GitHub release list.
 * @param {Array<{tag_name: string, prerelease?: boolean, draft?: boolean}>} releases
 * @returns {{ stable: string|null, prerelease: string|null }}
 */
function newestOf(releases) {
    const stable = [];
    const pre = [];
    for (const r of Array.isArray(releases) ? releases : []) {
        if (!r || r.draft) continue;
        const v = versionOfTag(r.tag_name);
        if (!v) continue;
        (r.prerelease || isPrerelease(v) ? pre : stable).push(v);
    }
    return { stable: newest(stable), prerelease: newest(pre) };
}

/** The version a channel offers, given the newest releases. */
function offeredVersion(channel, { stable, prerelease }) {
    if (normalizeChannel(channel) === 'stable') return stable;
    if (!stable) return prerelease;
    if (!prerelease) return stable;
    return compare(stable, prerelease) < 0 ? prerelease : stable;
}

let _releases = null; // { at, list } — the last list GitHub delivered

/** Forget the cached release list (tests, and whoever wants a check that really asks). */
function clearCache() {
    _releases = null;
}

async function fetchReleases() {
    if (_releases && Date.now() - _releases.at < RELEASES_TTL) return _releases.list;
    const res = await _fetch(GITHUB_RELEASES, {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': `${PACKAGE} update check` },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const list = await res.json();
    _releases = { at: Date.now(), list };
    return list;
}

async function existsOnNpm(version) {
    const res = await _fetch(`${NPM_REGISTRY}/${PACKAGE}/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data && data.version === version;
}

/**
 * The newest stable release and the newest pre-release as npm's dist-tags name them: `latest` and
 * `next`. A tag that does not hold what its name promises (a pre-release on `latest`) is sorted by
 * its version, like a GitHub release is.
 * @returns {Promise<{ stable: string|null, prerelease: string|null }>}
 */
async function fetchDistTags() {
    const res = await _fetch(NPM_DIST_TAGS, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`npm answered ${res.status}`);
    const tags = (await res.json()) || {};
    const stable = [];
    const pre = [];
    for (const tag of ['latest', 'next']) {
        const v = typeof tags[tag] === 'string' && VERSION_RX.test(tags[tag]) ? tags[tag] : null;
        if (v) (isPrerelease(v) ? pre : stable).push(v);
    }
    if (!stable.length && !pre.length) throw new Error('npm has no dist-tags for the package');
    return { stable: newest(stable), prerelease: newest(pre) };
}

/**
 * Check for an update on a channel.
 * @param {object} opts
 * @param {string} opts.installed the running version
 * @param {string} [opts.channel] 'stable' (default) or 'beta'
 * @param {boolean} [opts.docker] a Docker container cannot update itself
 * @returns {Promise<{channel: string, installed: string, stable: string|null, prerelease: string|null,
 *   latest: string|null, latestIsPrerelease: boolean, selfUpdate: boolean, checkedAt: number,
 *   source: 'github'|'npm'|null, error: string|null}>}
 *   `latest` is the version to offer — newer than `installed`, on the channel, present on npm — or null.
 *   `source` says who named the versions; with 'npm', `error` is the reason GitHub was not used.
 */
async function checkUpdate(opts) {
    const channel = normalizeChannel(opts.channel);
    const installed = String(opts.installed || '');
    const result = {
        channel,
        installed,
        stable: null,
        prerelease: null,
        latest: null,
        latestIsPrerelease: false,
        selfUpdate: !opts.docker,
        checkedAt: Date.now(),
        source: null,
        error: null,
    };
    let found;
    try {
        found = newestOf(await fetchReleases());
        result.source = 'github';
    } catch (err) {
        try {
            found = await fetchDistTags();
        } catch (npmErr) {
            result.error = `release list not available: ${err.message}; npm's dist-tags neither: ${npmErr.message}`;
            return result;
        }
        result.source = 'npm';
        result.error = `release list not available: ${err.message} — versions taken from npm's dist-tags instead`;
    }
    result.stable = found.stable;
    result.prerelease = found.prerelease;
    const candidate = offeredVersion(channel, found);
    if (!candidate || !(compare(installed, candidate) < 0)) return result;
    if (result.source === 'npm') {
        // a dist-tag names a published version, there is nothing left to ask
        result.latest = candidate;
        result.latestIsPrerelease = isPrerelease(candidate);
        return result;
    }
    let onNpm = false;
    try {
        onNpm = await existsOnNpm(candidate);
    } catch (err) {
        result.error = `npm registry not available: ${err.message}`;
        return result;
    }
    if (!onNpm) {
        result.error = `${candidate} is released on GitHub but not published on npm`;
        return result;
    }
    result.latest = candidate;
    result.latestIsPrerelease = isPrerelease(candidate);
    return result;
}

module.exports = { CHANNELS, PACKAGE, checkUpdate, clearCache, newestOf, offeredVersion, versionOfTag, isPrerelease, normalizeChannel, setFetch };
