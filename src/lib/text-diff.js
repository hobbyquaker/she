'use strict';

/**
 * A unified diff of two texts, line based (roadmap I16): what the chat shows for a script draft.
 * Plain LCS over lines — scripts are a few hundred lines, so quadratic is fine.
 */

function lcsTable(a, b) {
    const n = a.length;
    const m = b.length;
    const t = new Array(n + 1);
    for (let i = 0; i <= n; i++) t[i] = new Uint32Array(m + 1);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
        }
    }
    return t;
}

/** @returns {Array<{ kind: ' '|'-'|'+', line: string, a?: number, b?: number }>} */
function diffLines(a, b) {
    const t = lcsTable(a, b);
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            out.push({ kind: ' ', line: a[i], a: i, b: j });
            i++;
            j++;
        } else if (t[i + 1][j] >= t[i][j + 1]) {
            out.push({ kind: '-', line: a[i], a: i });
            i++;
        } else {
            out.push({ kind: '+', line: b[j], b: j });
            j++;
        }
    }
    while (i < a.length) out.push({ kind: '-', line: a[i++] });
    while (j < b.length) out.push({ kind: '+', line: b[j++] });
    return out;
}

/**
 * @param {string} oldText
 * @param {string} newText
 * @param {{ context?: number, fromName?: string, toName?: string }} [opts]
 * @returns {{ text: string, added: number, removed: number }}
 */
// a text's lines, without the empty one a trailing newline would produce
function toLines(text) {
    const str = String(text ?? '');
    if (str === '') return [];
    const lines = str.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
}

function unifiedDiff(oldText, newText, opts = {}) {
    const context = opts.context ?? 3;
    const a = toLines(oldText);
    const b = toLines(newText);
    const ops = diffLines(a, b);
    let added = 0;
    let removed = 0;
    for (const op of ops) {
        if (op.kind === '+') added++;
        else if (op.kind === '-') removed++;
    }
    const lines = [`--- ${opts.fromName || 'a'}`, `+++ ${opts.toName || 'b'}`];
    if (added === 0 && removed === 0) return { text: '', added, removed };
    // hunks: runs of changes with `context` lines around them
    let idx = 0;
    while (idx < ops.length) {
        if (ops[idx].kind === ' ') {
            idx++;
            continue;
        }
        let start = Math.max(0, idx - context);
        let end = idx;
        while (end < ops.length) {
            // extend the hunk while changes are within 2*context of each other
            let next = end;
            while (next < ops.length && ops[next].kind !== ' ') next++;
            let gap = next;
            while (gap < ops.length && ops[gap].kind === ' ' && gap - next < 2 * context) gap++;
            if (gap < ops.length && ops[gap].kind !== ' ' && gap - next < 2 * context) {
                end = gap;
                continue;
            }
            end = Math.min(ops.length, next + context);
            break;
        }
        const hunk = ops.slice(start, end);
        const aStart = (hunk.find((o) => o.a !== undefined)?.a ?? (hunk[0].b !== undefined ? aIndexBefore(ops, start) : 0)) + 1;
        const bStart = (hunk.find((o) => o.b !== undefined)?.b ?? bIndexBefore(ops, start)) + 1;
        const aLen = hunk.filter((o) => o.kind !== '+').length;
        const bLen = hunk.filter((o) => o.kind !== '-').length;
        lines.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
        for (const o of hunk) lines.push(o.kind + o.line);
        idx = end;
    }
    return { text: lines.join('\n'), added, removed };
}

function aIndexBefore(ops, k) {
    for (let i = k - 1; i >= 0; i--) if (ops[i].a !== undefined) return ops[i].a + 1;
    return 0;
}
function bIndexBefore(ops, k) {
    for (let i = k - 1; i >= 0; i--) if (ops[i].b !== undefined) return ops[i].b + 1;
    return 0;
}

module.exports = { unifiedDiff, diffLines };
