<script lang="ts">
    /**
     * Add-instance wizard: host → adapter installed there → instance name → options
     * from `--config-schema` → `<adapter> --install --name <instance>` via the helper.
     */
    import { onMount } from 'svelte';
    import { getServiceHosts, getServiceSchema, installService, type ServiceHost, type ServiceSchema, type SheBrokerInfo } from '../../lib/api.js';
    import SchemaForm from './SchemaForm.svelte';

    let { oninstalled }: { oninstalled?: (host: string, adapter: string, instance: string) => void } = $props();

    let hosts     = $state<ServiceHost[]>([]);
    let hostName  = $state('');
    let adapter   = $state('');
    let instance  = $state('');
    let env       = $state<Record<string, string>>({});
    let schema    = $state<ServiceSchema | null>(null);
    let secrets   = $state<string[]>([]);
    let sheBroker = $state<SheBrokerInfo | null>(null);
    let useSheBroker = $state(false);
    let schemaErr = $state('');
    let loadingSchema = $state(false);
    let installing = $state(false);
    let output    = $state('');
    let error     = $state('');
    let done      = $state(false);

    let host = $derived(hosts.find(h => h.name === hostName) ?? null);
    let adapters = $derived(host?.ok ? (host.adapters ?? []) : []);
    let existing = $derived((host?.instances ?? []).filter(i => i.adapter === adapter).map(i => i.instance));
    let nameOk = $derived(/^[A-Za-z0-9_.-]+$/.test(instance) && !existing.includes(instance));
    let missingRequired = $derived.by(() => {
        if (!schema) return [];
        return (schema.required ?? []).filter(k => k !== 'name').filter(k => { const p = schema!.properties[k]; return p && !(env[p['x-env']] ?? '').trim(); });
    });

    onMount(async () => {
        try {
            hosts = (await getServiceHosts()).hosts;
            const first = hosts.find(h => h.ok);
            if (first) hostName = first.name;
        } catch (e: any) {
            error = e.message ?? String(e);
        }
    });

    $effect(() => {
        // reset when the host changes
        void hostName;
        adapter = ''; schema = null; env = {}; instance = '';
    });

    async function pickAdapter(name: string) {
        adapter = name; schema = null; env = {}; schemaErr = '';
        if (!name || !hostName) return;
        // default instance name: the adapter's default --name is in the schema (property name.default)
        loadingSchema = true;
        try {
            const r = await getServiceSchema(hostName, name);
            schema = r.schema; secrets = r.secrets; sheBroker = r.sheBroker;
            useSheBroker = !!r.sheBroker; // new instances connect to she's broker unless told otherwise
            const def = schema.properties?.name?.default;
            if (!instance && typeof def === 'string') instance = existing.includes(def) ? def + '2' : def;
        } catch (e: any) {
            schemaErr = e.message ?? String(e);
        } finally {
            loadingSchema = false;
        }
    }

    async function install() {
        if (!hostName || !adapter || !nameOk || missingRequired.length) return;
        installing = true; error = ''; output = '';
        try {
            const r = await installService(hostName, adapter, instance, env, useSheBroker);
            output = r.output;
            done = true;
            oninstalled?.(hostName, adapter, instance);
        } catch (e: any) {
            error = e.message ?? String(e);
        } finally {
            installing = false;
        }
    }

    function reset() {
        done = false; output = ''; error = ''; instance = ''; env = {}; schema = null; adapter = '';
    }
</script>

