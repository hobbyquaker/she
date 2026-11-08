'use strict';

const bridges = require('../../src/lib/mosquitto-bridges');
const mosquittoConf = require('../../src/lib/mosquitto-conf');

const sample = {
    name: 'cloud',
    addresses: ['broker.example.net:8883'],
    topics: [
        { pattern: 'tele/#', direction: 'in', qos: 0, localPrefix: 'cloud/', remotePrefix: '' },
        { pattern: 'cmnd/#', direction: 'out', qos: 1, localPrefix: '', remotePrefix: '' },
    ],
    options: { remote_username: 'bridge', remote_password: 's3cret', bridge_cafile: '/etc/mosquitto/certs/ca.crt', try_private: 'true' },
};

describe('mosquitto-bridges: topic lines', () => {
    it('parses the full form', () => {
        expect(bridges.parseTopicLine('tele/# in 0 cloud/ ""')).toEqual({ pattern: 'tele/#', direction: 'in', qos: 0, localPrefix: 'cloud/', remotePrefix: '' });
    });
    it('defaults direction and qos', () => {
        expect(bridges.parseTopicLine('a/b')).toEqual({ pattern: 'a/b', direction: 'out', qos: 0, localPrefix: '', remotePrefix: '' });
        expect(bridges.parseTopicLine('a/b both')).toMatchObject({ direction: 'both', qos: 0 });
        expect(bridges.parseTopicLine('a/b 2')).toMatchObject({ direction: 'out', qos: 2 });
    });
    it('reads an empty pattern with prefixes', () => {
        expect(bridges.parseTopicLine('"" out 0 local/ remote/')).toEqual({ pattern: '', direction: 'out', qos: 0, localPrefix: 'local/', remotePrefix: 'remote/' });
    });
    it('writes the short form without prefixes and both prefixes otherwise', () => {
        expect(bridges.serialiseTopicRule({ pattern: 'a/#', direction: 'in', qos: 0 })).toBe('a/# in 0');
        expect(bridges.serialiseTopicRule({ pattern: 'a/#', direction: 'in', qos: 0, localPrefix: 'x/', remotePrefix: '' })).toBe('a/# in 0 x/ ""');
        expect(bridges.serialiseTopicRule({ pattern: '', direction: 'both', qos: 1, localPrefix: '', remotePrefix: 'r/' })).toBe('"" both 1 "" r/');
    });
    it('round-trips every rule shape', () => {
        for (const line of ['a/# in 0', 'a/# out 1 x/ ""', '"" both 2 "" r/', '+/temp both 0 l/ r/']) {
            expect(bridges.serialiseTopicRule(bridges.parseTopicLine(line))).toBe(line);
        }
    });
});

describe('mosquitto-bridges: connection block', () => {
    it('serialises the options in the order they were given', () => {
        const lines = bridges.serialiseBridge({ ...sample, options: { zz_unknown: '1', bridge_cafile: '/ca', remote_username: 'u', remote_password: 'p' } });
        expect(lines).toEqual([
            'connection cloud',
            'address broker.example.net:8883',
            'topic tele/# in 0 cloud/ ""',
            'topic cmnd/# out 1',
            'zz_unknown 1',
            'bridge_cafile /ca',
            'remote_username u',
            'remote_password p',
        ]);
    });
    it('skips empty options', () => {
        const lines = bridges.serialiseBridge({ name: 'b', addresses: ['h'], topics: [], options: { remote_username: '', try_private: undefined, cleansession: 'true' } });
        expect(lines).toEqual(['connection b', 'address h', 'cleansession true']);
    });
    it('parses free-form option lines', () => {
        expect(bridges.parseOptionLines('# comment\n\nkeepalive_interval 30\n  try_private false \nnovalue')).toEqual({
            keepalive_interval: '30',
            try_private: 'false',
            novalue: '',
        });
    });
});

