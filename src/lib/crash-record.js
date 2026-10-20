'use strict';

/**
 * Crash record for the safe-mode decision (roadmap A10). Safe mode — starting without any user
 * script — is the right answer to a script that kills the daemon at or shortly after load, where
 * every restart would fail the same way; it is the wrong answer to a crash after days of normal
 * operation, where systemd restarts the daemon and the house then runs without automation until
 * someone notices. So: a crash on its own is not a reason. Safe mode only when the crash repeats
 * and happens early.
 *
 * The sentinel `.she-running` carries `<pid> <startMs>`; a stale one at start tells when the dead
 * run began. The crash record `.she-crashes.json` next to it keeps the last few unclean runs. Pure
 * functions here; the daemon reads and writes the files.
 */

const fs = require('fs');

const DEFAULTS = Object.freeze({ earlyCrashSec: 300, crashCount: 3, windowSec: 1800 });
const KEEP = 10;

/** `<pid> <startMs>` (or the pre-A10 `<pid>` alone) → { pid, startMs }; null when unreadable. */
function parseSentinel(text) {
    const parts = String(text ?? '')
        .trim()
        .split(/\s+/);
    const pid = parseInt(parts[0], 10);
    if (!Number.isFinite(pid) || pid <= 0) return { pid: null, startMs: null };
    const startMs = parts.length > 1 ? parseInt(parts[1], 10) : NaN;
    return { pid, startMs: Number.isFinite(startMs) && startMs > 0 ? startMs : null };
}

function formatSentinel(pid, startMs) {
    return `${pid} ${startMs}\n`;
}

function readCrashes(file) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const list = Array.isArray(raw) ? raw : Array.isArray(raw?.crashes) ? raw.crashes : [];
        return list.filter((c) => c && typeof c === 'object' && Number.isFinite(c.end));
    } catch {
        return [];
    }
}

function writeCrashes(file, crashes) {
    try {
        if (!crashes.length) {
            fs.rmSync(file, { force: true });
            return;
        }
        fs.writeFileSync(file, JSON.stringify({ v: 1, crashes: crashes.slice(-KEEP) }) + '\n');
    } catch {
        /* a record that cannot be written costs at most one safe-mode decision */
    }
}

function fmtUptime(ms) {
    if (ms === null) return 'unknown uptime';
    const s = Math.round(ms / 1000);
    if (s < 120) return `${s} s`;
    const m = Math.round(s / 60);
    if (m < 120) return `${m} min`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h`;
    return `${Math.round(h / 24)} d`;
}

/**
 * The decision at a start that found a stale sentinel.
 *
 * @param {{ startMs: number|null }} dead   the dead run (from its sentinel; startMs null for a pre-A10 sentinel)
 * @param {{ start: number|null, end: number, early: boolean }[]} crashes  the record so far
 * @param {{ now?: number, earlyCrashSec?: number, crashCount?: number, windowSec?: number }} [opts]
 * @returns {{ safeMode: boolean, reason: string|null, crashes: object[], uptimeMs: number|null, early: boolean, message: string }}
 */
function evaluate(dead, crashes, opts = {}) {
    const now = opts.now ?? Date.now();
    const earlyMs = (opts.earlyCrashSec ?? DEFAULTS.earlyCrashSec) * 1000;
    const count = Math.max(1, opts.crashCount ?? DEFAULTS.crashCount);
    const windowMs = (opts.windowSec ?? DEFAULTS.windowSec) * 1000;
    const uptimeMs = dead?.startMs ? Math.max(0, now - dead.startMs) : null;
    // a dead run whose start is unknown (a sentinel from before this record) counts as early: that is
    // the case the detection was built for, and it happens once at most
    const early = uptimeMs === null || uptimeMs < earlyMs;
    const list = [...crashes, { start: dead?.startMs ?? null, end: now, early }].slice(-KEEP);
    const recent = list.slice(-count);
    const safeMode = early && recent.length >= count && recent.every((c) => c.early && now - c.end <= windowMs);
    let reason = null;
    let message;
    if (safeMode) {
        reason = `${count} crashes within ${fmtUptime(earlyMs)} of start (last ${fmtUptime(now - recent[0].end)})`;
        message = `the previous run was killed ${uptimeMs === null ? '' : 'after ' + fmtUptime(uptimeMs) + ' '}— the ${count}. early crash in a row`;
    } else if (early) {
        const n = list.filter((c, i) => i >= list.length - count && c.early && now - c.end <= windowMs).length;
        message = `the previous run was killed ${uptimeMs === null ? '(uptime unknown) ' : 'after ' + fmtUptime(uptimeMs) + ' '}— early crash ${n} of ${count} within ${fmtUptime(windowMs)}; starting normally`;
    } else {
        message = `the previous run was killed after ${fmtUptime(uptimeMs)} of uptime — not an early crash; starting normally`;
    }
    return { safeMode, reason, crashes: list, uptimeMs, early, message };
}

module.exports = { DEFAULTS, KEEP, parseSentinel, formatSentinel, readCrashes, writeCrashes, evaluate, fmtUptime };
