<script lang="ts">
    /**
     * The handlers of one or more scripts as a sortable table: kind, name, where it was registered,
     * fires and errors (since load and over the last five minutes), callback time, last and next run,
     * and the timers pending under each handler with a live countdown bar. Used by the Runtime page
     * (read-only, every script) and by the editor's Runtime panel (one script, with actions).
     */
    import type { RuntimeHandler, RuntimePending } from './api.js';
    import { fmtAgo, fmtIn, fmtMs, fmtClock, progressOf } from './runtime-format.js';

    interface Row extends RuntimeHandler {
        /** set when rows of several scripts are shown together */
        script?: string;
    }
    type SortKey = 'kind' | 'name' | 'fires' | 'recent' | 'totalMs' | 'maxMs' | 'errors' | 'lastFire' | 'next';

    interface Props {
        handlers: Row[];
        /** wall clock, updated by the parent several times a second for the countdowns */
        now: number;
        /** show the script column */
        showScript?: boolean;
        /** offer cancel / run now */
        actions?: boolean;
        /** rows whose id is in here are highlighted as the top consumers */
        top?: Set<string>;
        onjump?: (script: string | undefined, line: number) => void;
        onaction?: (id: string, action: 'cancel' | 'run') => void;
        emptyText?: string;
    }
    let { handlers, now, showScript = false, actions = false, top = new Set<string>(), onjump, onaction, emptyText = 'Nothing registered.' }: Props = $props();

    let sortKey = $state<SortKey>('kind');
    let sortDir = $state<1 | -1>(1);
    function sortBy(k: SortKey) {
        if (sortKey === k) sortDir = sortDir === 1 ? -1 : 1;
        else {
            sortKey = k;
            // numbers descending first, text ascending
            sortDir = k === 'kind' || k === 'name' ? 1 : -1;
        }
    }
    const KIND_ORDER = ['sub', 'var', 'schedule', 'sun', 'interval', 'timer', 'shift', 'timeout', 'debounce', 'debounce maxWait', 'throttle', 'retry', 'schedule random', 'command'];
    function nextOf(h: Row): number | null {
        if (h.next) return h.next;
        if (h.pending.length) return h.pending[0].due;
        return null;
    }
    const rows = $derived.by(() => {
        const list = handlers.slice();
        const dir = sortDir;
        list.sort((a, b) => {
            let r = 0;
            switch (sortKey) {
                case 'kind': r = (KIND_ORDER.indexOf(a.kind) + 100) % 200 - (KIND_ORDER.indexOf(b.kind) + 100) % 200 || (a.name ?? '').localeCompare(b.name ?? ''); break;
                case 'name': r = (a.name ?? '').localeCompare(b.name ?? ''); break;
                case 'fires': r = a.fires - b.fires; break;
                case 'recent': r = a.recent.fires - b.recent.fires; break;
                case 'totalMs': r = a.totalMs - b.totalMs; break;
                case 'maxMs': r = a.maxMs - b.maxMs; break;
                case 'errors': r = a.errors - b.errors || a.recent.errors - b.recent.errors; break;
                case 'lastFire': r = (a.lastFire ?? 0) - (b.lastFire ?? 0); break;
                case 'next': r = (nextOf(a) ?? Infinity) - (nextOf(b) ?? Infinity); break;
            }
            if (r === 0 && showScript) r = (a.script ?? '').localeCompare(b.script ?? '');
            return r * dir;
        });
        return list;
    });

    const KIND_LABEL: Record<string, string> = {
        'sub': 'sub', 'var': 'var', 'schedule': 'schedule', 'sun': 'sun', 'interval': 'interval', 'timer': 'setTimeout', 'shift': 'shift',
        'timeout': 'she.timeout', 'debounce': 'debounce', 'debounce maxWait': 'debounce (maxWait)', 'throttle': 'throttle', 'retry': 'retry',
        'schedule random': 'schedule (random)', 'command': 'command',
    };
    const kindClass = (k: string) => 'k-' + k.split(' ')[0];
    function pendingTitle(p: RuntimePending): string {
        const parts = [`due ${fmtClock(p.due)}`];
        if (p.every) parts.push(`every ${fmtMs(p.every)}`);
        if (p.topic) parts.push(`${p.topic} ← ${p.payload ?? ''}${p.tries ? ` (try ${p.tries})` : ''}`);
        return parts.join(' · ');
    }
    const arrow = (k: SortKey) => (sortKey === k ? (sortDir === 1 ? ' ▲' : ' ▼') : '');
