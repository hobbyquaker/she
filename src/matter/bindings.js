'use strict';

/**
 * Matter bindings — the pure half (roadmap M13): what to write into a target's Access Control
 * list and a source's Binding list so that the source may drive the target directly, and the
 * guard that keeps she's own Administer entry in every ACL it writes. No I/O here; the controller
 * reads and writes the attributes and calls these functions in between.
 *
 * Two independent clusters make a binding (Matter core spec 9.10 and 9.6):
 *   - the target's Access Control list (endpoint 0, cluster 0x001F) must grant the source node
 *     the Operate privilege on the bound cluster/endpoint — else the target refuses the command;
 *   - the source's Binding list (its endpoint, cluster 0x001E) names the targets it sends to.
 * Both are fabric-scoped lists: a write replaces this fabric's entries wholesale, so every write
 * goes through the guard below.
 */

const PRIVILEGE = { view: 1, proxyView: 2, operate: 3, manage: 4, administer: 5 };
const AUTH_MODE = { pase: 1, case: 2, group: 3 };

const BINDING_CLUSTER_ID = 0x001e;
const ACCESS_CONTROL_CLUSTER_ID = 0x001f;
const SWITCH_CLUSTER_ID = 0x003b;

/** The clusters a binding may carry, with the plain words the UI uses. */
const BINDABLE_CLUSTERS = {
    onOff: { id: 0x0006, label: 'on/off' },
    levelControl: { id: 0x0008, label: 'dimming' },
    colorControl: { id: 0x0300, label: 'colour' },
    windowCovering: { id: 0x0102, label: 'blinds' },
    thermostat: { id: 0x0201, label: 'thermostat' },
    fanControl: { id: 0x0202, label: 'fan' },
    doorLock: { id: 0x0101, label: 'lock' },
};

/** Device types whose endpoints are built to be binding sources (Matter device library). */
const SOURCE_DEVICE_TYPES = {
    0x0103: 'On/Off Light Switch',
    0x0104: 'Dimmer Switch',
    0x0105: 'Color Dimmer Switch',
    0x0203: 'Window Covering Controller',
    0x000b: 'Door Lock Controller',
    0x0018: 'Pump Controller',
    0x0017: 'Control Bridge',
};
const GENERIC_SWITCH_DEVICE_TYPE = 0x000f;

/** Defaults the specification guarantees when a device does not report its limits. */
const DEFAULT_LIMITS = { subjectsPerAccessControlEntry: 4, targetsPerAccessControlEntry: 3, accessControlEntriesPerFabric: 4 };

function clusterIdOf(cluster) {
    if (typeof cluster === 'number') return cluster;
    const known = BINDABLE_CLUSTERS[cluster];
    if (known) return known.id;
    const n = Number(cluster);
    if (Number.isFinite(n)) return n;
    throw new Error(`Unknown cluster "${cluster}"`);
}

function clusterNameOf(id) {
    for (const [name, def] of Object.entries(BINDABLE_CLUSTERS)) if (def.id === id) return name;
    return null;
}

function sameId(a, b) {
    if (a === undefined || a === null || b === undefined || b === null) return false;
    return String(a) === String(b);
}

/** she's own Administer entry on a device: CASE, privilege 5, subjects containing she's node ID. */
function findAdminEntry(acl, sheNodeId) {
    return (acl ?? []).find((e) => e && e.privilege === PRIVILEGE.administer && e.authMode === AUTH_MODE.case && (e.subjects ?? []).some((s) => sameId(s, sheNodeId))) ?? null;
}

/**
 * The guard: an ACL list is written only when it still carries she's own Administer entry —
 * without it the device would refuse every further interaction from she, and only a factory
 * reset brings it back.
 */
function assertSafeAcl(acl, sheNodeId) {
    if (!Array.isArray(acl)) throw new Error('ACL is not a list');
    if (!findAdminEntry(acl, sheNodeId)) {
        throw new Error(`refusing to write an ACL without she's own Administer entry (node ${sheNodeId}) — she would lock itself out of the device`);
    }
}

/**
 * Entries she manages for bindings and groups: Operate, the auth mode (CASE for a source node,
 * Group for a group ID), exactly one subject, explicit targets.
 */
function isOperateEntryFor(entry, subject, authMode = AUTH_MODE.case) {
    return (
        !!entry &&
        entry.privilege === PRIVILEGE.operate &&
        entry.authMode === authMode &&
        Array.isArray(entry.subjects) &&
        entry.subjects.length === 1 &&
        sameId(entry.subjects[0], subject) &&
        Array.isArray(entry.targets)
    );
}

