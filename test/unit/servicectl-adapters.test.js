/**
 * she-servicectl decides on the host which units are adapters. It is a shell script, so the
 * functions that make that call are sliced out of it and run against a fixture tree — the
 * fake helper the other tests use answers with canned JSON and would not catch this.
 *
 * The case that brought it up: dnscrypt-proxy, dnsproxy and mcproxy showed up as adapters on
 * a host, because their units run /usr/local/bin/<name> like an adapter's unit does.
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
    fs.writeFileSync(path.join(mods, 'speedtest2mqtt', 'package.json'), JSON.stringify({ name: 'speedtest2mqtt', version: '2.0.0' }));
    fs.writeFileSync(path.join(mods, 'speedtest2mqtt', 'index.js'), '// adapter\n');
    fs.writeFileSync(path.join(bin, 'speedtest2mqtt'), `#!/bin/sh\nexec node "${path.join(mods, 'speedtest2mqtt', 'index.js')}" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(units, 'speedtest2mqtt.service'), '[Service]\nExecStart=/usr/local/bin/speedtest2mqtt\nEnvironmentFile=-/etc/default/speedtest2mqtt\n');

    // an ordinary daemon of the host: same shape of unit, but its binary is no npm package
    fs.writeFileSync(path.join(bin, 'dnscrypt-proxy'), '#!/bin/sh\necho dnscrypt\n', { mode: 0o755 });
    fs.writeFileSync(path.join(units, 'dnscrypt-proxy.service'), '[Service]\nExecStart=/usr/local/bin/dnscrypt-proxy -config /etc/dnscrypt-proxy/dnscrypt-proxy.toml\n');

    // an adapter whose unit runs the package directly, no wrapper on PATH at all
    fs.mkdirSync(path.join(mods, 'hm2mqtt'), { recursive: true });
    fs.writeFileSync(path.join(mods, 'hm2mqtt', 'package.json'), JSON.stringify({ name: 'hm2mqtt', version: '1.0.0' }));
    fs.writeFileSync(path.join(units, 'hm2mqtt.service'), `[Service]\nExecStart=/usr/bin/node /usr/local/lib/node_modules/hm2mqtt/index.js\n`);

    // a unit for something that is not installed at all
    fs.writeFileSync(path.join(units, 'mcproxy.service'), '[Service]\nExecStart=/usr/local/bin/mcproxy -c /etc/mcproxy.conf\n');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** run legacy_unit for each name, with the fixture tree standing in for the host */
function legacyUnits(names) {
    const script = `set -u
UNIT_DIR="${path.join(dir, 'units')}"
PATH="${path.join(dir, 'bin')}:$PATH"
${helperFunctions()}
for a in ${names.join(' ')}; do
    if legacy_unit "$a"; then echo "$a yes"; else echo "$a no"; fi
done
`;
    return execFileSync('sh', ['-c', script], { encoding: 'utf8' }).trim().split('\n');
}

test('a legacy unit is an adapter only when its binary is an npm package of that name', () => {
    expect(legacyUnits(['speedtest2mqtt', 'hm2mqtt', 'dnscrypt-proxy', 'mcproxy'])).toEqual([
        'speedtest2mqtt yes', // wrapper into the package
        'hm2mqtt yes', // unit names the package directory itself
        'dnscrypt-proxy no', // a daemon of the host, not an adapter
        'mcproxy no', // no such package installed
    ]);
});