describe('mosquitto-conf: bridges in mosquitto.conf', () => {
    const raw = [
        'per_listener_settings false',
        'listener 1883',
        'allow_anonymous false',
        '',
        '# the cloud link',
        'connection cloud',
        'address a.example.net:8883 b.example.net',
        'topic tele/# in 0 cloud/ ""',
        'topic "" out 0 local/ remote/',
        'remote_username u',
        'remote_password p',
        'bridge_cafile /ca.crt',
        'bridge_future_option x',
        '',
        'connection second',
        'addresses c.example.net',
        'topic s/# both 2',
        'log_dest stdout',
        'some_unknown_global 1',
    ].join('\n');

    it('parses connection blocks into bridges and leaves the rest alone', () => {
        const parsed = mosquittoConf.parseText(raw);
        expect(parsed.listeners).toHaveLength(1);
        expect(parsed.bridges).toHaveLength(2);
        expect(parsed.bridges[0]).toEqual({
            name: 'cloud',
            addresses: ['a.example.net:8883', 'b.example.net'],
            topics: [
                { pattern: 'tele/#', direction: 'in', qos: 0, localPrefix: 'cloud/', remotePrefix: '' },
                { pattern: '', direction: 'out', qos: 0, localPrefix: 'local/', remotePrefix: 'remote/' },
            ],
            options: { remote_username: 'u', remote_password: 'p', bridge_cafile: '/ca.crt', bridge_future_option: 'x' },
        });
        expect(parsed.bridges[1]).toMatchObject({ name: 'second', addresses: ['c.example.net'], topics: [{ pattern: 's/#', direction: 'both', qos: 2 }] });
        expect(parsed.managed.log_dest).toBe('stdout');
        expect(parsed.passthrough).toContain('# the cloud link');
        expect(parsed.passthrough).toContain('some_unknown_global 1');
        // nothing of the bridge leaked into passthrough
        expect(parsed.passthrough.some((l) => /^(connection|address|topic|remote_|bridge_)/.test(l))).toBe(false);
    });

    it('round-trips: serialise(parse(x)) parses to the same bridges', () => {
        const once = mosquittoConf.parseText(raw);
        const text = mosquittoConf.serialise(once);
        const twice = mosquittoConf.parseText(text);
        expect(twice.bridges).toEqual(once.bridges);
        expect(twice.listeners).toEqual(once.listeners);
        expect(twice.managed).toEqual(once.managed);
        expect(mosquittoConf.serialise(twice)).toBe(text);
    });

    it('a conf without bridges still serialises as before', () => {
        const parsed = mosquittoConf.parseText('allow_anonymous true\nlistener 1883\n');
        expect(parsed.bridges).toEqual([]);
        expect(mosquittoConf.serialise({ listeners: parsed.listeners, managed: parsed.managed, passthrough: parsed.passthrough })).toBe('allow_anonymous true\n\nlistener 1883\n');
    });

    it('a bridge block ends at the next listener or global key', () => {
        const parsed = mosquittoConf.parseText('connection x\naddress h\nlistener 8883\ncertfile /s.crt\nconnection y\naddress i\nmax_connections 10\n');
        expect(parsed.bridges.map((b) => b.name)).toEqual(['x', 'y']);
        expect(parsed.listeners[0].tls.certfile).toBe('/s.crt');
        expect(parsed.managed.max_connections).toBe('10');
    });
});

