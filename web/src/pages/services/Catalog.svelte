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
    // the package the "where should it go" dialog is open for, and the host picked in it
    let installFor = $state<CatalogPackage | null>(null);
    let installHost = $state('');
    let busy    = $state<string | null>(null);
    let notice  = $state('');
    let output  = $state('');

    let poll: ReturnType<typeof setTimeout> | null = null;
    // the daemon answers from its cache at once and sweeps npm in the background — ask again while it does
    async function load(refresh = false) {
        loading = !cat; error = '';
        if (poll) { clearTimeout(poll); poll = null; }
        try {
            const [c, h] = await Promise.all([getServicesCatalog(refresh), getServiceHosts().catch(() => ({ hosts: [] as ServiceHost[] }))]);
            cat = c; hosts = h.hosts;
            if (c.refreshing) poll = setTimeout(() => load(false), 2000);
        } catch (e: any) {
            error = e.message ?? String(e);
        } finally {
            loading = false;
        }
    }
    onMount(() => { load(); return () => { if (poll) clearTimeout(poll); }; });
    const refreshing = $derived(Boolean(cat?.refreshing));
    function fmtWhen(ts?: number) { return ts ? new Date(ts).toLocaleString() : ''; }

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
    /** Hosts the adapter could still be installed on. */
    function free(p: CatalogPackage): ServiceHost[] {
        const taken = installedNames(p);
        return okHosts.filter(h => !taken.has(h.name));
    }

    /** Hosts this adapter is already on — those are not install targets, updates live on Installations. */
    function installedNames(p: CatalogPackage): Set<string> {
        return new Set(okHosts.filter(h => (h.adapters ?? []).some(a => a.name === p.name)).map(h => h.name));
    }

    function openInstall(p: CatalogPackage) {
        const taken = installedNames(p);
        installHost = (okHosts.find(h => !taken.has(h.name)) ?? okHosts[0])?.name ?? '';
        installFor = p;
    }

    async function install() {
        const p = installFor;
        const host = installHost;
        if (!p || !host) return;
        installFor = null;
        busy = p.name; notice = ''; output = '';
        try {
            const r = await installServicePackage(host, p.name);
            output = r.output;
            const label = okHosts.find(h => h.name === host);
            notice = `${p.name} installed on ${label?.hostname ?? host} — add an instance under Add instance.`;
            oninstalled?.(host, p.name);
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
        <button class="ghost" onclick={() => load(true)} disabled={loading || refreshing} title="Ask the npm registry now (it is swept once a day anyway)"><span class:spinning={loading || refreshing}>↺</span></button>
        {#if refreshing}<span class="muted"><span class="spinner"></span> asking the npm registry — the list below is the last known state</span>
        {:else if cat?.fetchedAt}<span class="muted" title={cat.stale ? 'the last sweep failed — this is the previous list' : 'swept once a day'}>updated {fmtWhen(cat.fetchedAt)}{#if cat.stale} (stale){/if}</span>{/if}
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
                <div class="pkg">
                    <div class="pkg-head">
                        <a class="name mono" href={'https://www.npmjs.com/package/' + p.name} target="_blank" rel="noopener" title="{p.name} on npm">{p.name}</a>
                        {#if p.repository}
                            <a class="gh" href={p.repository} target="_blank" rel="noopener" title={p.repository.replace(/^https?:\/\//, '')} aria-label="repository">
                                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
                            </a>
                        {/if}
                        <span class="muted">{p.version}{#if p.published} · {fmtDate(p.published)}{/if} · by {p.publisher}</span>
                        {#each p.mqttInterfaces?.needs ?? [] as n (n)}<span class="badge n-{n}" title="what the adapter talks to (mqttInterfaces.needs)">{n}</span>{/each}
                        <span class="spacer"></span>
                    </div>
                    <div class="desc">{p.description}</div>
                    <div class="pkg-foot">
                        {#if on.length}
                            <span class="muted">installed on {#each on as o, i (o.host)}{i > 0 ? ', ' : ''}{o.host}{#if o.version} ({o.version}){/if}{/each}{#if on.some(o => o.version && o.version !== p.version)} — updates live on the Installations tab{/if}</span>
                        {:else}
                            <span class="muted">not installed on a managed host</span>
                        {/if}
                        <span class="spacer"></span>
                        {#if okHosts.length === 0}
                            <span class="muted">no reachable host</span>
                        {:else if free(p).length === 0}
                            <span class="muted" title="Updating an installed adapter is done on the Installations tab">on every host</span>
                        {:else}
                            <button onclick={() => openInstall(p)} disabled={busy !== null}>{busy === p.name ? 'Installing…' : 'Install'}</button>
                        {/if}
                    </div>
                </div>
            {/each}
            {#if cat.packages.length && visible.length === 0}<div class="muted">No adapters match.</div>{/if}
            {#if output}<pre class="out mono">{output}</pre>{/if}
        {/if}
    </div>
</div>

<!-- Where should it go: one npm install per host, so the host is a deliberate choice -->
{#if installFor}
    {@const p = installFor}
    {@const taken = installedNames(p)}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="modal-back" role="presentation" onclick={() => (installFor = null)}>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="modal" role="dialog" tabindex="-1" aria-modal="true" aria-label="Install {p.name}" onclick={(e) => e.stopPropagation()}>
            <div class="modal-title">Install <span class="mono">{p.name}</span></div>
            <div class="modal-text">
                Which host should it run on? <span class="mono">npm install -g {p.name}@latest</span> runs there through the helper;
                the instance itself is created afterwards under <em>Add instance</em>.
            </div>
            <div class="host-list">
                {#each okHosts as h (h.name)}
                    {@const isTaken = taken.has(h.name)}
                    <label class="host-row" class:disabled={isTaken}>
                        <input type="radio" name="install-host" value={h.name} bind:group={installHost} disabled={isTaken} />
                        <span class="radio"></span>
                        <span class="host-name">{h.hostname ?? h.name}</span>
                        {#if isTaken}
                            <span class="muted">already installed — update it on the Installations tab</span>
                        {:else if h.node}
                            <span class="muted mono">node {h.node}</span>
                        {/if}
                    </label>
                {/each}
            </div>
            <div class="modal-actions">
                <button class="ghost" onclick={() => (installFor = null)}>Cancel</button>
                <button onclick={install} disabled={!installHost}>Install on {okHosts.find(h => h.name === installHost)?.hostname ?? installHost}</button>
            </div>
        </div>
    </div>
{/if}

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') installFor = null; }} />

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
    .badge.n-cloud { background: rgba(86,156,214,0.18); color: #569cd6; }
    .badge.n-bluetooth { background: rgba(155,89,182,0.18); color: #9b59b6; }
    .badge.n-serial, .badge.n-usb { background: rgba(127,140,141,0.22); color: var(--fg-muted); }
    /* "where should it go" dialog */
    .modal-back {
        position: fixed; inset: 0; z-index: 50;
        background: rgba(0,0,0,0.45);
        display: flex; align-items: center; justify-content: center;
    }
    .modal {
        background: var(--bg-panel); border: 1px solid var(--border); border-radius: 6px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.4);
        padding: 14px 16px; width: min(460px, 92vw);
        display: flex; flex-direction: column; gap: 10px; font-size: 12px; color: var(--fg);
    }
    .modal-title { font-size: 14px; font-weight: 600; }
    .modal-text { color: var(--fg-muted); line-height: 1.5; }
    .host-list { display: flex; flex-direction: column; gap: 2px; max-height: 300px; overflow: auto; }
    .host-row {
        display: flex; align-items: center; gap: 8px;
        padding: 5px 6px; border-radius: 4px; cursor: pointer;
    }
    .host-row:hover:not(.disabled) { background: var(--bg-hover); }
    .host-row.disabled { cursor: default; opacity: 0.65; }
    .host-row input { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .radio {
        flex-shrink: 0; width: 12px; height: 12px; border-radius: 50%;
        border: 1.5px solid var(--border); background: var(--bg-input); position: relative;
    }
    .host-row input:checked + .radio { border-color: var(--accent); }
    .host-row input:checked + .radio::after {
        content: ''; position: absolute; inset: 2px; border-radius: 50%; background: var(--accent);
    }
    .host-name { font-weight: 600; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
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
