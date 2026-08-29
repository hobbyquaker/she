<script lang="ts">
    /**
     * Add-instance wizard: host → adapter installed there → instance name → options
     * from `--config-schema` → `<adapter> --install --name <instance>` via the helper.
     */
    import { onMount, tick } from 'svelte';
    import { getServiceHosts, getServiceSchema, installService, type ServiceHost, type ServiceSchema, type SheBrokerInfo, type DynsecInfo, type BrokerMode, type DiscoveredDevice, type DiscoverKind } from '../../lib/api.js';
    import SchemaForm from './SchemaForm.svelte';
    import DeviceScan from './DeviceScan.svelte';

    export interface AddPreset { host: string; adapter: string; n: number }
    let { oninstalled, preset = null, onclose }: { oninstalled?: (host: string, adapter: string, instance: string) => void; preset?: AddPreset | null; onclose?: () => void } = $props();
    let loadingHosts = $state(true);

    let hosts     = $state<ServiceHost[]>([]);
    let hostName  = $state('');
    let adapter   = $state('');
    let instance  = $state('');
    let env       = $state<Record<string, string>>({});
    let schema    = $state<ServiceSchema | null>(null);
    let secrets   = $state<string[]>([]);
    let sheBroker = $state<SheBrokerInfo | null>(null);
    let dynsec = $state<DynsecInfo | null>(null);
    let brokerMode = $state<BrokerMode>('own');
    let schemaErr = $state('');
    let loadingSchema = $state(false);
    let installing = $state(false);
    let output    = $state('');
    let error     = $state('');
    let done      = $state(false);

    // I13: the property the core marked with x-discover — its presence makes the adapter scannable
    let discover = $derived.by(() => {
        const props = schema?.properties ?? {};
        for (const [key, prop] of Object.entries(props)) {
            const raw = prop['x-discover'];
            if (raw === undefined) continue;
            const kinds = (Array.isArray(raw) ? raw : [raw])
                .map(k => (k === true ? 'network' : k))
                .filter((k): k is DiscoverKind => k === 'network' || k === 'serial' || k === 'cloud');
            if (!kinds.length) continue;
            // core 0.12+: options the scan runs on (a cloud login), which must be filled in first
            const needs = (prop['x-discover-needs'] ?? [])
                .filter(n => n !== key && props[n])
                .map(n => ({ key: n, envName: props[n]['x-env'], label: props[n].description ?? n }));
            return { key, envName: prop['x-env'], kinds, needs };
        }
        return null;
    });
    /** The values of those options as typed so far — what the scan is handed. */
    let needValues = $derived.by(() => {
        const out: Record<string, string> = {};
        for (const n of discover?.needs ?? []) {
            const v = (env[n.envName] ?? '').trim();
            if (v) out[n.key] = v;
        }
        return out;
    });
    let needsMissing = $derived((discover?.needs ?? []).filter(n => !needValues[n.key]).map(n => n.key));
    let picked = $state<DiscoveredDevice | null>(null);
    let pickedValue = $state<string | null>(null);
    // the name field starts on the schema default, so "untouched" is what decides whether a picked
    // device may fill it in — not "empty", which never happens once the schema has loaded
    let nameTouched = $state(false);

    // `value` is the form of the device's identity the user picked on the row (ip / host / fqdn)
    function pickDevice(d: DiscoveredDevice, value: string) {
        picked = d;
        pickedValue = value;
        if (discover?.envName) env = { ...env, [discover.envName]: value };
        if (!nameTouched && d.suggestName) instance = d.suggestName;
    }

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
        } finally {
            loadingHosts = false;
        }
    });

    // a preset (Adapters tab "+ instance", Catalog install) selects host and adapter; hosts are re-read first
    let presetSeen = -1;
    $effect(() => {
        if (preset && preset.n !== presetSeen) {
            presetSeen = preset.n;
            applyPreset(preset);
        }
    });
    async function applyPreset(p: AddPreset) {
        loadingHosts = true;
        try {
            hosts = (await getServiceHosts()).hosts;
        } catch {
            /* keep the list we have */
        } finally {
            loadingHosts = false;
        }
        if (done) reset();
        hostName = p.host;
        await tick();
        pickAdapter(p.adapter);
    }

    $effect(() => {
        // reset when the host changes
        void hostName;
        adapter = ''; schema = null; env = {}; instance = ''; picked = null; pickedValue = null; nameTouched = false;
    });

    async function pickAdapter(name: string) {
        adapter = name; schema = null; env = {}; schemaErr = ''; picked = null; pickedValue = null; nameTouched = false;
        if (!name || !hostName) return;
        // default instance name: the adapter's default --name is in the schema (property name.default)
        loadingSchema = true;
        try {
            const r = await getServiceSchema(hostName, name);
            schema = r.schema; secrets = r.secrets; sheBroker = r.sheBroker; dynsec = r.dynsec;
            brokerMode = r.sheBroker ? 'she' : 'own'; // new instances connect to she's broker unless told otherwise
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
            const r = await installService(hostName, adapter, instance, env, brokerMode);
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
        done = false; output = ''; error = ''; instance = ''; env = {}; schema = null; adapter = ''; picked = null; pickedValue = null; nameTouched = false;
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
            {#if onclose}<button class="ghost" onclick={onclose}>← Back to installations</button>{:else}<button class="ghost" onclick={reset}>Add another</button>{/if}
        {:else}
            {#if loadingHosts}
                <div class="loading"><span class="spinner"></span> Asking the hosts…</div>
            {:else if preset}
                <div class="step fixed">
                    <span><span class="lbl">Host</span> <span class="mono">{host?.hostname ?? hostName}</span></span>
                    <span><span class="lbl">Adapter</span> <span class="mono">{adapter}{#if adapters.find(a => a.name === adapter)?.version} {adapters.find(a => a.name === adapter)?.version}{/if}</span></span>
                </div>
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
                    <span class="muted">No adapters installed on {hostName} yet — pick one on the <em>Catalog</em> tab and install it there, or <code>sudo npm install -g &lt;adapter&gt;</code> on the host.</span>
                {/if}
            </div>
            {/if}

            {#if adapter}
                {#if loadingSchema}
                    <div class="loading"><span class="spinner"></span> Reading <span class="mono">{adapter} --config-schema</span> on {host?.hostname ?? hostName}…</div>
                {:else if schemaErr}
                    <div class="err-box">{schemaErr}</div>
                {:else if schema}
                    <!-- scanning comes first: the picked device fills in the option the adapter marked
                         and suggests the instance name, so it is the start of the form, not a detail in it -->
                    {#if discover}
                        <section class="discover" aria-labelledby="add-scan-h">
                            <div class="d-head">
                                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                                    <circle cx="8" cy="8" r="1.6" />
                                    <path d="M4.8 11.2a4.5 4.5 0 0 1 0-6.4M11.2 4.8a4.5 4.5 0 0 1 0 6.4" />
                                    <path d="M2.6 13.4a7.6 7.6 0 0 1 0-10.8M13.4 2.6a7.6 7.6 0 0 1 0 10.8" />
                                </svg>
                                <div>
                                    <strong id="add-scan-h">Find the device</strong>
                                    <div class="muted">
                                        {#if discover.kinds.includes('cloud')}
                                            {adapter} can ask the vendor which devices your account owns — nothing is scanned on your
                                            network. Pick one and <span class="mono">{discover.key}</span> is filled in for you.
                                        {:else}
                                            {adapter} can look for its {discover.kinds.includes('network') ? 'device on the network' : 'stick'} from
                                            {host?.hostname ?? hostName} — pick what answers and <span class="mono">{discover.key}</span> is filled in for you.
                                        {/if}
                                    </div>
                                </div>
                            </div>
                            <DeviceScan
                                host={hostName}
                                {adapter}
                                kinds={discover.kinds}
                                property={discover.key}
                                needs={needValues}
                                missing={needsMissing}
                                selected={pickedValue}
                                onpick={pickDevice}
                            />
                        </section>
                    {/if}

                    <div class="step">
                        <label for="add-name">Instance name</label>
                        <input id="add-name" type="text" bind:value={instance} spellcheck="false" placeholder="topic prefix, e.g. cul" oninput={() => (nameTouched = true)} />
                        <span class="muted">
                            systemd unit <span class="mono">{adapter}@{instance || '…'}</span>, topics <span class="mono">{instance || '…'}/#</span>
                            {#if instance && !nameOk}<span class="err"> — {existing.includes(instance) ? 'already exists on this host' : 'letters, digits, _ . - only'}</span>{/if}
                        </span>
                        {#if picked?.name && !nameTouched && instance === picked.suggestName}
                            <span class="muted">from the device name <em>{picked.name}</em></span>
                        {/if}
                    </div>

                    <SchemaForm {schema} bind:env {secrets} mode="install" {sheBroker} dynsec={dynsec ? { ...dynsec, client: 'svc-' + (instance || '<instance>') } : null} bind:brokerMode />
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
    .step.fixed { flex-direction: row; gap: 24px; }
    .step.fixed .lbl { font-weight: 600; margin-right: 4px; }
    .muted { color: var(--fg-muted); font-size: 11px; }
    /* the discovery panel leads the form, so it is a card rather than another labelled row */
    .discover {
        display: flex; flex-direction: column; gap: 10px;
        border: 1px solid rgba(86,156,214,0.45); background: rgba(86,156,214,0.07);
        border-radius: 5px; padding: 10px 12px;
    }
    .d-head { display: flex; align-items: flex-start; gap: 9px; }
    .d-head svg { color: var(--accent); flex-shrink: 0; margin-top: 1px; }
    .d-head strong { font-size: 13px; }
    .d-head .muted { display: block; margin-top: 2px; line-height: 1.45; }
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
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0; }
    .loading { display: flex; align-items: center; gap: 8px; color: var(--fg-muted); padding: 18px 0; }
</style>
