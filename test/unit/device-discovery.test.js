'use strict';

const { shapeDevices, slugName, uniqueName, configValue, discoverTarget } = require('../../src/lib/device-discovery');

describe('slugName', () => {
    test('transliterates german umlauts rather than dropping them', () => {
        expect(slugName('Küche Oben')).toBe('kueche-oben');
        expect(slugName('Büro')).toBe('buero');
        expect(slugName('Straße')).toBe('strasse');
        expect(slugName('Wohnzimmer')).toBe('wohnzimmer');
    });

    test('strips the accents NFKD splits off', () => {
        expect(slugName('Café')).toBe('cafe');
        expect(slugName('Chambre à coucher')).toBe('chambre-a-coucher');
    });

    test('collapses everything outside the instance charset', () => {
        expect(slugName('Wohnzimmer!!!')).toBe('wohnzimmer');
        expect(slugName('LG S95QR (2.1)')).toBe('lg-s95qr-2.1');
        expect(slugName('  spaced   out  ')).toBe('spaced-out');
    });

    test('never returns something an instance name may not be', () => {
        for (const name of ['', '   ', '???', '---', '12345', null, undefined, 42, {}]) {
            expect(slugName(name)).toBeNull();
        }
    });

    test('caps the length and never ends on a separator', () => {
        const slug = slugName('Wohnzimmer hinten links neben der Tür oben');
        expect(slug.length).toBeLessThanOrEqual(32);
        expect(slug).not.toMatch(/[-._]$/);
    });

    test('a device name that is a topic-breaking string cannot escape the charset', () => {
        expect(slugName('a/b/#')).toBe('a-b');
        expect(slugName('../../etc/passwd')).toBe('etc-passwd');
        expect(slugName('name with\ttab')).toBe('name-withtab');
    });
});

describe('uniqueName', () => {
    test('leaves a free name alone', () => {
        expect(uniqueName('kueche', new Set(['bad']))).toBe('kueche');
    });

    test('suffixes until free', () => {
        expect(uniqueName('kueche', new Set(['kueche']))).toBe('kueche-2');
        expect(uniqueName('kueche', new Set(['kueche', 'kueche-2', 'kueche-3']))).toBe('kueche-4');
    });

    test('a suffixed name still fits the length cap', () => {
        const base = 'a'.repeat(32);
        const out = uniqueName(base, new Set([base]));
        expect(out.length).toBeLessThanOrEqual(32);
        expect(out).toMatch(/-2$/);
    });
});

describe('configValue', () => {
    test('prefers the qualified name — it outlives a dhcp lease', () => {
        expect(configValue({ address: '10.0.1.5', fqdn: 'wiim.lan', hostname: 'wiim' })).toBe('wiim.lan');
    });

    test('falls back to the address when dns knows nothing', () => {
        expect(configValue({ address: '10.0.1.5', hostname: 'wiim' })).toBe('10.0.1.5');
    });

    test('never uses the short hostname on its own', () => {
        expect(configValue({ hostname: 'wiim' })).toBeNull();
    });

    test('a serial port carries its by-id path as the address', () => {
        expect(configValue({ address: '/dev/serial/by-id/usb-busware.de_CUL868-if00', device: '/dev/ttyACM0' })).toBe('/dev/serial/by-id/usb-busware.de_CUL868-if00');
    });
});

