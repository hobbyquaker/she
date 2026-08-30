'use strict';

/**
 * Regression tests for the two places the Adapters page drives Svelte effects: the
 * sub-navigation routing (#/adapters/instances) and the cross-tab reload. Both hit the same
 * trap — an effect that writes state it also reads re-runs itself — so both are pinned here,
 * including the unguarded variants, which must still misbehave.
 *
 * Svelte runs in the browser, so the model in fixtures/subnav-model.svelte.js is compiled
 * with the real compiler and executed against the real client runtime in a child process —
 * both live in web/node_modules, which only exists once the frontend deps are installed.
 * CI installs the root deps only, so the test skips there rather than failing.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'web');
const MODEL = path.join(__dirname, 'fixtures', 'subnav-model.svelte.js');
const hasSvelte = fs.existsSync(path.join(WEB, 'node_modules', 'svelte', 'package.json'));

const RUNNER = `
import { compileModule } from 'svelte/compiler';
import fs from 'node:fs';
import path from 'node:path';

const settle = () => new Promise((r) => setTimeout(r, 25)); // generous: a loaded machine still gets several turns
const out = path.join(process.cwd(), '.subnav-model.' + process.pid + '.mjs');
fs.writeFileSync(out, compileModule(fs.readFileSync(process.env.MODEL, 'utf8'), { generate: 'client', filename: 'model.svelte.js' }).js.code);

try {
    const { makePage } = await import('file://' + out);
    const results = [];
    const check = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

    // a deep link opens the tab it names
    const p = makePage('instances', 'hosts');
    await settle();
    check('deep link opens that tab', [p.tab, p.hash], ['hostsconf', 'hosts']);

    // clicking a sub-tab switches it and the url follows
    p.click('instances');
    await settle();
    check('click switches the tab and the url follows', [p.tab, p.hash], ['instances', 'instances']);

    p.click('hosts');
    await settle();
    check('a second click', [p.tab, p.hash], ['hosts', 'installations']);

    // editing the address bar still steers the tab
    p.urlTo('hosts');
    await settle();
    check('url edit steers the tab', [p.tab, p.hash], ['hostsconf', 'hosts']);
    p.stop();

    // and the guard is what makes the click work: without it the click is undone
    const g = makePage('instances', 'hosts', { guard: false });
    await settle();
    g.click('instances');
    await settle();
    check('without the guard a click is undone (the 1.45.0 bug)', g.tab, 'hostsconf');
    g.stop();

    // the tab-reload guard: one reload per change, not a runaway
    const { makeReloader } = await import('file://' + out);
    const r1 = makeReloader();
    r1.change();
    await settle();
    check('a reported change reloads the tab once', r1.loads, 1);
    r1.change();
    await settle();
    check('and once more for the next change', r1.loads, 2);
    r1.stop();

    const r2 = makeReloader({ guard: false });
    r2.change();
    await settle();
    check('without the guard the reload runs away', r2.loads > 2, true);
    r2.stop();

    console.log(JSON.stringify(results));
} finally {
    fs.rmSync(out, { force: true });
}
`;

(hasSvelte ? describe : describe.skip)('sub-navigation routing', () => {
    let results;

    beforeAll(() => {
        const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', RUNNER], {
            cwd: WEB, // so `svelte` and the compiled model resolve against web/node_modules
            env: { ...process.env, MODEL },
            encoding: 'utf8',
            timeout: 60000,
        });
        results = JSON.parse(stdout.trim().split('\n').pop());
    });

    test('every case holds', () => {
        const failed = results.filter((r) => !r.ok);
        expect(failed.map((r) => `${r.name}: got ${JSON.stringify(r.got)}, want ${JSON.stringify(r.want)}`)).toEqual([]);
        expect(results).toHaveLength(8);
    });
});
