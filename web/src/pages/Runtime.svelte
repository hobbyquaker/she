<script lang="ts">
    /**
     * The Runtime page: the daemon's load as tiles — a ring where a value has a limit (heap against
     * the heap limit, CPU against one core, the event loop's utilisation, scripts running), a plain
     * number where it has none (message rate, callbacks) — each with its history over a span the
     * reader picks once for the whole page (1 h, 6 h, 24 h). Below them the components, and the
     * statistics of every handler every script registered, with the timers pending under them.
     * Read-only; the editor's Runtime panel is where a timer is cancelled. Live over the WebSocket
     * while open; the history is the daemon's day of minute samples, refreshed while the page is open.
     */
    import { onDestroy, untrack } from 'svelte';
    import { getRuntimeHistory, listScriptsTree, type DaemonStatus, type MinuteSample, type RuntimeHandler, type RuntimeSnapshot, type TreeEntry } from '../lib/api.js';
    import { subscribeRuntime } from '../lib/ws.js';
    import HistoryChart from '../lib/HistoryChart.svelte';
    import RingGauge from '../lib/RingGauge.svelte';
    import RuntimeHandlers from '../lib/RuntimeHandlers.svelte';
    import { fmtDuration, fmtMs } from '../lib/runtime-format.js';
    import { SPANS, peakOf, rollingSum, spanLabel, sumBars, type Point } from '../lib/history.js';

    interface Props {
        active: boolean;
        stats: DaemonStatus | null;
        onrestart: () => void;
    }
    let { active, stats, onrestart }: Props = $props();

    function stored(key: string): string | null {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }
    function store(key: string, value: string) {
        try {
            localStorage.setItem(key, value);
        } catch {
            /* private mode: the choice lasts as long as the page */
        }
    }

    let snapshot = $state<RuntimeSnapshot | null>(null);
    let minutes = $state<MinuteSample[]>([]);
    let tree = $state<TreeEntry[] | null>(null);
    let now = $state(Date.now());
    let live = $state(false);
    let filter = $state('');
    let pendingOnly = $state(false);
    let grouped = $state(stored('she:runtimeGrouped') !== '0');
    /** the span of every chart on the page, in minutes */
    let span = $state(SPANS.includes(Number(stored('she:runtimeSpan'))) ? Number(stored('she:runtimeSpan')) : 1440);
    $effect(() => store('she:runtimeSpan', String(span)));
    $effect(() => store('she:runtimeGrouped', grouped ? '1' : '0'));

    const DAY = 24 * 60 * 60_000;
    let unsub: (() => void) | null = null;
    let tick: ReturnType<typeof setInterval> | null = null;
    let refresh: ReturnType<typeof setInterval> | null = null;
    let refreshes = 0;

    /** the day at first, then only the minutes since the last one held — which is still running and is replaced */
    async function loadHistory() {
        try {
            const last = minutes.length ? minutes[minutes.length - 1].ts : undefined;
            const h = await getRuntimeHistory(last);
            const fresh = h.minutes?.samples ?? [];
            if (fresh.length === 0) return;
            const cut = Date.now() - DAY;
            minutes = [...minutes.filter((s) => s.ts < fresh[0].ts && s.ts >= cut), ...fresh];
        } catch { /* the tiles keep their live numbers */ }
    }
    async function loadTree() {
        try {
            tree = await listScriptsTree();
        } catch {
            tree = null; // no script directory (a single file): the tile shows the count alone
        }
    }
    function start() {
        stop();
        minutes = [];
        loadHistory();
        loadTree();
        unsub?.();
        unsub = subscribeRuntime(null, (msg) => {
            snapshot = msg as RuntimeSnapshot;
            live = true;
        });
        tick = setInterval(() => { now = Date.now(); }, 200);
        refresh = setInterval(() => {
            loadHistory();
            if (++refreshes % 4 === 0) loadTree();
        }, 15_000);
    }
    function stop() {
        unsub?.();
        unsub = null;
        if (tick) clearInterval(tick);
        if (refresh) clearInterval(refresh);
        tick = refresh = null;
        live = false;
    }
    $effect(() => {
        // only `active` starts and stops the page: what start() reads on its way must not restart it
        if (active) untrack(start);
        else untrack(stop);
    });
    onDestroy(stop);

    const gauges = $derived(snapshot?.gauges ?? null);

    // ── the history: one series per figure, the span's peak of each ──
    /** the charts' right edge; moves every 10 s, not with every tick of the countdowns */
    const end = $derived(Math.ceil(now / 10_000) * 10_000);
    const since = $derived(end - span * 60_000);
    const spanText = $derived(spanLabel(span));
    const pts = (key: keyof MinuteSample): Point[] => minutes.map((s) => ({ ts: s.ts, v: Number(s[key]) || 0 }));
    const hist = $derived({
        rss: pts('memMb'),
        heap: pts('heapMb'),
        cpu: pts('cpuPercent'),
        elu: pts('eluPercent'),
        lag: pts('elMaxMs'),
        msgs: pts('mqttMsgPerSec'),
        // the callbacks of the five minutes that end with each minute: the unit of the big number beside it
        callbacks: rollingSum(pts('callbacks'), 5 * 60_000),
        errors: pts('errors'),
    });
    /** the span's highest value, the live one included; null while there is neither */
    const peak = (series: Point[], current: number | null | undefined): number | null => {
        const p = peakOf(series, since);
        if (current === null || current === undefined) return p;
        return p === null ? current : Math.max(p, current);
    };
    // errors as bars: twelve for an hour, twenty-four for six hours and for a day
    const barMs = $derived(span <= 60 ? 5 * 60_000 : span <= 360 ? 15 * 60_000 : 60 * 60_000);
    const errorBars = $derived(sumBars(hist.errors, barMs));
    const errorsInSpan = $derived(hist.errors.reduce((a, p) => (p.ts >= since ? a + p.v : a), 0));

    // ── the handlers ──
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
    const totals = $derived.by(() => {
        let pending = 0, fires5 = 0, errors5 = 0, ms5 = 0;
        const failing = new Set<string>();
        for (const h of allRows) {
            pending += h.pending.length;
            fires5 += h.recent.fires;
            errors5 += h.recent.errors;
            ms5 += h.recent.totalMs;
            if (h.errors > 0) failing.add(h.script);
        }
        return { pending, fires5, errors5, ms5, failing: failing.size };
    });

    function jump(script: string | undefined, line: number) {
        if (!script) return;
        location.hash = '#/scripts';
        window.dispatchEvent(new CustomEvent('she:open-script', { detail: { path: script, line } }));
    }

    // ── the figures of the tiles ──
    const MB = 1048576;
    const mb = (bytes: number | null | undefined) => (bytes === null || bytes === undefined ? null : `${Math.round(bytes / MB)} MB`);
    const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(v));
    const pct = (v: number) => (v < 10 ? `${Math.round(v * 10) / 10} %` : `${Math.round(v)} %`);
    const thousands = (v: number) => String(Math.round(v)).replace(/\B(?=(\d{3})+$)/g, ' ');
    const level = (frac: number, warn: number, error: number): 'ok' | 'warn' | 'error' => (frac >= error ? 'error' : frac >= warn ? 'warn' : 'ok');

    const memory = $derived(stats?.memory ?? null);
    const procStats = $derived(stats?.stats ?? null);
    const heapMb = $derived(gauges?.heapMb ?? stats?.heapMb ?? null);
    const rssMb = $derived(gauges?.memMb ?? stats?.memMb ?? null);
    const heapLimitMb = $derived(stats?.heapLimit ? stats.heapLimit / MB : null);
    const heapFrac = $derived(heapMb !== null && heapLimitMb ? heapMb / heapLimitMb : null);
    const heapPeak = $derived(peak(hist.heap, heapMb));
    const rssPeak = $derived(peak(hist.rss, rssMb));
    const memMeta = $derived(
        [
            memory ? `heap total ${mb(memory.heapTotal)}` : '',
            memory ? `external ${mb(memory.external + memory.arrayBuffers)}` : '',
            procStats?.heapArena !== undefined ? `glibc arena ${mb(procStats.heapArena)}` : '',
            procStats?.anonymous !== undefined ? `anonymous ${mb(procStats.anonymous)}` : '',
        ].filter(Boolean).join(' · '),
    );

    const cpu = $derived(gauges?.cpuPercent ?? stats?.cpuPercent ?? null);
    const cpuPeak = $derived(peak(hist.cpu, cpu));
    const elu = $derived(gauges?.eluPercent ?? stats?.eluPercent ?? null);
    const eluPeak = $derived(peak(hist.elu, elu));
    const lagMean = $derived(gauges?.elMeanMs ?? stats?.elMeanMs ?? null);
    const lagMax = $derived(gauges?.elMaxMs ?? stats?.elMaxMs ?? null);
    const lagPeak = $derived(peak(hist.lag, lagMax));
    /** the lag above which the heartbeat names the blocking script, when it is on */
    const lagLimit = $derived(stats?.heartbeatThreshold ?? null);
    const lagOver = $derived(lagLimit === null ? 0 : hist.lag.filter((p) => p.ts >= since && p.v > lagLimit).length);

    const msgs = $derived(gauges?.mqttMsgPerSec ?? stats?.mqttMsgPerSec ?? null);
    const msgsPeak = $derived(peak(hist.msgs, msgs));
    const topics = $derived(gauges?.topics ?? stats?.topics ?? null);
    const failed = $derived(snapshot?.commandsFailed ?? stats?.commandsFailed ?? 0);
    const callbacksPeak = $derived(peak(hist.callbacks, snapshot ? totals.fires5 : null));

    /** the script files of the directory: those that should run, those running, those switched off */
    const files = $derived.by(() => {
        if (!tree) return null;
        const running = new Set(stats?.runningScripts ?? []);
        let enabled = 0, up = 0, disabled = 0;
        const walk = (list: TreeEntry[]) => {
            for (const e of list) {
                if (e.type === 'dir') walk(e.children ?? []);
                else if (e.name.endsWith('.js') && !e.lib) {
                    if (e.disabled) disabled++;
                    else {
                        enabled++;
                        if (running.has(e.path)) up++;
                    }
                }
            }
        };
        walk(tree);
        return { enabled, running: up, disabled };
    });
    const headSub = $derived(['she ' + __APP_VERSION__, stats?.user, stats?.dataDir].filter(Boolean).join(' · '));
    const handlerCount = $derived(gauges?.handlers ?? allRows.length);

    /** the additional brokers: from the live snapshot, else from the polled status */
    const brokers = $derived(snapshot?.brokers ?? stats?.brokers ?? []);
    const brokersDown = $derived(brokers.filter((b) => !b.connected));

    const HANDLE_NAMES: Record<string, string> = { FSEvent: 'file watchers', FSWatcher: 'file watchers', Timeout: 'timeouts', TCPSocketWrap: 'TCP sockets', TCPServerWrap: 'TCP servers', UDPWrap: 'UDP sockets', PipeWrap: 'pipes', Immediate: 'immediates' };
    const HANDLE_COLORS = ['var(--fg-brand)', 'var(--fg-warn)', 'var(--fg-ok)', 'var(--fg-dim)'];
    /** active handles by type: the three largest, the rest as one */
    const handles = $derived.by(() => {
        const all = Object.entries(stats?.resources ?? {}).sort((a, b) => b[1] - a[1]);
        const parts = all.slice(0, 3).map(([k, v]) => ({ name: HANDLE_NAMES[k] ?? k, n: v }));
        const rest = all.slice(3).reduce((a, [, v]) => a + v, 0);
        if (rest > 0) parts.push({ name: 'other', n: rest });
        return { total: all.reduce((a, [, v]) => a + v, 0), parts, title: 'process.getActiveResourcesInfo():\n' + all.map(([k, v]) => `${k}: ${v}`).join('\n') };
    });
