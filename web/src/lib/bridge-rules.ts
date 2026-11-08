/**
 * The live preview of a bridge's topic rules — the browser-side twin of the mapping and loop
 * logic in the daemon's mosquitto-bridges library. The daemon's version is authoritative (the
 * save dialog shows its result); this one answers while the user types.
 */
import type { BridgeTopicRule } from './api.js';

const SAMPLES = ['kitchen', 'light', 'sensor1', 'room2'];

/** An example topic for a filter: `+` becomes a sample segment, `#` a two-segment tail. */
export function exampleTopic(pattern: string): string {
    let n = 0;
    return pattern
        .split('/')
        .map((s) => (s === '+' ? SAMPLES[n++ % SAMPLES.length] : s === '#' ? 'a/b' : s))
        .join('/');
}

export interface RulePreview {
    local: string;
    remote: string;
    lines: { from: 'remote' | 'local'; fromTopic: string; to: 'remote' | 'local'; toTopic: string }[];
}

/** What one rule does, with an example topic in each direction it has. */
export function previewRule(rule: BridgeTopicRule): RulePreview {
    const pattern = rule.pattern ?? '';
    const ex = pattern ? exampleTopic(pattern) : 'a/b';
    const lp = rule.localPrefix || '';
    const rp = rule.remotePrefix || '';
    const lines: RulePreview['lines'] = [];
    if (rule.direction === 'in' || rule.direction === 'both') lines.push({ from: 'remote', fromTopic: rp + ex, to: 'local', toTopic: lp + ex });
    if (rule.direction === 'out' || rule.direction === 'both') lines.push({ from: 'local', fromTopic: lp + ex, to: 'remote', toTopic: rp + ex });
    return { local: lp + (pattern || '#'), remote: rp + (pattern || '#'), lines };
}

/** The reason an MQTT filter is invalid, or null. */
export function patternError(pattern: string): string | null {
    if (pattern === '') return null;
    const segs = pattern.split('/');
    for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (s === '#') {
            if (i !== segs.length - 1) return '"#" only as the last segment';
        } else if (s.includes('#')) return '"#" must stand alone in its segment';
        else if (s.includes('+') && s !== '+') return '"+" must stand alone in its segment';
    }
    return null;
}

/** Do two MQTT filters share at least one topic? */
export function patternsOverlap(a: string, b: string): boolean {
    const sa = a.split('/');
    const sb = b.split('/');
    let i = 0;
    for (;;) {
        const x = sa[i];
        const y = sb[i];
        if (x === '#' || y === '#') return true;
        if (x === undefined || y === undefined) return x === y;
        if (x !== '+' && y !== '+' && x !== y) return false;
        i++;
    }
}

const localPattern = (r: BridgeTopicRule) => (r.localPrefix || '') + (r.pattern || '');
const remotePattern = (r: BridgeTopicRule) => (r.remotePrefix || '') + (r.pattern || '');

/**
 * Loops between the rules of one bridge: a message coming in through rule A and going out through
 * rule B lands on the remote where A picks it up again. Same semantics as the daemon's check:
 * the same rule both ways with unchanged prefixes is a warning (try_private), two rules an error.
 */
export function findLoops(rules: BridgeTopicRule[]): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    rules.forEach((a, ia) => {
        if (a.direction === 'out') return;
        rules.forEach((b, ib) => {
            if (b.direction === 'in') return;
            if (!patternsOverlap(localPattern(a), localPattern(b))) return;
            if (!patternsOverlap(remotePattern(a), remotePattern(b))) return;
            if (ia === ib) {
                if ((a.localPrefix || '') === (a.remotePrefix || '')) warnings.push(`Rule ${ia + 1} both ways with the same prefixes echoes unless the remote is a Mosquitto with try_private.`);
                return;
            }
            if (ia < ib || rules[ib].direction !== 'both' || rules[ia].direction !== 'both') {
                errors.push(`Loop: rule ${ia + 1} brings "${remotePattern(a)}" in as "${localPattern(a)}", rule ${ib + 1} sends "${localPattern(b)}" back out as "${remotePattern(b)}".`);
            }
        });
    });
    return { errors, warnings };
}

/** Free-form `key value` lines → options; blank lines and comments skipped. */
export function parseOptionLines(text: string): Record<string, string | string[]> {
    const options: Record<string, string | string[]> = {};
    for (const raw of (text || '').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const sp = line.indexOf(' ');
        const key = sp === -1 ? line : line.slice(0, sp);
        const value = sp === -1 ? '' : line.slice(sp + 1).trim();
        const prev = options[key];
        options[key] = prev === undefined ? value : ([] as string[]).concat(prev, value);
    }
    return options;
}

/** options → the free-form lines of the Advanced field. */
export function optionLines(options: Record<string, string | string[] | null | undefined>): string {
    const out: string[] = [];
    for (const [k, v] of Object.entries(options)) {
        if (v === null || v === undefined || v === '') continue;
        for (const one of ([] as string[]).concat(v)) out.push(`${k} ${one}`);
    }
    return out.join('\n');
}
