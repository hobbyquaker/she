<script lang="ts">
    /**
     * The Thread tab of the Matter page, part 1 (roadmap M15, D-12): the Thread networks on the
     * LAN with their border routers, from the `_meshcop` mDNS announcements; a border router with
     * the OpenThread REST API shows its role and leader data. Read-only.
     */
    import { onDestroy, untrack } from 'svelte';
    import { subscribeWs } from '../../lib/ws.js';
    import { getThreadNetworks, refreshThreadNetworks, probeThreadRouter, getThreadMesh, refreshThreadMesh, type ThreadNetworks, type ThreadBorderRouter, type ThreadMesh, type MeshNode, type MeshLink } from '../../lib/api.js';
    import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, type Simulation, type SimulationNodeDatum, type SimulationLinkDatum } from 'd3-force';

    let { active = false }: { active?: boolean } = $props();

    let data = $state<ThreadNetworks | null>(null);
    let loaded = $state(false);
    let loading = $state(false);
    let error = $state<string | null>(null);
    let probing = $state<string | null>(null);

    async function load() {
        error = null;
        try {
            data = await getThreadNetworks();
            loaded = true;
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
    }
    async function refresh() {
        loading = true;
        error = null;
        try {
            data = await refreshThreadNetworks();
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            loading = false;
        }
    }
    async function probe(br: ThreadBorderRouter) {
        probing = br.extAddress;
        try {
            await probeThreadRouter(br.extAddress);
            await load();
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            probing = null;
        }
    }
    $effect(() => {
        if (active && !loaded) untrack(load);
    });
    const unsub = subscribeWs('matter:thread', () => { if (loaded) load(); });
    onDestroy(unsub);

    function ago(ts: number | null): string {
        if (!ts) return '—';
        const s = Math.round((Date.now() - ts) / 1000);
        if (s < 60) return `${s} s ago`;
        if (s < 3600) return `${Math.round(s / 60)} min ago`;
        return `${Math.round(s / 3600)} h ago`;
    }
    function hexAddr(s: string): string {
        return s.replace(/(..)(?=.)/g, '$1:').toLowerCase();
    }
    let total = $derived(data ? data.networks.reduce((n, x) => n + x.routerCount, 0) + data.unknown.length : 0);

    // ── The mesh graph (M16): d3-force in an SVG ───────────────────────────────
    type GNode = MeshNode & SimulationNodeDatum;
    type GLink = SimulationLinkDatum<GNode> & MeshLink;
    let mesh = $state<ThreadMesh | null>(null);
    let meshError = $state<string | null>(null);
    let meshRefreshing = $state(false);
    let gNodes = $state<GNode[]>([]);
    let gLinks = $state<GLink[]>([]);
    let selectedNode = $state<GNode | null>(null);
    let svgEl = $state<SVGSVGElement | undefined>(undefined);
    let W = $state(800);
    let H = $state(420);
    let sim: Simulation<GNode, GLink> | null = null;

    async function loadMesh() {
        meshError = null;
        try {
            mesh = await getThreadMesh();
            layout();
        } catch (e) {
            meshError = e instanceof Error ? e.message : String(e);
        }
    }
    async function refreshMesh(nodeId?: string) {
        meshRefreshing = true;
        meshError = null;
        try {
            mesh = await refreshThreadMesh(nodeId);
            layout();
        } catch (e) {
            meshError = e instanceof Error ? e.message : String(e);
        } finally {
            meshRefreshing = false;
        }
    }
    /** keep positions of nodes that stay, add the new ones near the centre, let the forces settle */
    function layout() {
        if (!mesh) return;
        const prev = new Map(gNodes.map((n) => [n.id, n]));
        const nodes: GNode[] = mesh.nodes.map((n) => ({ ...n, x: prev.get(n.id)?.x ?? W / 2 + (Math.random() - 0.5) * 80, y: prev.get(n.id)?.y ?? H / 2 + (Math.random() - 0.5) * 80 }));
        const byId = new Map(nodes.map((n) => [n.id, n]));
        const links: GLink[] = mesh.links.filter((l) => byId.has(l.source) && byId.has(l.target)).map((l) => ({ ...l }));
        sim?.stop();
        sim = forceSimulation<GNode, GLink>(nodes)
            .force('link', forceLink<GNode, GLink>(links).id((d) => d.id).distance((l) => (l.kind === 'binding' ? 120 : l.quality === 'good' ? 70 : l.quality === 'fair' ? 110 : 150)).strength((l) => (l.kind === 'binding' ? 0.05 : 0.6)))
            .force('charge', forceManyBody().strength(-260))
            .force('center', forceCenter(W / 2, H / 2))
            .force('collide', forceCollide(28))
            .alpha(1)
            .on('tick', () => { gNodes = nodes; gLinks = links; });
        gNodes = nodes;
        gLinks = links;
        if (selectedNode) selectedNode = byId.get(selectedNode.id) ?? null;
    }
    $effect(() => {
        if (active && !mesh) untrack(loadMesh);
    });
    $effect(() => {
        if (!svgEl) return;
        const ro = new ResizeObserver(() => { const r = svgEl!.getBoundingClientRect(); if (r.width > 0) { W = r.width; H = Math.max(320, r.height); sim?.force('center', forceCenter(W / 2, H / 2)).alpha(0.3).restart(); } });
        ro.observe(svgEl);
        return () => ro.disconnect();
    });
    onDestroy(() => sim?.stop());
    const unsubMesh = subscribeWs('matter:deviceStatus', () => { if (mesh) loadMesh(); });
    onDestroy(unsubMesh);

    // drag
    let dragging: GNode | null = null;
    function dragStart(n: GNode, e: PointerEvent) {
        dragging = n;
        n.fx = n.x; n.fy = n.y;
        sim?.alphaTarget(0.3).restart();
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
    }
    function dragMove(e: PointerEvent) {
        if (!dragging || !svgEl) return;
        const r = svgEl.getBoundingClientRect();
        dragging.fx = e.clientX - r.left;
        dragging.fy = e.clientY - r.top;
    }
    function dragEnd() {
        if (!dragging) return;
        dragging.fx = null; dragging.fy = null;
        dragging = null;
        sim?.alphaTarget(0);
    }
    function pos(l: GLink, which: 'source' | 'target'): { x: number; y: number } {
        const n = l[which] as GNode;
        return { x: n?.x ?? 0, y: n?.y ?? 0 };
    }
    function nodeColor(n: GNode): string {
        if (n.kind === 'border-router' || n.borderRouter) return '#c678dd';
        if (n.kind === 'external') return '#7f848e';
        if (n.kind === 'wifi') return n.quality === 'good' ? '#61afef' : n.quality === 'fair' ? '#e5a86b' : '#e06c75';
        if (!n.online) return '#5c6370';
        if (n.roleCode === 6) return '#e5c07b';
        if (n.roleCode === 5 || n.roleCode === 4) return '#98c379';
        if (n.roleCode === 2) return '#56b6c2';
        return '#61afef';
    }
    function linkColor(l: GLink): string {
        if (l.kind === 'binding') return 'var(--accent, #569cd6)';
        return l.quality === 'good' ? '#98c379' : l.quality === 'fair' ? '#e5a86b' : l.quality === 'poor' ? '#e06c75' : '#5c6370';
    }
    function roleGlyph(n: GNode): string {
        if (n.kind === 'border-router' || n.borderRouter) return 'BR';
        if (n.kind === 'external') return '?';
        if (n.kind === 'wifi') return 'Wi‑Fi';
        if (n.roleCode === 6) return 'L';
        if (n.roleCode === 5) return 'R';
        if (n.roleCode === 4) return 'RE';
        if (n.roleCode === 2) return 'Zz';
        if (n.roleCode === 3) return 'ED';
        return '·';
    }
</script>

<div class="thread">
    <div class="bar">
        <span class="title">Thread networks</span>
        {#if data}<span class="count">{data.networks.length} network{data.networks.length === 1 ? '' : 's'} · {total} border router{total === 1 ? '' : 's'}{data.running ? '' : ' · discovery not running'}</span>{/if}
        <button class="ghost" onclick={refresh} disabled={loading} title="Probe every border router's REST API again">{loading ? '…' : '↺'}</button>
        <span class="spacer"></span>
        <span class="hint">Passive mDNS (<code>_meshcop._udp</code>) — what every border agent on the LAN announces. Nothing is written to a border router.</span>
    </div>
    {#if error}<p class="err">{error}</p>{/if}
    {#if !loaded}
        <div class="info">Loading…</div>
    {:else if data && data.networks.length === 0 && data.unknown.length === 0}
        <div class="info">No border router announced itself yet. Apple TV and HomePod announce their Thread network only on the LAN they are on; OpenThread border routers and the ESP router announce <code>_meshcop._udp</code> as soon as they run. Discovery is passive — give it a minute.</div>
    {:else if data}
        <div class="body">
            {#each data.networks as net (net.extPanId)}
                <section class="net">
                    <div class="net-hdr">
                        <span class="net-name">{net.networkName ?? 'unnamed network'}</span>
                        <span class="mono dim">ext PAN ID {net.extPanId}</span>
                        <span class="dim">· {net.routerCount} border router{net.routerCount === 1 ? '' : 's'}</span>
                        {#if net.partitions.length > 1}<span class="badge b-warn" title="More than one partition ID announced — the network may be split">{net.partitions.length} partitions</span>{/if}
                        {#if net.datasetKnown}<span class="badge b-ok">she knows the credentials</span>{:else}<span class="badge">credentials unknown</span>{/if}
                    </div>
                    <table>
                        <thead><tr><th>Border router</th><th>Thread</th><th>State</th><th>Addresses</th><th>REST API</th><th>Seen</th><th></th></tr></thead>
                        <tbody>
                            {#each net.borderRouters as br (br.extAddress)}
                                <tr>
                                    <td>
                                        <div class="br-name">{br.vendorName ?? '?'} {br.modelName ?? ''}</div>
                                        <div class="dim mono">{hexAddr(br.extAddress)}{br.hostname ? ` · ${br.hostname.replace(/\.$/, '')}` : ''}</div>
                                        {#if br.swVersion}<div class="dim">firmware {br.swVersion}</div>{/if}
                                    </td>
                                    <td>{br.threadVersion ?? '—'}{#if br.partitionId}<div class="dim mono">partition {br.partitionId}</div>{/if}</td>
                                    <td>
                                        {#if br.state}
                                            <div>{br.state.role}{br.state.bbrPrimary ? ' · primary BBR' : br.state.bbrActive ? ' · BBR' : ''}</div>
                                            <div class="dim">{br.state.interfaceStatus} · {br.state.connectionMode}{br.state.epskcSupported ? ' · ePSKc' : ''}</div>
                                        {:else}—{/if}
                                    </td>
                                    <td class="mono addrs">{#each br.addresses as a (a)}<div>{a}</div>{/each}{#if br.meshcopPort}<div class="dim">meshcop :{br.meshcopPort}</div>{/if}</td>
                                    <td>
                                        {#if br.rest?.manageable}
                                            <div class="ok">manageable <span class="dim">(:{br.rest.port})</span></div>
                                            {#if br.rest.node}<div class="dim">{br.rest.node.role ?? br.rest.node.state}{br.rest.node.rloc16 !== null ? ` · RLOC16 0x${br.rest.node.rloc16.toString(16).padStart(4, '0')}` : ''}{br.rest.node.leaderData ? ` · leader router ${br.rest.node.leaderData.leaderRouterId}, partition ${br.rest.node.leaderData.partitionId}` : ''}{br.rest.node.numOfRouter !== null ? ` · ${br.rest.node.numOfRouter} routers` : ''}</div>{/if}
                                        {:else if br.rest}
                                            <div class="dim">none{br.rest.error ? ` (${br.rest.error})` : ''}</div>
                                        {:else}
                                            <div class="dim">not probed yet</div>
                                        {/if}
                                    </td>
                                    <td class="dim">{ago(br.lastSeen)}</td>
                                    <td class="c-act"><button class="ghost sm" disabled={probing === br.extAddress} onclick={() => probe(br)} title="Probe the OpenThread REST API (OTBR port 8081, esp-thread-br port 80)">{probing === br.extAddress ? '…' : 'probe'}</button></td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </section>
            {/each}
            <section class="net mesh">
                <div class="net-hdr">
                    <span class="net-name">Mesh</span>
                    {#if mesh}<span class="dim">· {mesh.nodes.filter((n) => n.kind === 'thread').length} Thread device{mesh.nodes.filter((n) => n.kind === 'thread').length === 1 ? '' : 's'} in she's fabric · {mesh.links.filter((l) => l.kind === 'neighbour').length} link{mesh.links.filter((l) => l.kind === 'neighbour').length === 1 ? '' : 's'}{mesh.lastRefresh ? ` · tables read ${ago(mesh.lastRefresh)}` : ' · tables from the subscriptions'}</span>{/if}
                    <span class="spacer"></span>
                    <button class="ghost sm" onclick={() => refreshMesh()} disabled={meshRefreshing} title="Re-read every Thread device's neighbour and route tables (sleepy devices answer slowly)">{meshRefreshing ? 'reading…' : 'refresh with neighbours'}</button>
                </div>
                <p class="hint">From every Thread device's Network Diagnostics cluster: links coloured by link quality (<span class="lq good">LQI 3</span> · <span class="lq fair">2</span> · <span class="lq poor">1</span>), a dashed link is seen from one side only, a child link is drawn thicker; a <span class="lq br">BR</span> is a border router, <span class="lq ext">?</span> a neighbour not paired with she; dotted arrows are bindings. Drag nodes; click one for details.</p>
                {#if meshError}<p class="err">{meshError}</p>{/if}
                {#if mesh && mesh.nodes.length === 0}
                    <div class="info">No Thread device in she's fabric yet.</div>
                {:else}
                    <div class="graph-wrap">
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <svg bind:this={svgEl} class="graph" viewBox="0 0 {W} {H}" onpointermove={dragMove} onpointerup={dragEnd} onpointerleave={dragEnd}>
                            <defs>
                                <marker id="arrow" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent, #569cd6)" /></marker>
                            </defs>
                            {#each gLinks as l (l.kind + '|' + (l.source as GNode).id + '|' + (l.target as GNode).id)}
                                {@const a = pos(l, 'source')}
                                {@const b = pos(l, 'target')}
                                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={linkColor(l)} stroke-width={l.kind === 'binding' ? 1.5 : l.isChild ? 3 : 1.5} stroke-dasharray={l.kind === 'binding' ? '2 4' : l.bidirectional === false ? '6 4' : undefined} marker-end={l.kind === 'binding' ? 'url(#arrow)' : undefined} opacity={selectedNode && (l.source as GNode).id !== selectedNode.id && (l.target as GNode).id !== selectedNode.id ? 0.25 : 0.9}>
                                    <title>{l.kind === 'binding' ? `binding ${l.label ?? ''}` : `LQI ${l.lqi}${l.lqiBack !== null && l.lqiBack !== undefined ? ' / ' + l.lqiBack : ''}${l.rssi !== null && l.rssi !== undefined ? ` · ${l.rssi} dBm` : ''}${l.isChild ? ' · child' : ''}`}</title>
                                </line>
                            {/each}
                            {#each gNodes as n (n.id)}
                                <g class="gnode" class:sel={selectedNode?.id === n.id} transform="translate({n.x ?? 0},{n.y ?? 0})" role="button" tabindex="0" onpointerdown={(e) => dragStart(n, e)} onclick={() => (selectedNode = selectedNode?.id === n.id ? null : n)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') selectedNode = selectedNode?.id === n.id ? null : n; }}>
                                    <circle r={n.kind === 'external' ? 11 : 15} fill={nodeColor(n)} stroke={selectedNode?.id === n.id ? 'var(--fg-text)' : 'var(--bg-app)'} stroke-width="2" opacity={n.online ? 1 : 0.5} />
                                    <text class="glyph" text-anchor="middle" dy="4">{roleGlyph(n)}</text>
                                    <text class="label" text-anchor="middle" dy="30">{n.name}</text>
                                    <title>{n.name}{n.role ? ` · ${n.role}` : ''}{n.rloc16 !== null && n.rloc16 !== undefined ? ` · RLOC16 0x${n.rloc16.toString(16).padStart(4, '0')}` : ''}{n.rssi !== null && n.rssi !== undefined ? ` · ${n.rssi} dBm` : ''}</title>
                                </g>
                            {/each}
                        </svg>
                        {#if selectedNode}
                            {@const n = selectedNode}
                            <div class="node-detail">
                                <div class="nd-hdr"><strong>{n.name}</strong> <span class="dim">{n.kind === 'border-router' ? 'border router' : n.kind === 'external' ? 'not in she\'s fabric' : n.kind}</span> <span class="spacer"></span><button class="ghost sm" onclick={() => (selectedNode = null)}>✕</button></div>
                                {#if n.kind === 'thread'}
                                    <div>role <b>{n.role}</b>{n.borderRouter ? ` · border router (${n.borderRouter.vendorName ?? ''} ${n.borderRouter.modelName ?? ''})` : ''}</div>
                                    <div class="mono dim">RLOC16 {n.rloc16 !== null && n.rloc16 !== undefined ? '0x' + n.rloc16.toString(16).padStart(4, '0') : '—'} · ext {n.extAddress ? hexAddr(n.extAddress) : '—'}</div>
                                    <div class="dim">{n.networkName ?? ''}{n.channel ? ` · channel ${n.channel}` : ''}{n.partitionId !== null && n.partitionId !== undefined ? ` · partition ${n.partitionId}` : ''} · {n.neighbours} neighbour{n.neighbours === 1 ? '' : 's'}, {n.routes} route{n.routes === 1 ? '' : 's'}{n.readAt ? ` · read ${ago(n.readAt)}` : ''}</div>
                                    <div class="nd-links">{#each gLinks.filter((l) => l.kind === 'neighbour' && ((l.source as GNode).id === n.id || (l.target as GNode).id === n.id)) as l}{@const other = (l.source as GNode).id === n.id ? (l.target as GNode) : (l.source as GNode)}<div><span class="lq {l.quality}">●</span> {other.name} <span class="dim">LQI {l.lqi}{l.rssi !== null && l.rssi !== undefined ? ` · ${l.rssi} dBm` : ''}{l.isChild ? ' · child' : ''}{l.bidirectional ? '' : ' · one-way'}</span></div>{/each}</div>
                                    {#if n.nodeId}<button class="ghost sm" disabled={meshRefreshing} onclick={() => refreshMesh(n.nodeId)}>refresh this device</button>{/if}
                                {:else if n.kind === 'wifi'}
                                    <div>Wi‑Fi · RSSI <b>{n.rssi ?? '—'} dBm</b> ({n.quality}){n.bssid ? ` · AP ${n.bssid}` : ''}</div>
                                {:else if n.kind === 'border-router'}
                                    <div class="dim">{n.networkName ?? ''}{n.role ? ` · ${n.role}` : ''} · ext {n.extAddress ? hexAddr(n.extAddress) : '—'}</div>
                                {:else if n.kind === 'external'}
                                    <div class="dim">{n.explanation}</div>
                                    <div class="mono dim">ext {n.extAddress ? hexAddr(n.extAddress) : '—'}{n.rloc16 !== null && n.rloc16 !== undefined ? ` · RLOC16 0x${Number(n.rloc16).toString(16)}` : ''}</div>
                                {:else}
                                    <div class="dim">no Thread or Wi‑Fi diagnostics{n.online ? '' : ' · offline'}</div>
                                {/if}
                            </div>
                        {/if}
                    </div>
                {/if}
            </section>
            {#if data.unknown.length}
                <section class="net">
                    <div class="net-hdr"><span class="net-name">Border routers without a network</span><span class="dim">· announced without an extended PAN ID</span></div>
                    <ul>
                        {#each data.unknown as br (br.extAddress)}
                            <li>{br.vendorName ?? '?'} {br.modelName ?? ''} <span class="dim mono">{hexAddr(br.extAddress)}</span> <span class="dim">{br.addresses.join(', ')}</span></li>
                        {/each}
                    </ul>
                </section>
            {/if}
        </div>
    {/if}
</div>

<style>
    .thread { flex: 1; display: flex; flex-direction: column; overflow: hidden; color: var(--fg); font-size: 12px; }
    .bar { display: flex; align-items: center; gap: 8px; padding: 5px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .title { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg-muted); }
    .count, .hint, .dim { color: var(--fg-muted); font-size: 11px; }
    .spacer { flex: 1; }
    code { color: var(--accent, #569cd6); font-size: 11px; }
    .err { margin: 6px 12px; color: #e74c3c; }
    .info { padding: 16px; color: var(--fg-muted); line-height: 1.5; }
    .body { flex: 1; overflow: auto; padding: 8px 12px 16px; display: flex; flex-direction: column; gap: 14px; }
    .net-hdr { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
    .net-name { font-weight: 600; color: var(--fg-text); font-size: 13px; }
    .mono { font-family: var(--font-mono, monospace); font-size: 11px; }
    .badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600; line-height: 16px; background: rgba(128,128,128,0.18); color: var(--fg-muted); }
    .b-ok { background: rgba(152,195,121,0.18); color: #98c379; }
    .b-warn { background: rgba(230,126,34,0.18); color: #e67e22; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-weight: 600; font-size: 11px; color: var(--fg-muted); padding: 4px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
    td { padding: 5px 8px; border-bottom: 1px solid var(--border-sub, var(--border)); vertical-align: top; }
    .br-name { font-weight: 600; color: var(--fg-text); }
    .addrs { max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
    .ok { color: #98c379; }
    .c-act { text-align: right; white-space: nowrap; }
    button { background: var(--accent); border: none; color: #fff; padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    button.sm { padding: 1px 7px; font-size: 11px; }
    ul { margin: 0; padding-left: 18px; }
    /* the mesh graph (M16) */
    .graph-wrap { position: relative; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-panel); }
    .graph { width: 100%; height: 420px; display: block; touch-action: none; }
    .gnode { cursor: grab; }
    .gnode text.glyph { font-size: 9px; font-weight: 700; fill: #1e1e1e; pointer-events: none; }
    .gnode text.label { font-size: 10px; fill: var(--fg); pointer-events: none; }
    .lq { font-weight: 600; }
    .lq.good { color: #98c379; }
    .lq.fair { color: #e5a86b; }
    .lq.poor { color: #e06c75; }
    .lq.unknown { color: #5c6370; }
    .lq.br { color: #c678dd; }
    .lq.ext { color: #7f848e; }
    .node-detail { position: absolute; right: 8px; top: 8px; width: 300px; max-height: calc(100% - 16px); overflow: auto; background: var(--bg-app); border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; font-size: 11px; display: flex; flex-direction: column; gap: 4px; }
    .nd-hdr { display: flex; align-items: center; gap: 6px; }
    .nd-links { display: flex; flex-direction: column; gap: 2px; margin: 4px 0; }
</style>
