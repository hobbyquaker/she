'use strict';

/**
 * Matter groups — the pure half and the store (roadmap M23): she's groups (name, members, which
 * key set), the key sets (16-byte epoch keys, kept encrypted at rest with the secrets store's key,
 * never logged or shown), and the helpers the controller uses to provision a member device.
 *
 * Matter's group model: a group ID (application range 0x0001 … 0xFEFF) is tied to a group key
 * set in every member's Group Key Management cluster (`groupKeyMap`), the key set itself is
 * written with `KeySetWrite`, the member endpoint joins with Groups `AddGroup`, and an ACL entry
 * with auth mode Group grants the group the Operate privilege on the endpoint. The controller
 * registers the same key set and map in its own fabric so it can send group messages.
 */

const crypto = require('crypto');
const path = require('path');

const GROUP_ID_MIN = 0x0001;
const GROUP_ID_MAX = 0xfeff;
const KEY_SET_ID_MIN = 1; // 0 is the IPK
const KEY_SET_ID_MAX = 0xffff;
const SHARED_KEY_SET_ID = 1;
const GROUP_NAME_MAX = 16; // Groups cluster: GroupName is max 16 bytes

const SECURITY_POLICY = { trustFirst: 0, cacheAndSync: 1 };
const MULTICAST_POLICY = { perGroupId: 0, allNodes: 1 };

/** Defaults the specification guarantees when a device does not report its limits. */
const DEFAULT_LIMITS = { maxGroupsPerFabric: 4, maxGroupKeysPerFabric: 3 };

function validName(name) {
    return typeof name === 'string' && name.trim().length > 0 && Buffer.byteLength(name.trim(), 'utf8') <= GROUP_NAME_MAX;
}

function nextGroupId(groups) {
    const used = new Set((groups ?? []).map((g) => Number(g.id)));
    for (let id = GROUP_ID_MIN; id <= GROUP_ID_MAX; id++) if (!used.has(id)) return id;
    throw new Error('no free group id');
}

function nextKeySetId(keySets) {
    const used = new Set(Object.values(keySets ?? {}).map((k) => Number(k.id)));
    for (let id = KEY_SET_ID_MIN; id <= KEY_SET_ID_MAX; id++) if (!used.has(id)) return id;
    throw new Error('no free key set id');
}

/** A fresh key set: one epoch key, Unix-epoch microseconds start time, TrustFirst. */
function newKeySet(id, { name = '', shared = false } = {}) {
    return {
        id: Number(id),
        name,
        shared: !!shared,
        epochKey: crypto.randomBytes(16).toString('hex'),
        epochStartTime: (BigInt(Date.now()) * 1000n).toString(),
        securityPolicy: SECURITY_POLICY.trustFirst,
        multicastPolicy: MULTICAST_POLICY.perGroupId,
        created: Date.now(),
    };
}

/** The GroupKeySetStruct for KeySetWrite and for the controller fabric's registration. */
function groupKeySetStruct(ks) {
    return {
        groupKeySetId: Number(ks.id),
        groupKeySecurityPolicy: Number(ks.securityPolicy ?? SECURITY_POLICY.trustFirst),
        epochKey0: Buffer.from(ks.epochKey, 'hex'),
        epochStartTime0: BigInt(ks.epochStartTime),
        epochKey1: null,
        epochStartTime1: null,
        epochKey2: null,
        epochStartTime2: null,
        groupKeyMulticastPolicy: Number(ks.multicastPolicy ?? MULTICAST_POLICY.perGroupId),
    };
}

/** What the API and the UI may see of a key set: never the key. */
function publicKeySet(ks) {
    return { id: Number(ks.id), name: ks.name ?? '', shared: !!ks.shared, created: ks.created ?? null };
}

function sameId(a, b) {
    return a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);
}

/** Add `{ groupId, groupKeySetId }` to a device's groupKeyMap list unless present; returns the new list. */
function groupKeyMapAdd(list, { groupId, keySetId, fabricIndex }) {
    const out = (list ?? []).map((e) => ({ ...e }));
    if (out.some((e) => sameId(e.groupId, groupId))) {
        return out.map((e) => (sameId(e.groupId, groupId) ? { ...e, groupKeySetId: Number(keySetId) } : e));
    }
    const entry = { groupId: Number(groupId), groupKeySetId: Number(keySetId) };
    if (fabricIndex !== undefined) entry.fabricIndex = fabricIndex;
    out.push(entry);
    return out;
}

