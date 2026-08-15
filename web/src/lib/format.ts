/**
 * Format a millisecond timestamp as HH:MM:SS.mmm (24 h) — shared by all log
 * views (Logs tab, Scripts tab log panel, broker Mosquitto logs) so they read
 * alike.
 */
export function fmtLogTs(ts: number): string {
    const d = new Date(ts);
    return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}
