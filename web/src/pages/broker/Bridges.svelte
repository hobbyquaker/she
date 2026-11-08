<script lang="ts">
    import { onMount } from 'svelte';
    import {
        getBrokerBridges, previewBrokerBridges, putBrokerBridges, testBrokerBridge,
        brokerBridgeRemoteRequirements, createBrokerBridgeRemoteUser,
        type BrokerBridge, type BrokerBridgesResponse, type BridgeTopicRule, type BridgePreview,
        type BridgeSaveResult, type BridgeTestResult, type BridgeRemoteRequirements, type BridgePreset,
    } from '../../lib/api.js';
    import { previewRule, findLoops, patternError, parseOptionLines, optionLines } from '../../lib/bridge-rules.js';
    import ConfirmDialog from '../../lib/ConfirmDialog.svelte';

    // ── Data ──────────────────────────────────────────────────────────────────
    let data = $state<BrokerBridgesResponse | null>(null);
    let loadError = $state('');
    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean; alert?: boolean }): Promise<boolean> };

    onMount(() => {
        load();
        const t = setInterval(() => { if (!editing && !preview) load(true); }, 5000);
        return () => clearInterval(t);
    });

    async function load(quiet = false) {
        try {
            data = await getBrokerBridges();
            loadError = '';
        } catch (e: any) {
            if (!quiet) loadError = e.message ?? 'Failed to load bridges';
        }
    }

    // ── The form ──────────────────────────────────────────────────────────────
    // The options the form has fields for; everything else lives in the Advanced lines.
    const FORM_KEYS = ['remote_username', 'remote_password', 'remote_clientid', 'bridge_cafile', 'bridge_capath', 'bridge_certfile', 'bridge_keyfile', 'bridge_insecure', 'bridge_tls_version',
        'cleansession', 'keepalive_interval', 'restart_timeout', 'try_private', 'notifications', 'start_type', 'bridge_protocol_version'];

    interface Form {
        originalName: string | null;   // null = new bridge
        name: string;
        addresses: string;             // one per line or space-separated
        topics: BridgeTopicRule[];
        remote_username: string;
        remote_password: string;       // what the user typed; '' = unchanged (or none)
        hasStoredPassword: boolean;
        clearPassword: boolean;
        remote_clientid: string;
        tls: boolean;
        bridge_cafile: string;
        bridge_capath: string;
        bridge_certfile: string;
        bridge_keyfile: string;
        bridge_insecure: boolean;
        bridge_tls_version: string;
        cleansession: string;
        keepalive_interval: string;
        restart_timeout: string;
        try_private: string;
        notifications: string;
        start_type: string;
        bridge_protocol_version: string;
        advanced: string;
    }

    let editing = $state<Form | null>(null);
    let rulesOpen = $state(true);
    let advancedOpen = $state(false);
    let remoteOpen = $state(false);
    let testResult = $state<BridgeTestResult | null>(null);
    let testing = $state(false);
    let remoteReq = $state<BridgeRemoteRequirements | null>(null);
    let remoteReqError = $state('');
    let remoteCreating = $state(false);
    let remoteCreateMsg = $state('');
    let copied = $state('');

    const str = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v[0] ?? '' : v ?? '');

    function emptyForm(): Form {
        return {
            originalName: null, name: '', addresses: '', topics: [], remote_username: '', remote_password: '', hasStoredPassword: false, clearPassword: false,
            remote_clientid: '', tls: false, bridge_cafile: '', bridge_capath: '', bridge_certfile: '', bridge_keyfile: '', bridge_insecure: false, bridge_tls_version: '',
            cleansession: '', keepalive_interval: '', restart_timeout: '', try_private: '', notifications: '', start_type: '', bridge_protocol_version: '', advanced: '',
        };
    }

    function toForm(b: BrokerBridge): Form {
        const o = b.options;
        const rest: Record<string, string | string[] | null> = {};
        for (const [k, v] of Object.entries(o)) if (!FORM_KEYS.includes(k)) rest[k] = v;
        return {
            originalName: b.name,
            name: b.name,
            addresses: b.addresses.join('\n'),
            topics: b.topics.map((t) => ({ ...t })),
            remote_username: str(o.remote_username),
            remote_password: '',
            hasStoredPassword: !!b.secrets?.remote_password,
            clearPassword: false,
            remote_clientid: str(o.remote_clientid),
            tls: !!(o.bridge_cafile || o.bridge_capath || o.bridge_certfile || o.bridge_tls_version),
            bridge_cafile: str(o.bridge_cafile),
            bridge_capath: str(o.bridge_capath),
            bridge_certfile: str(o.bridge_certfile),
            bridge_keyfile: str(o.bridge_keyfile),
            bridge_insecure: str(o.bridge_insecure) === 'true',
            bridge_tls_version: str(o.bridge_tls_version),
            cleansession: str(o.cleansession),
            keepalive_interval: str(o.keepalive_interval),
            restart_timeout: str(o.restart_timeout),
            try_private: str(o.try_private),
            notifications: str(o.notifications),
            start_type: str(o.start_type),
            bridge_protocol_version: str(o.bridge_protocol_version),
            advanced: optionLines(rest),
        };
    }

    /** The form as the API wants it. */
    function toBridge(f: Form): BrokerBridge {
        // the form's fields first, the advanced lines after them — that is the order the block gets
        const options: Record<string, string | string[] | null> = {};
        const set = (k: string, v: string) => { if (v !== '') options[k] = v; else delete options[k]; };
        set('remote_username', f.remote_username.trim());
        set('remote_clientid', f.remote_clientid.trim());
        if (f.clearPassword) delete options.remote_password;
        else if (f.remote_password !== '') options.remote_password = f.remote_password;
        else if (f.hasStoredPassword) options.remote_password = null; // keep what the file has
        if (f.tls) {
            set('bridge_cafile', f.bridge_cafile.trim());
            set('bridge_capath', f.bridge_capath.trim());
            set('bridge_certfile', f.bridge_certfile.trim());
            set('bridge_keyfile', f.bridge_keyfile.trim());
            set('bridge_insecure', f.bridge_insecure ? 'true' : '');
            set('bridge_tls_version', f.bridge_tls_version);
        }
        set('cleansession', f.cleansession);
        set('keepalive_interval', f.keepalive_interval.trim());
        set('restart_timeout', f.restart_timeout.trim());
        set('try_private', f.try_private);
        set('notifications', f.notifications);
        set('start_type', f.start_type);
        set('bridge_protocol_version', f.bridge_protocol_version);
        for (const [k, v] of Object.entries(parseOptionLines(f.advanced))) if (!(k in options)) options[k] = v;
        return {
            name: f.name.trim(),
            originalName: f.originalName ?? undefined,
            addresses: f.addresses.split(/[\s,]+/).map((a) => a.trim()).filter(Boolean),
            topics: f.topics.map((t) => ({ ...t, pattern: t.pattern.trim(), localPrefix: t.localPrefix.trim(), remotePrefix: t.remotePrefix.trim() })),
            options,
        };
    }

    /** The other bridges as the API knows them (unchanged: secrets kept with null). */
    function others(exceptName: string | null): BrokerBridge[] {
        return (data?.bridges ?? [])
            .filter((b) => b.name !== exceptName)
            .map((b) => ({ name: b.name, originalName: b.name, addresses: b.addresses, topics: b.topics, options: withKeptSecrets(b) }));
    }

    function withKeptSecrets(b: BrokerBridge): Record<string, string | string[] | null> {
        const o: Record<string, string | string[] | null> = { ...b.options };
        for (const k of Object.keys(b.secrets ?? {})) if (b.secrets![k]) o[k] = null;
        return o;
    }

    function startAdd() {
        editing = emptyForm();
        editing.notifications = '';
        resetFormState();
    }

    function startEdit(b: BrokerBridge) {
        editing = toForm(b);
        resetFormState();
    }

    function resetFormState() {
        testResult = null;
        remoteReq = null;
        remoteReqError = '';
        remoteCreateMsg = '';
        remoteOpen = false;
        advancedOpen = !!editing?.advanced;
        rulesOpen = true;
    }

    function cancelEdit() {
        editing = null;
    }

    // ── Topic rules ───────────────────────────────────────────────────────────
    function addRule(rule?: Partial<BridgeTopicRule>) {
        if (!editing) return;
        editing.topics = [...editing.topics, { pattern: '', direction: 'in', qos: 0, localPrefix: '', remotePrefix: '', ...rule }];
    }

    function removeRule(i: number) {
        if (!editing) return;
        editing.topics = editing.topics.filter((_, idx) => idx !== i);
    }

    let presetId = $state('');
    let presetParams = $state<Record<string, string>>({});

    function choosePreset(id: string) {
        presetId = id;
        const p = data?.presets.find((x) => x.id === id);
        presetParams = Object.fromEntries((p?.params ?? []).map((q) => [q.key, q.default]));
    }

    /** The presets' rules — the same shapes the daemon's catalogue has, filled with the parameters. */
    function presetRules(p: BridgePreset, params: Record<string, string>): BridgeTopicRule[] {
        const r = (pattern: string, direction: BridgeTopicRule['direction'], localPrefix = '', remotePrefix = ''): BridgeTopicRule => ({ pattern, direction, qos: 0, localPrefix, remotePrefix });
        switch (p.id) {
            case 'mirror-prefix': return [r('#', 'in', params.prefix ?? 'remote/', '')];
            case 'mqtt-smarthome-adapter': {
                const n = (params.name ?? 'adapter').replace(/\/+$/, '');
                return [r(`${n}/status/#`, 'in'), r(`${n}/connected`, 'in'), r(`${n}/set/#`, 'out')];
            }
            case 'publish-prefix': return [r('#', 'out', params.local ?? 'home/', params.remote ?? 'site1/')];
            default: return [];
        }
    }

    function applyPreset() {
        const p = data?.presets.find((x) => x.id === presetId);
        if (!p || !editing) return;
        editing.topics = [...editing.topics, ...presetRules(p, presetParams)];
        presetId = '';
    }

    // live checks while typing
    let liveLoops = $derived(editing ? findLoops(editing.topics.map((t) => ({ ...t, pattern: t.pattern.trim(), localPrefix: t.localPrefix.trim(), remotePrefix: t.remotePrefix.trim() }))) : { errors: [], warnings: [] });
    let liveNameClash = $derived(!!editing && editing.name.trim() !== '' && editing.name.trim() !== editing.originalName && (data?.bridges ?? []).some((b) => b.name === editing!.name.trim()));

    // ── Test connection ───────────────────────────────────────────────────────
    async function testConnection() {
        if (!editing) return;
        testing = true;
        testResult = null;
        try {
            const b = toBridge(editing);
            testResult = await testBrokerBridge({ name: b.name, originalName: b.originalName, addresses: b.addresses, options: b.options });
        } catch (e: any) {
            testResult = { ok: false, error: e.message ?? 'test failed' };
        } finally {
            testing = false;
        }
    }

    // ── The remote side ───────────────────────────────────────────────────────
    async function loadRemote() {
        if (!editing) return;
        remoteReqError = '';
        try {
            remoteReq = await brokerBridgeRemoteRequirements(toBridge(editing));
        } catch (e: any) {
            remoteReqError = e.message ?? 'failed';
        }
    }

    async function copy(text: string, key: string) {
        let ok = false;
        try {
            if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; }
        } catch { ok = false; }
        if (!ok) {
            const ta = document.createElement('textarea');
            ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            try { ok = document.execCommand('copy'); } catch { ok = false; }
            ta.remove();
        }
        if (ok) { copied = key; setTimeout(() => { if (copied === key) copied = ''; }, 1200); }
    }

    async function createRemoteUser() {
        if (!editing || !remoteReq) return;
        const pw = editing.remote_password;
        if (!pw) { remoteCreateMsg = 'Type the remote password into the form first — she cannot read a stored one back.'; return; }
        if (!await dialog.show(`Create user "${remoteReq.username}" with role "${remoteReq.role}" and ${remoteReq.acls.length} ACLs on this broker?`, { confirm: 'Create' })) return;
        remoteCreating = true;
        remoteCreateMsg = '';
        try {
            const r = await createBrokerBridgeRemoteUser(toBridge(editing), pw);
            remoteCreateMsg = `Done: ${r.done.length} created${r.skipped.length ? `, ${r.skipped.length} existed already` : ''}.`;
        } catch (e: any) {
            remoteCreateMsg = 'Failed: ' + (e.message ?? 'unknown error');
        } finally {
            remoteCreating = false;
        }
    }

    // ── Save: preview → diff dialog → write ───────────────────────────────────
    let preview = $state<{ bridges: BrokerBridge[]; result: BridgePreview; title: string } | null>(null);
    let previewing = $state(false);
    let saving = $state(false);
    let saveResult = $state<BridgeSaveResult | null>(null);
    let flash = $state('');

    async function openPreview(bridges: BrokerBridge[], title: string) {
        previewing = true;
        saveResult = null;
        try {
            const result = await previewBrokerBridges(bridges);
            preview = { bridges, result, title };
        } catch (e: any) {
            await dialog.show('Preview failed: ' + (e.message ?? 'unknown error'), { alert: true });
        } finally {
            previewing = false;
        }
    }

    function saveForm() {
        if (!editing) return;
        const b = toBridge(editing);
        // an edited bridge keeps its place in the file (a small diff); a new one goes to the end
        const list = editing.originalName
            ? (data?.bridges ?? []).map((x) => (x.name === editing!.originalName ? b : { name: x.name, originalName: x.name, addresses: x.addresses, topics: x.topics, options: withKeptSecrets(x) }))
            : [...others(null), b];
        openPreview(list, editing.originalName ? `Save bridge "${b.name}"` : `Add bridge "${b.name}"`);
    }

    async function deleteBridge(b: BrokerBridge) {
        if (!await dialog.show(`Remove bridge "${b.name}" from mosquitto.conf? The diff is shown before anything is written.`, { confirm: 'Continue', danger: true })) return;
        openPreview(others(b.name), `Remove bridge "${b.name}"`);
    }

    async function confirmWrite() {
        if (!preview || !data) return;
        saving = true;
        try {
            const r = await putBrokerBridges(preview.bridges, preview.result.checksum ?? data.checksum);
            if (r.status === 409) {
                saveResult = { ok: false, reason: 'mosquitto.conf was changed by someone else since it was read — the page reloads it, nothing was written.' };
                await load();
            } else if (r.status === 400) {
                saveResult = { ok: false, reason: 'Rejected: ' + (r.errors ?? []).join(' ') };
            } else {
                saveResult = r;
                if (r.ok) {
                    editing = null;
                    flash = r.unchanged ? 'Nothing to write — the file already matches.' : `Written and reloaded${r.probe ? ` — the broker answered after ${r.probe.durationMs} ms` : ''}.${r.backupPath ? ` Backup: ${r.backupPath}` : ''}`;
                    setTimeout(() => (flash = ''), 8000);
                    preview = null;
                }
                await load();
            }
        } catch (e: any) {
            saveResult = { ok: false, reason: e.message ?? 'save failed' };
        } finally {
            saving = false;
        }
    }

    function closePreview() {
        preview = null;
        saveResult = null;
    }

    // ── Card helpers ──────────────────────────────────────────────────────────
    function ruleSummary(t: BridgeTopicRule): string {
        const arrow = t.direction === 'in' ? '←' : t.direction === 'out' ? '→' : '↔';
        const p = t.pattern || '#';
        const lp = (t.localPrefix || '') + p;
        const rp = (t.remotePrefix || '') + p;
        return lp === rp ? `${arrow} ${p}` : `${lp} ${arrow} ${rp}`;
    }

    function stateLabel(name: string): string {
        const s = data?.states[name];
        if (!s || s.connected === null) return 'state unknown';
        return s.connected ? 'connected' : 'not connected';
    }

    function fmtAge(ts: number | null): string {
        if (!ts) return '';
        const s = Math.round((Date.now() - ts) / 1000);
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.round(s / 60)}m ago`;
        return `${Math.round(s / 3600)}h ago`;
    }
</script>

<div class="bridges-page">
    <div class="page-header">
        <h3>Bridges</h3>
        {#if data}<span class="meta">{data.bridges.length} bridge{data.bridges.length === 1 ? '' : 's'} · {data.mode} mode{data.brokerVersion ? ` · Mosquitto ${data.brokerVersion}` : ''}</span>{/if}
        <div class="header-actions">
            {#if !editing}<button onclick={startAdd}>+ Add bridge</button>{/if}
        </div>
    </div>

    {#if loadError}<div class="msg-err">{loadError}</div>{/if}
    {#if flash}<div class="msg-ok">{flash}</div>{/if}
    {#if saveResult && !saveResult.ok && !preview}
    <div class="msg-err">
        <strong>Not applied{saveResult.rolledBack ? ' — rolled back' : ''}.</strong> {saveResult.reason}
        {#if saveResult.rolledBack}
            <div class="small">{saveResult.restarted ? 'The previous mosquitto.conf was restored and the broker restarted' : 'The previous mosquitto.conf was restored and the broker reloaded'}{saveResult.recovered === true ? ' — it answers again.' : saveResult.recovered === false ? ' — it still does not answer; check the broker host.' : '.'}
            {#if saveResult.reloadError}<br/>Reload: {saveResult.reloadError}{/if}
            {#if saveResult.rollbackError}<br/>Rollback: {saveResult.rollbackError}{/if}</div>
        {/if}
        {#if saveResult.brokerErrors?.length}<div class="small">Mosquitto logged: {saveResult.brokerErrors.join(' · ')}</div>{/if}
    </div>
    {/if}
    {#if saveResult?.ok && saveResult.brokerErrors?.length}
    <div class="msg-warn">Mosquitto logged errors on reload — check the Logs tab: {saveResult.brokerErrors.join(' · ')}</div>
    {/if}

    {#if data === null && !loadError}
    <div class="loading">Loading…</div>
    {:else if data}

    {#if editing}
    <!-- ── The form ─────────────────────────────────────────────────────── -->
    <div class="card form">
        <div class="card-title">
            <span>{editing.originalName ? `Edit bridge "${editing.originalName}"` : 'New bridge'}</span>
        </div>

        <div class="section-title">Remote broker</div>
        <div class="field-row">
            <label>
                Name <span class="hint">(the <code>connection</code> name)</span>
                <input bind:value={editing.name} placeholder="cloud" />
                {#if liveNameClash}<span class="field-err">a bridge of that name exists</span>{/if}
            </label>
            <label>
                Address(es) <span class="hint">host or host:port, several for failover</span>
                <input bind:value={editing.addresses} placeholder="broker.example.net:8883" />
            </label>
            <label>
                Remote client id <span class="hint">default: &lt;hostname&gt;.&lt;name&gt;</span>
                <input bind:value={editing.remote_clientid} placeholder="she-cloud" />
            </label>
        </div>
        <div class="field-row">
            <label>
                Remote username
                <input bind:value={editing.remote_username} placeholder="(none)" autocomplete="off" />
            </label>
            <label>
                Remote password
                <input type="password" bind:value={editing.remote_password} placeholder={editing.hasStoredPassword && !editing.clearPassword ? '•••••••• stored — leave empty to keep' : '(none)'} autocomplete="new-password" disabled={editing.clearPassword} />
                {#if editing.hasStoredPassword}
                <span class="toggle-label small-toggle"><input type="checkbox" bind:checked={editing.clearPassword} /><span class="checkmark"></span>remove the stored password</span>
                {/if}
            </label>
            <label class="toggle-label tls-inline">
                <input type="checkbox" bind:checked={editing.tls} />
                <span class="checkmark"></span>
                TLS
            </label>
        </div>

        {#if editing.tls}
        <div class="sub-section">
            <div class="field-row">
                <label>
                    CA file (bridge_cafile) <span class="hint">path on the broker host</span>
                    <input bind:value={editing.bridge_cafile} placeholder="/etc/mosquitto/certs/remote-ca.crt" />
                </label>
                <label>
                    CA directory (bridge_capath)
                    <input bind:value={editing.bridge_capath} placeholder="/etc/ssl/certs" />
                </label>
                <label>
                    TLS version
                    <select bind:value={editing.bridge_tls_version}>
                        <option value="">default</option>
                        <option value="tlsv1.3">tlsv1.3</option>
                        <option value="tlsv1.2">tlsv1.2</option>
                    </select>
                </label>
            </div>
            <div class="field-row">
                <label>
                    Client certificate (bridge_certfile)
                    <input bind:value={editing.bridge_certfile} placeholder="(none)" />
                </label>
                <label>
                    Client key (bridge_keyfile)
                    <input bind:value={editing.bridge_keyfile} placeholder="(none)" />
                </label>
                <label class="toggle-label tls-inline">
                    <input type="checkbox" bind:checked={editing.bridge_insecure} />
                    <span class="checkmark"></span>
                    bridge_insecure <span class="hint">(skip the hostname check — testing only)</span>
                </label>
            </div>
            <p class="hint-line">The paths are read by Mosquitto on the broker host. A CA from she's Certificates tab works when its <code>ca.crt</code> is copied there.</p>
        </div>
        {/if}

        <div class="test-row">
            <button onclick={testConnection} disabled={testing || !editing.addresses.trim()}>{testing ? 'Testing…' : 'Test connection'}</button>
            {#if testResult}
                <span class={testResult.ok ? 'test-ok' : 'test-fail'}>
                    {#if testResult.ok}✓ connected to {testResult.url} in {testResult.durationMs} ms{:else}✗ {testResult.error}{testResult.url ? ` (${testResult.url})` : ''}{/if}
                </span>
                <span class="hint">from the she host{testResult.from ? ` (${testResult.from})` : ''}</span>
            {/if}
        </div>

        <!-- ── Topic rules ─────────────────────────────────────────────── -->
        <button class="section-toggle" onclick={() => (rulesOpen = !rulesOpen)}>{rulesOpen ? '▾' : '▸'} Topic rules ({editing.topics.length})</button>
        {#if rulesOpen}
        <div class="sub-section">
            {#if editing.topics.length > 0}
            <table class="rules">
                <thead>
                    <tr><th>Pattern</th><th>Direction</th><th>QoS</th><th>Local prefix</th><th>Remote prefix</th><th></th></tr>
                </thead>
                <tbody>
                    {#each editing.topics as t, i}
                    <tr>
                        <td><input bind:value={t.pattern} placeholder={'tele/#'} class:bad={!!patternError(t.pattern.trim())} title={patternError(t.pattern.trim()) ?? ''} /></td>
                        <td>
                            <select bind:value={t.direction}>
                                <option value="in">in — remote → here</option>
                                <option value="out">out — here → remote</option>
                                <option value="both">both</option>
                            </select>
                        </td>
                        <td>
                            <select value={String(t.qos)} onchange={(e) => { t.qos = Number((e.target as HTMLSelectElement).value) as 0|1|2; }}>
                                <option value="0">0</option><option value="1">1</option><option value="2">2</option>
                            </select>
                        </td>
                        <td><input bind:value={t.localPrefix} placeholder="(none)" /></td>
                        <td><input bind:value={t.remotePrefix} placeholder="(none)" /></td>
                        <td><button class="remove-btn" onclick={() => removeRule(i)} title="Remove rule">✕</button></td>
                    </tr>
                    <tr class="preview-row">
                        <td colspan="6">
                            {#each previewRule({ ...t, pattern: t.pattern.trim(), localPrefix: t.localPrefix.trim(), remotePrefix: t.remotePrefix.trim() }).lines as line}
                                <span class="pv"><span class="pv-side">{line.from}</span> <code>{line.fromTopic}</code> → <span class="pv-side">{line.to}</span> <code>{line.toTopic}</code></span>
                            {/each}
                        </td>
                    </tr>
                    {/each}
                </tbody>
            </table>
            {:else}
            <div class="empty-rules">No topic rule yet — the bridge would connect and carry nothing.</div>
            {/if}
            {#each liveLoops.errors as e}<div class="field-err block">{e}</div>{/each}
            {#each liveLoops.warnings as w}<div class="field-warn block">{w}</div>{/each}

            <div class="rules-actions">
                <button onclick={() => addRule()}>+ Add rule</button>
                <select value={presetId} onchange={(e) => choosePreset((e.target as HTMLSelectElement).value)}>
                    <option value="">Preset…</option>
                    {#each data.presets as p}<option value={p.id}>{p.title}</option>{/each}
                </select>
                {#if presetId}
                    {@const p = data.presets.find((x) => x.id === presetId)}
                    {#if p}
                    <span class="preset-params">
                        {#each p.params as q}
                            <label class="inline">{q.label} <input bind:value={presetParams[q.key]} /></label>
                        {/each}
                        <button class="btn-accent" onclick={applyPreset}>Add {presetRules(p, presetParams).length} rule{presetRules(p, presetParams).length === 1 ? '' : 's'}</button>
                        <span class="hint">{p.description}</span>
                    </span>
                    {/if}
                {/if}
            </div>
        </div>
        {/if}

        <!-- ── Connection options ─────────────────────────────────────── -->
        <div class="section-title">Connection</div>
        <div class="field-row">
            <label>
                cleansession
                <select bind:value={editing.cleansession}><option value="">default (false)</option><option value="true">true</option><option value="false">false</option></select>
            </label>
            <label>
                keepalive_interval <span class="hint">s</span>
                <input type="number" min="5" bind:value={editing.keepalive_interval} placeholder="60" />
            </label>
            <label>
                restart_timeout <span class="hint">s, or "base cap"</span>
                <input bind:value={editing.restart_timeout} placeholder="5 30" />
            </label>
            <label>
                start_type
                <select bind:value={editing.start_type}><option value="">default (automatic)</option><option value="automatic">automatic</option><option value="lazy">lazy</option><option value="once">once</option></select>
            </label>
        </div>
        <div class="field-row">
            <label>
                try_private <span class="hint">tell a Mosquitto remote this is a bridge</span>
                <select bind:value={editing.try_private}><option value="">default (true)</option><option value="true">true</option><option value="false">false</option></select>
            </label>
            <label>
                notifications <span class="hint">the state topic she shows</span>
                <select bind:value={editing.notifications}><option value="">default (true)</option><option value="true">true</option><option value="false">false</option></select>
            </label>
            <label>
                bridge_protocol_version
                <select bind:value={editing.bridge_protocol_version}><option value="">default (mqttv311)</option><option value="mqttv50">mqttv50</option><option value="mqttv311">mqttv311</option><option value="mqttv31">mqttv31</option></select>
            </label>
        </div>

        <button class="section-toggle" onclick={() => (advancedOpen = !advancedOpen)}>{advancedOpen ? '▾' : '▸'} Advanced</button>
        {#if advancedOpen}
        <div class="sub-section">
            <label class="block-label">
                Further options, one <code>key value</code> per line <span class="hint">— checked against Mosquitto's bridge options before writing; unknown ones are flagged</span>
                <textarea bind:value={editing.advanced} rows={4} placeholder={'local_clientid she-cloud-local\nbridge_outgoing_retain false\nidle_timeout 120'}></textarea>
            </label>
        </div>
        {/if}

        <!-- ── The remote side ─────────────────────────────────────────── -->
        <button class="section-toggle" onclick={() => { remoteOpen = !remoteOpen; if (remoteOpen) loadRemote(); }}>{remoteOpen ? '▾' : '▸'} What the remote broker needs</button>
        {#if remoteOpen}
        <div class="sub-section remote">
            <p class="hint-line">The bridge logs in to the remote broker as a client. she shows what that broker needs and changes nothing there. Locally no user or ACL is needed: the bridge is not a client of this broker.</p>
            {#if remoteReqError}<div class="msg-err">{remoteReqError}</div>
            {:else if remoteReq}
                <div class="remote-block">
                    <div class="remote-head"><span>Plain text</span><button onclick={() => copy(remoteReq!.plain, 'plain')}>{copied === 'plain' ? 'copied' : 'copy'}</button></div>
                    <pre>{remoteReq.plain}</pre>
                </div>
                <div class="remote-block">
                    <div class="remote-head"><span>dynsec (mosquitto_ctrl on the remote)</span><button onclick={() => copy(remoteReq!.dynsec.join('\n'), 'dynsec')}>{copied === 'dynsec' ? 'copied' : 'copy'}</button></div>
                    <pre>{remoteReq.dynsec.join('\n')}</pre>
                </div>
                {#if remoteReq.managedHere}
                    <div class="remote-managed">
                        This address is the broker she manages.
                        {#if remoteReq.canCreate}
                            <button class="btn-accent" onclick={createRemoteUser} disabled={remoteCreating || !remoteReq.username}>{remoteCreating ? 'Creating…' : 'Create the bridge user here'}</button>
                        {:else}
                            <span class="hint">dynsec is not active, so she cannot create the user — use the commands above.</span>
                        {/if}
                        {#if remoteCreateMsg}<div class="small">{remoteCreateMsg}</div>{/if}
                    </div>
                {/if}
                <button class="link-btn" onclick={loadRemote}>refresh</button>
            {:else}
                <div class="loading">…</div>
            {/if}
        </div>
        {/if}

        <div class="form-actions">
            <button onclick={cancelEdit}>Cancel</button>
            <button class="btn-save" onclick={saveForm} disabled={previewing || liveNameClash || liveLoops.errors.length > 0 || !editing.name.trim()}>{previewing ? 'Checking…' : 'Save…'}</button>
            <span class="hint">Save shows the mosquitto.conf diff first; the broker is reloaded and rolled back if it does not come back.</span>
        </div>
    </div>
    {/if}

    <!-- ── Cards ─────────────────────────────────────────────────────────── -->
    <div class="cards">
        {#each data.bridges as b (b.name)}
        {@const s = data.states[b.name]}
        <div class="card" class:dim={editing && editing.originalName !== b.name}>
            <div class="card-title">
                <span class="dot" class:ok={s?.connected === true} class:dot-err={s?.connected === false} class:dot-off={!s || s.connected === null} title={s?.topic ?? 'no state topic seen yet'}></span>
                <span>{b.name}</span>
                <span class="state" class:ok={s?.connected === true} class:err={s?.connected === false}>{stateLabel(b.name)}{s?.ts ? ` · ${fmtAge(s.ts)}` : ''}</span>
                <span class="spacer"></span>
                {#if !editing}
                <button class="small-btn" onclick={() => startEdit(b)}>Edit</button>
                <button class="small-btn danger" onclick={() => deleteBridge(b)}>Delete</button>
                {/if}
            </div>
            <div class="card-body">
                <div class="kv"><span>Remote</span><code>{b.addresses.join(', ')}</code>{#if b.options.remote_username}<span class="tag">user {b.options.remote_username}</span>{/if}{#if b.options.bridge_cafile || b.options.bridge_capath || b.options.bridge_certfile}<span class="tag">TLS</span>{/if}{#if b.options.remote_clientid}<span class="tag">id {b.options.remote_clientid}</span>{/if}</div>
                <div class="kv rules-kv"><span>Rules</span>
                    {#if b.topics.length === 0}<em class="muted">none</em>{/if}
                    {#each b.topics as t}<code class="rule">{ruleSummary(t)}</code>{/each}
                </div>
            </div>
        </div>
        {/each}
        {#if data.bridges.length === 0 && !editing}
        <div class="empty">No bridges in mosquitto.conf. A bridge joins this broker to another one permanently — for a connection she owns (cloud brokers, topics to rename), see the Config page's additional brokers.</div>
        {/if}
    </div>
    {/if}
</div>

<!-- ── Diff dialog ───────────────────────────────────────────────────────── -->
{#if preview}
<div class="backdrop" role="presentation" onclick={() => { if (!saving) closePreview(); }}></div>
<div class="dialog" role="dialog" aria-modal="true">
    <h4>{preview.title}</h4>
    {#if preview.result.errors.length}
        <div class="msg-err"><strong>Cannot write:</strong><ul>{#each preview.result.errors as e}<li>{e}</li>{/each}</ul></div>
    {/if}
    {#if preview.result.warnings.length}
        <div class="msg-warn"><ul>{#each preview.result.warnings as w}<li>{w}</li>{/each}</ul></div>
    {/if}
    {#if !preview.result.changed}
        <p class="muted">The file already matches — nothing to write.</p>
    {:else}
        <p class="muted">mosquitto.conf will change like this{data?.mode === 'remote' ? ' (uploaded over SSH)' : ''}; secrets are masked:</p>
        <pre class="diff">{#each preview.result.diff.split('\n') as line}<span class:add={line.startsWith('+') && !line.startsWith('+++')} class:del={line.startsWith('-') && !line.startsWith('---')} class:hunk={line.startsWith('@@')}>{line}
</span>{/each}</pre>
    {/if}
    {#if saveResult && !saveResult.ok}
        <div class="msg-err">
            <strong>Not applied{saveResult.rolledBack ? ' — rolled back' : ''}.</strong> {saveResult.reason}
            {#if saveResult.rolledBack}
                <div class="small">{saveResult.restarted ? 'The previous mosquitto.conf was restored and the broker restarted' : 'The previous mosquitto.conf was restored and the broker reloaded'}{saveResult.recovered === true ? ' — it answers again.' : saveResult.recovered === false ? ' — it still does not answer; check the broker host.' : '.'}
                {#if saveResult.reloadError}<br/>Reload: {saveResult.reloadError}{/if}
                {#if saveResult.rollbackError}<br/>Rollback: {saveResult.rollbackError}{/if}</div>
            {/if}
            {#if saveResult.brokerErrors?.length}<div class="small">Mosquitto logged: {saveResult.brokerErrors.join(' · ')}</div>{/if}
        </div>
    {/if}
    <div class="actions">
        <button class="cancel" onclick={closePreview} disabled={saving}>{saveResult && !saveResult.ok ? 'Close' : 'Cancel'}</button>
        {#if !(saveResult && !saveResult.ok)}
        <button class="btn-accent" onclick={confirmWrite} disabled={saving || preview.result.errors.length > 0 || !preview.result.changed}>
            {saving ? 'Writing, reloading, probing…' : 'Write & reload'}
        </button>
        {/if}
    </div>
</div>
{/if}

<ConfirmDialog bind:this={dialog} />

<style>
    .bridges-page { padding: 14px 16px; overflow: auto; height: 100%; box-sizing: border-box; }
    .page-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
    .page-header h3 { margin: 0; font-size: 13px; color: var(--text-muted, #aaa); text-transform: uppercase; letter-spacing: 0.04em; }
    .meta { font-size: 11px; color: var(--text-muted, #888); }
    .header-actions { display: flex; gap: 6px; margin-left: auto; }
    button { background: none; border: 1px solid var(--border, #444); border-radius: 4px; color: var(--text-muted, #aaa); cursor: pointer; font-size: 12px; padding: 4px 10px; }
    button:hover:not(:disabled) { color: var(--text, #ddd); border-color: var(--text-muted, #888); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-accent { background: var(--accent-dim, rgba(86,156,214,0.15)); border-color: rgba(86,156,214,0.35); color: var(--accent, #569cd6); }
    .btn-save { background: var(--accent, #569cd6); border-color: var(--accent, #569cd6); color: #fff; }
    .btn-save:hover:not(:disabled) { color: #fff; filter: brightness(1.1); }
    .small-btn { font-size: 11px; padding: 2px 8px; }
    .small-btn.danger:hover { color: #e66; border-color: #e66; }
    .link-btn { border: none; padding: 0; font-size: 11px; text-decoration: underline; }
    .remove-btn { border: none; color: var(--text-muted, #888); font-size: 13px; padding: 2px 6px; }
    .remove-btn:hover { color: #e66; }

    .msg-err { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.3); border-radius: 4px; color: #e88; font-size: 12px; padding: 6px 10px; margin-bottom: 10px; }
    .msg-warn { background: rgba(200,150,0,0.1); border: 1px solid rgba(200,150,0,0.3); border-radius: 4px; color: #db5; font-size: 12px; padding: 6px 10px; margin-bottom: 10px; }
    .msg-ok { background: rgba(70,180,70,0.1); border: 1px solid rgba(70,180,70,0.25); border-radius: 4px; color: #8c8; font-size: 12px; padding: 6px 10px; margin-bottom: 10px; }
    .msg-err ul, .msg-warn ul { margin: 4px 0 0; padding-left: 18px; }
    .small { font-size: 11px; opacity: 0.9; margin-top: 4px; }
    .loading, .empty, .muted { color: var(--text-muted, #888); font-size: 12px; }
    .empty { padding: 20px 0; }

    .cards { display: flex; flex-direction: column; gap: 12px; }
    .card { background: var(--surface, #1e1e1e); border: 1px solid var(--border, #333); border-radius: 6px; padding: 14px 16px; }
    .card.dim { opacity: 0.55; }
    .card.form { margin-bottom: 16px; border-color: rgba(86,156,214,0.35); }
    .card-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--text, #ddd); margin-bottom: 10px; }
    .spacer { flex: 1; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: #555; }
    .dot.ok { background: #4b9; }
    .dot.dot-err { background: #c44; }
    .dot.dot-off { background: #555; }
    .state { font-size: 11px; font-weight: 400; color: var(--text-muted, #888); }
    .state.ok { color: #4b9; }
    .state.err { color: #c66; }
    .card-body { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--text, #ccc); }
    .kv { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .kv > span:first-child { width: 56px; color: var(--text-muted, #888); font-size: 11px; }
    .kv code, .rule { font-size: 11px; background: var(--input-bg, #2a2a2a); border-radius: 3px; padding: 1px 6px; }
    .tag { font-size: 10px; color: var(--text-muted, #aaa); border: 1px solid var(--border, #444); border-radius: 3px; padding: 0 5px; }

    .section-title { font-size: 10px; font-weight: 600; color: var(--text-muted, #888); text-transform: uppercase; letter-spacing: 0.05em; margin: 10px 0 8px; }
    .section-toggle { display: block; border: none; padding: 2px 0; margin-top: 8px; font-size: 11px; }
    .sub-section { border-top: 1px solid var(--border, #333); padding-top: 10px; margin-top: 6px; }
    .field-row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 8px; }
    .field-row label:not(.toggle-label) { display: flex; flex-direction: column; font-size: 11px; color: var(--text-muted, #aaa); gap: 3px; flex: 1; min-width: 180px; }
    .hint { font-weight: 400; color: var(--text-muted, #777); font-size: 10.5px; }
    .hint-line { font-size: 11px; color: var(--text-muted, #888); margin: 4px 0 8px; }
    input:not([type='checkbox']), select, textarea { background: var(--input-bg, #2a2a2a); border: 1px solid var(--border, #444); border-radius: 4px; color: var(--text, #eee); font-size: 12px; padding: 4px 7px; font-family: inherit; }
    input.bad { border-color: #c44; }
    textarea { font-family: monospace; font-size: 11.5px; resize: vertical; }
    .block-label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--text-muted, #aaa); }
    .field-err { color: #e66; font-size: 11px; }
    .field-warn { color: #db5; font-size: 11px; }
    .field-err.block, .field-warn.block { margin: 4px 0; }

    .toggle-label { display: flex; flex-direction: row; align-items: center; gap: 6px; color: var(--text, #ddd); cursor: pointer; font-size: 12px; user-select: none; }
    .toggle-label input[type='checkbox'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .checkmark { flex-shrink: 0; width: 14px; height: 14px; border: 1.5px solid var(--border, #444); border-radius: 3px; background: var(--input-bg, #2a2a2a); position: relative; }
    .toggle-label input:checked + .checkmark { background: var(--accent, #569cd6); border-color: var(--accent, #569cd6); }
    .toggle-label input:checked + .checkmark::after { content: ''; position: absolute; left: 3px; top: 0px; width: 4px; height: 8px; border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg); }
    .tls-inline { flex: 0 0 auto; align-self: flex-end; padding-bottom: 6px; }
    .small-toggle { font-size: 10.5px; color: var(--text-muted, #aaa); margin-top: 2px; }

    .test-row { display: flex; align-items: center; gap: 10px; margin: 4px 0 8px; font-size: 12px; }
    .test-ok { color: #4b9; }
    .test-fail { color: #e66; }

    table.rules { width: 100%; border-collapse: collapse; font-size: 12px; }
    table.rules th { text-align: left; font-size: 10px; font-weight: 600; color: var(--text-muted, #888); text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 4px; }
    table.rules td { padding: 3px 4px; vertical-align: middle; }
    table.rules input, table.rules select { width: 100%; box-sizing: border-box; }
    table.rules td:nth-child(2) { width: 170px; }
    table.rules td:nth-child(3) { width: 56px; }
    table.rules td:last-child { width: 28px; }
    .preview-row td { padding: 0 4px 8px; font-size: 11px; color: var(--text-muted, #888); }
    .pv { display: inline-block; margin-right: 16px; }
    .pv code { font-size: 11px; color: var(--text, #ccc); }
    .pv-side { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
    .empty-rules { font-size: 12px; color: var(--text-muted, #888); padding: 4px 0 8px; }
    .rules-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; }
    .preset-params { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    label.inline { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-muted, #aaa); }
    label.inline input { width: 110px; }

    .remote pre { background: var(--input-bg, #2a2a2a); border: 1px solid var(--border, #333); border-radius: 4px; padding: 8px 10px; font-size: 11px; white-space: pre-wrap; margin: 0 0 8px; color: var(--text, #ddd); }
    .remote-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--text-muted, #aaa); margin-bottom: 4px; }
    .remote-head button { font-size: 10.5px; padding: 1px 8px; }
    .remote-managed { font-size: 12px; color: var(--text, #ccc); display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }

    .form-actions { display: flex; align-items: center; gap: 8px; margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border, #333); }

    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; }
    .dialog { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 101; background: var(--surface, #1e1e1e); border: 1px solid var(--border, #444); border-radius: 6px; padding: 16px 20px 14px; min-width: 420px; max-width: min(900px, 92vw); max-height: 86vh; overflow: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.6); }
    .dialog h4 { margin: 0 0 10px; font-size: 13px; color: var(--text, #ddd); }
    .dialog p { font-size: 12px; margin: 0 0 8px; }
    pre.diff { background: var(--input-bg, #141414); border: 1px solid var(--border, #333); border-radius: 4px; padding: 8px 10px; font-size: 11.5px; line-height: 1.4; max-height: 50vh; overflow: auto; margin: 0 0 12px; color: var(--text-muted, #aaa); }
    pre.diff .add { color: #8c8; }
    pre.diff .del { color: #e88; }
    pre.diff .hunk { color: #569cd6; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
