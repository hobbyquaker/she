<script lang="ts">
    import { onMount, onDestroy, untrack } from 'svelte';
    import { subscribeWs } from '../lib/ws.js';
    import { fetchMqttState, publishMqtt } from '../lib/api.js';

    /* ── Non-reactive data store ──────────────────────────────────────────────
     * topicMap holds all known topic values. It is intentionally NOT $state —
     * that avoids making Svelte deeply track a 2000-entry Map. Reactivity is
     * driven solely by bumping `version` once per animation frame after all
     * pending WS messages have been applied.
     * ─────────────────────────────────────────────────────────────────────── */
    const topicMap = new Map<string, { val: unknown; ts: number }>();
    const pending = new Set<string>();
    let rafId: number | null = null;
    let version = $state(0);

    function scheduleFlush() {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
            rafId = null;
            for (const t of pending) ensureNode(t);
            pending.clear();
            version++;
        });
    }

    /* ── Topic tree ───────────────────────────────────────────────────────── */
    interface TreeNode {
        seg: string;      // single path segment, e.g. "living"
        path: string;     // full path,            e.g. "home/living"
        children: Map<string, TreeNode>;
        isLeaf: boolean;  // this path exists as a topic in topicMap
    }

    const roots = new Map<string, TreeNode>();

    function ensureNode(topic: string) {
        const parts = topic.split('/');
        let map = roots;
        let path = '';
        for (let i = 0; i < parts.length; i++) {
            const seg = parts[i];
            path = i === 0 ? seg : `${path}/${seg}`;
            if (!map.has(seg)) map.set(seg, { seg, path, children: new Map(), isLeaf: false });
            const node = map.get(seg)!;
            if (i === parts.length - 1) node.isLeaf = true;
            map = node.children;
        }
    }

    /* Assign a new Set on each toggle so Svelte detects the change. */
    let expanded = $state(new Set<string>());

    function toggleNode(path: string) {
        const s = new Set(expanded);
        s.has(path) ? s.delete(path) : s.add(path);
        expanded = s;
    }

    /* ── Filter + virtual scroll ──────────────────────────────────────────── */
    let filter = $state('');

    const ROW_H = 24;    // px per row in the virtual-scroll list
    const OVERSCAN = 5;  // extra rows above/below the visible viewport

    let scrollTop  = $state(0);
    let containerH = $state(300);

    /* Flat sorted list — only materialised when filter is non-empty. */
    let flatList = $derived.by(() => {
        void version; // re-evaluate whenever data changes
        if (!filter) return [] as Array<{ topic: string; val: unknown; ts: number }>;
        const tokens = filter.toLowerCase().split(/\s+/).filter(Boolean);
        const out: Array<{ topic: string; val: unknown; ts: number }> = [];
        for (const [topic, e] of topicMap) {
            const lc = topic.toLowerCase();
            if (tokens.every((t) => lc.includes(t))) out.push({ topic, ...e });
        }
        return out.sort((a, b) => a.topic.localeCompare(b.topic));
    });

    let vslice = $derived.by(() => {
        const n = flatList.length;
        const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
        const end   = Math.min(n, Math.ceil((scrollTop + containerH) / ROW_H) + OVERSCAN);
        return { start, end, totalH: n * ROW_H, top: start * ROW_H };
    });

    /* ── Live stream pane ─────────────────────────────────────────────────── */
    const STREAM_MAX   = 1000;  // raw buffer — large enough to rebuild any filter
    const FILTER_MAX   = 200;   // per-filter rolling buffer cap
    const STREAM_ROW_H = 20;    // px — matches .sr { height: 20px }
    const STREAM_HDR_H = 36;    // px — resize handle + header row
    let _streamSeq = 0;
    type StreamRow = { id: number; topic: string; val: unknown; ts: number };
    let streamFeed   = $state<StreamRow[]>([]);  // raw rolling buffer (all messages)
    let filteredFeed = $state<StreamRow[]>([]);  // only rows matching current filter
    let streamOpen   = $state(true);
    let streamFilter = $state('#');
    let streamHeight = $state(200);

    // When the filter changes, rebuild filteredFeed from the raw buffer.
    // untrack(streamFeed) prevents this effect from re-running on every new message.
    $effect(() => {
        const pat = streamFilter.trim();
        const feed = untrack(() => streamFeed);
        filteredFeed = (!pat || pat === '#')
            ? feed.slice(0, FILTER_MAX)
            : feed.filter(r => mqttMatch(pat, r.topic)).slice(0, FILTER_MAX);
    });

    function mqttMatch(pattern: string, topic: string): boolean {
        if (pattern === '#') return true;
        const pp = pattern.split('/');
        const tp = topic.split('/');
        for (let i = 0; i < pp.length; i++) {
            if (pp[i] === '#') return true;
            if (i >= tp.length) return false;
            if (pp[i] !== '+' && pp[i] !== tp[i]) return false;
        }
        return pp.length === tp.length;
    }

    function startResize(e: MouseEvent) {
        e.preventDefault();
        const startY = e.clientY;
        const startH = streamHeight;
        function onMove(ev: MouseEvent) {
            streamHeight = Math.max(60, Math.min(800, startH + startY - ev.clientY));
        }
        function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    let filteredStream = $derived.by(() => {
        const max = Math.max(1, Math.floor((streamHeight - STREAM_HDR_H) / STREAM_ROW_H) + 1);
        return filteredFeed.slice(0, max);
    });

    /* ── Initial load ─────────────────────────────────────────────────────── */
    let loading   = $state(true);
    let loadError: string | null = $state(null);

    async function load() {
        loading = true;
        loadError = null;
        try {
            const entries = await fetchMqttState();
            for (const e of entries) {
                topicMap.set(e.topic, { val: e.val, ts: e.ts });
                ensureNode(e.topic);
            }
        } catch (e: unknown) {
            loadError = e instanceof Error ? e.message : String(e);
        } finally {
            loading = false;
            version++;
        }
    }

    /* Live updates — write directly into the Map, queue topic for ensureNode,
     * then schedule a batched rAF flush that bumps `version` once. */
    const unsubWs = subscribeWs('mqtt', (msg) => {
        const { topic, val, ts } = msg as { topic: string; val: unknown; ts: number };
        topicMap.set(topic, { val, ts });
        pending.add(topic);
        scheduleFlush();
        // Feed the live stream pane (newest first, capped at STREAM_MAX)
        const row: StreamRow = { id: _streamSeq++, topic, val, ts };
        streamFeed = [row, ...streamFeed.slice(0, STREAM_MAX - 1)];
        // Also push to filteredFeed if the message matches the current filter
        const pat = streamFilter.trim();
        if (!pat || pat === '#' || mqttMatch(pat, topic)) {
            filteredFeed = [row, ...filteredFeed.slice(0, FILTER_MAX - 1)];
        }
    });

    /* ── Publish ──────────────────────────────────────────────────────────── */
    let pubTopic   = $state('');
    let pubPayload = $state('');
    let pubRetain  = $state(false);
    let pubQos     = $state<0 | 1 | 2>(0);
    let pubBusy    = $state(false);
    let pubError: string | null = $state(null);
    let pubOk      = $state(false);

    async function publish() {
        if (!pubTopic) return;
        pubBusy = true; pubError = null; pubOk = false;
        try {
            await publishMqtt(pubTopic, pubPayload, pubRetain, pubQos);
            pubOk = true;
            setTimeout(() => { pubOk = false; }, 2000);
        } catch (e: unknown) {
            pubError = e instanceof Error ? e.message : String(e);
        } finally {
            pubBusy = false;
        }
    }

    /* ── Helpers ──────────────────────────────────────────────────────────── */
    function fmtVal(val: unknown): string {
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
    }

    function fmtTime(ts: number): string {
        return new Date(ts).toLocaleTimeString(undefined, {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
    }

    function fmtTimeStream(ts: number): string {
        return new Date(ts).toLocaleTimeString(undefined, {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
    }

    /**
     * Read a topic entry with `version` as a reactive dependency so that text-node
     * expressions calling this function re-run on every rAF flush.
     * ({@const} captures values once at block render; calling this directly inside
     * `{expr}` creates per-expression effects that properly track `version`.)
     */
    function liveEntry(path: string) {
        void version;
        return topicMap.get(path);
    }

    /* ── Derived ──────────────────────────────────────────────────────────── */
    let rootList = $derived.by(() => {
        void version;
        return [...roots.values()].sort((a, b) => a.seg.localeCompare(b.seg));
    });

    let totalCount = $derived.by(() => { void version; return topicMap.size; });

    onMount(load);
    onDestroy(() => { unsubWs(); if (rafId !== null) cancelAnimationFrame(rafId); });
</script>

<!--
    Recursive tree-node snippet.
    `version` is referenced via `version >= 0` guards so the entire body
    re-evaluates on each rAF flush.  Only expanded branches have DOM children —
    collapsed nodes cost zero DOM nodes.
-->
{#snippet treeNode(n: TreeNode)}
    {@const isOpen  = expanded.has(n.path)}
    {@const hasKids = version >= 0 && n.children.size > 0}
    <div class="tn">
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="tr" onclick={() => { streamFilter = n.path + '/#'; }}>
            {#if hasKids}
                <button
                    class="chev"
                    class:open={isOpen}
                    onclick={() => toggleNode(n.path)}
                    aria-label={isOpen ? 'Collapse' : 'Expand'}
                >›</button>
            {:else}
                <span class="chev-ph"></span>
            {/if}
            <span class="seg">{n.seg}</span>
            {#if n.isLeaf && topicMap.has(n.path)}
                <span class="tv" title={fmtVal(liveEntry(n.path)?.val)}>{fmtVal(liveEntry(n.path)?.val)}</span>
                <span class="tt">{liveEntry(n.path)?.ts != null ? fmtTime(liveEntry(n.path)!.ts) : ''}</span>
            {/if}
        </div>
        {#if hasKids && isOpen}
            <div class="tc">
                {#each [...n.children.values()].sort((a, b) => a.seg.localeCompare(b.seg)) as child (child.path)}
                    {@render treeNode(child)}
                {/each}
            </div>
        {/if}
    </div>
{/snippet}

<div class="page">
    <!-- Toolbar -->
    <div class="toolbar">
        <h2>MQTT</h2>
    </div>

    <!-- Grouped panel: publish + filter + tree -->
    <div class="main-group">
        <!-- Publish bar -->
        <div class="pub-bar">
            <input class="pt" type="text" placeholder="topic"   bind:value={pubTopic} />
            <input class="pp" type="text" placeholder="payload" bind:value={pubPayload} />
            <label class="rl"><input type="checkbox" bind:checked={pubRetain} /> retain</label>
            <select bind:value={pubQos}>
                <option value={0}>QoS 0</option>
                <option value={1}>QoS 1</option>
                <option value={2}>QoS 2</option>
            </select>
            <button onclick={publish} disabled={pubBusy || !pubTopic}>Publish</button>
            {#if pubOk}<span class="pub-ok">✓</span>{/if}
            {#if pubError}<span class="pub-err">{pubError}</span>{/if}
        </div>

        <!-- Topic filter above tree -->
        <div class="tree-filter-bar">
            <input class="filter-in" type="search" placeholder="Filter topics…" bind:value={filter} />
            <span class="count">
                {#if filter}{flatList.length} /{/if} {totalCount}
            </span>
        </div>

        <!-- Content -->
        {#if loading}
            <div class="info">Loading…</div>
        {:else if loadError}
            <div class="info err">{loadError}</div>
        {:else if filter}
            <!-- Filter mode: virtual-scrolled flat list -->
            {#if flatList.length === 0}
                <div class="info">No topics match.</div>
            {:else}
                <div
                    class="vs"
                    bind:clientHeight={containerH}
                    onscroll={(e) => { scrollTop = (e.currentTarget as HTMLDivElement).scrollTop; }}
                >
                    <div style="height: {vslice.totalH}px; position: relative;">
                        <div class="vrows-abs" style="top: {vslice.top}px;">
                            {#each flatList.slice(vslice.start, vslice.end) as row (row.topic)}
                                <div class="vr">
                                    <span class="v-topic">{row.topic}</span>
                                    <span class="v-val" title={fmtVal(row.val)}>{fmtVal(row.val)}</span>
                                    <span class="v-ts">{fmtTime(row.ts)}</span>
                                </div>
                            {/each}
                        </div>
                    </div>
                </div>
            {/if}
        {:else}
            <!-- Tree mode: only expanded branches are in the DOM -->
            <div class="tree-wrap">
                {#if rootList.length === 0}
                    <div class="info">No topics yet.</div>
                {:else}
                    {#each rootList as n (n.path)}
                        {@render treeNode(n)}
                    {/each}
                {/if}
            </div>
        {/if}
    </div>

    <!-- Live stream pane -->
    <div class="stream-panel" style={streamOpen ? `height: ${streamHeight}px;` : ''}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="stream-resize" onmousedown={startResize}></div>
        <div class="stream-hdr-row">
            <input class="filter-in stream-filter-in" type="search" placeholder="Live stream filter (MQTT wildcard, default: #)" bind:value={streamFilter} />
            {#if !streamOpen && filteredFeed.length > 0}
                <span class="stream-badge">{filteredFeed.length}</span>
            {/if}
            <button class="stream-toggle" onclick={() => { streamOpen = !streamOpen; }} title="Toggle live stream">
                {streamOpen ? '▾' : '▸'}
            </button>
        </div>
        {#if streamOpen}
            <div class="stream-body">
                {#if filteredStream.length === 0}
                    <span class="stream-empty">Waiting for messages…</span>
                {:else}
                    {#each filteredStream as row (row.id)}
                        <div class="sr">
                            <span class="s-ts">{fmtTimeStream(row.ts)}</span>
                            <span class="s-topic">{row.topic}</span>
                            <span class="s-val" title={fmtVal(row.val)}>{fmtVal(row.val)}</span>
                        </div>
                    {/each}
                {/if}
            </div>
        {/if}
    </div>
</div>

<style>
    .page {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    /* ── Toolbar ── */
    .toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
    }
    .toolbar h2 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--fg);
    }

    /* ── Grouped panel (publish + filter + tree) ── */
    .main-group {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    /* ── Publish bar ── */
    .pub-bar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
    }

    /* ── Tree filter bar ── */
    .tree-filter-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 12px;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
        background: var(--bg-panel);
    }
    .filter-in {
        flex: 1;
        background: var(--bg-app);
        border: 1px solid var(--border);
        border-radius: 3px;
        color: var(--fg);
        padding: 3px 8px;
        font-size: 13px;
    }
    .count {
        font-size: 12px;
        color: var(--fg-dim);
        white-space: nowrap;
    }
    .pt { width: 240px; }
    .pp { flex: 1; }
    .pt, .pp {
        background: var(--bg-app);
        border: 1px solid var(--border);
        border-radius: 3px;
        color: var(--fg);
        padding: 3px 8px;
        font-size: 13px;
    }
    .rl {
        font-size: 12px;
        color: var(--fg-muted);
        display: flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
    }
    select {
        background: var(--bg-widget);
        border: 1px solid var(--border);
        color: var(--fg);
        padding: 3px 6px;
        font-size: 12px;
        border-radius: 3px;
    }
    button {
        background: var(--accent);
        border: none;
        color: #fff;
        padding: 4px 12px;
        border-radius: 3px;
        font-size: 12px;
        cursor: pointer;
    }
    button:disabled { opacity: 0.5; cursor: default; }
    .pub-ok { color: var(--fg-ok); font-size: 13px; }
    .pub-err { color: var(--fg-err); font-size: 12px; }

    /* ── Shared ── */
    .info { padding: 24px 16px; color: var(--fg-dim); font-size: 13px; }
    .info.err { color: var(--fg-err); }

    /* ── Tree ── */
    .tree-wrap {
        flex: 1;
        overflow: auto;
        font-size: 13px;
    }
    .tn { display: block; }
    .tr {
        display: flex;
        align-items: center;
        gap: 4px;
        height: 22px;
        padding-left: 8px;
        cursor: pointer;
        user-select: none;
    }
    .tr:hover { background: var(--bg-hover); }
    .chev {
        background: none;
        border: none;
        color: var(--fg-muted);
        padding: 0;
        width: 16px;
        font-size: 14px;
        font-weight: 300;
        cursor: pointer;
        flex-shrink: 0;
        line-height: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.12s ease;
    }
    .chev.open { transform: rotate(90deg); }
    .chev:hover { color: var(--fg); }
    .chev-ph { width: 16px; flex-shrink: 0; display: inline-block; }
    .seg {
        color: var(--fg);
        font-family: monospace;
        font-size: 12px;
        flex-shrink: 0;
    }
    .tv {
        color: var(--fg-value);
        font-family: monospace;
        font-size: 12px;
        margin-left: 8px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
    }
    .tt {
        color: var(--fg-dim);
        font-size: 11px;
        flex-shrink: 0;
        margin-left: 8px;
        padding-right: 12px;
    }
    .tc {
        display: block;
        margin-left: 12px;
        border-left: 1px solid var(--indent-line);
    }

    /* ── Virtual scroll (filter mode) ── */
    .vs {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        font-size: 13px;
    }
    .vrows-abs {
        position: absolute;
        width: 100%;
    }
    .vr {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 24px;
        padding: 0 12px;
    }
    .vr:hover { background: var(--bg-hover); }
    .v-topic {
        font-family: monospace;
        font-size: 12px;
        color: var(--fg-value);
        white-space: nowrap;
        flex-shrink: 0;
        min-width: 200px;
    }
    .v-val {
        font-family: monospace;
        font-size: 12px;
        color: var(--fg);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
    }
    .v-ts {
        color: var(--fg-dim);
        font-size: 11px;
        flex-shrink: 0;
        white-space: nowrap;
    }

    /* ── Live stream pane ── */
    .stream-panel {
        flex-shrink: 0;
        border-top: 1px solid var(--border);
        background: var(--bg-panel);
        display: flex;
        flex-direction: column;
        min-height: 28px;
    }
    .stream-resize {
        height: 5px;
        margin-top: -3px;
        cursor: ns-resize;
        flex-shrink: 0;
        background: transparent;
        transition: background 0.15s;
    }
    .stream-resize:hover { background: var(--accent); opacity: 0.4; }
    .stream-hdr-row {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        padding: 4px 8px 4px 12px;
        gap: 6px;
        border-bottom: 1px solid var(--border-sub);
    }
    .stream-filter-in {
        flex: 1;
        max-width: unset;
    }
    .stream-toggle {
        background: none;
        border: none;
        color: var(--fg-dim);
        cursor: pointer;
        padding: 2px 6px;
        font-size: 11px;
        border-radius: 3px;
        flex-shrink: 0;
    }
    .stream-toggle:hover { background: var(--bg-hover); color: var(--fg); }
    .stream-body {
        overflow: hidden;
        flex: 1;
        font-size: 12px;
        font-family: monospace;
    }
    .stream-empty { padding: 4px 12px; color: var(--fg-dim); font-style: italic; }
    .sr {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 20px;
        padding: 0 12px;
    }
    .sr:hover { background: var(--bg-hover); }
    .s-ts { color: var(--fg-dim); font-size: 11px; flex-shrink: 0; width: 64px; }
    .s-topic { color: var(--fg-value); flex-shrink: 0; min-width: 180px; }
    .s-val {
        color: var(--fg);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
    }
</style>
