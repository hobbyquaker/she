/**
 * Small helpers for the home model in the web UI: the rule matcher (the same as the daemon's, so a
 * function's editor can show what its rules catch before they are saved), lookups and labels.
 */
import type { HomeEntity, HomeRule, HomeRoom, HomeDevice } from './api.js';

type Matchable = { component: string; device_class: string | null; entity_category: string | null };

/** Whether a rule matches an entity — the daemon's `matchRule`, field for field. */
export function matchRule(rule: HomeRule, ha: Matchable): boolean {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
    let positive = 0;
    for (const field of ['component', 'device_class', 'entity_category'] as const) {
        const want = rule[field];
        if (want === undefined) continue;
        positive++;
        const have = ha[field] ?? null;
        if (!(Array.isArray(want) ? want : [want]).some((w) => (w ?? null) === have)) return false;
    }
    if (!positive) return false;
    if (rule.not !== undefined && (Array.isArray(rule.not) ? rule.not : [rule.not]).some((r) => matchRule(r, ha))) return false;
    return true;
}

/** A rule field as text for an input: `light, switch`; `-` stands for "not set" (null); empty = any. */
export function fieldToText(v: HomeRule['component']): string {
    if (v === undefined) return '';
    return (Array.isArray(v) ? v : [v]).map((x) => (x === null ? '-' : x)).join(', ');
}

/** The other way round: empty text leaves the field out, `-` is null, one value stays a value. */
export function textToField(text: string): HomeRule['component'] {
    const parts = text
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (s === '-' ? null : s));
    if (!parts.length) return undefined;
    return parts.length === 1 ? parts[0] : parts;
}

/** A rule in a line of text, for the function list. */
export function ruleSummary(rule: HomeRule): string {
    const parts: string[] = [];
    for (const field of ['component', 'device_class', 'entity_category'] as const) {
        if (rule[field] === undefined) continue;
        parts.push(`${field.replace('_', ' ')} ${fieldToText(rule[field]).replace('-', 'none')}`);
    }
    if (rule.not !== undefined) parts.push('except ' + (Array.isArray(rule.not) ? rule.not : [rule.not]).map(ruleSummary).join(' / '));
    return parts.join(', ') || '(matches nothing)';
}

/** Room ids → names, unknown ids as they are. */
export function roomNames(ids: string[] | undefined, rooms: HomeRoom[]): string[] {
    return (ids ?? []).map((id) => rooms.find((r) => r.id === id)?.name ?? id);
}

/** The text an entity is searched by: its name, device, component, class, ids and topic. */
export function entitySearchText(e: HomeEntity, device: HomeDevice | undefined): string {
    return [
        e.eff.name,
        e.ha.name,
        e.ha.component,
        e.ha.device_class,
        e.ha.unique_id,
        e.ha.state_topic,
        device?.eff.name,
        device?.ha.manufacturer,
        device?.ha.model,
        device?.eff.adapter,
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

export function plural(n: number, one: string, many = one + 's'): string {
    return `${n} ${n === 1 ? one : many}`;
}

export function fmtSince(ts: number | null): string {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
