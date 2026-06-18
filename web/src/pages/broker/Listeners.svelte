<script lang="ts">
    import { onMount } from 'svelte';
    import {
        getBrokerConf, putBrokerConf, brokerReload,
        type BrokerConf, type BrokerListener,
    } from '../../lib/api.js';

    let conf = $state<BrokerConf | null>(null);
    let loadError = $state('');
    let saving = $state(false);
    let saveError = $state('');
    let saveOk = $state(false);
    let reloading = $state(false);
    let reloadMsg = $state('');

    // Deep clone of listeners for editing
    let listeners = $state<BrokerListener[]>([]);
    let checksum = $state<string | null>(null);

    onMount(() => { load(); });

    async function load() {
        try {
            conf = await getBrokerConf();
            listeners = JSON.parse(JSON.stringify(conf.listeners));
            checksum = conf.checksum;
            loadError = '';
        } catch (e: any) {
            loadError = e.message ?? 'Failed to load broker config';
        }
    }

    function addListener() {
        listeners = [...listeners, { port: 1883, bindAddress: '', protocol: 'mqtt', tls: {} }];
    }

    function removeListener(idx: number) {
        listeners = listeners.filter((_, i) => i !== idx);
    }

    async function save() {
        if (!conf) return;
        saving = true;
        saveError = '';
        saveOk = false;
        try {
            await putBrokerConf({ listeners, managed: conf.managed, passthrough: conf.passthrough, checksum });
            saveOk = true;
            setTimeout(() => (saveOk = false), 3000);
            await load(); // refresh checksum
        } catch (e: any) {
            saveError = e.message ?? 'Save failed';
        } finally {
            saving = false;
        }
    }

    async function reload() {
        reloading = true;
        reloadMsg = '';
        try {
            const r = await brokerReload();
            reloadMsg = r.stderr || r.stdout || 'Reloaded';
        } catch (e: any) {
            reloadMsg = 'Error: ' + (e.message ?? 'reload failed');
        } finally {
            reloading = false;
        }
    }

    function isTlsEnabled(l: BrokerListener): boolean {
        return !!(l.tls?.certfile || l.tls?.keyfile || l.tls?.capath || l.tls?.cafile);
    }

    function setTlsEnabled(l: BrokerListener, enabled: boolean) {
        if (!enabled) {
            l.tls = {};
        }
        // trigger reactivity
        listeners = [...listeners];
    }
</script>

