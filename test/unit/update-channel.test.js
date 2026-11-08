'use strict';

const uc = require('../../src/lib/update-channel');

const release = (tag, prerelease = false, draft = false) => ({ tag_name: tag, prerelease, draft });

/** a fetch stub: GitHub answers with `releases`, npm knows `npmVersions` */
function stubFetch({ releases, npmVersions = [], githubStatus = 200, githubThrows = false, npmThrows = false }) {
    const calls = [];
    uc.setFetch(async (url) => {
        calls.push(url);
        if (url.startsWith('https://api.github.com/')) {
            if (githubThrows) throw new Error('ENOTFOUND api.github.com');
            return { ok: githubStatus === 200, status: githubStatus, json: async () => releases };
        }
        if (npmThrows) throw new Error('ETIMEDOUT');
        const version = decodeURIComponent(url.split('/').pop());
        const known = npmVersions.includes(version);
        return { ok: known, status: known ? 200 : 404, json: async () => (known ? { version } : { error: 'Not found' }) };
    });
    return calls;
}

afterAll(() => uc.setFetch((...args) => fetch(...args)));

describe('update channel: the release list', () => {
    test('versionOfTag strips the v and rejects what is not a version', () => {
        expect(uc.versionOfTag('v2.1.0')).toBe('2.1.0');
        expect(uc.versionOfTag('3.0.0-beta.0')).toBe('3.0.0-beta.0');
        expect(uc.versionOfTag('nightly')).toBeNull();
        expect(uc.versionOfTag('v2.1')).toBeNull();
        expect(uc.versionOfTag(undefined)).toBeNull();
    });

    test('newestOf separates stable releases and pre-releases, skipping drafts and odd tags', () => {
        const found = uc.newestOf([
            release('v3.0.0-beta.1', true),
            release('v2.1.0'),
            release('v3.0.0-beta.0', true),
            release('v2.0.1'),
            release('v2.9.0', false, true), // a draft
            release('v3.0.0-rc.1'), // flagged stable on GitHub, but the version says pre-release
            release('docs-2026'),
            release('v2.1.0-beta.3', true),
        ]);
        expect(found).toEqual({ stable: '2.1.0', prerelease: '3.0.0-rc.1' });
        expect(uc.newestOf([])).toEqual({ stable: null, prerelease: null });
        expect(uc.newestOf(null)).toEqual({ stable: null, prerelease: null });
    });

    test('offeredVersion: stable ignores pre-releases, beta takes the higher of both', () => {
        expect(uc.offeredVersion('stable', { stable: '2.1.0', prerelease: '3.0.0-beta.0' })).toBe('2.1.0');
        expect(uc.offeredVersion('beta', { stable: '2.1.0', prerelease: '3.0.0-beta.0' })).toBe('3.0.0-beta.0');
        expect(uc.offeredVersion('beta', { stable: '3.0.0', prerelease: '3.0.0-beta.3' })).toBe('3.0.0');
        expect(uc.offeredVersion('beta', { stable: null, prerelease: '3.0.0-beta.0' })).toBe('3.0.0-beta.0');
        expect(uc.offeredVersion('beta', { stable: '2.1.0', prerelease: null })).toBe('2.1.0');
        expect(uc.offeredVersion('stable', { stable: null, prerelease: '3.0.0-beta.0' })).toBeNull();
        expect(uc.offeredVersion('nightly', { stable: '2.1.0', prerelease: '3.0.0-beta.0' })).toBe('2.1.0');
        expect(uc.normalizeChannel('beta')).toBe('beta');
        expect(uc.normalizeChannel(undefined)).toBe('stable');
    });
});