<div class="add">
    <div class="content">
        {#if error && !done}<div class="err-box">{error}</div>{/if}

        {#if done}
            <div class="ok-box">
                <strong>{adapter}@{instance}</strong> installed on {hostName} and started. It shows up in the Instances tab as soon as it publishes <code>{instance}/connected</code>.
            </div>
            <pre class="out mono">{output}</pre>
            <button class="ghost" onclick={reset}>Add another</button>
        {:else}
            <div class="step">
                <label for="add-host">Host</label>
                <select id="add-host" bind:value={hostName}>
                    {#each hosts as h (h.name)}
                        <option value={h.name} disabled={!h.ok}>{h.hostname ?? h.name}{h.ok ? '' : ' — unavailable'}</option>
                    {/each}
                </select>
                {#if hosts.length === 0}<span class="muted">No hosts — the she host itself needs <code>sudo she --install</code> for the helper.</span>{/if}
            </div>

            <div class="step">
                <label for="add-adapter">Adapter</label>
                <select id="add-adapter" value={adapter} onchange={(e) => pickAdapter((e.target as HTMLSelectElement).value)} disabled={!host?.ok}>
                    <option value="">choose…</option>
                    {#each adapters as a (a.name)}
                        <option value={a.name}>{a.name}{a.version ? ` ${a.version}` : ''}</option>
                    {/each}
                </select>
                {#if host?.ok && adapters.length === 0}
                    <span class="muted">No adapters installed on {hostName}. Install one first: <code>sudo npm install -g &lt;adapter&gt;</code> (catalog: roadmap I7).</span>
                {/if}
            </div>

            {#if adapter}
                <div class="step">
                    <label for="add-name">Instance name</label>
                    <input id="add-name" type="text" bind:value={instance} spellcheck="false" placeholder="topic prefix, e.g. cul" />
                    <span class="muted">
                        systemd unit <span class="mono">{adapter}@{instance || '…'}</span>, topics <span class="mono">{instance || '…'}/#</span>
                        {#if instance && !nameOk}<span class="err"> — {existing.includes(instance) ? 'already exists on this host' : 'letters, digits, _ . - only'}</span>{/if}
                    </span>
                </div>

                {#if loadingSchema}
                    <div class="muted">Reading {adapter} --config-schema…</div>
                {:else if schemaErr}
                    <div class="err-box">{schemaErr}</div>
                {:else if schema}
                    <SchemaForm {schema} bind:env {secrets} mode="install" {sheBroker} bind:useSheBroker />
                    <div class="actions">
                        <button onclick={install} disabled={installing || !nameOk || missingRequired.length > 0}>
                            {installing ? 'Installing…' : `Install ${adapter}@${instance || '…'}`}
                        </button>
                        {#if missingRequired.length}<span class="muted">required: {missingRequired.map(k => '--' + k).join(', ')}</span>{/if}
                    </div>
                {/if}
            {/if}
        {/if}
    </div>
</div>

<style>
    .add { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .content { flex: 1; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; font-size: 12px; color: var(--fg); max-width: 760px; }
    .step { display: flex; flex-direction: column; gap: 4px; }
    .step label { font-weight: 600; }
    .muted { color: var(--fg-muted); font-size: 11px; }
    .muted code { color: var(--accent); }
    .err { color: #e74c3c; }
    .mono { font-family: var(--font-mono, monospace); }
    input, select { background: var(--bg-input, var(--bg-app)); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; padding: 4px 7px; font-size: 12px; max-width: 480px; }
    input:focus, select:focus { outline: none; border-color: var(--accent); }
    .actions { display: flex; align-items: center; gap: 10px; }
    button { background: var(--accent); border: none; color: #fff; padding: 4px 12px; font-size: 12px; border-radius: 3px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); align-self: flex-start; }
    .err-box { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.35); border-radius: 3px; color: #e88; padding: 6px 10px; }
    .ok-box { background: rgba(39,174,96,0.12); border: 1px solid rgba(39,174,96,0.35); border-radius: 3px; padding: 6px 10px; }
    .ok-box code { color: var(--accent); }
    pre.out { margin: 0; max-height: 240px; overflow: auto; background: var(--bg-app); border: 1px solid var(--border); border-radius: 3px; padding: 6px 8px; font-size: 11px; white-space: pre-wrap; }
</style>
