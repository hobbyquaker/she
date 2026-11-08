/**
 * The Config page lists the holiday regions in a dropdown of its own — it cannot import the
 * daemon's table. This keeps the two in step: a region added to the table has to be offered on
 * the page, and the page must not offer one the daemon does not know.
 */

const fs = require('fs');
const path = require('path');
const { listRegions } = require('../../src/lib/holidays');

test('the Config page offers exactly the holiday regions of the table', () => {
    const svelte = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'pages', 'Config.svelte'), 'utf8');
    const block = /const HOLIDAY_REGIONS[^=]*=\s*\[([\s\S]*?)\n\s*\];/.exec(svelte);
    expect(block).not.toBeNull();
    const onPage = [...block[1].matchAll(/\['([A-Z-]+)',\s*'([^']+)'\]/g)].map((m) => ({ code: m[1], name: m[2] }));
    expect(onPage).toEqual(listRegions());
});