describe('mosquitto-bridges: validation', () => {
    it('accepts a sane bridge', () => {
        expect(bridges.validateBridge(sample)).toEqual({ errors: [], warnings: [] });
    });
    it('requires a name and an address', () => {
        const r = bridges.validateBridge({ name: '', addresses: [], topics: [] });
        expect(r.errors.some((e) => /name/.test(e))).toBe(true);
        expect(r.errors.some((e) => /address/.test(e))).toBe(true);
    });
    it('rejects bad names, addresses and ports', () => {
        expect(bridges.validateBridge({ ...sample, name: 'has space' }).errors).toHaveLength(1);
        expect(bridges.validateBridge({ ...sample, addresses: ['host:99999'] }).errors).toHaveLength(1);
        expect(bridges.validateBridge({ ...sample, addresses: ['host:1883', 'not a host'] }).errors).toHaveLength(1);
        expect(bridges.validateBridge({ ...sample, addresses: ['[fe80::1]:1883'] }).errors).toHaveLength(0);
    });
    it('checks the topic rules', () => {
        const bad = (t) => bridges.validateBridge({ ...sample, topics: [t] }).errors;
        expect(bad({ pattern: 'a/#/b', direction: 'in', qos: 0 })).toHaveLength(1);
        expect(bad({ pattern: 'a/b+', direction: 'in', qos: 0 })).toHaveLength(1);
        expect(bad({ pattern: 'a/b', direction: 'sideways', qos: 0 })).toHaveLength(1);
        expect(bad({ pattern: 'a/b', direction: 'in', qos: 3 })).toHaveLength(1);
        expect(bad({ pattern: '', direction: 'in', qos: 0 })).toHaveLength(1);
        expect(bad({ pattern: 'a/#', direction: 'in', qos: 0, localPrefix: 'x/+/' })).toHaveLength(1);
        expect(bad({ pattern: '', direction: 'in', qos: 0, localPrefix: 'x/' })).toHaveLength(0);
    });
    it('types the options and warns on unknown ones', () => {
        const r = bridges.validateBridge({
            ...sample,
            options: { ...sample.options, cleansession: 'yes', keepalive_interval: 'abc', start_type: 'never', restart_timeout: '5 30 1', bridge_future: '1' },
        });
        expect(r.errors).toHaveLength(4);
        expect(r.warnings.some((w) => /Unknown option "bridge_future"/.test(w))).toBe(true);
    });
    it('knows which options need Mosquitto 2.1', () => {
        const opts = { ...sample.options, bridge_reload_type: 'lazy' };
        expect(bridges.validateBridge({ ...sample, options: opts }, { brokerVersion: '2.0.18' }).warnings.some((w) => /needs Mosquitto 2.1/.test(w))).toBe(true);
        expect(bridges.validateBridge({ ...sample, options: opts }, { brokerVersion: '2.1.2' }).warnings).toEqual([]);
        expect(bridges.validateBridge({ ...sample, options: opts }).warnings).toEqual([]);
    });
    it('catches a password without a user and a half client certificate', () => {
        expect(bridges.validateBridge({ ...sample, options: { remote_password: 'x', bridge_cafile: '/ca' } }).errors).toEqual(['A remote password needs a remote username.']);
        expect(bridges.validateBridge({ ...sample, options: { bridge_certfile: '/c' } }).errors).toEqual(['A client certificate needs both bridge_certfile and bridge_keyfile.']);
    });
    it('warns about clear-text credentials, bridge_insecure and notifications off', () => {
        const w = bridges.validateBridge({ ...sample, options: { remote_username: 'u', remote_password: 'p', bridge_insecure: 'true', notifications: 'false' } }).warnings;
        expect(w).toHaveLength(3);
    });
    it('a structural key in the options is an error', () => {
        expect(bridges.validateBridge({ ...sample, options: { address: 'x' } }).errors).toHaveLength(1);
    });
    it('reads the broker version out of $SYS', () => {
        expect(bridges.brokerVersionFromSys('mosquitto version 2.1.2')).toBe('2.1.2');
        expect(bridges.brokerVersionFromSys(undefined)).toBeNull();
        expect(bridges.compareVersion('2.0.18', '2.1')).toBe(-1);
        expect(bridges.compareVersion('2.1.2', '2.1')).toBe(0);
    });
});

