'use strict';

/**
 * Unit tests for src/lib/services-catalog.js — a fake npm registry.
 */

const catalog = require('../../src/lib/services-catalog');

function registry(state) {
    return async (url, opts) => {
        const accept = (opts && opts.headers && opts.headers.accept) || '';
        const u = new URL(url);
        const ok = (body) => ({ ok: true, status: 200, json: async () => body });
        if (u.host === 'api.github.com') {
            const repo = state.github && state.github[u.pathname];
            return repo ? ok(repo) : { ok: false, status: 404 };
        }
        if (u.pathname === '/-/v1/search') {
            const m = /^maintainer:(.+)$/.exec(u.searchParams.get('text') || '');
            const list = (m && state.search[m[1]]) || null;
            if (!list) return { ok: false, status: 500 };
            return ok({ objects: list.map((p) => ({ package: { name: p, version: '1.0.0', description: 'd ' + p, publisher: { username: m[1] } } })) });
        }
        const name = u.pathname.slice(1);
        const pkg = state.packages[name];
        if (!pkg) return { ok: false, status: 404 };
        if (accept.includes('install-v1')) return ok({ 'dist-tags': { latest: pkg.latest }, 'versions': { [pkg.latest]: { dependencies: pkg.dependencies || {} } } });
        return ok({
            name,
            description: pkg.description || '',
            homepage: pkg.homepage || null,
            repository: pkg.repository || null,
            maintainers: [{ name: 'hobbyquaker' }],
            time: { [pkg.latest]: '2026-08-22T10:00:00.000Z' },
            versions: { [pkg.latest]: { description: pkg.description, mqttInterfaces: pkg.mqttInterfaces, deprecated: pkg.deprecated } },
        });
    };
}

const STATE = {
    github: { '/repos/hobbyquaker/cul2mqtt': { stargazers_count: 42, owner: { login: 'hobbyquaker', html_url: 'https://github.com/hobbyquaker' } } },
    search: { hobbyquaker: ['cul2mqtt', 'lgtv2mqtt', 'hm2mqtt', 'mqtt-interfaces-core', 'old2mqtt'], someone: ['foo2mqtt'] },
    packages: {
        cul2mqtt: {
            latest: '1.1.2',
            dependencies: { 'mqtt-interfaces-core': '^0.6.0', 'cul': '^1.0.0' },
            description: 'CUL',
            homepage: 'https://github.com/hobbyquaker/cul2mqtt',
            repository: { url: 'git+https://github.com/hobbyquaker/cul2mqtt.git' },
            mqttInterfaces: { spec: '2.0', needs: ['serial'] },
        },
        lgtv2mqtt: { latest: '3.0.0', dependencies: { 'mqtt-interfaces-core': '^0.1.0' }, description: 'LG TV' },
        hm2mqtt: { latest: '2.5.0', dependencies: { mqtt: '^2.0.0' } },
        old2mqtt: { latest: '0.9.0', dependencies: { 'mqtt-interfaces-core': '^0.3.0' }, deprecated: 'use new2mqtt' },
        foo2mqtt: { latest: '0.1.0', dependencies: { 'mqtt-interfaces-core': '^0.6.0' } },
    },
};

beforeEach(() => catalog.init({ file: null }));

describe('services-catalog', () => {
    test('a package without a GitHub repository, or one GitHub does not answer for, still lists', async () => {
        catalog.setFetch(registry(STATE));
        const r = await catalog.catalog(['hobbyquaker'], { now: 1000 });
        // lgtv2mqtt has no repository field at all
        expect(r.packages[1]).toMatchObject({ name: 'lgtv2mqtt', stars: null, owner: null, ownerUrl: null });
        expect(r.errors).toEqual([]);
    });

    test('githubSlug reads owner and repo out of the usual repository urls', () => {
        expect(catalog.githubSlug('https://github.com/hobbyquaker/cul2mqtt')).toEqual({ owner: 'hobbyquaker', repo: 'cul2mqtt' });
        expect(catalog.githubSlug('git+ssh://git@github.com/a/b.git')).toEqual({ owner: 'a', repo: 'b' });
        expect(catalog.githubSlug('https://gitlab.com/a/b')).toBeNull();
        expect(catalog.githubSlug(null)).toBeNull();
    });

    test("members = trusted publishers' packages whose latest depends on the core; deprecated skipped", async () => {
        catalog.setFetch(registry(STATE));
        const r = await catalog.catalog(['hobbyquaker'], { now: 1000 });
        expect(r.packages.map((p) => p.name)).toEqual(['cul2mqtt', 'lgtv2mqtt']);
        expect(r.packages[0]).toMatchObject({
            name: 'cul2mqtt',
            version: '1.1.2',
            coreRange: '^0.6.0',
            publisher: 'hobbyquaker',
            stars: 42,
            owner: 'hobbyquaker',
            ownerUrl: 'https://github.com/hobbyquaker',
            description: 'CUL',
            homepage: 'https://github.com/hobbyquaker/cul2mqtt',
            repository: 'https://github.com/hobbyquaker/cul2mqtt',
            mqttInterfaces: { spec: '2.0', needs: ['serial'] },
            maintainers: ['hobbyquaker'],
        });
        expect(r.errors).toEqual([]);
        expect(r.cached).toBe(false);
    });

    test('several publishers, invalid names dropped, cache and refresh', async () => {
        let calls = 0;
        const f = registry(STATE);
        catalog.setFetch((...a) => (calls++, f(...a)));
        let r = await catalog.catalog(['hobbyquaker', 'someone', 'bad name!'], { now: 1000 });
        expect(r.publishers).toEqual(['hobbyquaker', 'someone']);
        expect(r.packages.map((p) => p.name)).toEqual(['cul2mqtt', 'foo2mqtt', 'lgtv2mqtt']);
        const n = calls;
        r = await catalog.catalog(['hobbyquaker', 'someone'], { now: 2000 });
        expect(r.cached).toBe(true);
        expect(calls).toBe(n);
        r = await catalog.catalog(['hobbyquaker', 'someone'], { now: 3000, force: true, wait: true });
        expect(r.cached).toBe(false);
        expect(calls).toBeGreaterThan(n);
        expect((await catalog.catalog([], { now: 1 })).packages).toEqual([]);
    });

    test('a failing publisher is reported, the rest still lists; a dead registry keeps the last good list', async () => {
        catalog.setFetch(registry({ ...STATE, search: { hobbyquaker: STATE.search.hobbyquaker } }));
        let r = await catalog.catalog(['hobbyquaker', 'someone'], { now: 1000 });
        expect(r.packages.map((p) => p.name)).toEqual(['cul2mqtt', 'lgtv2mqtt']);
        expect(r.errors).toEqual([{ publisher: 'someone', error: expect.stringMatching(/500/) }]);
        catalog.setFetch(async () => ({ ok: false, status: 503 }));
        r = await catalog.catalog(['hobbyquaker', 'someone'], { now: 5000, force: true, wait: true });
        expect(r.stale).toBe(true);
        expect(r.packages.map((p) => p.name)).toEqual(['cul2mqtt', 'lgtv2mqtt']);
    });
});
