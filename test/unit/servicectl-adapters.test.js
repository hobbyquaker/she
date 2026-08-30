/**
 * she-servicectl decides on the host which units are adapters. It is a shell script, so the
 * functions that make that call are sliced out of it and run against a fixture tree — the
 * fake helper the other tests use answers with canned JSON and would not catch this.
 *
 * The cases that brought it up: dnscrypt-proxy, dnsproxy and mcproxy showed up as adapters,
 * because their units run /usr/local/bin/<name> like an adapter's unit does — and nut-display,
 * an npm package that is no adapter at all, because its unit runs it out of node_modules.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'service', 'she-servicectl');

/** the script's validation + helper block, without its command dispatch */
function helperFunctions() {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const from = src.indexOf('# ── validation');
    const to = src.indexOf('# ── commands');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return src.slice(from, to);
}

let dir;
beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-servicectl-'));
    const units = path.join(dir, 'units');
    const bin = path.join(dir, 'bin');
    const mods = path.join(dir, 'lib', 'node_modules');
    fs.mkdirSync(units, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });

    // an adapter installed the pre-core way: a wrapper in /usr/local/bin pointing into its package
    fs.mkdirSync(path.join(mods, 'speedtest2mqtt'), { recursive: true });
    fs.writeFileSync(path.join(mods, 'speedtest2mqtt', 'package.json'), JSON.stringify({ name: 'speedtest2mqtt', version: '2.0.0', mqttInterfaces: { spec: '1' } }));
    fs.writeFileSync(path.join(mods, 'speedtest2mqtt', 'index.js'), '// adapter\n');
    fs.writeFileSync(path.join(bin, 'speedtest2mqtt'), `#!/bin/sh\nexec node "${path.join(mods, 'speedtest2mqtt', 'index.js')}" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(units, 'speedtest2mqtt.service'), '[Service]\nExecStart=/usr/local/bin/speedtest2mqtt\nEnvironmentFile=-/etc/default/speedtest2mqtt\n');

    // an ordinary daemon of the host: same shape of unit, but its binary is no npm package
    fs.writeFileSync(path.join(bin, 'dnscrypt-proxy'), '#!/bin/sh\necho dnscrypt\n', { mode: 0o755 });
    fs.writeFileSync(path.join(units, 'dnscrypt-proxy.service'), '[Service]\nExecStart=/usr/local/bin/dnscrypt-proxy -config /etc/dnscrypt-proxy/dnscrypt-proxy.toml\n');

    // an adapter whose unit runs the package directly, no wrapper on PATH at all
    fs.mkdirSync(path.join(mods, 'hm2mqtt'), { recursive: true });
    fs.writeFileSync(path.join(mods, 'hm2mqtt', 'package.json'), JSON.stringify({ name: 'hm2mqtt', version: '1.0.0', mqttInterfaces: { spec: '1' } }));
    fs.writeFileSync(path.join(units, 'hm2mqtt.service'), `[Service]\nExecStart=/usr/bin/node /usr/local/lib/node_modules/hm2mqtt/index.js\n`);

    // an adapter that only depends on the core, without an mqttInterfaces block of its own
    fs.mkdirSync(path.join(mods, 'cul2mqtt'), { recursive: true });
    fs.writeFileSync(path.join(mods, 'cul2mqtt', 'package.json'), JSON.stringify({ name: 'cul2mqtt', dependencies: { 'mqtt-interfaces-core': '^0.8.0' } }));
    fs.writeFileSync(path.join(units, 'cul2mqtt.service'), `[Service]\nExecStart=/usr/bin/node /usr/local/lib/node_modules/cul2mqtt/index.js\n`);

    // an npm package of the host that has nothing to do with mqtt-interfaces
    fs.mkdirSync(path.join(mods, 'nut-display'), { recursive: true });
    fs.writeFileSync(path.join(mods, 'nut-display', 'package.json'), JSON.stringify({ name: 'nut-display', version: '1.0.0' }));
    fs.writeFileSync(path.join(units, 'nut-display.service'), `[Service]\nExecStart=/usr/bin/node /usr/local/lib/node_modules/nut-display/index.js\n`);

    // a unit for something that is not installed at all
    fs.writeFileSync(path.join(units, 'mcproxy.service'), '[Service]\nExecStart=/usr/local/bin/mcproxy -c /etc/mcproxy.conf\n');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** run legacy_unit for each name, with the fixture tree standing in for the host */
function legacyUnits(names) {
    const script = `set -u
UNIT_DIR="${path.join(dir, 'units')}"
PATH="${path.join(dir, 'bin')}:$PATH"
# no npm on the test machine's path may answer for the fixture: npm_roots reads this one
npm() { [ "$1" = root ] && printf '%s\\n' "${path.join(dir, 'lib', 'node_modules')}"; }
${helperFunctions()}
for a in ${names.join(' ')}; do
    if legacy_unit "$a"; then echo "$a yes"; else echo "$a no"; fi
done
`;
    return execFileSync('sh', ['-c', script], { encoding: 'utf8' }).trim().split('\n');
}

test('a legacy unit counts only when the package behind it is an mqtt-interfaces adapter', () => {
    expect(legacyUnits(['speedtest2mqtt', 'hm2mqtt', 'cul2mqtt', 'dnscrypt-proxy', 'mcproxy', 'nut-display'])).toEqual([
        'speedtest2mqtt yes', // wrapper into the package, mqttInterfaces block
        'hm2mqtt yes', // unit names the package directory itself
        'cul2mqtt yes', // no block of its own, but depends on the core
        'dnscrypt-proxy no', // a daemon of the host, no npm package at all
        'mcproxy no', // nothing of that name installed
        'nut-display no', // an npm package of the host, but no adapter
    ]);
});
