'use strict';

/**
 * Device discovery (roadmap I13): shaping what an adapter's `--discover --discover-json` printed
 * into what the Add-instance UI needs.
 *
 * The adapter owns the scanning (mqtt-interfaces-core 0.9 `lib/discovery.js`: SSDP, mDNS/DNS-SD,
 * UDP probes, port probes, subnet sweeps, ARP/OUI, USB serial ports). This module never scans —
 * it validates the JSON that came back over the helper, decides what goes into the config, and
 * proposes an instance name.
 *
 * Everything here treats its input as hostile: it was printed by a device on the network that
 * answered a broadcast, and it ends up in a config file, a systemd unit name and an MQTT topic.
 */

/** Fields of a core discovery entry we pass on, with the maximum length we keep of each. */
const STRING_FIELDS = {
    address: 128,
    fqdn: 253,
    hostname: 63,
    name: 120,
    model: 120,
    type: 120,
    serial: 120,
    version: 60,
    id: 253, // serial: the /dev/serial/by-id name
    device: 253, // serial: the /dev/tty* the by-id name points at
    udn: 120,
};

/** Instance names are topic prefixes, systemd instances and file names all at once. */
const INSTANCE_RE = /^[A-Za-z0-9_.-]+$/;
const MAX_NAME = 32;

/** German first, then whatever else NFKD can strip an accent off. */
const TRANSLITERATE = [
    [/ä/g, 'ae'],
    [/ö/g, 'oe'],
    [/ü/g, 'ue'],
    [/Ä/g, 'Ae'],
    [/Ö/g, 'Oe'],
    [/Ü/g, 'Ue'],
    [/ß/g, 'ss'],
];

function cleanString(value, max) {
    if (typeof value !== 'string') return null;
    // control characters would break the log line and the terminal of whoever cats the env file
    // eslint-disable-next-line no-control-regex
    const stripped = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return stripped ? stripped.slice(0, max) : null;
}

/**
 * Turn a device's own name into something usable as an instance name.
 * "Küche Oben" → "kueche-oben". Returns null when nothing usable is left.
 * @param {string} value the name the device answers with
 * @returns {string|null}
 */
function slugName(value) {
    const cleaned = cleanString(value, 200);
    if (!cleaned) return null;
    let out = cleaned;
    for (const [re, replacement] of TRANSLITERATE) out = out.replace(re, replacement);
    out = out
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '') // the accents NFKD just split off
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[-._]+|[-._]+$/g, '')
        .slice(0, MAX_NAME)
        .replace(/[-._]+$/, ''); // the slice may have ended on a separator
    // all digits would be a uuid or a serial rather than a name, and reads like an index
    if (!out || !INSTANCE_RE.test(out) || /^[0-9]+$/.test(out)) return null;
    return out;
}

/**
 * A name not taken yet, suffixed `-2`, `-3`, … Instance names are MQTT topic prefixes, so the
 * set to avoid is every instance she knows of — any adapter, any host — not just this adapter's.
 * @param {string} base
 * @param {Set<string>} taken lower-cased names already in use
 * @returns {string}
 */
function uniqueName(base, taken) {
    if (!taken.has(base)) return base;
    for (let n = 2; n < 100; n++) {
        const stem = base.slice(0, MAX_NAME - String(n).length - 1).replace(/[-._]+$/, '');
        const candidate = `${stem}-${n}`;
        if (!taken.has(candidate)) return candidate;
    }
    return base;
}

/**
 * The value that goes into the config: the qualified name when DNS knows the device, its address
 * otherwise — the same choice `--<option> auto` makes in the core, and for the same reason, a
 * name outlives a DHCP lease. The short hostname is deliberately not used: it only resolves
 * through the search list of whoever asks. For a serial port the address *is* the by-id path.
 * @param {object} entry
 * @returns {string|null}
 */
function configValue(entry) {
    const fqdn = cleanString(entry.fqdn, STRING_FIELDS.fqdn);
    const address = cleanString(entry.address, STRING_FIELDS.address);
    return fqdn || address;
}

