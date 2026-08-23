<script lang="ts">
    import { onMount } from 'svelte';
    import {
        getServiceHosts, updateServiceAdapter,
        testServiceHost, deployServiceHelper, getServiceInstances,
        type ServiceHost, type HelperDeployResult, type ServiceInstance,
    } from '../../lib/api.js';
    import ConfirmDialog from '../../lib/ConfirmDialog.svelte';

    let { onchanged }: { onchanged?: () => void } = $props();

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

    /* ── I5: connection test + helper deploy ───────────────────────────────── */
    let testResult = $state<Record<string, string>>({});
    let deployResult = $state<Record<string, HelperDeployResult | { error: string }>>({});
    let hostBusy = $state<string | null>(null);

    async function testHost(h: ServiceHost) {
        hostBusy = h.name;
        try {
            const r = await testServiceHost(h.name);
            testResult = { ...testResult, [h.name]: r.ok ? `ok — helper v${r.helper ?? '?'}` : `${r.code}: ${r.error}` };
        } catch (e: any) {
            testResult = { ...testResult, [h.name]: e.message ?? String(e) };
        } finally {
            hostBusy = null;
        }
    }
    async function deployHelper(h: ServiceHost) {
        hostBusy = h.name;
        try {
            const r = await deployServiceHelper(h.name);
            deployResult = { ...deployResult, [h.name]: r };
            if (r.ok) await load();
        } catch (e: any) {
            deployResult = { ...deployResult, [h.name]: { error: e.message ?? String(e) } };
        } finally {
            hostBusy = null;
        }
    }

</script>

<ConfirmDialog bind:this={dialog} />

