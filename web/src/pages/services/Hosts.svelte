<script lang="ts">
    import { onMount, untrack } from 'svelte';
    import {
        getServiceHosts, updateServiceAdapter,
        getServiceInstances, uninstallServiceAdapter,
        type ServiceHost, type ServiceInstance,
    } from '../../lib/api.js';
    import ConfirmDialog from '../../lib/ConfirmDialog.svelte';

    import AddInstance, { type AddPreset } from './AddInstance.svelte';
    let {
        onchanged,
        onupdates,
        generation = 0,
        origin = null,
        addPreset = null,
    }: {
        onchanged?: () => void;
        onupdates?: (count: number) => void;
        generation?: number;
        origin?: string | null;
        /** an install on the Catalog tab asks for the add form of that host and adapter */
        addPreset?: { host: string; adapter: string; n: number } | null;
    } = $props();
    // the tab shows the host list or the add-instance form (host + adapter fixed), covering the whole tab
    type View = { kind: 'list' } | { kind: 'add'; preset: AddPreset };
    let view = $state<View>({ kind: 'list' });
    let addN = 0;
    function openAdd(host: string, adapter: string) {
        view = { kind: 'add', preset: { host, adapter, n: ++addN } };
    }
    function back() {
        view = { kind: 'list' };
    }
    // an install finished on the Catalog tab: it switched here, the form opens on its adapter
    let seenAdd = 0;
    $effect(() => {
        const p = addPreset;
        if (!p || p.n === seenAdd) return;
        seenAdd = p.n;
        untrack(() => openAdd(p.host, p.adapter));
    });

    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean; alert?: boolean }): Promise<boolean> } = $state(null as any);

    let hosts    = $state<ServiceHost[]>([]);
    let mqttInstances = $state<ServiceInstance[]>([]);
    let loading  = $state(true);
    let error    = $state('');
    let busy     = $state<string | null>(null);
    let notice   = $state('');
    let output   = $state('');

    async function load(refresh = false) {
        loading = true; error = '';
        try {
            const [h, inv] = await Promise.all([getServiceHosts(refresh), getServiceInstances().catch(() => null)]);
            hosts = h.hosts;
            if (inv) mqttInstances = inv.instances;
        } catch (e: any) {
            error = e.message ?? String(e);
        } finally {
            loading = false;
        }
    }
    onMount(() => { load(); });

    // a host added or removed on the Hosts tab, an instance gone on Instances — ask the
    // hosts again (refresh: the daemon caches the listing for a minute). Guarded and
    // untracked so the reload cannot feed back into the effect that started it.
    let seenGeneration = 0;
    $effect(() => {
        const g = generation;
        if (g === seenGeneration) return;
        seenGeneration = g;
        untrack(() => { if (origin !== 'hosts') load(true); });
    });

    // cards sorted by the label they show (hostname, falling back to the configured name)
    let sortedHosts = $derived(
        [...hosts]
            .sort((a, b) => (a.hostname ?? a.name).localeCompare(b.hostname ?? b.name, undefined, { numeric: true, sensitivity: 'base' }))
            // a reachable host with nothing installed has nothing to show here; one she cannot
            // reach keeps its card, because that card is where the error is explained
            .filter((h) => !h.ok || (h.adapters ?? []).length > 0 || (h.legacy ?? []).length > 0),
    );
    let emptyHosts = $derived(hosts.length - sortedHosts.length);

    // adapter updates waiting on any host — drives the yellow dot on the Installations sub-tab
    let updateCount = $derived(hosts.reduce((n, h) => n + (h.adapters ?? []).filter(a => a.updateAvailable).length, 0));
    $effect(() => { onupdates?.(updateCount); });

    /** Hosts that adapters report in info.host but that are not configured here (SV-14 correlation by hostname). */
    let unmanaged = $derived.by(() => {
        const known = new Set(hosts.map(h => h.hostname).filter(Boolean));
        const byHost = new Map<string, ServiceInstance[]>();
        for (const i of mqttInstances) {
            if (i.legacy || !i.host || known.has(i.host)) continue;
            byHost.set(i.host, [...(byHost.get(i.host) ?? []), i]);
        }
        return [...byHost.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    });

    // ── Update all ─────────────────────────────────────────────────────────────
    // One package at a time: each update restarts the instances of that adapter, and a
    // host doing several npm installs at once is how a small box runs out of memory.
    let updateAllBusy = $state(false);
    let updateAllAt = $state('');
    let pending = $derived(
        sortedHosts.flatMap((h) => (h.adapters ?? []).filter((a) => a.updateAvailable).map((a) => ({ host: h, adapter: a.name }))),
    );

    async function updateAll() {
        const todo = pending;
        if (todo.length === 0 || updateAllBusy) return;
        const what = todo.map((t) => `${t.adapter} on ${t.host.hostname ?? t.host.name}`).join('\n');
        if (!(await dialog.show(`Update ${todo.length} adapter${todo.length === 1 ? '' : 's'}, one after another?\n\n${what}\n\nRunning instances of each are restarted as it goes.`, { confirm: 'Update all' }))) return;
        updateAllBusy = true; notice = ''; output = '';
        const done: string[] = [];
        const failed: string[] = [];
        try {
            for (const [i, t] of todo.entries()) {
                updateAllAt = `${i + 1} of ${todo.length}: ${t.adapter} on ${t.host.hostname ?? t.host.name}`;
                try {
                    // manual deploys need an explicit force, and are skipped rather than asked about here
                    const r = await updateServiceAdapter(t.host.name, t.adapter);
                    (r.ok ? done : failed).push(`${t.adapter}@${t.host.name}`);
                } catch (e: any) {
                    failed.push(`${t.adapter}@${t.host.name}: ${e.message ?? String(e)}`);
                }
            }
            notice = `${done.length} adapter${done.length === 1 ? '' : 's'} updated${failed.length ? `, ${failed.length} failed: ${failed.join(', ')}` : ''}.`;
            onchanged?.();
            await load(true);
        } finally {
            updateAllBusy = false;
            updateAllAt = '';
        }
    }

    async function update(h: ServiceHost, adapter: string, force = false) {
        busy = `${h.name}/${adapter}`; notice = ''; output = '';
        try {
            const r = await updateServiceAdapter(h.name, adapter, force);
            output = r.output;
            notice = r.ok
                ? `${adapter} updated on ${h.name}${r.restarted.length ? `, restarted ${r.restarted.join(', ')}` : ''}.`
                : `${adapter} updated, but restart failed for ${r.failed.map(f => f.instance).join(', ')}.`;
            onchanged?.();
            await load();
        } catch (e: any) {
            if (/deployed manually/.test(e.message ?? '')) {
                const ok = await dialog.show(
                    `${adapter} on ${h.name} was deployed manually (not via npm install -g) — e.g. by the adapter's deploy.sh. Updating replaces it with the version from the npm registry. Continue?`,
                    { confirm: 'Replace with npm version', danger: true },
                );
                busy = null;
                if (ok) return update(h, adapter, true);
                return;
            }
            notice = e.message ?? String(e);
        } finally {
            busy = null;
        }
    }

    async function uninstall(h: ServiceHost, adapter: string, names: string[]) {
        const where = h.hostname ?? h.name;
        const msg = names.length
            ? `Uninstall ${adapter} from ${where}?\n\n${names.length === 1 ? 'There is an instance' : 'There are ' + names.length + ' instances'} of it: ${names.join(', ')}. ${names.length === 1 ? 'It' : 'They'} will be stopped and removed first — systemd unit, config, state directory and broker identity — then the package, /etc/${adapter} and /var/lib/${adapter} are deleted. This cannot be undone.`
            : `Uninstall ${adapter} from ${where}? The package, /etc/${adapter} and /var/lib/${adapter} are deleted.`;
        if (!(await dialog.show(msg, { confirm: names.length ? `Remove ${names.length === 1 ? 'the instance' : names.length + ' instances'} and uninstall` : 'Uninstall', danger: true }))) return;
        busy = `${h.name}/${adapter}`; notice = ''; output = '';
        try {
            const r = await uninstallServiceAdapter(h.name, adapter);
            output = r.output;
            notice = `${adapter} uninstalled from ${where}${r.removedInstances.length ? ` (instances removed: ${r.removedInstances.join(', ')})` : ''}.`;
            onchanged?.();
            await load(true);
        } catch (e: any) {
            notice = e.message ?? String(e);
        } finally {
            busy = null;
        }
    }

</script>

<ConfirmDialog bind:this={dialog} />

<div class="hosts">
    {#if view.kind === 'add'}
    <div class="sheet-head">
        <button class="ghost sm" onclick={back}>← Installations</button>
        <strong>Add instance</strong>
        <span class="muted">a systemd instance of the adapter on the host, configured from its --config-schema</span>
    </div>
    <AddInstance preset={view.preset} oninstalled={() => { load(true); onchanged?.(); }} onclose={back} />
    {:else}
    <div class="bar">
        <button class="ghost" onclick={() => load(true)} disabled={loading} title="Ask every host again (otherwise the listing is cached for a minute)"><span class:spinning={loading}>↺</span></button>
        {#if pending.length > 0}
            <button class="ghost" onclick={updateAll} disabled={updateAllBusy || busy !== null} title="Update every adapter that has a newer version, one after another">
                {updateAllBusy ? 'Updating…' : `Update all (${pending.length})`}
            </button>
        {/if}
        <span class="muted">
            {hosts.length} host{hosts.length === 1 ? '' : 's'} — managed on the Hosts tab{#if emptyHosts > 0}, {emptyHosts} without adapters not shown{/if}
        </span>
        <span class="hint">To install an adapter click <em>Install</em> on the Catalog tab</span>
        {#if loading}<span class="spinner" title="Asking every host…"></span>{/if}
        <span class="spacer"></span>
        {#if updateAllBusy && updateAllAt}<span class="muted">{updateAllAt}</span>{/if}
        {#if notice}<span class="muted">{notice}</span>{/if}
    </div>

    <div class="content">
        {#if loading && hosts.length === 0}
            <div class="loading-row"><span class="spinner"></span> Asking every host — a host over a slow link can take a moment…</div>
        {:else if error}
            <div class="err-box">{error}</div>
        {/if}

        {#each sortedHosts as h (h.name)}
            <div class="card">
                <div class="card-head">
                    <span class="dot" class:ok={h.ok} class:err={!h.ok}></span>
                    <span class="name">{h.hostname ?? h.name}</span>
                    <span class="muted">{h.local ? 'this host' : `${h.ssh?.user ?? ''}@${h.ssh?.host}`}</span>
                    <span class="spacer"></span>
                    <!-- the helper itself is managed on the Hosts tab, next to the host it belongs to -->
                    {#if h.ok && h.helperOutdated}
                        <span class="muted" title="she ships a newer she-servicectl — update it on the Hosts tab">helper v{h.helper}, outdated</span>
                    {/if}
                </div>
                {#if !h.ok}
                    <div class="err-box">
                        {h.error}
                        {#if h.code === 'HELPER_MISSING' && h.local}
                            <div class="hint">Install the helper on this host: <code>sudo she --install</code> (copies <code>she-servicectl</code> to <code>/usr/local/bin</code> and allows it in <code>/etc/sudoers.d/she</code>).</div>
                        {:else if h.code === 'HELPER_MISSING'}
                            <div class="hint">The helper is not on this host yet — deploy it from the Hosts tab, or run the one-line setup command there on the host as root.</div>
                        {:else if h.code === 'SUDO_DENIED' && h.local}
                            <div class="hint">Add to <code>/etc/sudoers.d/she</code>: <code>she ALL=(root) NOPASSWD: /usr/local/bin/she-servicectl</code> — <code>sudo she --install</code> does this.</div>
                        {:else if h.code === 'SUDO_DENIED'}
                            <div class="hint">Allow the helper for <code>{h.ssh?.user}</code> on the host: <code>{h.ssh?.user} ALL=(root) NOPASSWD: /usr/local/bin/she-servicectl</code> in <code>/etc/sudoers.d/she-services</code> — <em>Deploy helper</em> on the Hosts tab prints the exact commands.</div>
                        {:else if h.code === 'SSH_FAILED'}
                            <div class="hint">SSH to <code>{h.ssh?.user}@{h.ssh?.host}:{h.ssh?.port}</code> failed — is the services public key (Hosts tab) in that user's <code>~/.ssh/authorized_keys</code>, and the host reachable? The setup command in the Hosts tab does the whole host setup in one go.</div>
                        {:else if h.code === 'UNSUPPORTED'}
                            <div class="hint">The host entry has an <code>ssh</code> block without a <code>host</code> — fix it on the Hosts tab.</div>
                        {/if}
                    </div>
                {:else}
                    <table class="adapters">
                        <colgroup><col class="c-adapter" /><col class="c-version" /><col class="c-origin" /><col class="c-instances" /><col class="c-actions" /></colgroup>
                        <thead><tr><th>Adapter</th><th>Installed</th><th>Origin</th><th>Instances</th><th class="c-act"></th></tr></thead>
                        <tbody>
                            {#each h.adapters ?? [] as a (a.name)}
                                {@const names = [...(h.instances ?? []).filter(i => i.adapter === a.name).map(i => i.instance), ...(h.legacy ?? []).filter(l => l.adapter === a.name).map(l => `${l.unit} (old unit)`)]}
                                <tr>
                                    <td class="mono">{a.name}</td>
                                    <td><span class="ver">{a.version ?? '—'}{#if a.updateAvailable}<span class="badge b-upd" title="npm has {a.latestVersion} — Update installs it">{a.latestVersion}</span>{/if}</span></td>
                                    <td>
                                        {#if a.origin === 'manual'}<span class="badge warn-b" title="Deployed by tarball / deploy.sh, not npm install -g — path: {a.path}">manual</span>
                                        {:else}<span class="muted">npm</span>{/if}
                                    </td>
                                    <td>{#if names.length}{names.join(', ')}{:else}<span class="muted">{a.unit === false ? 'none yet' : '—'}</span>{/if}</td>
                                    <td class="c-act">
                                        {#if a.updateAvailable}
                                            <button class="ghost sm" onclick={() => update(h, a.name)} disabled={busy !== null} title="npm install -g {a.name}@latest, then restart its instances">
                                                {busy === `${h.name}/${a.name}` ? 'Updating…' : 'Update'}
                                            </button>
                                        {/if}
                                        <button class="ghost sm danger" onclick={() => uninstall(h, a.name, (h.instances ?? []).filter(i => i.adapter === a.name).map(i => i.instance))} disabled={busy !== null} title={`Uninstall ${a.name} from ${h.hostname ?? h.name} — with its instances`}>{busy === `${h.name}/${a.name}` ? '…' : 'Uninstall'}</button>
                                        <button class="ghost sm" onclick={() => openAdd(h.name, a.name)} disabled={busy !== null} title={names.length ? `Add another ${a.name} instance on ${h.hostname ?? h.name}` : `Create the first ${a.name} instance on ${h.hostname ?? h.name}`}>+ instance</button>
                                    </td>
                                </tr>
                            {/each}
                            {#if (h.adapters ?? []).length === 0}
                                <tr><td colspan="5" class="muted">No mqtt-interfaces adapters installed on this host (no <span class="mono">&lt;adapter&gt;@.service</span> template unit reading <span class="mono">/etc/&lt;adapter&gt;/%i.env</span>).</td></tr>
                            {/if}
                        </tbody>
                    </table>
                {/if}
            </div>
        {/each}

        {#if output}
            <pre class="out mono">{output}</pre>
        {/if}

        {#each unmanaged as [hostname, list] (hostname)}
            <div class="card unmanaged">
                <div class="card-head">
                    <span class="dot"></span>
                    <span class="name">{hostname}</span>
                    <span class="muted">seen on MQTT, not managed</span>
                </div>
                <div class="muted">
                    {list.length} instance{list.length === 1 ? '' : 's'} report this host:
                    {#each list as i, idx (i.instance)}{idx > 0 ? ', ' : ''}<span class="mono">{i.instance}</span> ({i.adapter}){/each}.
                    To manage them, add <span class="mono">{hostname}</span> on the Hosts tab (<em>+ Add remote host</em>), then deploy the helper here.
                </div>
            </div>
        {/each}
    </div>
    {/if}
</div>

<style>
    .hosts { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .bar { display: flex; align-items: center; gap: 8px; padding: 5px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; font-size: 12px; }
    .spacer { flex: 1; }
    .content { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; font-size: 12px; color: var(--fg); }
    .muted { color: var(--fg-muted); font-size: 11px; }
    .mono { font-family: var(--font-mono, monospace); font-size: 11px; }
    /* the reload glyph turns while the listing is being fetched — same as the Catalog tab */
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
        display: inline-block; width: 12px; height: 12px; flex-shrink: 0;
        border: 2px solid var(--fg-dim); border-top-color: var(--fg-brand); border-radius: 50%;
        animation: spin 0.7s linear infinite;
    }
    .loading-row { display: flex; align-items: center; gap: 8px; color: var(--fg-muted); font-size: 12px; padding: 4px 0; }
    .spinning { display: inline-block; animation: spin 0.8s linear infinite; }
    .card { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; }
    .card.unmanaged { border-style: dashed; }
    .card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .name { font-weight: 600; font-size: 13px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-muted); }
    .dot.ok { background: #27ae60; }
    .dot.err { background: #e74c3c; }
    /* identical column widths in every card so the tables line up across hosts */
    table.adapters { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }
    col.c-adapter { width: 26%; }
    col.c-version { width: 14%; }
    col.c-origin { width: 12%; }
    col.c-actions { width: 236px; }
    td { overflow: hidden; text-overflow: ellipsis; }
    th { text-align: left; font-weight: 600; font-size: 11px; color: var(--fg-muted); padding: 4px 8px; border-bottom: 1px solid var(--border); }
    td { padding: 4px 8px; border-bottom: 1px solid var(--border-sub, var(--border)); }
    /* where the thing this tab cannot do itself is done */
    .hint { color: var(--fg-muted); font-size: 11px; }
    .hint em { font-style: normal; color: var(--fg); }

    .c-act { text-align: right; white-space: nowrap; }
    .sheet-head { display: flex; align-items: center; gap: 10px; padding: 5px 12px; border-bottom: 1px solid var(--border); font-size: 12px; flex-shrink: 0; }
    td.c-act button + button { margin-left: 4px; }
    button.ghost.danger:hover:not(:disabled) { color: #e74c3c; border-color: #e74c3c; }
    .badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600; line-height: 16px; }
    .ver { display: inline-flex; align-items: center; gap: 5px; }
    .warn-b { background: rgba(230,126,34,0.18); color: #e67e22; }
    .b-upd { background: rgba(241,196,15,0.18); color: #d4ac0d; }
    button { background: var(--accent); border: none; color: #fff; padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    button.sm { padding: 1px 7px; font-size: 11px; }
    .err-box { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.35); border-radius: 3px; color: #e88; padding: 6px 10px; }
    .hint { margin-top: 4px; color: var(--fg-muted); }
    .hint code { color: var(--accent); }
    pre.out { margin: 0; max-height: 240px; overflow: auto; background: var(--bg-app); border: 1px solid var(--border); border-radius: 3px; padding: 6px 8px; font-size: 11px; white-space: pre-wrap; }
</style>
