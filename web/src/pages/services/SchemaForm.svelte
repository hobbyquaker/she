<script lang="ts">
    /**
     * Form generated from an adapter's `--config-schema` (mqtt-interfaces-core).
     * Values live in `env` keyed by the property's `x-env` name, as strings — exactly
     * what ends up in /etc/<adapter>/<instance>.env. Secrets arrive masked as '***'
     * and stay masked unless the user types a new value.
     */
    import type { ServiceSchema, ServiceSchemaProperty, SheBrokerInfo, DynsecInfo, BrokerMode } from '../../lib/api.js';

    let {
        schema,
        env = $bindable({}),
        secrets = [],
        mode = 'edit',
        sheBroker = null,
        dynsec = null,
        brokerMode = $bindable('own'),
    }: {
        schema: ServiceSchema | null;
        env: Record<string, string>;
        secrets?: string[];
        mode?: 'edit' | 'install';
        /** she's own broker settings — enables the "she's settings" mode */
        sheBroker?: SheBrokerInfo | null;
        /** Mosquitto dynsec availability, the would-be client name and the ACL — enables the "dedicated identity" mode */
        dynsec?: DynsecInfo | null;
        brokerMode?: BrokerMode;
    } = $props();

    const SHE_BROKER_KEYS = new Set(['mqtt-url', 'mqtt-username', 'mqtt-password']);
    const MARKERS = new Set(['SHE_USE_BROKER', 'SHE_DYNSEC_CLIENT']);
    let managedBroker = $derived(brokerMode !== 'own' && !!sheBroker);
    let showAcl = $state(false);

    const MASK = '***';
    // options every core adapter shares — collapsed by default; `name` is the instance name and not part of the env file
    const SHARED = new Set(['mqtt-url', 'mqtt-username', 'mqtt-password', 'mqtt-client-id-prefix', 'mqtt-tls-ca', 'json-payloads', 'ha-discovery', 'ha-prefix', 'maintenance', 'verbosity']);
    const HIDDEN = new Set(['name']);

    type Field = { key: string; prop: ServiceSchemaProperty; envName: string; required: boolean; secret: boolean };

    let fields = $derived.by((): Field[] => {
        if (!schema?.properties) return [];
        const req = new Set(schema.required ?? []);
        const sec = new Set(secrets);
        return Object.entries(schema.properties)
            .filter(([k, p]) => !HIDDEN.has(k) && typeof p['x-env'] === 'string')
            .map(([key, prop]) => ({ key, prop, envName: prop['x-env'], required: req.has(key), secret: sec.has(prop['x-env']) || prop['x-secret'] === true }));
    });
    let requiredFields = $derived(fields.filter(f => f.required));
    let adapterFields  = $derived(fields.filter(f => !f.required && !SHARED.has(f.key)));
    let sharedFields   = $derived(fields.filter(f => !f.required && SHARED.has(f.key)));
    let knownEnv       = $derived(new Set(fields.map(f => f.envName)));
    let extraEnv       = $derived(Object.entries(env).filter(([k]) => !knownEnv.has(k) && !MARKERS.has(k)));
    /** value shown for a broker field while she manages the credentials */
    function sheValue(f: Field): string {
        if (!sheBroker) return '';
        if (f.key === 'mqtt-url') return sheBroker.url;
        if (brokerMode === 'dynsec') {
            if (f.key === 'mqtt-username') return dynsec?.client ?? '';
            return '••••••••';
        }
        if (f.key === 'mqtt-username') return sheBroker.username;
        return sheBroker.hasPassword ? '••••••••' : '';
    }

    // initial value only — the user toggles it afterwards
    // svelte-ignore state_referenced_locally
    let showShared = $state(mode !== 'install');

    function set(envName: string, value: string) {
        env = { ...env, [envName]: value };
    }
    function unset(envName: string) {
        const { [envName]: _, ...rest } = env;
        env = rest;
    }
    function fmtDefault(v: unknown): string {
        if (v === undefined || v === null) return '';
        if (Array.isArray(v)) return v.join(', ');
        return String(v);
    }
    function boolValue(f: Field): '' | 'true' | 'false' {
        const v = env[f.envName];
        if (v === undefined || v === '') return '';
        return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()) ? 'true' : 'false';
    }
</script>