<div class="listeners-page">
    <div class="page-header">
        <h3>Listeners</h3>
        <div class="header-actions">
            <button onclick={addListener}>+ Add listener</button>
            <button class="btn-save" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            <button class="btn-reload" onclick={reload} disabled={reloading} title="Apply & Reload mosquitto">{reloading ? 'Reloading…' : 'Apply & Reload'}</button>
        </div>
    </div>

    {#if loadError}<div class="err">{loadError}</div>{/if}
    {#if saveError}<div class="err">{saveError}</div>{/if}
    {#if saveOk}<div class="ok">Saved.</div>{/if}
    {#if reloadMsg}<div class="reload-msg">{reloadMsg}</div>{/if}

    {#if conf === null && !loadError}
    <div class="loading">Loading…</div>
    {:else}
    <div class="cards">
        {#each listeners as l, idx}
        <div class="listener-card">
            <div class="card-title">
                <span>Port {l.port}</span>
                <button class="remove-btn" onclick={() => removeListener(idx)} title="Remove listener">✕</button>
            </div>

            <div class="field-row">
                <label>
                    Port
                    <input type="number" bind:value={l.port} min="1" max="65535" />
                </label>
                <label>
                    Protocol
                    <select bind:value={l.protocol}>
                        <option value="mqtt">mqtt</option>
                        <option value="websockets">websockets</option>
                    </select>
                </label>
                <label>
                    Bind address
                    <input bind:value={l.bindAddress} placeholder="(all interfaces)" />
                </label>
            </div>

            <div class="tls-toggle-row">
                <label class="toggle-label">
                    <input type="checkbox" checked={isTlsEnabled(l)} onchange={(e) => setTlsEnabled(l, (e.target as HTMLInputElement).checked)} />
                    TLS
                </label>
            </div>

            {#if isTlsEnabled(l)}
            <div class="tls-section">
                <div class="field-row">
                    <label>
                        Certificate file (certfile)
                        <input bind:value={l.tls.certfile} placeholder="/etc/mosquitto/certs/server.crt" />
                    </label>
                    <label>
                        Key file (keyfile)
                        <input bind:value={l.tls.keyfile} placeholder="/etc/mosquitto/certs/server.key" />
                    </label>
                </div>
                <div class="field-row">
                    <label>
                        CA file (cafile) — single CA cert
                        <input bind:value={l.tls.cafile} placeholder="/etc/mosquitto/ca.crt" />
                    </label>
                    <label>
                        CA path (capath) — CA cert directory
                        <input bind:value={l.tls.capath} placeholder="/etc/mosquitto/ca-certs/" />
                    </label>
                </div>
                <div class="field-row">
                    <label>
                        CRL file (crlfile)
                        <input bind:value={l.tls.crlfile} placeholder="/etc/mosquitto/crl.pem" />
                    </label>
                    <label>
                        TLS version
                        <select bind:value={l.tls.tls_version}>
                            <option value="">Default</option>
                            <option value="tlsv1.3">tlsv1.3</option>
                            <option value="tlsv1.2">tlsv1.2</option>
                        </select>
                    </label>
                </div>
                <div class="field-row">
                    <label class="toggle-label">
                        <input type="checkbox" bind:checked={l.tls.require_certificate} />
                        Require client certificate (require_certificate)
                    </label>
                    <label class="toggle-label">
                        <input type="checkbox" bind:checked={l.tls.use_identity_as_username} />
                        Use cert CN as username (use_identity_as_username)
                    </label>
                </div>
            </div>
            {/if}
        </div>
        {/each}

        {#if listeners.length === 0}
        <div class="empty">No listeners configured. Click "+ Add listener" to create one.</div>
        {/if}
    </div>
    {/if}
</div>

<style>
    .listeners-page {
        padding: 14px 16px;
        overflow: auto;
        height: 100%;
        box-sizing: border-box;
    }

    .page-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 14px;
    }

    .page-header h3 {
        margin: 0;
        font-size: 13px;
        color: var(--text-muted, #aaa);
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .header-actions {
        display: flex;
        gap: 6px;
        margin-left: auto;
    }

    .header-actions button {
        background: none;
        border: 1px solid var(--border, #444);
        border-radius: 4px;
        color: var(--text-muted, #aaa);
        cursor: pointer;
        font-size: 12px;
        padding: 4px 10px;
    }

    .btn-save { background: var(--accent-dim, rgba(86,156,214,0.15)) !important; border-color: rgba(86,156,214,0.35) !important; color: var(--accent, #569cd6) !important; }
    .btn-reload { background: rgba(100,180,100,0.1) !important; border-color: rgba(100,180,100,0.3) !important; color: #8c8 !important; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    .err { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.3); border-radius: 4px; color: #e88; font-size: 12px; padding: 6px 10px; margin-bottom: 10px; }
    .ok { background: rgba(70,180,70,0.1); border: 1px solid rgba(70,180,70,0.25); border-radius: 4px; color: #8c8; font-size: 12px; padding: 6px 10px; margin-bottom: 10px; }
    .reload-msg { background: var(--surface, #1e1e1e); border: 1px solid var(--border, #333); border-radius: 4px; color: var(--text-muted, #aaa); font-family: monospace; font-size: 11px; padding: 6px 10px; margin-bottom: 10px; white-space: pre-wrap; }

    .loading { color: var(--text-muted, #888); font-size: 12px; }
    .empty { color: var(--text-muted, #888); font-size: 12px; padding: 20px 0; }

    .cards { display: flex; flex-direction: column; gap: 12px; }

    .listener-card {
        background: var(--surface, #1e1e1e);
        border: 1px solid var(--border, #333);
        border-radius: 6px;
        padding: 14px 16px;
    }

    .card-title {
        display: flex;
        align-items: center;
        font-size: 13px;
        font-weight: 600;
        color: var(--text, #ddd);
        margin-bottom: 12px;
    }

    .remove-btn {
        margin-left: auto;
        background: none;
        border: none;
        color: var(--text-muted, #888);
        cursor: pointer;
        font-size: 13px;
        padding: 2px 6px;
    }
    .remove-btn:hover { color: #e66; }

    .field-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 8px;
    }

    .field-row label {
        display: flex;
        flex-direction: column;
        font-size: 11px;
        color: var(--text-muted, #aaa);
        gap: 3px;
        flex: 1;
        min-width: 160px;
    }

    .field-row input, .field-row select {
        background: var(--input-bg, #2a2a2a);
        border: 1px solid var(--border, #444);
        border-radius: 4px;
        color: var(--text, #eee);
        font-size: 12px;
        padding: 4px 7px;
    }

    .tls-toggle-row { margin-bottom: 8px; }

    .toggle-label {
        display: flex !important;
        flex-direction: row !important;
        align-items: center;
        gap: 6px;
        color: var(--text, #ddd) !important;
        cursor: pointer;
        font-size: 12px;
    }

    .tls-section {
        border-top: 1px solid var(--border, #333);
        padding-top: 10px;
        margin-top: 4px;
    }
</style>
