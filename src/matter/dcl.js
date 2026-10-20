'use strict';

/**
 * Device information from the CSA Distributed Compliance Ledger (roadmap M25): vendor names for
 * vendor IDs and product details (name, label, part number, product/manual/support URLs) for
 * vendor/product IDs — what a device reports about itself is often a placeholder.
 *
 * Built on matter.js: `DclVendorInfoService` keeps the vendor list in the Matter storage (seeded
 * from the `@matter/dcl-data` snapshot so names are there without network, refreshed from the
 * ledger daily) and fetches product models on demand. she caches the product models itself
 * (`dcl-products.json` next to the Matter storage, 30 days) so the device page works offline.
 *
 * `offline: true` (config `matterDclOffline`) never touches the network: vendors come from the
 * snapshot, products from the cache only.
 */

const fs = require('fs');
const path = require('path');

const PRODUCT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

let _log = null;
let _service = null;
let _offline = false;
let _seedVendors = new Map();
let _products = new Map(); // "vid:pid" → { info: object|null, fetchedAt: number }
let _productsFile = null;
let _inflight = new Map();

function _vendorFromSeed(e) {
    return {
        vendorId: Number(e.vendorId),
        vendorName: e.vendorName ?? null,
        companyLegalName: e.companyLegalName ?? null,
        companyPreferredName: e.companyPreferredName ?? null,
        vendorLandingPageUrl: e.vendorLandingPageUrl ?? e.vendorLandingPageURL ?? null,
    };
}

/**
 * The vendor snapshot from `@matter/dcl-data` (an ESM package — `require()` loads it on Node 20.19,
 * 22.12 and later; older Nodes get no snapshot and a warning): a SeedSource, or null.
 */
function _loadSeed() {
    try {
        const mod = require('@matter/dcl-data/node');
        return mod.vendors();
    } catch (err) {
        _log?.warn(`matter: DCL vendor snapshot not available: ${String(err.message).split('\n')[0]}`);
        return null;
    }
}

function _loadProducts() {
    _products = new Map();
    if (!_productsFile) return;
    try {
        const raw = JSON.parse(fs.readFileSync(_productsFile, 'utf8'));
        for (const [k, v] of Object.entries(raw)) if (v && typeof v === 'object') _products.set(k, v);
    } catch (err) {
        if (err.code !== 'ENOENT') _log?.warn(`matter: cannot read ${_productsFile}: ${err.message}`);
    }
}

function _saveProducts() {
    if (!_productsFile) return;
    try {
        const tmp = _productsFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(_products), null, 1));
        fs.renameSync(tmp, _productsFile);
    } catch (err) {
        _log?.warn(`matter: cannot write ${_productsFile}: ${err.message}`);
    }
}

/**
 * Start the DCL layer. Never throws — without the ledger the device page shows what the device
 * reports.
 *
 * @param {{ env: object, storageDir: string, log: object, offline?: boolean }} opts
 *   env: the matter.js Environment of the controller node (its StorageService holds the vendor list)
 */
async function start({ env, storageDir, log, offline = false }) {
    _log = log;
    _offline = !!offline;
    _productsFile = storageDir ? path.join(storageDir, 'dcl-products.json') : null;
    _loadProducts();
    const seed = _loadSeed();
    if (seed) {
        try {
            for await (const e of seed.entries) _seedVendors.set(Number(e.vendorId), _vendorFromSeed(e));
            _log?.info(`matter: DCL vendor snapshot loaded (${_seedVendors.size} vendors, built ${seed.builtAt})`);
        } catch (err) {
            _log?.warn(`matter: reading the DCL vendor snapshot failed: ${err.message}`);
        }
    }
    if (_offline) {
        _log?.info('matter: DCL access is off (matterDclOffline) — vendor names from the snapshot, products from the cache');
        return;
    }
    if (!env) return;
    try {
        const { DclVendorInfoService } = require('@matter/protocol');
        const { Days } = require('@matter/general');
        const service = new DclVendorInfoService(env, {
            updateInterval: Days.one,
            ...(seed ? { seed: { vendors: seed } } : {}),
        });
        // construction fetches from the ledger — do not hold the controller start for it
        service.construction.then(
            () => {
                _service = service;
                _log?.info(`matter: DCL vendor information ready (${service.vendors.size} vendors)`);
            },
            (err) => _log?.warn(`matter: DCL vendor information service failed: ${err.message}`),
        );
    } catch (err) {
        _log?.warn(`matter: DCL vendor information service not started: ${err.message}`);
    }
}