describe('mosquitto-bridges: loop check', () => {
    it('knows when two filters overlap', () => {
        expect(bridges.patternsOverlap('a/#', 'a/b/c')).toBe(true);
        expect(bridges.patternsOverlap('a/+/c', 'a/b/#')).toBe(true);
        expect(bridges.patternsOverlap('a/b', 'a/c')).toBe(false);
        expect(bridges.patternsOverlap('a/b', 'a/b/c')).toBe(false);
        expect(bridges.patternsOverlap('#', 'x')).toBe(true);
        expect(bridges.patternsOverlap('cloud/tele/#', 'tele/#')).toBe(false);
    });
    it('a plain mirror in and out under a prefix is fine', () => {
        const r = bridges.findLoops([
            { pattern: 'tele/#', direction: 'in', qos: 0, localPrefix: 'cloud/', remotePrefix: '' },
            { pattern: 'cmnd/#', direction: 'out', qos: 0, localPrefix: '', remotePrefix: '' },
        ]);
        expect(r).toEqual({ errors: [], warnings: [] });
    });
    it('the same pattern both ways without a prefix change is a warning (try_private)', () => {
        const r = bridges.findLoops([{ pattern: 'home/#', direction: 'both', qos: 0, localPrefix: '', remotePrefix: '' }]);
        expect(r.errors).toEqual([]);
        expect(r.warnings).toHaveLength(1);
        expect(r.warnings[0]).toMatch(/try_private/);
    });
    it('a rule mapping back onto itself through another rule is an error', () => {
        // in: remote tele/x -> local cloud/tele/x ; out: local cloud/tele/x -> remote tele/x ; -> in again
        const r = bridges.findLoops([
            { pattern: 'tele/#', direction: 'in', qos: 0, localPrefix: 'cloud/', remotePrefix: '' },
            { pattern: 'tele/#', direction: 'out', qos: 0, localPrefix: 'cloud/', remotePrefix: '' },
        ]);
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0]).toMatch(/^Loop:/);
    });
    it('an in rule and an out rule with a prefix on the way out do not loop', () => {
        const r = bridges.findLoops([
            { pattern: '#', direction: 'in', qos: 0, localPrefix: 'remote/', remotePrefix: '' },
            { pattern: '#', direction: 'out', qos: 0, localPrefix: '', remotePrefix: 'site1/' },
        ]);
        // remote a/b -> local remote/a/b -> out as site1/remote/a/b -> matches in-pattern "#" again: a real loop
        expect(r.errors).toHaveLength(1);
        const ok = bridges.findLoops([
            { pattern: 'tele/#', direction: 'in', qos: 0, localPrefix: 'remote/', remotePrefix: '' },
            { pattern: 'home/#', direction: 'out', qos: 0, localPrefix: '', remotePrefix: 'site1/' },
        ]);
        expect(ok.errors).toEqual([]);
    });
    it('validateBridges reports duplicate names and loops across bridges to the same remote', () => {
        const a = { ...sample, name: 'x', topics: [{ pattern: 'tele/#', direction: 'in', qos: 0, localPrefix: 'cloud/', remotePrefix: '' }] };
        const b = { ...sample, name: 'x', topics: [{ pattern: 'tele/#', direction: 'out', qos: 0, localPrefix: 'cloud/', remotePrefix: '' }] };
        const r = bridges.validateBridges([a, b]);
        expect(r.errors.some((e) => /Duplicate bridge name "x"/.test(e))).toBe(true);
        expect(r.errors.some((e) => /^Loop: x: rule 1/.test(e))).toBe(true);
        const other = bridges.validateBridges([a, { ...b, name: 'y', addresses: ['elsewhere.example.net'] }]);
        expect(other.errors).toEqual([]);
    });
});

describe('mosquitto-bridges: preview and presets', () => {
    it('shows both directions of a rule with an example topic', () => {
        const p = bridges.previewRule({ pattern: 'tele/+/temp', direction: 'both', qos: 0, localPrefix: 'cloud/', remotePrefix: 'site/' });
        expect(p.lines).toEqual(['remote site/tele/kitchen/temp → local cloud/tele/kitchen/temp', 'local cloud/tele/kitchen/temp → remote site/tele/kitchen/temp']);
        expect(bridges.exampleTopic('a/#')).toBe('a/a/b');
    });
    it('the presets produce valid rules', () => {
        for (const preset of bridges.PRESETS) {
            const params = Object.fromEntries(preset.params.map((p) => [p.key, p.default]));
            const rules = preset.rules(params);
            expect(rules.length).toBeGreaterThan(0);
            const r = bridges.validateBridge({ ...sample, topics: rules });
            expect(r.errors).toEqual([]);
        }
        const sh = bridges.PRESETS.find((p) => p.id === 'mqtt-smarthome-adapter').rules({ name: 'hm' });
        expect(sh.map((r) => `${r.pattern} ${r.direction}`)).toEqual(['hm/status/# in', 'hm/connected in', 'hm/set/# out']);
    });
});

