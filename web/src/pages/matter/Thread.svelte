<script lang="ts">
    /**
     * The Thread tab of the Matter page, part 1 (roadmap M15, D-12): the Thread networks on the
     * LAN with their border routers, from the `_meshcop` mDNS announcements; a border router with
     * the OpenThread REST API shows its role and leader data. Read-only.
     */
    import { onDestroy, untrack } from 'svelte';
    import { subscribeWs } from '../../lib/ws.js';
    import { getThreadNetworks, refreshThreadNetworks, probeThreadRouter, type ThreadNetworks, type ThreadBorderRouter } from '../../lib/api.js';

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
</style>
