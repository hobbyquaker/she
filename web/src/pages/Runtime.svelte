<script lang="ts">
    /**
     * The Runtime page: what the stats popup used to show as a panel of gauges with an hour of
     * history, every pending timer with a live countdown, and the statistics of every handler every
     * script registered — fires, callback time, errors — with the top consumers highlighted. Read-only;
     * the editor's Runtime panel is where a timer is cancelled. Live over the WebSocket while open.
     */
    import { onDestroy } from 'svelte';
    import { getRuntimeHistory, type DaemonStatus, type GaugeSample, type RuntimeHandler, type RuntimeSnapshot } from '../lib/api.js';
    import { subscribeRuntime } from '../lib/ws.js';
    import Sparkline from '../lib/Sparkline.svelte';
    import RuntimeHandlers from '../lib/RuntimeHandlers.svelte';
    import { fmtUptime } from '../lib/runtime-format.js';

    interface Props {
        active: boolean;
        stats: DaemonStatus | null;
        onrestart: () => void;
    }
    let { active, stats, onrestart }: Props = $props();

    let snapshot = $state<RuntimeSnapshot | null>(null);
    let history = $state<GaugeSample[]>([]);
    let now = $state(Date.now());
    let live = $state(false);
    let filter = $state('');
    let pendingOnly = $state(false);
    let grouped = $state(false);
    let collapsed = $state<Record<string, boolean>>({});

    const MAX_SAMPLES = 720;
    let unsub: (() => void) | null = null;
    let tick: ReturnType<typeof setInterval> | null = null;

    async function start() {
        live = false;
        try {
            const h = await getRuntimeHistory();
            history = h.samples;
        } catch { /* the live samples still fill the sparklines */ }
        unsub?.();
        unsub = subscribeRuntime(null, (msg) => {
            const snap = msg as RuntimeSnapshot;
            snapshot = snap;
            live = true;
            if (snap.gauges && (history.length === 0 || snap.gauges.ts > history[history.length - 1].ts)) {
                history = [...history.slice(-(MAX_SAMPLES - 1)), snap.gauges];
            }
        });
        tick = setInterval(() => { now = Date.now(); }, 200);
    }
    function stop() {
        unsub?.();
        unsub = null;
        if (tick) clearInterval(tick);
        tick = null;
        live = false;
    }
    $effect(() => {
        if (active) start();
        else stop();
    });
    onDestroy(stop);

    const gauges = $derived(snapshot?.gauges ?? null);
    const series = (key: keyof GaugeSample) => history.map((s) => ({ ts: s.ts, v: Number(s[key]) || 0 }));

    interface Row extends RuntimeHandler { script: string }
    const allRows = $derived.by<Row[]>(() => {
        if (!snapshot) return [];
        const rows: Row[] = [];
        for (const s of snapshot.scripts) for (const h of s.handlers) rows.push({ ...h, script: s.label });
        return rows;
    });
    const rows = $derived.by(() => {
        const q = filter.trim().toLowerCase();
        return allRows.filter((h) => {
            if (pendingOnly && h.pending.length === 0) return false;
            if (!q) return true;
            return h.script.toLowerCase().includes(q) || (h.name ?? '').toLowerCase().includes(q) || h.kind.includes(q) || (h.detail ?? '').toLowerCase().includes(q);
        });
    });
    /** the three handlers that cost the most callback time in the last five minutes */
    const top = $derived.by(() => {
        const ranked = allRows.filter((h) => h.recent.totalMs > 0).sort((a, b) => b.recent.totalMs - a.recent.totalMs).slice(0, 3);
        return new Set(ranked.map((h) => h.id));
    });
    const byScript = $derived.by(() => {
        const m = new Map<string, Row[]>();
        for (const r of rows) {
            if (!m.has(r.script)) m.set(r.script, []);
            m.get(r.script)!.push(r);
        }
        return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    });
    const totals = $derived.by(() => {
        let pending = 0, fires5 = 0, errors5 = 0, ms5 = 0;
        for (const h of allRows) {
            pending += h.pending.length;
            fires5 += h.recent.fires;
            errors5 += h.recent.errors;
            ms5 += h.recent.totalMs;
        }
        return { pending, fires5, errors5, ms5: Math.round(ms5) };
    });

    function jump(script: string | undefined, line: number) {
        if (!script) return;
        location.hash = '#/scripts';
        window.dispatchEvent(new CustomEvent('she:open-script', { detail: { path: script, line } }));
    }
    const n = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? '—' : `${v}${unit}`);
    const mb = (bytes: number | null | undefined) => (bytes === null || bytes === undefined ? '—' : `${Math.round(bytes / 1048576)} MB`);
    /** the daemon's memory in bytes: the live status, the last maintenance/stats sample for the Linux split */
    const memory = $derived(stats?.memory ?? null);
    const procStats = $derived(stats?.stats ?? null);
    const resources = $derived(stats?.resources ? Object.entries(stats.resources).sort((a, b) => b[1] - a[1]) : []);
    /** the additional brokers (M2): from the live snapshot, else from the polled status */
    const brokers = $derived(snapshot?.brokers ?? stats?.brokers ?? []);
    const brokersDown = $derived(brokers.filter((b) => !b.connected));
