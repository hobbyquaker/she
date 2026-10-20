'use strict';

/**
 * Unit tests for src/matter/thread-datasets.js (roadmap M17): import, redaction, reveal, the
 * encrypted store across a restart, the MeshCoP switch and the credentials it gates.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// a made-up dataset (channel 25, PAN 0x1234, ext PAN ID dead00beef00cafe, "Lab", PSKc 01…, key 02…), encoded with matter.js
const TLV = '0003000019010212340208dead00beef00cafe03034c61620410010101010101010101010101010101010510020202020202020202020202020202020708fd00dead00beef000e080000000000010000';
const KEY_HEX = '02020202020202020202020202020202';
const PSKC_HEX = '01010101010101010101010101010101';

describe('matter thread datasets', () => {
    let ds;
    let dir;
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    beforeEach(() => {
        jest.resetModules();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-tds-'));
        const secrets = require('../../src/lib/secrets');
        secrets.init({ file: path.join(dir, 'secrets.enc'), keyFile: path.join(dir, 'secrets.key'), env: {} });
        ds = require('../../src/matter/thread-datasets');
        ds._reset();
        ds.init({ storageDir: dir, log });
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('normaliseTlv accepts hex with 0x, spaces and colons, refuses the rest', () => {
        expect(ds.normaliseTlv(' 0x0E08 00:11 ')).toBe('0e080011');
        expect(() => ds.normaliseTlv('MT:XYZ')).toThrow('hex TLV');
        expect(() => ds.normaliseTlv('abc')).toThrow('hex TLV');
    });

    test('import: decoded, listed redacted, has(), the store survives a restart and holds no plaintext', () => {
        expect(ds.list()).toEqual({ available: true, error: null, datasets: [] });
        const v = ds.add({ tlv: TLV, source: 'pasted', note: 'test net' });
        expect(v).toMatchObject({
            extPanId: 'DEAD00BEEF00CAFE',
            networkName: 'Lab',
            channel: 25,
            panId: 0x1234,
            meshLocalPrefix: 'FD00DEAD00BEEF00',
            hasNetworkKey: true,
            hasPskc: true,
            source: 'pasted',
            note: 'test net',
            meshcop: false,
        });
        expect(JSON.stringify(v)).not.toContain(KEY_HEX);
        expect(JSON.stringify(ds.list())).not.toContain(PSKC_HEX.toUpperCase());
        expect(ds.has('dead00beef00cafe')).toBe(true);
        expect(ds.has('0000000000000000')).toBe(false);
        const raw = fs.readFileSync(ds.fileFor(dir), 'utf8');
        expect(raw).not.toContain(KEY_HEX);
        expect(raw).not.toContain('dead00beef00cafe');
        expect(log.info.mock.calls.flat().join(' ')).not.toContain(KEY_HEX);

        jest.resetModules();
        require('../../src/lib/secrets').init({ file: path.join(dir, 'secrets.enc'), keyFile: path.join(dir, 'secrets.key'), env: {} });
        const again = require('../../src/matter/thread-datasets');
        again._reset();
        again.init({ storageDir: dir, log });
        expect(again.list().datasets[0]).toMatchObject({ extPanId: 'DEAD00BEEF00CAFE', networkName: 'Lab' });
        expect(again.reveal('DEAD00BEEF00CAFE')).toEqual({ extPanId: 'DEAD00BEEF00CAFE', tlv: TLV });
    });

    test('garbage is refused; a dataset without an extended PAN ID too', () => {
        expect(() => ds.add({ tlv: 'zz' })).toThrow('hex TLV');
        expect(() => ds.add({ tlv: '00030000190102123400' })).toThrow(/extended PAN ID|TLV/);
    });

    test('the MeshCoP switch gates the credentials; remove forgets', () => {
        ds.add({ tlv: TLV });
        expect(ds.credentialsFor('DEAD00BEEF00CAFE')).toBeNull();
        const v = ds.setMeshcop('dead00beef00cafe', true);
        expect(v.meshcop).toBe(true);
        const creds = ds.credentialsFor('DEAD00BEEF00CAFE');
        expect(creds.networkName).toBe('Lab');
        expect(Buffer.from(creds.pskc).toString('hex')).toBe(PSKC_HEX);
        expect(Buffer.from(creds.extPanId).toString('hex')).toBe('dead00beef00cafe');
        expect(ds.dataset('DEAD00BEEF00CAFE').channel).toBe(25);
        expect(ds.remove('DEAD00BEEF00CAFE')).toEqual({ ok: true });
        expect(ds.has('DEAD00BEEF00CAFE')).toBe(false);
        expect(() => ds.remove('DEAD00BEEF00CAFE')).toThrow('no dataset');
        expect(() => ds.reveal('DEAD00BEEF00CAFE')).toThrow('no dataset');
    });

    test('without a key file the store reports itself unavailable', () => {
        jest.resetModules();
        const secrets = require('../../src/lib/secrets');
        secrets.init({ file: path.join(dir, 'x.enc'), keyFile: path.join(dir, 'missing.key'), env: {} });
        fs.writeFileSync(path.join(dir, 'thread-datasets.enc'), JSON.stringify({ alg: 'aes-256-gcm', iv: 'AA==', tag: 'AA==', data: 'AA==' }));
        const locked = require('../../src/matter/thread-datasets');
        locked._reset();
        locked.init({ storageDir: dir, log });
        expect(locked.list()).toMatchObject({ available: false, error: expect.stringContaining('no key') });
        expect(() => locked.add({ tlv: TLV })).toThrow('not available');
    });
});