{#snippet field(f: Field)}
    <div class="sf-field" class:sf-required={f.required}>
        <label for={'sf-' + f.envName}>
            <span class="sf-key">--{f.key}</span>
            {#if f.required}<span class="sf-req" title="required">*</span>{/if}
            <span class="sf-env" title="environment variable in the instance's env file">{f.envName}</span>
        </label>
        {#if managedBroker && SHE_BROKER_KEYS.has(f.key)}
            <input id={'sf-' + f.envName} type="text" value={sheValue(f)} disabled title={brokerMode === 'dynsec' ? "the instance's own dynsec identity, managed by she" : "from she's MQTT settings"} />
        {:else if f.prop.enum}
            <select id={'sf-' + f.envName} value={env[f.envName] ?? ''} onchange={(e) => { const v = (e.target as HTMLSelectElement).value; v === '' ? unset(f.envName) : set(f.envName, v); }}>
                <option value="">default{f.prop.default !== undefined ? ` (${fmtDefault(f.prop.default)})` : ''}</option>
                {#each f.prop.enum as o (o)}<option value={o}>{o}</option>{/each}
            </select>
        {:else if f.prop.type === 'boolean'}
            <select id={'sf-' + f.envName} value={boolValue(f)} onchange={(e) => { const v = (e.target as HTMLSelectElement).value; v === '' ? unset(f.envName) : set(f.envName, v); }}>
                <option value="">default{f.prop.default !== undefined ? ` (${fmtDefault(f.prop.default)})` : ''}</option>
                <option value="true">true</option>
                <option value="false">false</option>
            </select>
        {:else if f.secret}
            <div class="sf-secret">
                <input id={'sf-' + f.envName} type="password" autocomplete="new-password"
                    value={env[f.envName] === MASK ? '' : (env[f.envName] ?? '')}
                    placeholder={env[f.envName] === MASK ? '(unchanged — type to replace)' : fmtDefault(f.prop.default)}
                    oninput={(e) => set(f.envName, (e.target as HTMLInputElement).value)} />
                {#if env[f.envName] === MASK}
                    <button type="button" class="sf-clear" title="Remove the stored value" onclick={() => unset(f.envName)}>clear</button>
                {/if}
            </div>
        {:else}
            <input id={'sf-' + f.envName} type={f.prop.type === 'number' ? 'number' : 'text'} spellcheck="false"
                value={env[f.envName] ?? ''}
                placeholder={fmtDefault(f.prop.default) || (f.prop.type === 'array' ? 'comma separated' : '')}
                oninput={(e) => { const v = (e.target as HTMLInputElement).value; v === '' ? unset(f.envName) : set(f.envName, v); }} />
        {/if}
        {#if f.prop.description}<div class="sf-desc">{f.prop.description}</div>{/if}
    </div>
{/snippet}

<div class="sf">
    {#if !schema}
        <div class="sf-note">No schema available for this adapter — editing the raw variables.</div>
    {:else}
        {#if requiredFields.length}
            <div class="sf-group">
                {#each requiredFields as f (f.envName)}{@render field(f)}{/each}
            </div>
        {/if}
        {#if adapterFields.length}
            <div class="sf-group">
                <div class="sf-group-title">{schema.title ?? 'adapter'} options</div>
                {#each adapterFields as f (f.envName)}{@render field(f)}{/each}
            </div>
        {/if}
        {#if sharedFields.length}
            <div class="sf-group">
                <button type="button" class="sf-group-title sf-toggle" onclick={() => (showShared = !showShared)}>
                    {showShared ? '▾' : '▸'} MQTT &amp; common options
                    <span class="sf-hint">— empty fields use the adapter defaults</span>
                </button>
                {#if sheBroker}
                    <div class="sf-modes">
                        <span class="sf-modes-title">Broker credentials</span>
                        <label class="sf-radio" title="The values below, as typed">
                            <input type="radio" name="sf-broker-mode" value="own" bind:group={brokerMode} /><span class="sf-radiomark"></span> own values
                        </label>
                        <label class="sf-radio" title="she's MQTT URL, username and password, re-applied on every save">
                            <input type="radio" name="sf-broker-mode" value="she" bind:group={brokerMode} /><span class="sf-radiomark"></span> she's settings <span class="sf-hint">({sheBroker.url}{sheBroker.username ? ', user ' + sheBroker.username : ''})</span>
                        </label>
                        <label class="sf-radio" class:sf-disabled={!dynsec?.available} title={dynsec?.available ? 'A dynsec client and role of its own, limited to the topics this instance needs' : 'Needs Mosquitto management with the dynamic security plugin'}>
                            <input type="radio" name="sf-broker-mode" value="dynsec" bind:group={brokerMode} disabled={!dynsec?.available} /><span class="sf-radiomark"></span> dedicated identity <span class="sf-hint">(dynsec client <span class="sf-mono">{dynsec?.client ?? 'svc-<instance>'}</span>{dynsec?.available ? '' : ' — needs Mosquitto management with dynsec'})</span>
                        </label>
                        {#if brokerMode === 'dynsec' && dynsec?.acl}
                            <button type="button" class="sf-toggle sf-acl-toggle" onclick={() => (showAcl = !showAcl)}>{showAcl ? '▾' : '▸'} ACL of the role ({dynsec.acl.length} rules)</button>
                            {#if showAcl}
                                <ul class="sf-acl">
                                    {#each dynsec.acl as a (a.acltype + a.topic)}<li><span class="sf-mono">{a.acltype}</span> {a.topic} <span class="sf-hint">{a.allow ? 'allow' : 'deny'}</span></li>{/each}
                                </ul>
                                <div class="sf-hint">Created together with the client on save; removed again when you switch the mode or uninstall the instance. The password is random and only stored in the instance's env file.</div>
                            {/if}
                        {/if}
                    </div>
                {/if}
                {#if showShared}
                    {#each sharedFields as f (f.envName)}{@render field(f)}{/each}
                {/if}
            </div>
        {/if}
    {/if}
    {#if extraEnv.length}
        <div class="sf-group">
            <div class="sf-group-title">Other variables in the env file</div>
            {#each extraEnv as [k, v] (k)}
                <div class="sf-field">
                    <label for={'sf-' + k}><span class="sf-env">{k}</span></label>
                    <input id={'sf-' + k} type={secrets.includes(k) ? 'password' : 'text'} spellcheck="false"
                        value={v === MASK ? '' : v} placeholder={v === MASK ? '(unchanged — type to replace)' : ''}
                        oninput={(e) => set(k, (e.target as HTMLInputElement).value)} />
                </div>
            {/each}
        </div>
    {/if}
</div>

<style>
    .sf { display: flex; flex-direction: column; gap: 14px; font-size: 12px; color: var(--fg); }
    .sf-note { color: var(--fg-muted); }
    .sf-group { display: flex; flex-direction: column; gap: 10px; }
    .sf-group-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-muted); }
    .sf-toggle { background: none; border: none; padding: 0; text-align: left; cursor: pointer; color: var(--fg-muted); }
    .sf-toggle:hover { color: var(--fg); }
    .sf-hint { font-weight: 400; text-transform: none; letter-spacing: 0; }
    .sf-field { display: flex; flex-direction: column; gap: 3px; }
    .sf-field label { display: flex; align-items: baseline; gap: 6px; }
    .sf-key { font-family: var(--font-mono, monospace); font-weight: 600; }
    .sf-req { color: #e67e22; }
    .sf-env { font-family: var(--font-mono, monospace); font-size: 10px; color: var(--fg-muted); }
    .sf-desc { font-size: 11px; color: var(--fg-muted); line-height: 1.4; }
    input, select {
        background: var(--bg-input, var(--bg-app)); color: var(--fg); border: 1px solid var(--border);
        border-radius: 3px; padding: 4px 7px; font-size: 12px; max-width: 480px;
    }
    input:focus, select:focus { outline: none; border-color: var(--accent); }
    input:disabled { opacity: 0.6; }
    .sf-modes { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; }
    .sf-modes-title { font-size: 11px; font-weight: 600; color: var(--fg-muted); }
    .sf-radio { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
    .sf-radio.sf-disabled { opacity: 0.55; cursor: default; }
    .sf-radio input[type='radio'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .sf-radiomark { flex-shrink: 0; width: 13px; height: 13px; border: 1.5px solid var(--border); border-radius: 50%; background: var(--bg-app); position: relative; }
    .sf-radio input:checked + .sf-radiomark { border-color: var(--accent); }
    .sf-radio input:checked + .sf-radiomark::after { content: ''; position: absolute; left: 2.5px; top: 2.5px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
    .sf-mono { font-family: var(--font-mono, monospace); }
    .sf-acl-toggle { margin-top: 2px; }
    .sf-acl { margin: 2px 0 0 18px; padding: 0; font-size: 11px; }
    .sf-acl li { list-style: none; }
    .sf-secret { display: flex; gap: 6px; align-items: center; }
    .sf-secret input { flex: 1; }
    .sf-clear { background: none; border: 1px solid var(--border); color: var(--fg-muted); border-radius: 3px; font-size: 11px; padding: 2px 7px; cursor: pointer; }
    .sf-clear:hover { color: var(--fg); border-color: var(--fg-muted); }
</style>