/** Remove the group's entry from a groupKeyMap list; returns the new list. */
function groupKeyMapRemove(list, groupId) {
    return (list ?? []).filter((e) => !sameId(e.groupId, groupId));
}

/** Is the key set still referenced by an entry of the map (another group on that device)? */
function keySetStillMapped(list, keySetId) {
    return (list ?? []).some((e) => sameId(e.groupKeySetId, keySetId));
}

function effectiveLimits(limits) {
    const out = { ...DEFAULT_LIMITS };
    for (const k of Object.keys(DEFAULT_LIMITS)) {
        const v = Number(limits?.[k]);
        if (Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
}

/**
 * Check a device's limits before provisioning: the key set count (the IPK counts) and the group
 * count of she's fabric must stay within what the device reports.
 * @param {{ keySetsOnDevice: number, keySetIsNew: boolean, groupsOnDevice: number, groupIsNew: boolean, limits?: object }} o
 */
function assertWithinLimits({ keySetsOnDevice, keySetIsNew, groupsOnDevice, groupIsNew, limits }) {
    const lim = effectiveLimits(limits);
    if (keySetIsNew && keySetsOnDevice + 1 > lim.maxGroupKeysPerFabric) {
        throw new Error(`the device holds at most ${lim.maxGroupKeysPerFabric} group key sets per fabric (the fabric's IPK counts) and all are in use — use the shared key set`);
    }
    if (groupIsNew && groupsOnDevice + 1 > lim.maxGroupsPerFabric) {
        throw new Error(`the device holds at most ${lim.maxGroupsPerFabric} groups per fabric and all are in use`);
    }
}

/**
 * The group's state from its members' attributes: on (all / some / none), the average level.
 * @param {{ onOff?: boolean|null, level?: number|null }[]} states
 */
function derivedState(states) {
    const on = states.map((s) => s.onOff).filter((v) => typeof v === 'boolean');
    const levels = states.map((s) => s.level).filter((v) => typeof v === 'number' && Number.isFinite(v));
    let onState = null;
    if (on.length) onState = on.every(Boolean) ? 'all' : on.some(Boolean) ? 'some' : 'none';
    return {
        on: onState,
        onCount: on.filter(Boolean).length,
        memberCount: states.length,
        level: levels.length ? Math.round(levels.reduce((a, b) => a + b, 0) / levels.length) : null,
    };
}

// ── The store ─────────────────────────────────────────────────────────────────

const EMPTY = () => ({ v: 1, keySets: {}, groups: [] });

function fileFor(storageDir) {
    return path.join(storageDir, 'groups.enc');
}

/** Read the store; a missing file is an empty store. Throws when the file cannot be decrypted. */
function readStore(storageDir) {
    const { readEncryptedFile } = require('../lib/secrets');
    const data = readEncryptedFile(fileFor(storageDir));
    if (!data || typeof data !== 'object') return EMPTY();
    return { v: 1, keySets: data.keySets ?? {}, groups: Array.isArray(data.groups) ? data.groups : [] };
}

function writeStore(storageDir, store) {
    const { writeEncryptedFile } = require('../lib/secrets');
    writeEncryptedFile(fileFor(storageDir), { v: 1, keySets: store.keySets, groups: store.groups });
}

module.exports = {
    GROUP_ID_MIN,
    GROUP_ID_MAX,
    SHARED_KEY_SET_ID,
    GROUP_NAME_MAX,
    SECURITY_POLICY,
    MULTICAST_POLICY,
    DEFAULT_LIMITS,
    validName,
    nextGroupId,
    nextKeySetId,
    newKeySet,
    groupKeySetStruct,
    publicKeySet,
    groupKeyMapAdd,
    groupKeyMapRemove,
    keySetStillMapped,
    assertWithinLimits,
    derivedState,
    readStore,
    writeStore,
    fileFor,
    EMPTY,
};
