<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
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
    const STREAM_MAX = 20;
    let streamFeed = $state<Array<{ topic: string; val: unknown; ts: number }>>([]);
    let streamOpen = $state(true);

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
        streamFeed = [{ topic, val, ts }, ...streamFeed.slice(0, STREAM_MAX - 1)];
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
            hour: '2-digit', minute: '2-digit', hour12: false,
        });
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
    {@const depth   = n.path.split('/').length - 1}
    {@const isOpen  = expanded.has(n.path)}
    {@const hasKids = version >= 0 && n.children.size > 0}
    <div class="tn">
        <div class="tr" style="--d: {depth}">
            {#if hasKids}
                <button
                    class="chev"
                    onclick={() => toggleNode(n.path)}
                    aria-label={isOpen ? 'Collapse' : 'Expand'}
                >{isOpen ? '▾' : '▸'}</button>
            {:else}
                <span class="chev-ph"></span>
            {/if}
            <span class="seg">{n.seg}</span>
            {#if n.isLeaf && version >= 0}
                {@const e = topicMap.get(n.path)}
                {#if e !== undefined}
                    <span class="tv" title={fmtVal(e.val)}>{fmtVal(e.val)}</span>
                    <span class="tt">{fmtTime(e.ts)}</span>
                {/if}
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
        <input class="filter-in" type="search" placeholder="Filter topics…" bind:value={filter} />
        <span class="count">
            {#if filter}{flatList.length} /{/if} {totalCount}
        </span>
    </div>

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

    <!-- Live stream pane -->
    <div class="stream-panel">
        <button class="stream-hdr" onclick={() => { streamOpen = !streamOpen; }}>
            <span class="stream-chev">{streamOpen ? '▾' : '▸'}</span>
            Live stream
            {#if !streamOpen && streamFeed.length > 0}
                <span class="stream-badge">{streamFeed.length}</span>
            {/if}
        </button>
        {#if streamOpen}
            <div class="stream-body">
                {#if streamFeed.length === 0}
                    <span class="stream-empty">Waiting for messages…</span>
                {:else}
                    {#each streamFeed as row (`${row.ts}-${row.topic}`)}
                        <div class="sr">
                            <span class="s-ts">{fmtTime(row.ts)}</span>
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
    .filter-in {
        flex: 1;
        max-width: 360px;
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
        margin-left: auto;
        white-space: nowrap;
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
        padding-left: calc(4px + var(--d, 0) * 16px);
        cursor: default;
        user-select: none;
    }
    .tr:hover { background: var(--bg-hover); }
    .chev {
        background: none;
        border: none;
        color: var(--fg-muted);
        padding: 0;
        width: 16px;
        font-size: 10px;
        cursor: pointer;
        flex-shrink: 0;
        line-height: 1;
    }
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
    .tc { display: block; }

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
        max-height: 160px;
        display: flex;
        flex-direction: column;
    }
    .stream-hdr {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px;
        font-size: 12px;
        font-weight: 600;
        color: var(--fg-muted);
        background: none;
        border: none;
        cursor: pointer;
        text-align: left;
        width: 100%;
        user-select: none;
    }
    .stream-hdr:hover { color: var(--fg); }
    .stream-chev { font-size: 10px; color: var(--fg-dim); }
    .stream-badge {
        font-size: 10px;
        background: var(--accent);
        color: #fff;
        border-radius: 8px;
        padding: 0 5px;
        line-height: 1.4;
    }
    .stream-body {
        overflow-y: auto;
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
    .s-ts { color: var(--fg-dim); font-size: 11px; flex-shrink: 0; width: 50px; }
    .s-topic { color: var(--fg-value); flex-shrink: 0; min-width: 180px; }
    .s-val {
        color: var(--fg);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
    }
</style>
