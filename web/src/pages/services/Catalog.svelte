<script lang="ts">
    /**
     * Catalog tab (I7): adapters on npm — the trusted publishers' packages whose latest version
     * depends on mqtt-interfaces-core — with "install on <host>".
     */
    import { onMount } from 'svelte';
    import { getServicesCatalog, getServiceHosts, installServicePackage, type Catalog, type CatalogPackage, type ServiceHost } from '../../lib/api.js';

    let { oninstalled }: { oninstalled?: () => void } = $props();

    let cat     = $state<Catalog | null>(null);
    let hosts   = $state<ServiceHost[]>([]);
    let loading = $state(true);
    let error   = $state('');
    let filter  = $state('');
    let target  = $state<Record<string, string>>({}); // package → host name
    let busy    = $state<string | null>(null);
    let notice  = $state('');
    let output  = $state('');

    async function load(refresh = false) {
        loading = true; error = '';
        try {
            const [c, h] = await Promise.all([getServicesCatalog(refresh), getServiceHosts().catch(() => ({ hosts: [] as ServiceHost[] }))]);
            cat = c; hosts = h.hosts;
        } catch (e: any) {
            error = e.message ?? String(e);
        } finally {
            loading = false;
        }
    }
    onMount(() => { load(); });

    let okHosts = $derived(hosts.filter(h => h.ok));
    let visible = $derived.by(() => {
        const list = cat?.packages ?? [];
        const q = filter.trim().toLowerCase();
        return q ? list.filter(p => p.name.includes(q) || p.description.toLowerCase().includes(q)) : list;
    });

    /** where a package is installed: [host label, version] */
    function installedOn(p: CatalogPackage): { host: string; version: string | null }[] {
        return okHosts.flatMap(h => (h.adapters ?? []).filter(a => a.name === p.name).map(a => ({ host: h.hostname ?? h.name, version: a.version })));
    }
    function hostFor(p: CatalogPackage): string {
        return target[p.name] ?? okHosts[0]?.name ?? '';
    }
    async function install(p: CatalogPackage) {
        const host = hostFor(p);
        if (!host) return;
        busy = p.name; notice = ''; output = '';
        try {
            const r = await installServicePackage(host, p.name);
            output = r.output;
            notice = `${p.name} installed on ${host} — add an instance under Add instance.`;
            oninstalled?.();
            await load();
        } catch (e: any) {
            notice = e.message ?? String(e);
        } finally {
            busy = null;
        }
    }
    function fmtDate(s: string | null): string {
        return s ? new Date(s).toLocaleDateString() : '';
    }
</script>