function targetMatches(t, endpoint, clusterId) {
    return !!t && sameId(t.cluster, clusterId) && sameId(t.endpoint, endpoint);
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
 * Grant the source node Operate on the target endpoint's clusters. Returns the new ACL list (the
 * input is not modified). Extends she's own Operate entry for that source when one exists and has
 * room, else adds an entry; refuses when the device's limits would be exceeded.
 *
 * @param {object[]} acl           the target's ACL entries of she's fabric, as read
 * @param {{ subject: bigint|number|string, endpoint: number, clusters: (number|string)[], sheNodeId: bigint|number|string, limits?: object, fabricIndex?: number }} opts
 * @returns {object[]}
 */
function grantOperate(acl, { subject, endpoint, clusters, sheNodeId, limits, fabricIndex, authMode = AUTH_MODE.case }) {
    assertSafeAcl(acl, sheNodeId);
    const lim = effectiveLimits(limits);
    const out = acl.map((e) => ({ ...e, subjects: e.subjects ? [...e.subjects] : e.subjects, targets: e.targets ? e.targets.map((t) => ({ ...t })) : e.targets }));
    const wanted = clusters.map(clusterIdOf).filter((id, i, arr) => arr.indexOf(id) === i);
    const missing = wanted.filter((id) => !out.some((e) => isOperateEntryFor(e, subject, authMode) && e.targets.some((t) => targetMatches(t, endpoint, id))));
    if (missing.length === 0) return out;
    const fi = fabricIndex ?? findAdminEntry(acl, sheNodeId).fabricIndex;
    for (const id of missing) {
        const target = { cluster: id, endpoint: Number(endpoint), deviceType: null };
        const room = out.find((e) => isOperateEntryFor(e, subject, authMode) && e.targets.length < lim.targetsPerAccessControlEntry);
        if (room) {
            room.targets.push(target);
            continue;
        }
        if (out.length >= lim.accessControlEntriesPerFabric) {
            throw new Error(`the device allows only ${lim.accessControlEntriesPerFabric} access control entries per fabric and all are in use`);
        }
        const entry = { privilege: PRIVILEGE.operate, authMode, subjects: [typeof subject === 'bigint' ? subject : BigInt(subject)], targets: [target] };
        if (fi !== undefined) entry.fabricIndex = fi;
        out.push(entry);
    }
    return out;
}

/**
 * Take the Operate grant for the given endpoint/clusters away from the source node — only from
 * entries she manages (Operate, CASE, that one subject). An entry left without targets is dropped.
 * Returns the new ACL list.
 */
function revokeOperate(acl, { subject, endpoint, clusters, sheNodeId, authMode = AUTH_MODE.case }) {
    assertSafeAcl(acl, sheNodeId);
    const ids = clusters.map(clusterIdOf);
    const out = [];
    for (const e of acl) {
        if (!isOperateEntryFor(e, subject, authMode)) {
            out.push(e);
            continue;
        }
        const targets = e.targets.filter((t) => !ids.some((id) => targetMatches(t, endpoint, id)));
        if (targets.length > 0) out.push({ ...e, targets });
    }
    return out;
}

/** Which clusters of target endpoint the source node is granted Operate on (by she's entries). */
function grantedClusters(acl, { subject, endpoint, authMode = AUTH_MODE.case }) {
    const ids = new Set();
    for (const e of acl ?? []) {
        if (!isOperateEntryFor(e, subject, authMode)) continue;
        for (const t of e.targets) if (sameId(t.endpoint, endpoint) && t.cluster !== null && t.cluster !== undefined) ids.add(Number(t.cluster));
    }
    return [...ids];
}

function bindingEntryMatches(b, { node, group, endpoint, cluster }) {
    if (!b || !sameId(b.cluster, cluster)) return false;
    if (group !== undefined && group !== null) return sameId(b.group, group) && (b.node === undefined || b.node === null);
    return sameId(b.node, node) && sameId(b.endpoint, endpoint);
}

/**
 * Append unicast binding entries `{ node, endpoint, cluster }` for the clusters not bound yet.
 * Returns the new list (and which clusters were added).
 */
function addBindingEntries(bindings, { node, group, endpoint, clusters, fabricIndex }) {
    const out = (bindings ?? []).map((b) => ({ ...b }));
    const added = [];
    const isGroup = group !== undefined && group !== null;
    for (const c of clusters) {
        const cluster = clusterIdOf(c);
        if (out.some((b) => bindingEntryMatches(b, { node, group, endpoint, cluster }))) continue;
        const entry = isGroup ? { group: Number(group), cluster } : { node: typeof node === 'bigint' ? node : BigInt(node), endpoint: Number(endpoint), cluster };
        if (fabricIndex !== undefined) entry.fabricIndex = fabricIndex;
        out.push(entry);
        added.push(cluster);
    }
    return { bindings: out, added };
}

