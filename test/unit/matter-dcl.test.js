'use strict';

/**
 * Unit tests for src/matter/dcl.js (roadmap M25): vendor names from the snapshot or the live
 * service, product details cached on disk with a TTL, the offline switch, and the device-page
 * summary.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('matter dcl', () => {
    let dcl;
    let dir;
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    beforeEach(() => {
        jest.resetModules();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-dcl-'));
        dcl = require('../../src/matter/dcl');
        dcl._reset();
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('vendor names come from the snapshot when there is no live service', () => {
        dcl._inject({ seedVendors: [{ vendorId: 4874, vendorName: 'IKEA of Sweden AB', companyPreferredName: 'IKEA', companyLegalName: 'IKEA of Sweden AB' }] });
        expect(dcl.vendorName(4874)).toBe('IKEA');
        expect(dcl.vendorName('4874')).toBe('IKEA');
        expect(dcl.vendorName(1)).toBeNull();
        expect(dcl.vendor(4874)).toMatchObject({ vendorId: 4874, vendorName: 'IKEA of Sweden AB' });
    });

    test('the live service wins over the snapshot', () => {
        dcl._inject({
            seedVendors: [{ vendorId: 4874, vendorName: 'old name' }],
            service: { infoFor: (id) => (id === 4874 ? { vendorId: 4874, vendorName: 'IKEA of Sweden AB', companyPreferredName: 'IKEA' } : undefined) },
        });
        expect(dcl.vendorName(4874)).toBe('IKEA');
        expect(dcl.vendorName(5)).toBeNull();
    });

    test('product details are fetched once, cached on disk and served from the cache within the TTL', async () => {
        const file = path.join(dir, 'dcl-products.json');
        const productInfoFor = jest.fn().mockResolvedValue({
            productName: 'TRADFRI bulb',
            productLabel: 'E27',
            partNumber: '123',
            deviceTypeID: 0x101,
            productUrl: 'https://x/p',
            userManualUrl: 'https://x/m',
        });
        dcl._inject({ service: { infoFor: () => undefined, productInfoFor }, productsFile: file });
        const p1 = await dcl.product(4874, 7);
        expect(p1).toMatchObject({ productName: 'TRADFRI bulb', partNumber: '123', deviceTypeId: 0x101, productUrl: 'https://x/p', supportUrl: null });
        expect(productInfoFor).toHaveBeenCalledTimes(1);
        await dcl.product(4874, 7);
        expect(productInfoFor).toHaveBeenCalledTimes(1);
        const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(onDisk['4874:7'].info.productName).toBe('TRADFRI bulb');

        // a fresh module reads the cache back and does not ask the ledger
        jest.resetModules();
        const dcl2 = require('../../src/matter/dcl');
        dcl2._reset();
        const again = jest.fn();
        dcl2._inject({ service: { infoFor: () => undefined, productInfoFor: again }, productsFile: file });
        expect((await dcl2.product(4874, 7)).productName).toBe('TRADFRI bulb');
        expect(again).not.toHaveBeenCalled();

        // an expired entry is refreshed
        onDisk['4874:7'].fetchedAt = Date.now() - dcl.PRODUCT_TTL_MS - 1000;
        fs.writeFileSync(file, JSON.stringify(onDisk));
        jest.resetModules();
        const dcl3 = require('../../src/matter/dcl');
        dcl3._reset();
        const refresh = jest.fn().mockResolvedValue({ productName: 'newer' });
        dcl3._inject({ service: { infoFor: () => undefined, productInfoFor: refresh }, productsFile: file });
        expect((await dcl3.product(4874, 7)).productName).toBe('newer');
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    test('a product the ledger does not know is cached as such; a failing lookup keeps the old answer', async () => {
        const file = path.join(dir, 'dcl-products.json');
        const productInfoFor = jest.fn().mockResolvedValue(undefined);
        dcl._inject({ service: { infoFor: () => undefined, productInfoFor }, productsFile: file });
        expect(await dcl.product(1, 2)).toBeNull();
        expect(await dcl.product(1, 2)).toBeNull();
        expect(productInfoFor).toHaveBeenCalledTimes(1);
        expect((await dcl.deviceInfo({ vendorId: 1, productId: 2 })).productStatus).toBe('not in the ledger');

        productInfoFor.mockRejectedValueOnce(new Error('ECONNRESET'));
        expect(await dcl.product(3, 4)).toBeNull();
        expect((await dcl.deviceInfo({ vendorId: 3, productId: 4 })).productStatus).toBe('not in the ledger');
    });

    test('offline: the snapshot and the cache only, the ledger is never asked', async () => {
        jest.doMock(
            '@matter/dcl-data/node',
            () => ({
                vendors: () => ({
                    builtAt: '2026-10-18',
                    expectedCount: 1,
                    entries: (async function* () {
                        yield { vendorId: 4874, vendorName: 'IKEA of Sweden AB', companyPreferredName: 'IKEA' };
                    })(),
                }),
            }),
            { virtual: true },
        );
        jest.resetModules();
        dcl = require('../../src/matter/dcl');
        dcl._reset();
        await dcl.start({ env: null, storageDir: dir, log, offline: true });
        expect(dcl.vendorName(4874)).toBe('IKEA');
        const info = await dcl.deviceInfo({ vendorId: 4874, productId: 9 });
        expect(info).toMatchObject({ vendorId: 4874, productId: 9, vendorName: 'IKEA', product: null, offline: true, live: false, productStatus: 'offline — not cached' });
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('DCL access is off'));
    });

    test('start survives a missing snapshot and a broken service constructor', async () => {
        jest.doMock(
            '@matter/dcl-data/node',
            () => {
                throw new Error('ERR_REQUIRE_ESM');
            },
            { virtual: true },
        );
        jest.doMock('@matter/protocol', () => ({
            DclVendorInfoService: class {
                constructor() {
                    throw new Error('no storage');
                }
            },
        }));
        jest.doMock('@matter/general', () => ({ Days: { one: 1 } }));
        jest.resetModules();
        dcl = require('../../src/matter/dcl');
        dcl._reset();
        await expect(dcl.start({ env: {}, storageDir: dir, log })).resolves.toBeUndefined();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('snapshot not available'));
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not started'));
        expect((await dcl.deviceInfo({ vendorId: 1, productId: 1 })).productStatus).toBe('ledger not reachable yet');
    });
});