</script>

<div class="page">
    <div class="toolbar">
        <h2>Runtime</h2>
        <span class="live" class:on={live} title={live ? 'Live — a snapshot every second' : 'Connecting…'}>{live ? '● live' : '○ connecting…'}</span>
        <span class="meta">
            {#if stats?.startedAt}up {fmtUptime(stats.startedAt, now)}{/if}
            {#if stats?.user} · {stats.user}{/if}
            {#if stats?.dataDir} · {stats.dataDir}{/if}
        </span>
        {#if !stats?.docker}
            <button class="restart" onclick={onrestart} title="Restart the daemon">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
                Restart daemon
            </button>
        {/if}
    </div>

    <div class="body">
        <section class="tiles">
            <div class="tile">
                <div class="label">Scripts</div>
                <div class="value">{n(stats?.scripts)}</div>
                <div class="hint">{allRows.length} handlers · {totals.pending} pending</div>
            </div>
            <div class="tile">
                <div class="label">MQTT msg/s</div>
                <div class="value">{n(gauges?.mqttMsgPerSec ?? stats?.mqttMsgPerSec)}</div>
                <div class="spark"><Sparkline values={series('mqttMsgPerSec')} unit="msg/s" /></div>
            </div>
            <div class="tile">
                <div class="label">MQTT topics</div>
                <div class="value">{n(gauges?.topics ?? stats?.topics)}</div>
                <div class="spark"><Sparkline values={series('topics')} zero={false} /></div>
            </div>
            <div class="tile">
                <div class="label">Memory (RSS)</div>
                <div class="value">{n(gauges?.memMb ?? stats?.memMb, ' MB')}</div>
                <div class="spark"><Sparkline values={series('memMb')} unit="MB" zero={false} /></div>
            </div>
            <div class="tile">
                <div class="label">Heap used</div>
                <div class="value">{n(gauges?.heapMb ?? stats?.heapMb, ' MB')}</div>
                <div class="spark"><Sparkline values={series('heapMb')} unit="MB" zero={false} /></div>
            </div>
            <div class="tile" title="process.memoryUsage(): heapTotal is what V8 reserved for the heap, external and arrayBuffers live outside it">
                <div class="label">Heap total · external</div>
                <div class="value">{mb(memory?.heapTotal)}<span class="unit"> · {mb(memory ? memory.external + memory.arrayBuffers : null)}</span></div>
                {#if procStats?.heapArena !== undefined}
                    <div class="hint" title="from /proc/self/smaps: the glibc heap arena ([heap], retained after free) and every anonymous page (V8's heap included)">glibc arena {mb(procStats.heapArena)} · anonymous {mb(procStats.anonymous)}</div>
                {:else if stats?.statsTopic}
                    <div class="hint">published retained to {stats.statsTopic}</div>
                {/if}
            </div>
            <div class="tile">
                <div class="label">CPU</div>
                <div class="value">{n(gauges?.cpuPercent ?? stats?.cpuPercent, ' %')}</div>
                <div class="spark"><Sparkline values={series('cpuPercent')} unit="%" /></div>
            </div>
            <div class="tile">
                <div class="label">Event loop utilisation</div>
                <div class="value">{n(gauges?.eluPercent ?? stats?.eluPercent, ' %')}</div>
                <div class="spark"><Sparkline values={series('eluPercent')} unit="%" /></div>
            </div>
            <div class="tile">
                <div class="label">Event loop lag (mean)</div>
                <div class="value">{n(gauges?.elMeanMs ?? stats?.elMeanMs, ' ms')}</div>
                <div class="spark"><Sparkline values={series('elMeanMs')} unit="ms" /></div>
            </div>
            <div class="tile">
                <div class="label">Event loop lag (max)</div>
                <div class="value">{n(gauges?.elMaxMs ?? stats?.elMaxMs, ' ms')}</div>
                <div class="spark"><Sparkline values={series('elMaxMs')} unit="ms" /></div>
            </div>
            <div class="tile">
                <div class="label">Handlers</div>
                <div class="value">{n(gauges?.handlers ?? allRows.length)}</div>
                <div class="spark"><Sparkline values={series('handlers')} /></div>
            </div>
            <div class="tile">
                <div class="label">Pending timers</div>
                <div class="value">{n(gauges?.pendingTimers ?? totals.pending)}</div>
                <div class="spark"><Sparkline values={series('pendingTimers')} /></div>
            </div>
            {#if resources.length > 0}
            <div class="tile" title={'process.getActiveResourcesInfo():\n' + resources.map(([k, v]) => `${k}: ${v}`).join('\n')}>
                <div class="label">Active handles</div>
                <div class="value">{resources.reduce((a, [, v]) => a + v, 0)}</div>
                <div class="hint">{resources.slice(0, 3).map(([k, v]) => `${v} ${k}`).join(' · ')}{stats?.schedules ? ` · ${stats.schedules} schedules` : ''}{stats?.statsTopic ? ` · stats → ${stats.statsTopic}` : ''}</div>
            </div>
            {/if}
            <div class="tile">
                <div class="label">Last 5 min</div>
                <div class="value">{totals.fires5} <span class="unit">callbacks</span></div>
                <div class="hint" class:warn={totals.errors5 > 0}>{totals.ms5} ms · {totals.errors5} errors</div>
            </div>
            {#if stats?.matterEnabled}
            <div class="tile">
                <div class="label">Matter</div>
                <div class="value">{n(stats.matterNodes)} <span class="unit">nodes</span></div>
                <div class="hint">{n(stats.matterEndpoints)} endpoints</div>
            </div>
            {/if}
            {#if stats?.dbEnabled}
            <div class="tile">
                <div class="label">sheDB</div>
                <div class="value">{n(stats.dbDocs)} <span class="unit">docs</span></div>
                <div class="hint">{n(stats.dbViews)} views</div>
            </div>
            {/if}
            <div class="tile">
                <div class="label">Failed commands</div>
                <div class="value" class:err={(snapshot?.commandsFailed ?? 0) > 0}>{n(snapshot?.commandsFailed ?? stats?.commandsFailed ?? 0)}</div>
                <div class="hint">she.mqtt.command since start</div>
            </div>
            {#if brokers.length > 0}
            <div class="tile" title={brokers.map((b) => `${b.name}: ${b.connected ? 'connected' : 'not connected' + (b.error ? ' — ' + b.error : '')}`).join('\n')}>
                <div class="label">Additional brokers</div>
                <div class="value" class:warn={brokersDown.length > 0}>{brokers.length - brokersDown.length}<span class="unit"> / {brokers.length} connected</span></div>
                {#if brokersDown.length > 0}
                    <div class="hint warn">not connected: {brokersDown.map((b) => b.name).join(', ')}</div>
                {:else}
                    <div class="hint">{brokers.reduce((a, b) => a + b.mirror.in + b.mirror.out, 0)} mirrored since start</div>
                {/if}
            </div>
            {/if}
        </section>

        <section class="handlers">
            <div class="section-bar">
                <h3>Handlers and timers</h3>
                <input class="filter" type="search" placeholder="Filter by script, topic, name, kind…" bind:value={filter} />
                <label class="check"><input type="checkbox" bind:checked={pendingOnly} /><span class="checkmark"></span> Pending only</label>
                <label class="check"><input type="checkbox" bind:checked={grouped} /><span class="checkmark"></span> Group by script</label>
                <span class="count">{rows.length} of {allRows.length}</span>
            </div>
            {#if !snapshot}
                <div class="empty">Loading…</div>
            {:else if grouped}
                {#each byScript as [script, list] (script)}
                    <div class="group">
                        <div class="group-hdr">
                            <button class="group-toggle" onclick={() => (collapsed[script] = !collapsed[script])}>
                                <span class="chev">{collapsed[script] ? '▸' : '▾'}</span>
                                <span class="group-name">{script}</span>
                                <span class="group-meta">{list.length} handlers · {list.reduce((a, h) => a + h.pending.length, 0)} pending · {list.reduce((a, h) => a + h.recent.fires, 0)} fires / 5 min{#if list.some((h) => h.errors > 0)} · <span class="err">{list.reduce((a, h) => a + h.errors, 0)} errors</span>{/if}</span>
                            </button>
                            <button class="link open" onclick={() => jump(script, 1)}>open</button>
                        </div>
                        {#if !collapsed[script]}
                            <RuntimeHandlers handlers={list} {now} {top} onjump={jump} />
                        {/if}
                    </div>
                {/each}
            {:else}
                <RuntimeHandlers handlers={rows} {now} {top} showScript onjump={jump} emptyText={allRows.length === 0 ? 'No script has registered anything.' : 'Nothing matches the filter.'} />
            {/if}
        </section>
    </div>
</div>

<style>
    .page { display: flex; flex-direction: column; height: 100%; }
    .toolbar { display: flex; align-items: center; gap: 10px; padding: 6px 12px; background: var(--bg-panel); border-bottom: 1px solid var(--border-sub); flex-shrink: 0; }
    h2 { font-size: 13px; font-weight: 600; margin: 0; }
    .live { font-size: 11px; color: var(--fg-dim); }
    .live.on { color: var(--fg-ok); }
    .meta { flex: 1; font-size: 11px; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .restart { display: inline-flex; align-items: center; gap: 6px; background: var(--bg-input); color: var(--fg); border: 1px solid var(--border); padding: 3px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; }
    .restart:hover { background: var(--bg-active); }
    .body { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 14px; }

    .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
    .tile { position: relative; background: var(--bg-panel); border: 1px solid var(--border-sub); border-radius: 5px; padding: 8px 10px 6px; min-height: 78px; display: flex; flex-direction: column; }
    .label { font-size: 11px; color: var(--fg-muted); }
    .value { font-size: 20px; font-weight: 600; color: var(--fg-text); font-variant-numeric: tabular-nums; line-height: 1.3; margin: 2px 0 4px; }
    .value .unit { font-size: 11px; font-weight: normal; color: var(--fg-muted); }
    .value.err { color: var(--fg-err); }
    .value.warn { color: var(--fg-warn); }
    .hint { font-size: 11px; color: var(--fg-muted); margin-top: auto; }
    .hint.warn { color: var(--fg-warn); }
    .spark { margin-top: auto; height: 28px; }

    .handlers { background: var(--bg-panel); border: 1px solid var(--border-sub); border-radius: 5px; overflow: hidden; }
    .section-bar { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-bottom: 1px solid var(--border-sub); }
    h3 { font-size: 12px; font-weight: 600; margin: 0; flex-shrink: 0; }
    .filter { flex: 1; max-width: 360px; background: var(--bg-input); color: var(--fg); border: 1px solid var(--border); padding: 2px 6px; border-radius: 3px; font-size: 12px; }
    .count { margin-left: auto; font-size: 11px; color: var(--fg-muted); }
    .check { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; color: var(--fg-muted); user-select: none; white-space: nowrap; position: relative; }
    .check input[type='checkbox'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .checkmark { flex-shrink: 0; width: 13px; height: 13px; border: 1.5px solid var(--border); border-radius: 3px; background: var(--bg-input); position: relative; }
    .check input:checked + .checkmark { background: var(--accent); border-color: var(--accent); }
    .check input:checked + .checkmark::after { content: ''; position: absolute; left: 3px; top: 0px; width: 4px; height: 7px; border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg); }
    .empty { padding: 12px; color: var(--fg-muted); font-size: 12px; }
    .group-hdr { display: flex; align-items: center; gap: 8px; background: var(--bg-widget); border-bottom: 1px solid var(--border-sub); padding: 0 10px 0 0; }
    .group-hdr:hover { background: var(--bg-hover); }
    .group-toggle { display: flex; align-items: center; gap: 8px; flex: 1; text-align: left; background: none; color: var(--fg); border: none; padding: 4px 10px; font-size: 12px; cursor: pointer; }
    .chev { color: var(--fg-muted); width: 10px; }
    .group-name { font-weight: 600; color: var(--fg-text); }
    .group-meta { color: var(--fg-muted); font-size: 11px; flex: 1; }
    .err { color: var(--fg-err); }
    .link { background: none; border: none; padding: 0; font: inherit; color: var(--fg-brand); cursor: pointer; font-size: 11px; }
    .link:hover { text-decoration: underline; }
</style>
