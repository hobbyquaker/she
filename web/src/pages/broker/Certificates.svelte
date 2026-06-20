<script lang="ts">
    import { onMount } from 'svelte';
    import {
        getBrokerServerCert, generateBrokerServerCert, generateBrokerServerCSR, importBrokerServerCert,
        listTrustedCerts, addTrustedCert, removeTrustedCert,
        type ServerCertInfo, type TrustedCert,
    } from '../../lib/api.js';

    // ── State ──────────────────────────────────────────────────────────────────
    let serverInfo = $state<ServerCertInfo | null>(null);
    let trustedCerts = $state<TrustedCert[]>([]);
    let loadError = $state('');
    let actionError = $state('');

    // ── Generate self-signed server cert ───────────────────────────────────────
    let showGenServer = $state(false);
    let genServerCn = $state('');
    let genServerSan = $state('');
    let genServerDays = $state(365);
    let genServerLoading = $state(false);
    let genServerError = $state('');
    let genServerResult = $state<{ fingerprint: string; expires: string } | null>(null);

    // ── Generate CSR ───────────────────────────────────────────────────────────
    let showGenCSR = $state(false);
    let csrCn = $state('');
    let csrSan = $state('');
    let csrLoading = $state(false);
    let csrError = $state('');
    let csrPem = $state('');
    let uploadCertPem = $state('');
    let uploadLoading = $state(false);
    let uploadError = $state('');
    let uploadDone = $state(false);

    // ── Import server cert ─────────────────────────────────────────────────────
    let showImportServer = $state(false);
    let importServerMode = $state<'pem' | 'p12'>('pem');
    let importServerCertPem = $state('');
    let importServerKeyPem = $state('');
    let importServerP12B64 = $state('');
    let importServerP12Name = $state('');
    let importServerPassphrase = $state('');
    let showImportServerPassphrase = $state(false);
    let importServerLoading = $state(false);
    let importServerError = $state('');

    // ── Trusted CAs ────────────────────────────────────────────────────────────
    let showAddTrusted = $state(false);
    let trustedPem = $state('');
    let addTrustedLoading = $state(false);
    let addTrustedError = $state('');

    // ── load ───────────────────────────────────────────────────────────────────
    async function load() {
        try {
            const [srvR, trustedR] = await Promise.allSettled([
                getBrokerServerCert(),
                listTrustedCerts(),
            ]);
            if (srvR.status === 'fulfilled') serverInfo = srvR.value.server;
            if (trustedR.status === 'fulfilled') trustedCerts = trustedR.value.certs;
            loadError = '';
        } catch (e: any) {
            loadError = e.message;
        }
    }

    onMount(() => { load(); });

    // ── Generate self-signed ───────────────────────────────────────────────────
    async function submitGenServer() {
        genServerError = '';
        genServerLoading = true;
        genServerResult = null;
        try {
            const san = genServerSan.split(',').map((s) => s.trim()).filter(Boolean);
            const result = await generateBrokerServerCert({ cn: genServerCn, san, days: genServerDays });
            genServerResult = { fingerprint: result.fingerprint, expires: result.expires };
            await load();
        } catch (e: any) {
            genServerError = e.message;
        } finally {
            genServerLoading = false;
        }
    }

    // ── Generate CSR ───────────────────────────────────────────────────────────
    async function submitGenCSR() {
        csrError = '';
        csrLoading = true;
        csrPem = '';
        try {
            const san = csrSan.split(',').map((s) => s.trim()).filter(Boolean);
            const result = await generateBrokerServerCSR({ cn: csrCn, san });
            csrPem = result.csrPem;
        } catch (e: any) {
            csrError = e.message;
        } finally {
            csrLoading = false;
        }
    }

    async function submitUploadCert() {
        uploadError = '';
        uploadLoading = true;
        uploadDone = false;
        try {
            if (!uploadCertPem.trim()) throw new Error('Paste the signed certificate PEM');
            await importBrokerServerCert({ cert: uploadCertPem });
            uploadDone = true;
            await load();
        } catch (e: any) {
            uploadError = e.message;
        } finally {
            uploadLoading = false;
        }
    }

    function copyCSR() {
        navigator.clipboard.writeText(csrPem).catch(() => {});
    }

    // ── Import server cert ─────────────────────────────────────────────────────
    function handleImportServerP12(e: Event) {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        importServerP12Name = file.name;
        const reader = new FileReader();
        reader.onload = () => {
            const ab = reader.result as ArrayBuffer;
            importServerP12B64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
        };
        reader.readAsArrayBuffer(file);
    }

    async function submitImportServer() {
        importServerError = '';
        importServerLoading = true;
        try {
            if (importServerMode === 'p12') {
                if (!importServerP12B64) throw new Error('Select a .p12 / .pfx file');
                await importBrokerServerCert({ p12base64: importServerP12B64, passphrase: importServerPassphrase });
            } else {
                if (!importServerCertPem.trim()) throw new Error('Certificate PEM is required');
                await importBrokerServerCert({ cert: importServerCertPem, key: importServerKeyPem || undefined });
            }
            showImportServer = false;
            await load();
        } catch (e: any) {
            importServerError = e.message;
        } finally {
            importServerLoading = false;
        }
    }

    // ── Trusted CAs ────────────────────────────────────────────────────────────
    async function submitAddTrusted() {
        addTrustedError = '';
        addTrustedLoading = true;
        try {
            await addTrustedCert(trustedPem);
            trustedPem = '';
            showAddTrusted = false;
            await load();
        } catch (e: any) {
            addTrustedError = e.message;
        } finally {
            addTrustedLoading = false;
        }
    }

    async function doRemoveTrusted(fingerprint: string) {
        if (!confirm('Remove this trusted CA cert?')) return;
        try {
            await removeTrustedCert(fingerprint);
            await load();
        } catch (e: any) {
            actionError = e.message;
        }
    }

    function expiryClass(expires: string): string {
        const ms = new Date(expires).getTime() - Date.now();
        if (ms < 0) return 'expired';
        if (ms < 30 * 86400_000) return 'expiring';
        return '';
    }

    function fmtExpiry(expires: string): string {
        return new Date(expires).toLocaleDateString();
    }
