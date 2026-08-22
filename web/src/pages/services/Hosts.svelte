<script lang="ts">
    import { onMount } from 'svelte';
    import {
        getServiceHosts, updateServiceAdapter, getServiceBrokerEnv, putServiceBrokerEnv,
        type ServiceHost,
    } from '../../lib/api.js';
    import ConfirmDialog from '../../lib/ConfirmDialog.svelte';

    let { onchanged }: { onchanged?: () => void } = $props();

    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean; alert?: boolean }): Promise<boolean> } = $state(null as any);

    let hosts    = $state<ServiceHost[]>([]);
    let loading  = $state(true);
    let error    = $state('');
    let busy     = $state<string | null>(null);
    let notice   = $state('');
    let output   = $state('');

    async function load() {
        loading = true; error = '';
        try {
            hosts = (await getServiceHosts()).hosts;
        } catch (e: any) {
            error = e.message ?? String(e);
        } finally {
            loading = false;
        }
    }
    onMount(load);

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

    /* ── broker.env editor ────────────────────────────────────────────────── */
    const BROKER_KEYS = ['MQTT_URL', 'MQTT_USERNAME', 'MQTT_PASSWORD', 'MQTT_CLIENT_ID_PREFIX', 'MQTT_TLS_CA'];
    let brokerHost = $state<string | null>(null);
    let brokerEnv  = $state<Record<string, string>>({});
    let brokerSecrets = $state<string[]>([]);
    let brokerMsg  = $state('');
    let brokerBusy = $state(false);

    async function openBrokerEnv(h: ServiceHost) {
        brokerHost = h.name; brokerMsg = ''; brokerBusy = true;
        try {
            const r = await getServiceBrokerEnv(h.name);
            brokerEnv = r.env; brokerSecrets = r.secrets;
        } catch (e: any) {
            brokerMsg = e.message ?? String(e);
        } finally {
            brokerBusy = false;
        }
    }
    async function saveBrokerEnv() {
        if (!brokerHost) return;
        brokerBusy = true; brokerMsg = '';
        try {
            await putServiceBrokerEnv(brokerHost, brokerEnv);
            brokerMsg = 'Saved — restart the instances to apply.';
            await load();
        } catch (e: any) {
            brokerMsg = e.message ?? String(e);
        } finally {
            brokerBusy = false;
        }
    }
    function setBroker(k: string, v: string) {
        brokerEnv = { ...brokerEnv, [k]: v };
    }
</script>

<ConfirmDialog bind:this={dialog} />

<div class="hosts">
    <div class="bar">
        <button class="ghost" onclick={load} disabled={loading} title="Reload">↺</button>
        <span class="muted">{hosts.length} host{hosts.length === 1 ? '' : 's'} — configure more under Settings → Services (remote hosts over SSH: roadmap I5)</span>
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
                    <span class="name">{h.name}</span>
                    <span class="muted">{h.local ? 'this host' : h.ssh?.host}{#if h.hostname} · hostname {h.hostname}{/if}{#if h.node} · node {h.node}{/if}</span>
                    <span class="spacer"></span>
                    {#if h.ok}
                        <span class="muted" title="she-servicectl version">helper v{h.helper}{#if h.helperOutdated} <span class="warn">— outdated, run sudo she --install</span>{/if}</span>
                    {/if}
                </div>

                {#if !h.ok}
                    <div class="err-box">
                        {h.error}
                        {#if h.code === 'HELPER_MISSING'}
                            <div class="hint">Install the helper on this host: <code>sudo she --install</code> (copies <code>she-servicectl</code> to <code>/usr/local/bin</code> and allows it in <code>/etc/sudoers.d/she</code>).</div>
                        {:else if h.code === 'SUDO_DENIED'}
                            <div class="hint">Add to <code>/etc/sudoers.d/she</code>: <code>she ALL=(root) NOPASSWD: /usr/local/bin/she-servicectl</code> — <code>sudo she --install</code> does this.</div>
                        {:else if h.code === 'UNSUPPORTED'}
                            <div class="hint">Remote hosts arrive with roadmap item I5.</div>
                        {/if}
                    </div>
                {:else}
                    <table>
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
                                <tr><td colspan="5" class="muted">No mqtt-interfaces adapters installed on this host (template units with the broker.env fingerprint).</td></tr>
                            {/if}
                        </tbody>
                    </table>
                    <div class="card-foot">
                        <span class="muted">/etc/mqtt-interfaces/broker.env: {h.brokerEnv ? 'present' : 'not present'}</span>
                        <button class="ghost sm" onclick={() => openBrokerEnv(h)}>Edit broker.env</button>
                    </div>
                    {#if brokerHost === h.name}
                        <div class="broker-env">
                            <div class="muted">Shared broker settings for every adapter instance on this host (used when the instance's own env file does not set them).</div>
                            {#each BROKER_KEYS as k (k)}
                                <label class="be-row">
                                    <span class="mono">{k}</span>
                                    <input type={brokerSecrets.includes(k) ? 'password' : 'text'} spellcheck="false"
                                        value={brokerEnv[k] === '***' ? '' : (brokerEnv[k] ?? '')}
                                        placeholder={brokerEnv[k] === '***' ? '(unchanged — type to replace)' : ''}
                                        oninput={(e) => setBroker(k, (e.target as HTMLInputElement).value)} />
                                </label>
                            {/each}
                            <div class="actions">
                                <button onclick={saveBrokerEnv} disabled={brokerBusy}>Save</button>
                                <button class="ghost" onclick={() => (brokerHost = null)}>Close</button>
                                {#if brokerMsg}<span class="muted">{brokerMsg}</span>{/if}
                            </div>
                        </div>
                    {/if}
                {/if}
            </div>
        {/each}

        {#if output}
            <pre class="out mono">{output}</pre>
        {/if}
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
    .card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .card-foot { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
    .name { font-weight: 600; font-size: 13px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-muted); }
    .dot.ok { background: #27ae60; }
    .dot.err { background: #e74c3c; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
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
    .broker-env { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
    .be-row { display: grid; grid-template-columns: 200px 1fr; align-items: center; gap: 8px; max-width: 640px; }
    .be-row input { background: var(--bg-input, var(--bg-app)); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; padding: 4px 7px; font-size: 12px; }
    .actions { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
    pre.out { margin: 0; max-height: 240px; overflow: auto; background: var(--bg-app); border: 1px solid var(--border); border-radius: 3px; padding: 6px 8px; font-size: 11px; white-space: pre-wrap; }
</style>
