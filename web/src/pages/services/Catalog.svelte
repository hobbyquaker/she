<script lang="ts">
    /**
     * Catalog tab (I7): adapters on npm — the trusted publishers' packages whose latest version
     * depends on mqtt-interfaces-core — with "install on <host>".
     */
    import { onMount } from 'svelte';
    import { getServicesCatalog, getServiceHosts, installServicePackage, type Catalog, type CatalogPackage, type ServiceHost } from '../../lib/api.js';

    let { oninstalled }: { oninstalled?: (host: string, adapter: string) => void } = $props();

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
    /** -1 older, 0 same, 1 newer (numeric dotted compare; unparsable → 0) */
    function cmpVersion(a: string | null, b: string): number {
        if (!a) return -1;
        const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const x = pa[i] ?? 0, y = pb[i] ?? 0;
            if (Number.isNaN(x) || Number.isNaN(y)) return 0;
            if (x !== y) return x < y ? -1 : 1;
        }
        return 0;
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
            oninstalled?.(hostFor(p), p.name);
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
        <button class="ghost" onclick={() => load(true)} disabled={loading} title="Ask the npm registry again (otherwise cached for a day)"><span class:spinning={loading}>↺</span></button>
        {#if loading && cat}<span class="muted"><span class="spinner"></span> asking the npm registry…</span>{/if}
        {#if cat}
            <span class="muted">{visible.length} adapter{visible.length === 1 ? '' : 's'} by {cat.publishers.join(', ') || '—'}{#if cat.stale} · <span class="warn">stale — registry unreachable</span>{/if}</span>
        {/if}
        <span class="spacer"></span>
        {#if notice}<span class="muted">{notice}</span>{/if}
    </div>

    <div class="content">
        {#if loading && !cat}
            <div class="loading"><span class="spinner"></span> Asking the npm registry — one search per trusted publisher, then a lookup per package…</div>
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
                {@const sel = okHosts.find(h => h.name === hostFor(p))}
                {@const cur = on.find(o => o.host === (sel?.hostname ?? sel?.name))}
                {@const rel = cur ? cmpVersion(cur.version, p.version) : -1}
                <div class="pkg">
                    <div class="pkg-head">
                        <a class="name mono" href={'https://www.npmjs.com/package/' + p.name} target="_blank" rel="noopener" title="{p.name} on npm">{p.name}</a>
                        {#if p.repository}
                            <a class="gh" href={p.repository} target="_blank" rel="noopener" title={p.repository.replace(/^https?:\/\//, '')} aria-label="repository">
                                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
                            </a>
                        {/if}
                        <span class="muted">{p.version}{#if p.published} · {fmtDate(p.published)}{/if} · by {p.publisher}</span>
                        {#each p.mqttInterfaces?.needs ?? [] as n (n)}<span class="badge" title="what the adapter talks to (mqttInterfaces.needs)">{n}</span>{/each}
                        <span class="spacer"></span>
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
                            {#if cur && rel === 0}
                                <span class="muted" title="{cur.version} installed on {cur.host}">up to date</span>
                            {:else if cur && rel > 0}
                                <span class="muted" title="{cur.version} installed on {cur.host}, npm has {p.version}">newer than npm</span>
                            {:else}
                                <button onclick={() => install(p)} disabled={busy !== null}>{busy === p.name ? 'Installing…' : cur ? 'Update' : 'Install'}</button>
                            {/if}
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
    .name { font-weight: 600; font-size: 13px; color: var(--fg); text-decoration: none; }
    .name:hover { color: var(--accent); text-decoration: underline; }
    .gh { display: inline-flex; align-items: center; color: var(--fg-muted); margin-left: -2px; }
    .gh:hover { color: var(--fg); }
    .desc { color: var(--fg); }
    .badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600; line-height: 16px; background: rgba(230,126,34,0.18); color: #e67e22; }
    .badge + .badge { margin-left: 4px; }
    select { background: var(--bg-app); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; font-size: 11px; padding: 2px 4px; }
    button { background: var(--accent); border: none; color: #fff; padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    .err-box { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.35); border-radius: 3px; color: #e88; padding: 6px 10px; }
    .warn-box { background: rgba(230,126,34,0.10); border: 1px solid rgba(230,126,34,0.35); border-radius: 3px; padding: 6px 10px; font-size: 11px; }
    pre.out { margin: 0; max-height: 240px; overflow: auto; background: var(--bg-app); border: 1px solid var(--border); border-radius: 3px; padding: 6px 8px; font-size: 11px; white-space: pre-wrap; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinning { display: inline-block; animation: spin 0.8s linear infinite; }
    .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: -2px; margin-right: 4px; }
    .loading { display: flex; align-items: center; gap: 6px; color: var(--fg-muted); padding: 24px 0; justify-content: center; }
</style>
