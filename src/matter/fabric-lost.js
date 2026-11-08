'use strict';

/**
 * A Matter node that no longer carries she's fabric.
 *
 * When a paired device is factory-reset, or another administrator removes she's fabric from it,
 * the device answers every CASE handshake with the status NoSharedTrustRoots: it does not know
 * she's root certificate any more and cannot come back without re-commissioning. matter.js has no
 * notion of this — it treats the answer as a peer error and retries every 5 minutes on every
 * address of the node, for ever (two thousand log lines a day for one dead node).
 *
 * This module keeps the state per node — how many NoSharedTrustRoots answers came in a row, when
 * the first one came, whether the node is paused, when it was last probed — and decides: a node is
 * `fabric_lost` after THRESHOLD consecutive answers; it is then paused (the controller disables
 * the ClientNode) and probed at most once per PROBE_INTERVAL_MS, for PROBE_WINDOW_MS each time.
 * The node coming online clears the state. `fabric-lost.json` in the Matter storage keeps it
 * across restarts (the pause itself is persisted by matter.js, in the node's network state).
 *
 * The controller feeds the tracker and acts on its verdicts; this file has no matter.js dependency
 * so the policy can be tested on its own.
 */

const fs = require('fs');

/** Consecutive NoSharedTrustRoots answers before a node counts as having lost the fabric. */
const THRESHOLD = 3;
/** A paused node is probed at most this often. */
const PROBE_INTERVAL_MS = 60 * 60 * 1000;
/** How long a probe lets the node try before it is paused again. */
const PROBE_WINDOW_MS = 2 * 60 * 1000;

/**
 * @param {{ file?: string | null, log?: { warn: Function, debug: Function } | null, threshold?: number, probeIntervalMs?: number }} [options]
 */
function createTracker({ file = null, log = null, threshold = THRESHOLD, probeIntervalMs = PROBE_INTERVAL_MS } = {}) {
    /** nodeId → { count, since, lastAt, paused, pausedAt, probes, lastProbeAt, probing } */
    let nodes = new Map();

    function load() {
        nodes = new Map();
        if (!file) return;
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (const [k, v] of Object.entries(raw.nodes ?? {})) {
                if (!v || typeof v !== 'object' || typeof v.since !== 'number') continue;
                nodes.set(k, {
                    count: v.count ?? threshold,
                    since: v.since,
                    lastAt: v.lastAt ?? v.since,
                    paused: v.paused === true,
                    pausedAt: v.pausedAt ?? null,
                    probes: v.probes ?? 0,
                    lastProbeAt: v.lastProbeAt ?? null,
                    probing: false,
                });
            }
        } catch (err) {
            if (err.code !== 'ENOENT') log?.warn(`matter fabric-lost: cannot read ${file}: ${err.message}`);
        }
    }

    function save() {
        if (!file) return;
        try {
            const out = {};
            for (const [k, v] of nodes) {
                const { probing: _p, ...rest } = v;
                out[k] = rest;
            }
            fs.writeFileSync(file + '.tmp', JSON.stringify({ v: 1, nodes: out }));
            fs.renameSync(file + '.tmp', file);
        } catch (err) {
            log?.warn(`matter fabric-lost: cannot write ${file}: ${err.message}`);
        }
    }

    function entry(nodeId) {
        let e = nodes.get(String(nodeId));
        if (!e) {
            e = { count: 0, since: null, lastAt: null, paused: false, pausedAt: null, probes: 0, lastProbeAt: null, probing: false };
            nodes.set(String(nodeId), e);
        }
        return e;
    }

    /**
     * One NoSharedTrustRoots answer from the node.
     * @returns {{ lost: boolean, justLost: boolean, count: number, since: number }}
     *   `lost` once the threshold is reached; `justLost` on the answer that reaches it; `since` the
     *   time of the first answer of the run.
     */
    function record(nodeId, now = Date.now()) {
        const e = entry(nodeId);
        const wasLost = e.count >= threshold;
        e.count++;
        e.lastAt = now;
        if (e.since === null) e.since = now;
        const lost = e.count >= threshold;
        if (lost) save();
        return { lost, justLost: lost && !wasLost, count: e.count, since: e.since };
    }

    function get(nodeId) {
        const e = nodes.get(String(nodeId));
        if (!e || e.count < threshold) return null;
        return {
            nodeId: String(nodeId),
            since: e.since,
            lastAt: e.lastAt,
            count: e.count,
            paused: e.paused,
            pausedAt: e.pausedAt,
            probes: e.probes,
            lastProbeAt: e.lastProbeAt,
            probing: e.probing,
        };
    }

    function isLost(nodeId) {
        return get(nodeId) !== null;
    }

    /** When the first NoSharedTrustRoots of the run came, or null when the node has not lost the fabric. */
    function since(nodeId) {
        return get(nodeId)?.since ?? null;
    }

    /** The controller has disabled the node. */
    function markPaused(nodeId, now = Date.now()) {
        const e = nodes.get(String(nodeId));
        if (!e || e.count < threshold) return;
        if (!e.paused) {
            e.paused = true;
            e.pausedAt = now;
        }
        e.probing = false;
        save();
    }

    /** The node answered properly again (or was forgotten): drop the state. Returns whether it was lost. */
    function clear(nodeId) {
        const e = nodes.get(String(nodeId));
        const wasLost = !!e && e.count >= threshold;
        if (e) {
            nodes.delete(String(nodeId));
            if (wasLost) save();
        }
        return wasLost;
    }

    /** The paused nodes whose probe is due: never probed since the pause, or the last probe older than the interval. */
    function dueProbes(now = Date.now()) {
        const due = [];
        for (const [id, e] of nodes) {
            if (e.count < threshold || !e.paused || e.probing) continue;
            const ref = e.lastProbeAt ?? e.pausedAt ?? e.since;
            if (ref === null || now - ref >= probeIntervalMs) due.push(id);
        }
        return due;
    }

    /** A probe starts: the node is enabled for a probe window. */
    function startProbe(nodeId, now = Date.now()) {
        const e = nodes.get(String(nodeId));
        if (!e) return;
        e.probing = true;
        e.probes++;
        e.lastProbeAt = now;
        save();
    }

    function isProbing(nodeId) {
        return nodes.get(String(nodeId))?.probing === true;
    }

    /** Every node that has lost the fabric. */
    function list() {
        const out = [];
        for (const id of nodes.keys()) {
            const v = get(id);
            if (v) out.push(v);
        }
        return out;
    }

    load();
    return { record, get, isLost, since, markPaused, clear, dueProbes, startProbe, isProbing, list, threshold, probeIntervalMs };
}

module.exports = { createTracker, THRESHOLD, PROBE_INTERVAL_MS, PROBE_WINDOW_MS };