</script>

<div class="rt-table-wrap">
{#if rows.length === 0}
    <div class="rt-empty">{emptyText}</div>
{:else}
<table class="rt-table">
    <thead>
        <tr>
            <th class="sortable" onclick={() => sortBy('kind')}>Kind{arrow('kind')}</th>
            {#if showScript}<th>Script</th>{/if}
            <th class="sortable grow" onclick={() => sortBy('name')}>Handler{arrow('name')}</th>
            <th class="num sortable" onclick={() => sortBy('fires')} title="Callbacks since the script was loaded">Fires{arrow('fires')}</th>
            <th class="num sortable" onclick={() => sortBy('recent')} title="Callbacks in the last five minutes">5 min{arrow('recent')}</th>
            <th class="num sortable" onclick={() => sortBy('totalMs')} title="Callback time in total · in the last five minutes">Time{arrow('totalMs')}</th>
            <th class="num sortable" onclick={() => sortBy('maxMs')} title="Longest single callback">Max{arrow('maxMs')}</th>
            <th class="num sortable" onclick={() => sortBy('errors')} title="Callbacks that threw or rejected">Errors{arrow('errors')}</th>
            <th class="sortable" onclick={() => sortBy('lastFire')}>Last{arrow('lastFire')}</th>
            <th class="sortable next" onclick={() => sortBy('next')}>Next / pending{arrow('next')}</th>
            {#if actions}<th></th>{/if}
        </tr>
    </thead>
    <tbody>
        {#each rows as h (h.id)}
            <tr class:top={top.has(h.id)} class:has-errors={h.errors > 0}>
                <td><span class="kind {kindClass(h.kind)}">{KIND_LABEL[h.kind] ?? h.kind}</span></td>
                {#if showScript}
                    <td class="script"><button class="link" title="Open {h.script} in the editor" onclick={() => h.script && onjump?.(h.script, h.line ?? 1)}>{h.script}</button></td>
                {/if}
                <td class="name">
                    <span class="name-text" title={h.name ?? ''}>{h.name ?? '—'}</span>
                    {#if h.line}
                        <button class="line link" title="Jump to line {h.line} in the editor" onclick={() => onjump?.(h.script, h.line!)}>:{h.line}</button>
                    {/if}
                    {#if h.detail}<div class="detail" title={h.detail}>{h.detail}</div>{/if}
                </td>
                <td class="num">{h.fires}</td>
                <td class="num" class:muted={h.recent.fires === 0}>{h.recent.fires}</td>
                <td class="num" title="{fmtMs(h.totalMs)} total · {fmtMs(h.recent.totalMs)} in the last 5 min">{fmtMs(h.totalMs)}{#if h.recent.totalMs > 0}<span class="sub"> · {fmtMs(h.recent.totalMs)}</span>{/if}</td>
                <td class="num">{h.maxMs > 0 ? fmtMs(h.maxMs) : '—'}</td>
                <td class="num" class:err={h.errors > 0}>{h.errors}{#if h.recent.errors > 0}<span class="sub"> · {h.recent.errors}</span>{/if}</td>
                <td class="when" title={h.lastFire ? fmtClock(h.lastFire) + (h.lastMs !== null ? ` · ${fmtMs(h.lastMs)}` : '') : ''}>{fmtAgo(h.lastFire, now)}</td>
                <td class="next">
                    {#if h.pending.length > 0}
                        {#each h.pending.slice(0, 5) as p (p.id)}
                            <div class="pending" title={pendingTitle(p)}>
                                <div class="bar"><div class="fill" class:interval={!!p.every} style:width="{Math.round(progressOf(p.start, p.due, now) * 100)}%"></div></div>
                                <span class="in">{fmtIn(p.due, now)}</span>
                                {#if p.topic}<span class="topic" title={p.topic}>{p.topic}</span>{/if}
                                {#if actions && (h.kind !== 'interval')}
                                    <span class="acts">
                                        {#if h.kind !== 'command'}<button class="act" title="Run now — remove the timer and call its callback" onclick={() => onaction?.(p.id, 'run')}>▶</button>{/if}
                                        <button class="act" title="Cancel — remove the timer without running it" onclick={() => onaction?.(p.id, 'cancel')}>✕</button>
                                    </span>
                                {/if}
                            </div>
                        {/each}
                        {#if h.pending.length > 5}<div class="more">+{h.pending.length - 5} more</div>{/if}
                    {:else if h.next}
                        <span class="in" title={fmtClock(h.next)}>{fmtIn(h.next, now)}</span>
                    {:else}
                        <span class="muted">—</span>
                    {/if}
                </td>
                {#if actions}
                    <td class="acts-cell">
                        {#if h.actions.run}<button class="act" title={h.kind === 'interval' ? 'Run once now — the interval keeps running' : 'Run once now — the schedule stays'} onclick={() => onaction?.(h.id, 'run')}>▶</button>{/if}
                        {#if h.actions.cancel}<button class="act" title="Cancel — clear the interval" onclick={() => onaction?.(h.id, 'cancel')}>✕</button>{/if}
                    </td>
                {/if}
            </tr>
        {/each}
    </tbody>
</table>
{/if}
</div>

<style>
    .rt-table-wrap { overflow: auto; }
    .rt-empty { padding: 10px 12px; color: var(--fg-muted); font-size: 12px; }
    .rt-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { padding: 3px 8px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border-sub); white-space: nowrap; }
    th { position: sticky; top: 0; background: var(--bg-panel); color: var(--fg-muted); font-weight: 600; font-size: 11px; z-index: 1; user-select: none; }
    th.sortable { cursor: pointer; }
    th.sortable:hover { color: var(--fg); }
    th.grow, td.name { white-space: normal; min-width: 160px; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    tr:hover td { background: var(--bg-hover); }
    tr.top td { background: var(--bg-warn-subtle); }
    tr.top:hover td { background: var(--bg-warn-subtle); filter: brightness(1.1); }
    td.err { color: var(--fg-err); font-weight: 600; }
    .muted { color: var(--fg-dim); }
    .sub { color: var(--fg-muted); }
    .kind { display: inline-block; padding: 0 5px; border-radius: 3px; font-size: 10px; font-weight: 600; line-height: 16px; background: var(--bg-widget); color: var(--fg-muted); white-space: nowrap; }
    .k-sub { color: var(--fg-brand); } .k-var { color: var(--fg-value); } .k-schedule, .k-sun { color: var(--fg-ok); }
    .k-timer, .k-timeout, .k-debounce, .k-throttle, .k-retry, .k-interval, .k-shift { color: var(--fg-warn-subtle); } .k-command { color: var(--fg-err-subtle); }
    .name-text { color: var(--fg-text); word-break: break-all; }
    .detail { color: var(--fg-muted); font-size: 11px; word-break: break-all; }
    .link { background: none; border: none; padding: 0; font: inherit; color: var(--fg-brand); cursor: pointer; }
    .link:hover { text-decoration: underline; }
    .line { margin-left: 4px; color: var(--fg-muted); font-size: 11px; }
    .script { color: var(--fg-muted); max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
    .when { color: var(--fg-muted); }
    td.next { min-width: 180px; }
    .pending { display: flex; align-items: center; gap: 6px; margin: 1px 0; }
    .bar { width: 80px; height: 6px; border-radius: 3px; background: var(--bg-widget); overflow: hidden; flex-shrink: 0; }
    .fill { height: 100%; background: var(--fg-brand); border-radius: 3px; transition: width 0.1s linear; }
    .fill.interval { background: var(--fg-ok); }
    .in { font-variant-numeric: tabular-nums; color: var(--fg); }
    .topic { color: var(--fg-muted); max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
    .more { color: var(--fg-dim); font-size: 11px; }
    .acts, .acts-cell { display: inline-flex; gap: 2px; }
    .act { background: var(--bg-input); color: var(--fg-muted); border: 1px solid var(--border); border-radius: 3px; width: 20px; height: 18px; font-size: 10px; line-height: 1; cursor: pointer; padding: 0; }
    .act:hover { color: var(--fg); background: var(--bg-active); }
</style>