describe('update channel: checkUpdate', () => {
    const releases = [release('v3.0.0-beta.1', true), release('v2.1.0'), release('v3.0.0-beta.0', true), release('v2.0.1')];

    test('stable channel offers only the stable release', async () => {
        stubFetch({ releases, npmVersions: ['2.1.0', '3.0.0-beta.1'] });
        const r = await uc.checkUpdate({ installed: '2.0.1', channel: 'stable' });
        expect(r).toMatchObject({
            channel: 'stable',
            installed: '2.0.1',
            stable: '2.1.0',
            prerelease: '3.0.0-beta.1',
            latest: '2.1.0',
            latestIsPrerelease: false,
            selfUpdate: true,
            error: null,
        });
        expect(typeof r.checkedAt).toBe('number');
        // up to date on stable — the pre-release does not count
        const upToDate = await uc.checkUpdate({ installed: '2.1.0', channel: 'stable' });
        expect(upToDate.latest).toBeNull();
        expect(upToDate.error).toBeNull();
    });

    test('beta channel offers the newer pre-release, installed exactly, marked as one', async () => {
        const calls = stubFetch({ releases, npmVersions: ['2.1.0', '3.0.0-beta.1'] });
        const r = await uc.checkUpdate({ installed: '3.0.0-beta.0', channel: 'beta' });
        expect(r).toMatchObject({ latest: '3.0.0-beta.1', latestIsPrerelease: true, error: null });
        expect(calls[1]).toBe('https://registry.npmjs.org/smart-home-engine/3.0.0-beta.1');
        // on the newest pre-release: nothing newer
        expect((await uc.checkUpdate({ installed: '3.0.0-beta.1', channel: 'beta' })).latest).toBeNull();
        // from a stable version, beta offers the pre-release
        expect((await uc.checkUpdate({ installed: '2.1.0', channel: 'beta' })).latest).toBe('3.0.0-beta.1');
    });

    test('beta channel offers the stable release when it is newer than the pre-release', async () => {
        stubFetch({ releases: [release('v3.0.0'), ...releases], npmVersions: ['3.0.0'] });
        const r = await uc.checkUpdate({ installed: '3.0.0-beta.1', channel: 'beta' });
        expect(r).toMatchObject({ stable: '3.0.0', prerelease: '3.0.0-beta.1', latest: '3.0.0', latestIsPrerelease: false });
    });

    test('switching back to stable on a pre-release never downgrades', async () => {
        stubFetch({ releases, npmVersions: ['2.1.0'] });
        const r = await uc.checkUpdate({ installed: '3.0.0-beta.0', channel: 'stable' });
        expect(r.latest).toBeNull();
        expect(r.stable).toBe('2.1.0');
        expect(r.error).toBeNull();
    });

    test('a failed GitHub fetch yields no update and says why', async () => {
        stubFetch({ releases, githubThrows: true });
        const r = await uc.checkUpdate({ installed: '2.0.1', channel: 'stable' });
        expect(r.latest).toBeNull();
        expect(r.stable).toBeNull();
        expect(r.error).toMatch(/release list not available: ENOTFOUND/);
        stubFetch({ releases, githubStatus: 403 });
        expect((await uc.checkUpdate({ installed: '2.0.1', channel: 'stable' })).error).toMatch(/GitHub answered 403/);
    });

    test('a release that is not on npm is not offered', async () => {
        stubFetch({ releases, npmVersions: ['2.0.1'] });
        const r = await uc.checkUpdate({ installed: '2.0.1', channel: 'stable' });
        expect(r.latest).toBeNull();
        expect(r.stable).toBe('2.1.0');
        expect(r.error).toBe('2.1.0 is released on GitHub but not published on npm');
        stubFetch({ releases, npmThrows: true });
        expect((await uc.checkUpdate({ installed: '2.0.1', channel: 'stable' })).error).toMatch(/npm registry not available/);
    });

    test('Docker: the version is reported, the self-update is not offered', async () => {
        stubFetch({ releases, npmVersions: ['2.1.0'] });
        const r = await uc.checkUpdate({ installed: '2.0.1', channel: 'stable', docker: true });
        expect(r.latest).toBe('2.1.0');
        expect(r.selfUpdate).toBe(false);
    });

    test('an unknown channel is treated as stable', async () => {
        stubFetch({ releases, npmVersions: ['2.1.0'] });
        const r = await uc.checkUpdate({ installed: '2.0.1', channel: 'nightly' });
        expect(r.channel).toBe('stable');
        expect(r.latest).toBe('2.1.0');
    });
});