<div class="catalog">
    <div class="bar">
        <input class="filter-in" type="search" placeholder="Filter adapters…" bind:value={filter} />
        <button class="ghost" onclick={() => load(true)} disabled={loading} title="Ask the npm registry again (otherwise cached for a day)">↺</button>
        {#if cat}
            <span class="muted">{visible.length} adapter{visible.length === 1 ? '' : 's'} by {cat.publishers.join(', ') || '—'}{#if cat.stale} · <span class="warn">stale — registry unreachable</span>{/if}</span>
        {/if}
        <span class="spacer"></span>
        {#if notice}<span class="muted">{notice}</span>{/if}
    </div>

    <div class="content">
        {#if loading && !cat}
            <div class="muted">Asking the npm registry…</div>
        {:else if error}
            <div class="err-box">{error}</div>
        {:else if cat}
            {#if cat.publishers.length === 0}
                <div class="muted">No trusted publishers configured — add npm user names under Settings → Services → Trusted publishers.</div>
            {/if}
            {#if cat.errors.length}
                <div class="warn-box">{#each cat.errors as e, i (i)}<div>{e.publisher ? 'publisher ' + e.publisher : e.package}: {e.error}</div>{/each}</div>
            {/if}
            <div class="muted intro">Packages of the trusted npm publishers whose latest version depends on <span class="mono">mqtt-interfaces-core</span>. Installing runs <span class="mono">npm install -g &lt;adapter&gt;@latest</span> on the host through the helper; instances are created afterwards under <em>Add instance</em>.</div>
            {#each visible as p (p.name)}
                {@const on = installedOn(p)}
                <div class="pkg">
                    <div class="pkg-head">
                        <span class="name mono">{p.name}</span>
                        <span class="muted">{p.version}{#if p.published} · {fmtDate(p.published)}{/if} · by {p.publisher}</span>
                        {#if p.mqttInterfaces?.needs?.length}<span class="badge" title="host prerequisites">{p.mqttInterfaces.needs.join(', ')}</span>{/if}
                        <span class="spacer"></span>
                        {#if p.homepage}<a class="link" href={p.homepage} target="_blank" rel="noopener">docs</a>{/if}
                    </div>
                    <div class="desc">{p.description}</div>
                    <div class="pkg-foot">
                        {#if on.length}
                            <span class="muted">installed on {#each on as o, i (o.host)}{i > 0 ? ', ' : ''}{o.host}{#if o.version} ({o.version}{o.version !== p.version ? ` → ${p.version} available` : ''}){/if}{/each}</span>
                        {:else}
                            <span class="muted">not installed on a managed host</span>
                        {/if}
                        <span class="spacer"></span>
                        {#if okHosts.length}
                            <select value={hostFor(p)} onchange={(e) => (target = { ...target, [p.name]: (e.target as HTMLSelectElement).value })}>
                                {#each okHosts as h (h.name)}<option value={h.name}>{h.hostname ?? h.name}</option>{/each}
                            </select>
                            <button onclick={() => install(p)} disabled={busy !== null}>{busy === p.name ? 'Installing…' : on.some(o => o.host === (okHosts.find(h => h.name === hostFor(p))?.hostname ?? hostFor(p))) ? 'Update' : 'Install'}</button>
                        {:else}
                            <span class="muted">no reachable host</span>
                        {/if}
                    </div>
                </div>
            {/each}
            {#if cat.packages.length && visible.length === 0}<div class="muted">No adapters match.</div>{/if}
            {#if output}<pre class="out mono">{output}</pre>{/if}
        {/if}
    </div>
</div>

<style>
    .catalog { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .bar { display: flex; align-items: center; gap: 8px; padding: 5px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; font-size: 12px; }
    .spacer { flex: 1; }
    .filter-in { background: var(--bg-app); border: 1px solid var(--border); color: var(--fg); padding: 3px 6px; font-size: 12px; border-radius: 3px; width: 220px; }
    .content { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; font-size: 12px; color: var(--fg); }
    .intro { margin-bottom: 4px; }
    .muted { color: var(--fg-muted); font-size: 11px; }
    .warn { color: #d4ac0d; }
    .mono { font-family: var(--font-mono, monospace); }
    .pkg { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; display: flex; flex-direction: column; gap: 4px; }
    .pkg-head, .pkg-foot { display: flex; align-items: center; gap: 8px; }
    .name { font-weight: 600; font-size: 13px; }
    .desc { color: var(--fg); }
    .badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600; line-height: 16px; background: rgba(230,126,34,0.18); color: #e67e22; }
    .link { color: var(--accent); font-size: 11px; }
    select { background: var(--bg-app); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; font-size: 11px; padding: 2px 4px; }
    button { background: var(--accent); border: none; color: #fff; padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    .err-box { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.35); border-radius: 3px; color: #e88; padding: 6px 10px; }
    .warn-box { background: rgba(230,126,34,0.10); border: 1px solid rgba(230,126,34,0.35); border-radius: 3px; padding: 6px 10px; font-size: 11px; }
    pre.out { margin: 0; max-height: 240px; overflow: auto; background: var(--bg-app); border: 1px solid var(--border); border-radius: 3px; padding: 6px 8px; font-size: 11px; white-space: pre-wrap; }
</style>