describe('mosquitto-bridges: the remote side', () => {
    it('derives the state topic from remote_clientid or notification_topic', () => {
        expect(bridges.stateTopic(sample)).toBeNull();
        expect(bridges.stateTopic(sample, 'brokerhost')).toBe('$SYS/broker/connection/brokerhost.cloud/state');
        expect(bridges.stateTopic({ ...sample, options: { remote_clientid: 'cid' } })).toBe('$SYS/broker/connection/cid/state');
        expect(bridges.stateTopic({ ...sample, options: { notification_topic: 'bridges/cloud' } })).toBe('bridges/cloud');
    });
    it('lists the ACLs the remote needs, as dynsec commands and plain text', () => {
        const r = bridges.remoteRequirements({ ...sample, options: { ...sample.options, remote_clientid: 'she-cloud' } });
        expect(r.username).toBe('bridge');
        expect(r.role).toBe('bridge-cloud');
        expect(r.acls.map((a) => `${a.acltype} ${a.topic}`)).toEqual([
            'subscribePattern tele/#',
            'publishClientReceive tele/#',
            'publishClientSend cmnd/#',
            'publishClientSend $SYS/broker/connection/she-cloud/state',
        ]);
        expect(r.dynsec[0]).toBe('mosquitto_ctrl dynsec createClient bridge');
        expect(r.dynsec[r.dynsec.length - 1]).toBe('mosquitto_ctrl dynsec addClientRole bridge bridge-cloud');
        expect(r.plain).toMatch(/^User "bridge" with client id "she-cloud"/);
    });
    it('uses the remote prefix and skips the notification when local only', () => {
        const r = bridges.remoteRequirements({
            ...sample,
            topics: [{ pattern: '#', direction: 'in', qos: 0, localPrefix: 'remote/', remotePrefix: 'site/' }],
            options: { remote_username: 'u', notifications_local_only: 'true' },
        });
        expect(r.acls.map((a) => a.topic)).toEqual(['site/#', 'site/#']);
    });
});

describe('mosquitto-bridges: diff and rollback', () => {
    it('masks secrets and shows a unified diff', () => {
        const before = 'listener 1883\n\nconnection a\naddress h\nremote_password old\n';
        const after = 'listener 1883\n\nconnection a\naddress h\nremote_password new\ntopic t/# in 0\n';
        const d = bridges.unifiedDiff(before, after);
        expect(d).not.toMatch(/old|new$/m);
        expect(d).toMatch(/^-remote_password \*{8}$/m);
        expect(d).toMatch(/^\+remote_password \*{8}$/m);
        expect(d).toMatch(/^\+topic t\/# in 0$/m);
        expect(d).toMatch(/^@@ -2,5 \+2,6 @@$/m);
        expect(bridges.unifiedDiff('same\n', 'same\n')).toBe('');
    });
    it('merges nearby changes into one hunk and never repeats a line', () => {
        const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
        const after = before.replace('line 5', 'line five').replace('line 9', 'line nine');
        const d = bridges.unifiedDiff(before, after);
        expect(d.match(/^@@/gm)).toHaveLength(1);
        expect(d.match(/^ line 7$/gm)).toHaveLength(1);
        const far = bridges.unifiedDiff(before, before.replace('line 2', 'two').replace('line 17', 'seventeen'));
        expect(far.match(/^@@/gm)).toHaveLength(2);
    });
    it('masks local_password and bridge_psk too', () => {
        expect(bridges.maskSecrets('local_password a\nbridge_psk b\nremote_username c')).toBe('local_password ********\nbridge_psk ********\nremote_username c');
    });
    it('decides the rollback from the reload result and the probe', () => {
        expect(bridges.decideRollback({ reloadOk: true, probeOk: true })).toEqual({ rollback: false, restart: false, reason: null });
        expect(bridges.decideRollback({ reloadOk: false, probeOk: true })).toMatchObject({ rollback: true, restart: false });
        expect(bridges.decideRollback({ reloadOk: true, probeOk: false })).toMatchObject({ rollback: true, restart: true });
        expect(bridges.decideRollback({ reloadOk: false, probeOk: false })).toMatchObject({ rollback: true, restart: true });
    });
});