<div class="hosts">
    <div class="bar">
        <button class="ghost" onclick={() => load(true)} disabled={loading} title="Ask every host again (otherwise the listing is cached for a minute)">↺</button>
        <span class="muted">{hosts.length} host{hosts.length === 1 ? '' : 's'} — add remote hosts under Settings → Services</span>
        <span class="spacer"></span>
        {#if notice}<span class="muted">{notice}</span>{/if}
    </div>

    <div class="content">
        {#if loading && hosts.length === 0}
            <div class="muted">Loading…</div>
        {:else if error}
            <div class="err-box">{error}</div>
        {/if}

        {#each hosts as h (h.name)}
            <div class="card">
                <div class="card-head">
                    <span class="dot" class:ok={h.ok} class:err={!h.ok}></span>
                    <span class="name">{h.hostname ?? h.name}</span>
                    <span class="muted">{h.local ? 'this host' : `${h.ssh?.user ?? ''}@${h.ssh?.host}`}{#if h.node} · node {h.node}{/if}</span>
                    <span class="spacer"></span>
                    {#if h.ok}
                        <span class="muted" title="she-servicectl version">helper v{h.helper}{#if h.helperOutdated} <span class="warn">— outdated, update it</span>{/if}</span>
                    {/if}
                    <button class="ghost sm" onclick={() => testHost(h)} disabled={hostBusy !== null} title="Run she-servicectl version on the host">Test</button>
                    {#if !h.ok || h.helperOutdated}
                        <button class="ghost sm" onclick={() => deployHelper(h)} disabled={hostBusy !== null} title={h.ok ? 'Replace the helper with the version she ships (the helper updates itself through its sudo rule)' : 'Copy she-servicectl to the host and install it'}>{h.ok ? 'Update helper' : 'Deploy helper'}</button>
                    {/if}
                </div>
                {#if testResult[h.name]}<div class="muted" style="margin-bottom:6px">test: {testResult[h.name]}</div>{/if}
                {#if deployResult[h.name]}
                    {@const d = deployResult[h.name]}
                    <div class="deploy-box" class:deploy-ok={'ok' in d && d.ok}>
                        {#if 'error' in d}
                            {d.error}
                        {:else if d.ok}
                            Helper v{d.helper} {d.method === 'self-update' ? 'updated on' : 'installed on'} {h.hostname ?? h.name}{d.method === 'self-update' ? '' : ` and allowed for ${d.user}`}.
                        {:else}
                            {#if d.installed}Helper installed, but <span class="mono">sudo</span> does not allow it for <span class="mono">{d.user}</span> yet.{:else}Helper uploaded to the SSH user's home; installing it needs root.{/if}
                            Run on the host as an admin:
                            <pre class="mono">{(d.instructions ?? []).join('\n')}</pre>
                            {#if d.error}<div class="muted">{d.error}</div>{/if}
                        {/if}
                    </div>
                {/if}

                {#if !h.ok}
                    <div class="err-box">
                        {h.error}
                        {#if h.code === 'HELPER_MISSING' && h.local}
                            <div class="hint">Install the helper on this host: <code>sudo she --install</code> (copies <code>she-servicectl</code> to <code>/usr/local/bin</code> and allows it in <code>/etc/sudoers.d/she</code>).</div>
                        {:else if h.code === 'HELPER_MISSING'}
                            <div class="hint">The helper is not on this host yet — <em>Deploy helper</em> copies it over and prints the sudoers line to add, or run the one-line setup command from Settings → Services on the host as root.</div>
                        {:else if h.code === 'SUDO_DENIED' && h.local}
                            <div class="hint">Add to <code>/etc/sudoers.d/she</code>: <code>she ALL=(root) NOPASSWD: /usr/local/bin/she-servicectl</code> — <code>sudo she --install</code> does this.</div>
                        {:else if h.code === 'SUDO_DENIED'}
                            <div class="hint">Allow the helper for <code>{h.ssh?.user}</code> on the host: <code>{h.ssh?.user} ALL=(root) NOPASSWD: /usr/local/bin/she-servicectl</code> in <code>/etc/sudoers.d/she-services</code> — <em>Deploy helper</em> prints the exact commands.</div>
                        {:else if h.code === 'SSH_FAILED'}
                            <div class="hint">SSH to <code>{h.ssh?.user}@{h.ssh?.host}:{h.ssh?.port}</code> failed — is the services public key (Settings → Services) in that user's <code>~/.ssh/authorized_keys</code>, and the host reachable? The setup command in Settings → Services does the whole host setup in one go.</div>
                        {:else if h.code === 'UNSUPPORTED'}
                            <div class="hint">The host entry has an <code>ssh</code> block without a <code>host</code> — fix it under Settings → Services.</div>
                        {/if}
                    </div>
                {:else}
                    <table class="adapters">
                        <colgroup><col class="c-adapter" /><col class="c-version" /><col class="c-origin" /><col class="c-instances" /><col class="c-actions" /></colgroup>
                        <thead><tr><th>Adapter</th><th>Installed</th><th>Origin</th><th>Instances</th><th class="c-act"></th></tr></thead>
                        <tbody>
                            {#each h.adapters ?? [] as a (a.name)}
                                <tr>
                                    <td class="mono">{a.name}</td>
                                    <td>{a.version ?? '—'}</td>
                                    <td>
                                        {#if a.origin === 'manual'}<span class="badge warn-b" title="Deployed by tarball / deploy.sh, not npm install -g — path: {a.path}">manual</span>
                                        {:else}<span class="muted">npm</span>{/if}
                                    </td>
                                    <td>{(h.instances ?? []).filter(i => i.adapter === a.name).map(i => i.instance).join(', ') || '—'}</td>
                                    <td class="c-act">
                                        <button class="ghost sm" onclick={() => update(h, a.name)} disabled={busy !== null} title="npm install -g {a.name}@latest, then restart its instances">
                                            {busy === `${h.name}/${a.name}` ? 'Updating…' : 'Update'}
                                        </button>
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
                    To manage them, add <span class="mono">{hostname}</span> under Settings → Services → Remote hosts (ssh host, user), then deploy the helper here.
                </div>
            </div>
        {/each}
    </div>
</div>

<style>
    .hosts { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .bar { display: flex; align-items: center; gap: 8px; padding: 5px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; font-size: 12px; }
    .spacer { flex: 1; }
    .content { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; font-size: 12px; color: var(--fg); }
    .muted { color: var(--fg-muted); font-size: 11px; }
    .warn { color: #d4ac0d; }
    .mono { font-family: var(--font-mono, monospace); font-size: 11px; }
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
    col.c-actions { width: 96px; }
    td { overflow: hidden; text-overflow: ellipsis; }
    th { text-align: left; font-weight: 600; font-size: 11px; color: var(--fg-muted); padding: 4px 8px; border-bottom: 1px solid var(--border); }
    td { padding: 4px 8px; border-bottom: 1px solid var(--border-sub, var(--border)); }
    .c-act { text-align: right; }
    .badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600; line-height: 16px; }
    .warn-b { background: rgba(230,126,34,0.18); color: #e67e22; }
    button { background: var(--accent); border: none; color: #fff; padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    button.sm { padding: 1px 7px; font-size: 11px; }
    .err-box { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.35); border-radius: 3px; color: #e88; padding: 6px 10px; }
    .hint { margin-top: 4px; color: var(--fg-muted); }
    .hint code { color: var(--accent); }
    .deploy-box { background: rgba(230,126,34,0.10); border: 1px solid rgba(230,126,34,0.35); border-radius: 3px; padding: 6px 10px; margin-bottom: 8px; font-size: 12px; }
    .deploy-box.deploy-ok { background: rgba(39,174,96,0.12); border-color: rgba(39,174,96,0.35); }
    .deploy-box pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-all; background: var(--bg-app); border: 1px solid var(--border); border-radius: 3px; padding: 6px 8px; font-size: 11px; }
    pre.out { margin: 0; max-height: 240px; overflow: auto; background: var(--bg-app); border: 1px solid var(--border); border-radius: 3px; padding: 6px 8px; font-size: 11px; white-space: pre-wrap; }
</style>