</script>

{#snippet head(title: string, sub: string, icon: string)}
    <span class="card-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d={icon} /></svg></span>
    <div class="card-titles"><div class="card-title">{title}</div><div class="card-sub" title={sub}>{sub}</div></div>
{/snippet}

<div class="page">
    <div class="body">
        <header class="head">
            <div class="icon-lg" aria-hidden="true">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
            </div>
            <div class="head-titles">
                <h1>Runtime <span class="live" class:on={live} title={live ? 'Live — a snapshot every second' : 'Connecting…'}>{live ? 'live' : 'connecting…'}</span></h1>
                <div class="head-sub" title={headSub}>{headSub}</div>
            </div>
            <div class="facts">
                <div class="fact"><div class="k">Uptime</div><div class="v">{stats?.startedAt ? fmtDuration(now - stats.startedAt).replace(/ \d\ds$/, '') : '—'}</div></div>
                <div class="fact"><div class="k">Scripts</div><div class="v">{#if files}{files.running} / {files.enabled}{:else}{num(stats?.scripts)}{/if}</div></div>
                <div class="fact"><div class="k">Handlers</div><div class="v">{num(handlerCount)}</div></div>
                <div class="fact"><div class="k">MQTT topics</div><div class="v">{num(topics)}</div></div>
            </div>
            {#if !stats?.docker}
                <button class="btn" onclick={onrestart} title="Restart the daemon">Restart daemon</button>
            {/if}
        </header>

        <div class="section-h"><h2>Load</h2><span class="hint">the process, sampled every second while this page is open · the history keeps a day at one point per minute</span></div>
        <div class="grid">
            <section class="card" aria-label="Memory">
                <div class="card-head">{@render head('Memory', heapLimitMb ? `V8 heap · limit ${thousands(heapLimitMb)} MB` : 'V8 heap', 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3')}</div>
                <div class="row">
                    {#if heapFrac !== null}
                        <RingGauge value={heapFrac} display={pct(heapFrac * 100)} peak={heapPeak !== null && heapLimitMb ? heapPeak / heapLimitMb : null} level={level(heapFrac, 0.75, 0.9)} title="{heapMb} MB heap used of the {thousands(heapLimitMb ?? 0)} MB V8 may take" />
                    {:else}
                        <div class="big">{num(heapMb)}<small>MB</small></div>
                    {/if}
                    <div class="figures">
                        <div class="det">{num(heapMb)} MB heap used · RSS {num(rssMb)} MB</div>
                        {#if rssPeak !== null}<div class="peak"><span class="swatch"></span>max RSS {Math.round(rssPeak)} MB ({spanText})</div>{/if}
                        {#if memMeta}<div class="meta" title="process.memoryUsage(); the glibc heap arena and the anonymous pages from /proc/self/smaps">{memMeta}</div>{/if}
                    </div>
                </div>
                <div class="legend"><span><i style:background="var(--fg-brand)"></i>RSS</span><span><i style:background="var(--fg-ok)"></i>heap used</span></div>
                <HistoryChart label="Memory" unit="MB" bind:span {end} series={[{ label: 'RSS', points: hist.rss, color: 'var(--fg-brand)', fill: true }, { label: 'heap used', points: hist.heap, color: 'var(--fg-ok)' }]} />
            </section>

            <section class="card" aria-label="CPU">
                <div class="card-head">{@render head('CPU', 'share of one core', 'M22 12h-4l-3 9L9 3l-3 9H2')}</div>
                <div class="row">
                    {#if cpu !== null}
                        <RingGauge value={cpu / 100} display={pct(cpu)} peak={cpuPeak !== null ? cpuPeak / 100 : null} level={level(cpu / 100, 0.7, 0.9)} title="{cpu} % of one core" />
                    {:else}
                        <div class="big">—</div>
                    {/if}
                    <div class="figures">
                        <div class="det">of one core</div>
                        {#if cpuPeak !== null}<div class="peak"><span class="swatch"></span>max {pct(cpuPeak)} ({spanText})</div>{/if}
                        {#if stats?.cpus}<div class="meta">{stats.cpus} {stats.cpus === 1 ? 'core' : 'cores'} on this host</div>{/if}
                    </div>
                </div>
                <HistoryChart label="CPU" unit="%" bind:span {end} series={[{ label: 'CPU', points: hist.cpu, color: 'var(--fg-brand)', fill: true }]} />
            </section>

            <section class="card" aria-label="Event loop">
                <div class="card-head">{@render head('Event loop', 'utilisation · lag', 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5')}</div>
                <div class="row">
                    {#if elu !== null}
                        <RingGauge value={elu / 100} display={pct(elu)} peak={eluPeak !== null ? eluPeak / 100 : null} level={level(elu / 100, 0.7, 0.9)} title="The event loop was busy {elu} % of the time" />
                    {:else}
                        <div class="big">—</div>
                    {/if}
                    <div class="figures">
                        <div class="det">busy · lag {num(lagMean)} ms mean, {num(lagMax)} ms max</div>
                        {#if lagPeak !== null}<div class="peak"><span class="swatch"></span>max lag {Math.round(lagPeak)} ms ({spanText})</div>{/if}
                        {#if lagLimit !== null}
                            <div class="meta" class:warn={lagOver > 0}>warns above {lagLimit} ms · {lagOver === 0 ? 'none in this span' : `${lagOver} ${lagOver === 1 ? 'minute' : 'minutes'} above it in this span`}</div>
                        {/if}
                    </div>
                </div>
                <div class="legend">
                    <span><i style:background="var(--fg-brand)"></i>lag max (ms)</span>
                    {#if lagLimit !== null}<span><i class="dashed"></i>warning {lagLimit} ms</span>{/if}
                </div>
                <HistoryChart label="Event-loop lag" unit="ms" bind:span {end} threshold={lagLimit !== null ? { value: lagLimit, label: `${lagLimit} ms` } : null} series={[{ label: 'lag max', points: hist.lag, color: 'var(--fg-brand)', fill: true }]} />
            </section>

            <section class="card" aria-label="MQTT">
                <div class="card-head">
                    {@render head('MQTT', 'messages received', 'M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16M6.5 19a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0')}
                    {#if stats?.mqttConnected !== undefined}<span class="badge" class:warn={!stats.mqttConnected}>{stats.mqttConnected ? 'connected' : 'not connected'}</span>{/if}
                </div>
                <div class="row">
                    <div class="big">{num(msgs)}<small>/s</small></div>
                    <div class="figures">
                        <div class="det">messages in</div>
                        {#if msgsPeak !== null}<div class="peak"><span class="swatch"></span>max {Math.round(msgsPeak)} /s ({spanText})</div>{/if}
                        <div class="meta" class:warn={failed > 0}>{num(topics)} topics · {failed} failed {failed === 1 ? 'command' : 'commands'} since start</div>
                    </div>
                </div>
                <HistoryChart label="MQTT messages per second" unit="/s" bind:span {end} series={[{ label: 'messages', points: hist.msgs, color: 'var(--fg-brand)', fill: true }]} />
            </section>

            <section class="card" aria-label="Script callbacks">
                <div class="card-head">{@render head('Script callbacks', 'handlers, timers, schedules', 'm8 6-6 6 6 6M16 6l6 6-6 6')}</div>
                <div class="row">
                    <div class="big">{snapshot ? totals.fires5 : '—'}<small>/5 min</small></div>
                    <div class="figures">
                        <div class="det" class:err={totals.errors5 > 0}>callbacks · {fmtMs(totals.ms5)} spent · {totals.errors5} {totals.errors5 === 1 ? 'error' : 'errors'}</div>
                        {#if callbacksPeak !== null}<div class="peak"><span class="swatch"></span>max {Math.round(callbacksPeak)} /5 min ({spanText})</div>{/if}
                        <div class="meta">{num(handlerCount)} handlers · {num(gauges?.pendingTimers ?? totals.pending)} pending timers · {num(stats?.schedules)} schedules</div>
                    </div>
                </div>
                <HistoryChart label="Script callbacks per five minutes" unit="/5 min" bind:span {end} series={[{ label: 'callbacks', points: hist.callbacks, color: 'var(--fg-brand)', fill: true }]} />
            </section>

            <section class="card" aria-label="Scripts">
                <div class="card-head">
                    {@render head('Scripts', 'the files of the script directory', 'M14 3v4a1 1 0 0 0 1 1h4M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z')}
                    {#if totals.failing > 0}<span class="badge warn" title="Scripts with a handler whose callback threw or rejected since the script was loaded">{totals.failing} with errors</span>{/if}
                </div>
                <div class="row">
                    {#if files && files.enabled > 0}
                        <RingGauge value={files.running / files.enabled} display={String(files.running)} level={files.running < files.enabled ? 'error' : totals.failing > 0 ? 'warn' : 'ok'} title="{files.running} of {files.enabled} scripts running" />
                    {:else}
                        <div class="big">{num(stats?.scripts)}</div>
                    {/if}
                    <div class="figures">
                        <div class="det">{#if files}{files.running} of {files.enabled} running{:else}running{/if}</div>
                        <div class="meta" class:warn={errorsInSpan > 0}>{errorsInSpan} {errorsInSpan === 1 ? 'error' : 'errors'} at load or in a callback in the last {spanText}</div>
                        {#if files}<div class="meta">{stats && stats.scripts > files.running ? `disabled: ${files.disabled} · ${stats.scripts - files.running} built-in` : `disabled: ${files.disabled}`}</div>{/if}
                    </div>
                </div>
                <div class="legend"><span><i style:background="var(--fg-err)"></i>script errors per {barMs === 3_600_000 ? 'hour' : `${barMs / 60_000} min`}</span></div>
                <HistoryChart label="Script errors" bind:span {end} {barMs} minTop={5} series={[{ label: 'errors', points: errorBars, color: 'var(--fg-err)' }]} />
            </section>
        </div>

        <div class="section-h"><h2>Components</h2></div>
        <div class="grid small">
            {#if handles.total > 0}
                <section class="card stat" title={handles.title}>
                    <div class="k">Active handles</div>
                    <div class="v">{handles.total}</div>
                    <div class="bars" aria-hidden="true">
                        {#each handles.parts as p, i (p.name)}<span style:flex={p.n} style:background={HANDLE_COLORS[i]}></span>{/each}
                    </div>
                    <div class="m">{handles.parts.map((p) => `${p.n} ${p.name}`).join(' · ')}</div>
                </section>
            {/if}
            {#if stats?.matterEnabled}
                <section class="card stat">
                    <div class="k">Matter</div>
                    <div class="v">{num(stats.matterNodes)}<small>{stats.matterNodes === 1 ? 'node' : 'nodes'}</small></div>
                    <div class="m">{num(stats.matterEndpoints)} endpoints</div>
                </section>
            {/if}
            {#if stats?.dbEnabled}
                <section class="card stat">
                    <div class="k">sheDB</div>
                    <div class="v">{num(stats.dbDocs)}<small>docs</small></div>
                    <div class="m">{num(stats.dbViews)} views</div>
                </section>
            {/if}
            {#if brokers.length > 0}
                <section class="card stat" title={brokers.map((b) => `${b.name}: ${b.connected ? 'connected' : 'not connected' + (b.error ? ' — ' + b.error : '')}`).join('\n')}>
                    <div class="k">Additional brokers</div>
                    <div class="v" class:warn={brokersDown.length > 0}>{brokers.length - brokersDown.length}<small>/ {brokers.length} connected</small></div>
                    {#if brokersDown.length > 0}
                        <div class="m warn">not connected: {brokersDown.map((b) => b.name).join(', ')}</div>
                    {:else}
                        <div class="m">{brokers.reduce((a, b) => a + b.mirror.in + b.mirror.out, 0)} mirrored since start</div>
                    {/if}
                </section>
            {/if}
            {#if stats?.statsTopic}
                <section class="card stat">
                    <div class="k">Stats topic</div>
                    <div class="v topic" title={stats.statsTopic}>{stats.statsTopic}</div>
                    <div class="m">{stats.statsInterval ? `retained · every ${stats.statsInterval} s` : 'retained'}</div>
                </section>
            {/if}
        </div>

        <section class="card tbl-card" aria-label="Handlers and timers">
            <div class="tbl-bar">
                <h3>Handlers and timers</h3>
                <input class="filter" type="search" placeholder="Filter by script, topic, name, kind…" aria-label="Filter handlers" bind:value={filter} />
                <label class="check"><input type="checkbox" bind:checked={pendingOnly} /><span class="checkmark"></span> Pending only</label>
                <div class="seg" role="group" aria-label="Grouping">
                    <button type="button" aria-pressed={grouped} onclick={() => (grouped = true)}>Group by script</button>
                    <button type="button" aria-pressed={!grouped} onclick={() => (grouped = false)}>Flat list</button>
                </div>
                <span class="count">{rows.length} of {allRows.length}</span>
            </div>
            {#if !snapshot}
                <div class="empty">Loading…</div>
            {:else}
                <RuntimeHandlers handlers={rows} {now} {top} {grouped} fixed showScript onjump={jump} emptyText={allRows.length === 0 ? 'No script has registered anything.' : 'Nothing matches the filter.'} />
            {/if}
        </section>
    </div>
</div>

<style>
    .page { height: 100%; --tint: color-mix(in srgb, var(--fg-brand) 15%, transparent); }
    /* the whole width of the window, as the other pages; the tiles wrap into as many columns as fit */
    .body { height: 100%; overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 20px; font-size: 14px; line-height: 1.45; }
    .body > * { flex-shrink: 0; }

    .head { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; background: var(--bg-panel); border: 1px solid var(--border-sub); border-radius: 10px; padding: 16px 20px; }
    .icon-lg { width: 52px; height: 52px; border-radius: 50%; background: var(--tint); color: var(--fg-brand); display: grid; place-items: center; flex: 0 0 auto; }
    .head-titles { flex: 1 1 260px; min-width: 0; }
    h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; color: var(--fg-text); }
    .head-sub { color: var(--fg-muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .live { color: var(--fg-muted); font-size: 13px; margin-left: 8px; font-weight: 500; letter-spacing: 0; }
    .live::before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid currentColor; box-sizing: border-box; margin-right: 5px; vertical-align: 1px; }
    .live.on { color: var(--fg-ok); }
    .live.on::before { background: currentColor; }
    .facts { display: flex; gap: 32px; flex-wrap: wrap; }
    .fact .k { color: var(--fg-muted); font-size: 12.5px; }
    .fact .v { font-size: 19px; color: var(--fg-text); font-variant-numeric: tabular-nums; }
    .btn { font: inherit; font-size: 13px; color: var(--fg); background: var(--bg-input); border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
    .btn:hover { background: var(--bg-active); }
    .btn:focus-visible, .seg button:focus-visible { outline: 2px solid var(--fg-brand); outline-offset: 2px; }

    .section-h { display: flex; align-items: baseline; gap: 12px; margin: 0 0 -8px; flex-wrap: wrap; }
    h2 { margin: 0; font-size: 12.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-muted); font-weight: 600; }
    .section-h .hint { color: var(--fg-dim); font-size: 12.5px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr)); gap: 16px; }
    .grid.small { grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr)); }

    .card { background: var(--bg-panel); border: 1px solid var(--border-sub); border-radius: 10px; padding: 18px 20px 14px; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
    .card-head { display: flex; align-items: center; gap: 10px; }
    .card-icon { width: 30px; height: 30px; border-radius: 50%; background: var(--tint); color: var(--fg-brand); display: grid; place-items: center; flex: 0 0 auto; }
    .card-titles { min-width: 0; }
    .card-title { font-size: 15.5px; font-weight: 600; color: var(--fg-text); }
    .card-sub { font-family: var(--font-mono, ui-monospace, 'Cascadia Code', Consolas, monospace); font-size: 12px; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { margin-left: auto; flex: 0 0 auto; font-size: 12px; padding: 2px 10px; border-radius: 999px; background: var(--tint); color: var(--fg-brand); }
    .badge.warn { background: color-mix(in srgb, var(--fg-warn) 15%, transparent); color: var(--fg-warn); }

    .row { display: flex; align-items: center; gap: 18px; min-height: 104px; }
    .big { font-size: 38px; font-weight: 500; color: var(--fg-text); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; min-width: 104px; text-align: center; flex: 0 0 auto; }
    .big small { font-size: 15px; color: var(--fg-muted); margin-left: 3px; letter-spacing: 0; }
    .figures { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .det { font-size: 16px; color: var(--fg-text); font-variant-numeric: tabular-nums; }
    .det.err { color: var(--fg-err); }
    .peak { color: var(--fg-muted); font-size: 13px; display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
    .swatch { width: 10px; height: 10px; border-radius: 50%; background: var(--fg-brand); opacity: 0.45; flex: 0 0 auto; }
    .meta { color: var(--fg-muted); font-size: 12.5px; overflow-wrap: anywhere; }
    .meta.warn, .m.warn, .v.warn { color: var(--fg-warn); }
    .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12.5px; color: var(--fg-muted); min-height: 18px; }
    .legend i { display: inline-block; width: 10px; height: 3px; border-radius: 2px; margin-right: 5px; vertical-align: 3px; }
    .legend i.dashed { height: 0; border-top: 1px dashed var(--fg-err); border-radius: 0; }
    /* a tile without a legend keeps the chart at the foot, level with its neighbours */
    .card > :global(.chart) { margin-top: auto; }

    .stat { padding: 14px 18px; gap: 6px; }
    .stat .k { color: var(--fg-muted); font-size: 13px; }
    .stat .v { font-size: 28px; font-weight: 500; color: var(--fg-text); font-variant-numeric: tabular-nums; }
    .stat .v small { font-size: 14px; color: var(--fg-muted); margin-left: 5px; font-weight: 400; }
    .stat .v.topic { font-size: 15px; font-family: var(--font-mono, ui-monospace, 'Cascadia Code', Consolas, monospace); padding-block: 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stat .m { color: var(--fg-muted); font-size: 12.5px; }
    .bars { display: flex; height: 6px; border-radius: 3px; overflow: hidden; gap: 2px; margin-top: 4px; }
    .bars span { display: block; min-width: 2px; }

    .tbl-card { padding: 0; gap: 0; overflow: hidden; }
    .tbl-bar { display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-bottom: 1px solid var(--border-sub); flex-wrap: wrap; }
    h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--fg-text); }
    .filter { font: inherit; font-size: 13px; background: var(--bg-input); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; width: min(320px, 100%); }
    .count { margin-left: auto; color: var(--fg-muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
    .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .seg button { font: inherit; font-size: 12.5px; background: none; color: var(--fg-muted); border: 0; padding: 4px 10px; cursor: pointer; }
    .seg button:hover { color: var(--fg); }
    .seg button[aria-pressed='true'] { background: var(--tint); color: var(--fg-brand); }
    .check { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; color: var(--fg-muted); user-select: none; white-space: nowrap; position: relative; }
    .check input[type='checkbox'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .checkmark { flex-shrink: 0; width: 13px; height: 13px; border: 1.5px solid var(--border); border-radius: 3px; background: var(--bg-input); position: relative; }
    .check input:checked + .checkmark { background: var(--accent); border-color: var(--accent); }
    .check input:checked + .checkmark::after { content: ''; position: absolute; left: 3px; top: 0px; width: 4px; height: 7px; border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg); }
    .check input:focus-visible + .checkmark { outline: 2px solid var(--fg-brand); outline-offset: 2px; }
    .empty { padding: 12px 16px; color: var(--fg-muted); font-size: 13px; }

    @media (max-width: 640px) {
        .facts { gap: 18px; }
        .row { flex-wrap: wrap; }
    }
</style>
