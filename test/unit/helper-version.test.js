/**
 * `HELPER_VERSION` is what she compares a host's reported helper version against, so it decides
 * whether a host is offered *Update helper*. It has to match the `VERSION` the helper script
 * reports about itself: leave it behind and every host looks current, the pill and the button
 * never appear, and hosts silently keep an old helper — which is what happened when v12 shipped
 * (she 1.40.0/1.40.1), because the two live in different files and only a comment tied them.
 */

const fs = require('fs');
const path = require('path');
const { HELPER_VERSION } = require('../../src/lib/services-host');

test('HELPER_VERSION matches the VERSION the helper script reports', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', '..', 'service', 'she-servicectl'), 'utf8');
    const declared = /^VERSION=(\d+)$/m.exec(script);
    expect(declared).not.toBeNull();
    expect(Number(declared[1])).toBe(HELPER_VERSION);
});
