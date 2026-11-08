/** Formatting shared by the Runtime page and the editor's Runtime panel. */

/** 1500 → "1.5 s", 65000 → "1m 05s", 3700000 → "1h 01m", 90000000 → "1d 1h" */
export function fmtDuration(ms: number): string {
    if (!Number.isFinite(ms)) return '—';
    if (ms < 0) ms = 0;
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
}

/** A callback duration: 0.123 → "0.12 ms", 12.3 → "12 ms", 1234 → "1.2 s" */
export function fmtMs(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
    if (ms >= 10) return `${Math.round(ms)} ms`;
    if (ms >= 1) return `${ms.toFixed(1)} ms`;
    return `${ms.toFixed(2)} ms`;
}

/** "3 s ago", "2m ago", "—" when never */
export function fmtAgo(ts: number | null | undefined, now: number): string {
    if (!ts) return '—';
    const d = now - ts;
    if (d < 1000) return 'now';
    return fmtDuration(d).replace(/ \d\ds$/, '') + ' ago';
}

/** "in 3m 12s" for a future time, "due" when it passed */
export function fmtIn(ts: number | null | undefined, now: number): string {
    if (!ts) return '—';
    const d = ts - now;
    if (d <= 0) return 'due';
    return 'in ' + fmtDuration(d);
}

/** The wall-clock time of a timestamp: "14:05:09", with the date when it is not today */
export function fmtClock(ts: number | null | undefined): string {
    if (!ts) return '—';
    const d = new Date(ts);
    const time = d.toTimeString().slice(0, 8);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return time;
    return `${d.getDate()}.${d.getMonth() + 1}. ${time}`;
}

/** 0…1 of a pending timer's countdown */
export function progressOf(start: number, due: number, now: number): number {
    const span = due - start;
    if (span <= 0) return 1;
    return Math.min(1, Math.max(0, (now - start) / span));
}

/** "4h 12m" uptime from a start timestamp */
export function fmtUptime(startedAt: number | undefined, now: number): string {
    if (!startedAt) return '—';
    const sec = Math.floor((now - startedAt) / 1000);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${d > 0 ? d + 'd ' : ''}${h > 0 || d > 0 ? h + 'h ' : ''}${m}m`;
}