</script>

<div class="certs-page">
    <div class="page-toolbar">
        <button class="reload-btn" onclick={load} title="Refresh">↺</button>
    </div>

    {#if loadError}<div class="err">{loadError}</div>{/if}
    {#if actionError}<div class="err">{actionError}</div>{/if}

    <!-- ── Server Certificate ──────────────────────────────────────────────── -->
    <div class="section">
        <div class="section-header">
            <h3>Server Certificate</h3>
            <button onclick={() => { showGenServer = true; genServerError = ''; genServerResult = null; }}>Self-signed</button>
            <button onclick={() => { showGenCSR = true; csrError = ''; csrPem = ''; uploadCertPem = ''; uploadDone = false; uploadError = ''; }}>Generate CSR</button>
            <button onclick={() => { showImportServer = true; importServerError = ''; importServerMode = 'pem'; importServerCertPem = ''; importServerKeyPem = ''; importServerP12B64 = ''; importServerP12Name = ''; importServerPassphrase = ''; showImportServerPassphrase = false; }}>Import cert</button>
        </div>
        {#if serverInfo}
        <div class="info-card">
            <dl>
                <dt>CN</dt><dd>{serverInfo.cn}</dd>
                <dt>Fingerprint (SHA-256)</dt><dd class="mono small">{serverInfo.fingerprint}</dd>
                <dt>Expires</dt><dd class={expiryClass(serverInfo.expires)}>{fmtExpiry(serverInfo.expires)}</dd>
            </dl>
        </div>
        {:else}
        <div class="empty">No managed server certificate. Use one of the options above, or configure <code>certfile</code>/<code>keyfile</code> manually in the Listeners tab.</div>
        {/if}
    </div>

    <!-- ── Trusted CAs ─────────────────────────────────────────────────────── -->
    <div class="section">
        <div class="section-header">
            <h3>Trusted CA Certificates (capath)</h3>
            <button onclick={() => { showAddTrusted = true; addTrustedError = ''; trustedPem = ''; }}>+ Add CA cert</button>
        </div>
        {#if trustedCerts.length === 0}
        <div class="empty">No trusted CA certs. Add one to enable client certificate authentication.</div>
        {:else}
        <table>
            <thead><tr><th>CN</th><th>Fingerprint</th><th>Expires</th><th></th></tr></thead>
            <tbody>
            {#each trustedCerts as c}
            <tr>
                <td class="mono">{c.cn}</td>
                <td class="mono small">{c.fingerprint.slice(0, 29)}…</td>
                <td class={expiryClass(c.expires)}>{fmtExpiry(c.expires)}</td>
                <td class="actions"><button class="danger" onclick={() => doRemoveTrusted(c.fingerprint)}>✕</button></td>
            </tr>
            {/each}
            </tbody>
        </table>
        {/if}
    </div>
</div>

<!-- ── Self-signed server cert modal ──────────────────────────────────────── -->
{#if showGenServer}
<div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal">
        <h3>Generate self-signed server certificate</h3>
        <label>Common Name (hostname / IP)<input bind:value={genServerCn} placeholder="e.g. mqtt.home.arpa" /></label>
        <label>Subject Alternative Names (comma-separated, optional)<input bind:value={genServerSan} placeholder="192.168.1.10, mqtt.local" /></label>
        <label>Validity (days)<input type="number" bind:value={genServerDays} min="1" max="3650" /></label>
        {#if genServerError}<div class="err">{genServerError}</div>{/if}
        {#if genServerResult}
        <div class="result-box">
            <p>✓ Certificate installed.</p>
            <dl><dt>Fingerprint</dt><dd class="mono small">{genServerResult.fingerprint}</dd><dt>Expires</dt><dd>{fmtExpiry(genServerResult.expires)}</dd></dl>
        </div>
        {/if}
        <div class="modal-actions">
            <button onclick={() => (showGenServer = false)}>Close</button>
            {#if !genServerResult}<button class="btn-primary" onclick={submitGenServer} disabled={genServerLoading}>{genServerLoading ? 'Generating…' : 'Generate'}</button>{/if}
        </div>
    </div>
</div>
{/if}

<!-- ── Generate CSR modal ──────────────────────────────────────────────────── -->
{#if showGenCSR}
<div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal modal--wide">
        <h3>Generate key + CSR for server certificate</h3>
        {#if !csrPem}
        <label>Common Name (hostname / IP)<input bind:value={csrCn} placeholder="e.g. mqtt.home.arpa" /></label>
        <label>Subject Alternative Names (comma-separated, optional)<input bind:value={csrSan} placeholder="192.168.1.10, mqtt.local" /></label>
        <p class="hint">A private key and CSR are generated on the server. Copy the CSR, have it signed by your CA, then paste the signed cert below.</p>
        {#if csrError}<div class="err">{csrError}</div>{/if}
        <div class="modal-actions">
            <button onclick={() => (showGenCSR = false)}>Cancel</button>
            <button class="btn-primary" onclick={submitGenCSR} disabled={csrLoading}>{csrLoading ? 'Generating…' : 'Generate key + CSR'}</button>
        </div>
        {:else}
        <p class="hint">Key stored on server. Copy the CSR, get it signed, then paste the signed certificate to complete installation.</p>
        <label>Certificate Signing Request<textarea readonly rows="8" value={csrPem}></textarea></label>
        <div class="csr-actions">
            <button onclick={copyCSR}>Copy CSR</button>
            <a class="btn-download" href="data:application/pkcs10;charset=utf-8,{encodeURIComponent(csrPem)}" download="server.csr">Download .csr</a>
        </div>
        <hr />
        <label>Upload signed certificate (PEM)<textarea bind:value={uploadCertPem} rows="6" placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----"></textarea></label>
        {#if uploadError}<div class="err">{uploadError}</div>{/if}
        {#if uploadDone}<div class="ok">✓ Certificate installed.</div>{/if}
        <div class="modal-actions">
            <button onclick={() => (showGenCSR = false)}>Close</button>
            {#if !uploadDone}<button class="btn-primary" onclick={submitUploadCert} disabled={uploadLoading || !uploadCertPem.trim()}>{uploadLoading ? 'Uploading…' : 'Upload signed cert'}</button>{/if}
        </div>
        {/if}
    </div>
</div>
{/if}

<!-- ── Import server cert modal ────────────────────────────────────────────── -->
{#if showImportServer}
<div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal modal--wide">
        <h3>Import server certificate</h3>
        <div class="import-mode-tabs">
            <button class:active={importServerMode === 'pem'} onclick={() => (importServerMode = 'pem')}>PEM files</button>
            <button class:active={importServerMode === 'p12'} onclick={() => (importServerMode = 'p12')}>PKCS#12 (.p12 / .pfx)</button>
        </div>
        {#if importServerMode === 'pem'}
        <label>Certificate (PEM)<textarea bind:value={importServerCertPem} rows="5" placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----"></textarea></label>
        <label>Private key (PEM — leave blank if key is already on disk from a prior CSR)<textarea bind:value={importServerKeyPem} rows="4" placeholder="-----BEGIN PRIVATE KEY-----&#10;…&#10;-----END PRIVATE KEY-----"></textarea></label>
        {:else}
        <label>PKCS#12 file
            <div class="file-row">
                <input type="file" accept=".p12,.pfx" onchange={handleImportServerP12} />
                {#if importServerP12Name}<span class="file-name mono small">{importServerP12Name}</span>{/if}
            </div>
        </label>
        <label>Passphrase
            <div class="pw-row">
                <input type={showImportServerPassphrase ? 'text' : 'password'} bind:value={importServerPassphrase} autocomplete="off" />
                <button class="toggle-pw" onclick={() => (showImportServerPassphrase = !showImportServerPassphrase)}>{showImportServerPassphrase ? 'Hide' : 'Show'}</button>
            </div>
        </label>
        {/if}
        {#if importServerError}<div class="err">{importServerError}</div>{/if}
        <div class="modal-actions">
            <button onclick={() => (showImportServer = false)}>Cancel</button>
            <button class="btn-primary" onclick={submitImportServer} disabled={importServerLoading}>{importServerLoading ? 'Importing…' : 'Import'}</button>
        </div>
    </div>
</div>
{/if}

<!-- ── Add Trusted CA modal ────────────────────────────────────────────────── -->
{#if showAddTrusted}
<div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal modal--wide">
        <h3>Add trusted CA certificate</h3>
        <label>CA certificate (PEM)<textarea bind:value={trustedPem} rows="8" placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----"></textarea></label>
        {#if addTrustedError}<div class="err">{addTrustedError}</div>{/if}
        <div class="modal-actions">
            <button onclick={() => (showAddTrusted = false)}>Cancel</button>
            <button class="btn-primary" onclick={submitAddTrusted} disabled={addTrustedLoading || !trustedPem.trim()}>{addTrustedLoading ? 'Adding…' : 'Add CA cert'}</button>
        </div>
    </div>
</div>
{/if}

<style>
    .certs-page { display: flex; flex-direction: column; gap: 28px; padding: 16px; }

    .page-toolbar { display: flex; justify-content: flex-end; margin-bottom: -16px; }
    .reload-btn { background: none; border: none; color: var(--text-muted, #888); cursor: pointer; font-size: 16px; padding: 2px 6px; }
    .reload-btn:hover { color: var(--text, #eee); }

    .section { display: flex; flex-direction: column; gap: 12px; }

    .section-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 2px; }
    .section-header h3 { margin: 0; font-size: 13px; color: var(--text-muted, #aaa); text-transform: uppercase; letter-spacing: 0.04em; flex: 1; min-width: 140px; }
    .section-header button { background: var(--accent-dim, rgba(86,156,214,0.15)); border: 1px solid rgba(86,156,214,0.3); border-radius: 4px; color: var(--accent, #569cd6); cursor: pointer; font-size: 12px; padding: 3px 10px; }

    .info-card { background: var(--surface, #1e1e1e); border: 1px solid var(--border, #333); border-radius: 6px; padding: 14px 16px; }

    dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 12px; margin: 0; }
    dt { color: var(--text-muted, #888); }
    dd { margin: 0; color: var(--text, #ddd); word-break: break-all; }

    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { color: var(--text-muted, #888); font-weight: 500; text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border, #333); }
    td { padding: 5px 8px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: middle; }

    .mono { font-family: monospace; }
    .small { font-size: 10px; }

    .actions { display: flex; gap: 4px; justify-content: flex-end; }
    .actions button { background: none; border: 1px solid var(--border, #333); border-radius: 3px; color: var(--text-muted, #888); cursor: pointer; font-size: 11px; padding: 2px 6px; }
    .actions button.danger:hover { background: rgba(220,60,60,0.15); border-color: rgba(220,60,60,0.4); color: #e66; }

    .expiring { color: #cc9; }
    .expired  { color: #e88; }

    .empty { color: var(--text-muted, #888); font-size: 12px; padding: 4px 0; }
    .err { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.3); border-radius: 4px; color: #e88; font-size: 12px; padding: 6px 10px; }
    .ok  { background: rgba(70,180,70,0.1); border: 1px solid rgba(70,180,70,0.25); border-radius: 4px; color: #8c8; font-size: 12px; padding: 6px 10px; }

    .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 100; }
    .modal { background: var(--surface, #252526); border: 1px solid var(--border, #444); border-radius: 6px; display: flex; flex-direction: column; gap: 10px; min-width: 320px; max-width: 520px; width: 100%; padding: 18px 20px; max-height: 90vh; overflow: auto; }
    .modal--wide { min-width: 500px; max-width: 680px; }
    .modal h3 { font-size: 13px; margin: 0; }
    .modal label { display: flex; flex-direction: column; font-size: 12px; color: var(--text-muted, #aaa); gap: 4px; }
    .modal input, .modal textarea { background: var(--input-bg, #1e1e1e); border: 1px solid var(--border, #555); border-radius: 4px; color: var(--text, #eee); font-size: 12px; padding: 5px 8px; resize: vertical; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
    .modal-actions button { background: none; border: 1px solid var(--border, #555); border-radius: 4px; color: var(--text-muted, #aaa); cursor: pointer; font-size: 12px; padding: 5px 12px; }
    .btn-primary { background: var(--accent-dim, rgba(86,156,214,0.18)) !important; border-color: rgba(86,156,214,0.4) !important; color: var(--accent, #569cd6) !important; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

    .result-box { background: var(--surface, #1e1e1e); border: 1px solid var(--border, #333); border-radius: 5px; padding: 10px 12px; font-size: 12px; }
    .result-box p { margin: 0 0 6px; }

    .hint { color: var(--text-muted, #888); font-size: 11px; margin: 2px 0; }

    .import-mode-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border, #333); }
    .import-mode-tabs button { background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-muted, #888); cursor: pointer; font-size: 12px; padding: 4px 10px 5px; margin-bottom: -1px; }
    .import-mode-tabs button.active { color: var(--text, #eee); border-bottom-color: var(--accent, #569cd6); }

    .csr-actions { display: flex; gap: 8px; align-items: center; }
    .csr-actions button { background: none; border: 1px solid var(--border, #555); border-radius: 4px; color: var(--text-muted, #aaa); cursor: pointer; font-size: 12px; padding: 4px 10px; }
    .btn-download { background: var(--accent-dim, rgba(86,156,214,0.12)); border: 1px solid rgba(86,156,214,0.3); border-radius: 4px; color: var(--accent, #569cd6); font-size: 12px; padding: 4px 10px; text-decoration: none; }

    hr { border: none; border-top: 1px solid var(--border, #333); margin: 4px 0; }

    .file-row { display: flex; align-items: center; gap: 8px; }
    .file-name { color: var(--text-muted, #aaa); font-size: 11px; }
    .pw-row { display: flex; gap: 4px; }
    .pw-row input { flex: 1; }
    .toggle-pw { background: none; border: 1px solid var(--border, #555); border-radius: 4px; color: var(--text-muted, #aaa); cursor: pointer; font-size: 11px; padding: 4px 8px; }
</style>