async function close() {
    const s = _service;
    _service = null;
    _inflight = new Map();
    if (s) {
        try {
            await s.close();
        } catch {
            /* closing */
        }
    }
}

/** Vendor details for a vendor ID from the live service, else the snapshot; null when unknown. */
function vendor(vendorId) {
    const id = Number(vendorId);
    if (!Number.isFinite(id)) return null;
    if (_service) {
        try {
            const v = _service.infoFor(id);
            if (v) return _vendorFromSeed(v);
        } catch {
            /* not constructed yet */
        }
    }
    return _seedVendors.get(id) ?? null;
}

/** The name to show for a vendor ID: the preferred company name, the vendor name, or null. */
function vendorName(vendorId) {
    const v = vendor(vendorId);
    return v ? v.companyPreferredName || v.vendorName || v.companyLegalName || null : null;
}

function _withTimeout(promise, ms) {
    let t;
    return Promise.race([promise, new Promise((_r, reject) => (t = setTimeout(() => reject(new Error(`DCL request timed out after ${ms} ms`)), ms)))]).finally(() =>
        clearTimeout(t),
    );
}

/**
 * Product details for vendor/product ID: from the cache (30 days), else from the ledger (and
 * cached, also a "not in the ledger" answer). Offline: the cache only. Returns null when unknown.
 */
async function product(vendorId, productId) {
    const vid = Number(vendorId);
    const pid = Number(productId);
    if (!Number.isFinite(vid) || !Number.isFinite(pid)) return null;
    const key = `${vid}:${pid}`;
    const cached = _products.get(key);
    const fresh = cached && Date.now() - (cached.fetchedAt ?? 0) < PRODUCT_TTL_MS;
    if (fresh || _offline || !_service) return cached?.info ?? null;
    if (_inflight.has(key)) return _inflight.get(key);
    const p = (async () => {
        try {
            const info = await _withTimeout(_service.productInfoFor(vid, pid), FETCH_TIMEOUT_MS);
            const entry = {
                info: info
                    ? {
                          productName: info.productName ?? null,
                          productLabel: info.productLabel ?? null,
                          partNumber: info.partNumber ?? null,
                          deviceTypeId: info.deviceTypeID === undefined ? null : Number(info.deviceTypeID),
                          productUrl: info.productUrl ?? null,
                          userManualUrl: info.userManualUrl ?? null,
                          supportUrl: info.supportUrl ?? null,
                          commissioningFallbackUrl: info.commissioningFallbackUrl ?? null,
                      }
                    : null,
                fetchedAt: Date.now(),
            };
            _products.set(key, entry);
            _saveProducts();
            return entry.info;
        } catch (err) {
            _log?.debug(`matter: DCL product lookup ${key} failed: ${err.message}`);
            return cached?.info ?? null;
        } finally {
            _inflight.delete(key);
        }
    })();
    _inflight.set(key, p);
    return p;
}

/**
 * Everything the device page shows under "Product (CSA ledger)" for a node's basic information.
 * @param {{ vendorId?: number, productId?: number }} basic  basicInformation of the root endpoint
 */
async function deviceInfo(basic) {
    const vid = basic?.vendorId;
    const pid = basic?.productId;
    const v = vendor(vid);
    const p = await product(vid, pid);
    const cached = Number.isFinite(Number(vid)) && Number.isFinite(Number(pid)) ? _products.get(`${Number(vid)}:${Number(pid)}`) : undefined;
    return {
        vendorId: vid === undefined ? null : Number(vid),
        productId: pid === undefined ? null : Number(pid),
        vendor: v,
        vendorName: vendorName(vid),
        product: p,
        productStatus: p ? 'found' : cached ? 'not in the ledger' : _offline ? 'offline — not cached' : _service ? 'not in the ledger' : 'ledger not reachable yet',
        fetchedAt: cached?.fetchedAt ?? null,
        offline: _offline,
        live: !!_service,
    };
}

/** Test hook. */
function _reset() {
    _service = null;
    _offline = false;
    _seedVendors = new Map();
    _products = new Map();
    _productsFile = null;
    _inflight = new Map();
}

/** Test hook: inject a fake service / seed. */
function _inject({ service, seedVendors, productsFile } = {}) {
    if (service !== undefined) _service = service;
    if (seedVendors) _seedVendors = new Map(seedVendors.map((v) => [Number(v.vendorId), _vendorFromSeed(v)]));
    if (productsFile !== undefined) {
        _productsFile = productsFile;
        _loadProducts();
    }
}

module.exports = { start, close, vendor, vendorName, product, deviceInfo, _reset, _inject, PRODUCT_TTL_MS };
