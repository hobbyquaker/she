import type { TreeEntry } from './api.js';

/**
 * Shared linkification of script locations in log messages (Logs tab and the
 * Scripts tab log panel): the script-label prefix ("path/script.js: …") and
 * stack-frame locations ("…/scripts/path/script.js:12:5") become links that
 * open the script in the editor, optionally at a line/column.
 */

export interface LogSegment {
    text: string;
    link?: { path: string; line?: number; column?: number };
}

const LOCATION_RE = /([^\s():,]+\.js)(?::(\d+)(?::(\d+))?)?/g;

/**
 * Split a log message into plain-text and script-link segments. A ".js" token
 * (with optional :line:col) becomes a link only when `resolveScript` maps it
 * to a known script — unknown paths (node internals, external frames) stay
 * plain text.
 */
export function splitLogMessage(msg: string, resolveScript: (path: string) => string | null): LogSegment[] {
    const segments: LogSegment[] = [];
    let last = 0;
    LOCATION_RE.lastIndex = 0;
    for (let m = LOCATION_RE.exec(msg); m !== null; m = LOCATION_RE.exec(msg)) {
        const resolved = resolveScript(m[1]);
        if (!resolved) continue;
        if (m.index > last) segments.push({ text: msg.slice(last, m.index) });
        segments.push({
            text: m[0],
            link: { path: resolved, line: m[2] ? Number(m[2]) : undefined, column: m[3] ? Number(m[3]) : undefined },
        });
        last = m.index + m[0].length;
    }
    if (last < msg.length) segments.push({ text: msg.slice(last) });
    return segments;
}

/**
 * Build a resolver from known script paths. Matches exactly, or as a path
 * suffix — stack frames carry the absolute file path (vm filename) while the
 * script tree uses paths relative to the scripts directory.
 */
export function scriptResolver(known: Set<string>): (path: string) => string | null {
    return (p) => {
        const norm = p.replace(/\\/g, '/');
        if (known.has(norm)) return norm;
        for (const k of known) {
            if (norm.endsWith('/' + k)) return k;
        }
        return null;
    };
}

/** Collect all file paths from a scripts tree into a Set. */
export function collectScriptPaths(entries: TreeEntry[], into = new Set<string>()): Set<string> {
    for (const e of entries) {
        if (e.type === 'file') into.add(e.path);
        else if (e.children) collectScriptPaths(e.children, into);
    }
    return into;
}