describe('shapeDevices', () => {
    const wiim = { address: '10.0.1.5', fqdn: 'kueche.lan', name: 'Küche', model: 'WiiM Pro Plus', sources: ['ssdp'], services: { upnp: true } };

    test('shapes an entry into what the form needs', () => {
        const [device] = shapeDevices([wiim]);
        expect(device).toMatchObject({
            value: 'kueche.lan',
            address: '10.0.1.5',
            name: 'Küche',
            model: 'WiiM Pro Plus',
            suggestName: 'kueche',
            usedBy: null,
            sources: ['ssdp'],
            services: { upnp: true },
        });
    });

    test('two devices with the same name get distinct instance names', () => {
        const devices = shapeDevices([wiim, { ...wiim, address: '10.0.1.6', fqdn: 'kueche2.lan' }]);
        expect(devices.map((d) => d.suggestName)).toEqual(['kueche', 'kueche-2']);
    });

    test('names already in use elsewhere are avoided', () => {
        const [device] = shapeDevices([wiim], { taken: ['Kueche'] });
        expect(device.suggestName).toBe('kueche-2');
    });

    test('a device without a name of its own falls back to the schema default', () => {
        const [device] = shapeDevices([{ address: '10.0.1.7', type: 'eQ3-HmIP-CCU3-App' }], { fallbackName: 'hm' });
        expect(device.suggestName).toBe('hm');
        expect(device.name).toBeUndefined();
    });

    test('a model is never used as the instance name — every device would propose the same', () => {
        const [device] = shapeDevices([{ address: '10.0.1.8', model: 'WiiM Pro Plus' }]);
        expect(device.suggestName).toBeUndefined();
    });

    test('marks a device an instance already uses', () => {
        const [device] = shapeDevices([wiim], { usedBy: { 'kueche.lan': 'kueche' } });
        expect(device.usedBy).toBe('kueche');
    });

    test('matches an instance configured with any identifier the device answers to', () => {
        // the stick was configured with the raw device node, discovery reports the by-id path
        const stick = { address: '/dev/serial/by-id/usb-busware.de_CUL868-if00', device: '/dev/ttyACM0' };
        expect(shapeDevices([stick], { usedBy: { '/dev/ttyACM0': 'cul' } })[0].usedBy).toBe('cul');
        // configured with the address before dns had a name for it
        expect(shapeDevices([{ address: '10.0.1.5', fqdn: 'kueche.lan' }], { usedBy: { '10.0.1.5': 'kueche' } })[0].usedBy).toBe('kueche');
    });

    test('drops entries nothing can be configured from, and non-objects', () => {
        expect(shapeDevices([{ hostname: 'no-address' }, null, 'nope', [], 42])).toEqual([]);
    });

    test('is not fooled by hostile input from the network', () => {
        const [device] = shapeDevices([
            {
                address: '10.0.1.9',
                name: 'x'.repeat(500),
                serial: 'y'.repeat(500),
                sources: Array.from({ length: 40 }, (_, i) => 'src' + i),
                services: Object.fromEntries(Array.from({ length: 60 }, (_, i) => ['p' + i, true])),
                evil: 'dropped',
            },
        ]);
        expect(device.name.length).toBe(120);
        expect(device.serial.length).toBe(120);
        expect(device.sources.length).toBe(8);
        expect(Object.keys(device.services).length).toBe(24);
        expect(device.evil).toBeUndefined();
        expect(device.suggestName).toMatch(/^x{32}$/);
    });

    test('service values are booleans, never whatever the device sent', () => {
        const [device] = shapeDevices([{ address: '10.0.1.10', services: { open: true, closed: false, weird: 'yes' } }]);
        expect(device.services).toEqual({ open: true, closed: false, weird: false });
    });

    test('caps the number of devices', () => {
        const many = Array.from({ length: 80 }, (_, i) => ({ address: '10.0.2.' + i }));
        expect(shapeDevices(many).length).toBe(50);
    });

    test('anything that is not an array is no devices at all', () => {
        for (const raw of [null, undefined, {}, 'x', 7]) expect(shapeDevices(raw)).toEqual([]);
    });
});

describe('discoverTarget', () => {
    const schema = (props) => ({ properties: props });

    test('finds the marked property and its kind', () => {
        expect(discoverTarget(schema({ 'ccu-address': { 'x-env': 'HM_CCU_ADDRESS', 'x-discover': 'network' }, 'name': { 'x-env': 'HM_NAME' } }))).toEqual({
            key: 'ccu-address',
            envName: 'HM_CCU_ADDRESS',
            kinds: ['network'],
        });
    });

    test('an adapter that speaks both gets both kinds', () => {
        expect(discoverTarget(schema({ serialport: { 'x-env': 'CUL_SERIALPORT', 'x-discover': ['serial', 'network'] } })).kinds).toEqual(['serial', 'network']);
    });

    test('tolerates a bare true from a future core', () => {
        expect(discoverTarget(schema({ address: { 'x-env': 'A', 'x-discover': true } })).kinds).toEqual(['network']);
    });

    test('an unknown kind does not make an adapter discovery-capable', () => {
        expect(discoverTarget(schema({ address: { 'x-env': 'A', 'x-discover': 'telepathy' } }))).toBeNull();
    });

    test('a schema without the marker is not discovery-capable', () => {
        expect(discoverTarget(schema({ address: { 'x-env': 'A' } }))).toBeNull();
        expect(discoverTarget(null)).toBeNull();
        expect(discoverTarget({})).toBeNull();
    });
});