/** Remove the unicast binding entries for the clusters; returns the new list and which clusters were removed. */
function removeBindingEntries(bindings, { node, group, endpoint, clusters }) {
    const ids = clusters.map(clusterIdOf);
    const removed = [];
    const out = (bindings ?? []).filter((b) => {
        const hit = ids.find((cluster) => bindingEntryMatches(b, { node, group, endpoint, cluster }));
        if (hit === undefined) return true;
        removed.push(hit);
        return false;
    });
    return { bindings: out, removed };
}

/** The clusters of `{ node, endpoint }` that other entries of the list still bind — their ACL grant must stay. */
function clustersStillBound(bindings, { node, group, endpoint }) {
    const ids = new Set();
    const isGroup = group !== undefined && group !== null;
    for (const b of bindings ?? []) {
        if (b.cluster === undefined || b.cluster === null) continue;
        const hit = isGroup ? sameId(b.group, group) : sameId(b.node, node) && sameId(b.endpoint, endpoint);
        if (hit) ids.add(Number(b.cluster));
    }
    return [...ids];
}

/** Does the source still bind anything to the group (its key set must stay)? */
function groupStillBound(bindings, group) {
    return (bindings ?? []).some((b) => sameId(b.group, group));
}

/**
 * Classify the endpoints of the commissioned nodes into binding sources and targets.
 *
 * @param {{ nodeId: string, name: string|null, online: boolean, endpoints: { endpointId: number, name: string|null, deviceTypes: number[], serverList: number[], clientList: number[] }[] }[]} nodes
 * @returns {{ sources: object[], targets: object[], notBindable: object[] }}
 */
function classifyEndpoints(nodes) {
    const sources = [];
    const targets = [];
    const notBindable = [];
    for (const node of nodes) {
        for (const ep of node.endpoints) {
            if (ep.endpointId === 0) continue;
            const servers = (ep.serverList ?? []).map(Number);
            const clients = (ep.clientList ?? []).map(Number);
            const base = { nodeId: node.nodeId, nodeName: node.name, online: node.online, endpointId: ep.endpointId, name: ep.name, deviceTypes: ep.deviceTypes ?? [] };
            const serverClusters = Object.entries(BINDABLE_CLUSTERS)
                .filter(([, def]) => servers.includes(def.id))
                .map(([name, def]) => ({ name, id: def.id, label: def.label }));
            if (serverClusters.length) targets.push({ ...base, clusters: serverClusters });
            const clientClusters = Object.entries(BINDABLE_CLUSTERS)
                .filter(([, def]) => clients.includes(def.id))
                .map(([name, def]) => ({ name, id: def.id, label: def.label }));
            if (servers.includes(BINDING_CLUSTER_ID) && clientClusters.length) {
                sources.push({ ...base, clusters: clientClusters, deviceTypeName: (ep.deviceTypes ?? []).map((t) => SOURCE_DEVICE_TYPES[t]).find(Boolean) ?? null });
            } else if (servers.includes(SWITCH_CLUSTER_ID) || (ep.deviceTypes ?? []).includes(GENERIC_SWITCH_DEVICE_TYPE)) {
                notBindable.push({ ...base, reason: 'sends button events only (Generic Switch) — bind it with a script, see she.matter.sub' });
            } else if (servers.includes(BINDING_CLUSTER_ID) && !clientClusters.length && !serverClusters.length) {
                notBindable.push({ ...base, reason: 'has a Binding cluster but no client cluster she can bind (On/Off, Level Control, …)' });
            }
        }
    }
    return { sources, targets, notBindable };
}

module.exports = {
    PRIVILEGE,
    AUTH_MODE,
    BINDING_CLUSTER_ID,
    ACCESS_CONTROL_CLUSTER_ID,
    SWITCH_CLUSTER_ID,
    BINDABLE_CLUSTERS,
    SOURCE_DEVICE_TYPES,
    DEFAULT_LIMITS,
    clusterIdOf,
    clusterNameOf,
    sameId,
    findAdminEntry,
    assertSafeAcl,
    grantOperate,
    revokeOperate,
    grantedClusters,
    addBindingEntries,
    removeBindingEntries,
    clustersStillBound,
    groupStillBound,
    classifyEndpoints,
};
