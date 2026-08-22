<script lang="ts">
    /**
     * Form generated from an adapter's `--config-schema` (mqtt-interfaces-core).
     * Values live in `env` keyed by the property's `x-env` name, as strings — exactly
     * what ends up in /etc/<adapter>/<instance>.env. Secrets arrive masked as '***'
     * and stay masked unless the user types a new value.
     */
    import type { ServiceSchema, ServiceSchemaProperty } from '../../lib/api.js';

    let {
        schema,
        env = $bindable({}),
        secrets = [],
        mode = 'edit',
    }: {
        schema: ServiceSchema | null;
        env: Record<string, string>;
        secrets?: string[];
        mode?: 'edit' | 'install';
    } = $props();

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
    let extraEnv       = $derived(Object.entries(env).filter(([k]) => !knownEnv.has(k)));

    let showShared = $state(mode === 'install' ? false : true);

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
        {#if f.prop.enum}
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
                    <span class="sf-hint">— empty fields fall back to /etc/mqtt-interfaces/broker.env and the adapter defaults</span>
                </button>
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
    .sf-secret { display: flex; gap: 6px; align-items: center; }
    .sf-secret input { flex: 1; }
    .sf-clear { background: none; border: 1px solid var(--border); color: var(--fg-muted); border-radius: 3px; font-size: 11px; padding: 2px 7px; cursor: pointer; }
    .sf-clear:hover { color: var(--fg); border-color: var(--fg-muted); }
</style>