/**
 * Validate and shape the entries of `--discover-json`.
 *
 * @param {unknown} raw parsed JSON from the adapter
 * @param {object} [options]
 * @param {Set<string>|string[]} [options.taken] instance names already in use (any adapter, any host)
 * @param {Map<string,string>|object} [options.usedBy] configured value → instance using it
 * @param {string} [options.fallbackName] instance name to build on when a device has no name of its own
 * @param {number} [options.max] maximum number of devices returned (default 50)
 * @returns {Array<object>} devices, each `{value, suggestName, usedBy, sources, services, …}`
 */
function shapeDevices(raw, options = {}) {
    if (!Array.isArray(raw)) return [];
    const taken = new Set([...(options.taken ?? [])].map((n) => String(n).toLowerCase()));
    const usedBy = options.usedBy instanceof Map ? options.usedBy : new Map(Object.entries(options.usedBy ?? {}));
    const max = Number.isFinite(options.max) ? options.max : 50;
    const out = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const value = configValue(entry);
        if (!value) continue; // an entry we cannot configure anything with is of no use here
        const device = { value };
        for (const [field, maxLen] of Object.entries(STRING_FIELDS)) {
            const clean = cleanString(entry[field], maxLen);
            if (clean) device[field] = clean;
        }
        device.sources = Array.isArray(entry.sources)
            ? entry.sources
                  .map((s) => cleanString(s, 20))
                  .filter(Boolean)
                  .slice(0, 8)
            : [];
        device.services = {};
        if (entry.services && typeof entry.services === 'object' && !Array.isArray(entry.services)) {
            for (const [label, open] of Object.entries(entry.services).slice(0, 24)) {
                const clean = cleanString(label, 40);
                if (clean) device.services[clean] = open === true;
            }
        }
        // The name the *user* gave the device (core convention: `name`), not what it is
        // (`model`/`type`) — an instance name built from a model would repeat per device.
        const slug = slugName(entry.name) ?? (options.fallbackName ? slugName(options.fallbackName) : null);
        if (slug) {
            const unique = uniqueName(slug, taken);
            device.suggestName = unique;
            taken.add(unique); // two speakers both called "Küche" must not both propose kueche
        }
        // An instance may have been configured with any of the identifiers this device answers
        // to: the raw /dev/ttyACM0 rather than the by-id path, or the address before dns knew a
        // name for it. Matching only `value` would offer a stick that is already in use.
        device.usedBy = null;
        for (const identifier of [value, device.address, device.fqdn, device.hostname, device.device, device.id]) {
            if (identifier && usedBy.has(identifier)) {
                device.usedBy = usedBy.get(identifier);
                break;
            }
        }
        out.push(device);
        if (out.length >= max) break;
    }
    return out;
}

/**
 * The discovery kinds a schema asks for, from the `x-discover` marker the core sets on the one
 * property that takes what a scan finds (`ccu-address`, `serialport`, …).
 *
 * @param {object|null} schema a `--config-schema` document
 * @returns {{key: string, envName: string, kinds: string[]}|null} null when not discovery-capable
 */
function discoverTarget(schema) {
    const properties = schema && typeof schema === 'object' ? schema.properties : null;
    if (!properties || typeof properties !== 'object') return null;
    for (const [key, prop] of Object.entries(properties)) {
        if (!prop || typeof prop !== 'object' || prop['x-discover'] === undefined) continue;
        const raw = prop['x-discover'];
        // 'network' | 'serial' | both; `true` from a future core is treated as a network scan
        const kinds = (Array.isArray(raw) ? raw : [raw]).map((k) => (k === true ? 'network' : k)).filter((k) => k === 'network' || k === 'serial');
        if (kinds.length === 0) continue;
        return { key, envName: typeof prop['x-env'] === 'string' ? prop['x-env'] : null, kinds };
    }
    return null;
}

module.exports = { shapeDevices, slugName, uniqueName, configValue, discoverTarget, INSTANCE_RE, MAX_NAME };
