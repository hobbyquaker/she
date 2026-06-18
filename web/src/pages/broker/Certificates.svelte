<script lang="ts">
    import { onMount } from 'svelte';
    import {
        getBrokerCA, generateBrokerCA,
        getBrokerServerCert, generateBrokerServerCert,
        listIssuedCerts, issueClientCert, revokeClientCert, downloadCertUrl,
        listTrustedCerts, addTrustedCert, removeTrustedCert,
        type CaInfo, type ServerCertInfo, type IssuedCert, type IssuedCertResult, type TrustedCert,
    } from '../../lib/api.js';

    // ── State ──────────────────────────────────────────────────────────────────
    let section = $state<'ca' | 'server' | 'trusted' | 'clients'>('ca');

    let caInfo = $state<CaInfo | null>(null);
    let serverInfo = $state<ServerCertInfo | null>(null);
    let issuedCerts = $state<IssuedCert[]>([]);
    let trustedCerts = $state<TrustedCert[]>([]);
    let loadError = $state('');

    // Generate CA
    let showGenCA = $state(false);
    let genCACn = $state('she-broker-ca');
    let genCADays = $state(365);
    let genCALoading = $state(false);
    let genCAError = $state('');

    // Generate server cert
    let showGenServer = $state(false);
    let genServerCn = $state('');
    let genServerSan = $state('');
    let genServerDays = $state(365);
    let genServerLoading = $state(false);
    let genServerError = $state('');
    let genServerResult = $state<{ fingerprint: string; expires: string; certPath: string; keyPath: string } | null>(null);

    // Issue client cert
    let showIssue = $state(false);
    let issueCn = $state('');
    let issueDays = $state(365);
    let issueLoading = $state(false);
    let issueError = $state('');
    let issueResult = $state<IssuedCertResult | null>(null);

    // Trusted cert paste
    let showAddTrusted = $state(false);
    let trustedPem = $state('');
    let addTrustedLoading = $state(false);
    let addTrustedError = $state('');

    let actionError = $state('');

    async function load() {
        try {
            const [caR, srvR, issuedR, trustedR] = await Promise.allSettled([
                getBrokerCA(),
                getBrokerServerCert(),
                listIssuedCerts(),
                listTrustedCerts(),
            ]);
            if (caR.status === 'fulfilled') caInfo = caR.value.ca;
            if (srvR.status === 'fulfilled') serverInfo = srvR.value.server;
            if (issuedR.status === 'fulfilled') issuedCerts = issuedR.value.certs;
            if (trustedR.status === 'fulfilled') trustedCerts = trustedR.value.certs;
            loadError = '';
        } catch (e: any) {
            loadError = e.message;
        }
    }

    onMount(() => { load(); });

    // ── Generate CA ────────────────────────────────────────────────────────────
    async function submitGenCA() {
        genCAError = '';
        genCALoading = true;
        try {
            await generateBrokerCA({ cn: genCACn, days: genCADays });
            showGenCA = false;
            await load();
        } catch (e: any) {
            genCAError = e.message;
        } finally {
            genCALoading = false;
        }
    }

    // ── Generate server cert ───────────────────────────────────────────────────
    async function submitGenServer() {
        genServerError = '';
        genServerLoading = true;
        genServerResult = null;
        try {
            const san = genServerSan.split(',').map((s) => s.trim()).filter(Boolean);
            const result = await generateBrokerServerCert({ cn: genServerCn, san, days: genServerDays });
            genServerResult = result;
            await load();
        } catch (e: any) {
            genServerError = e.message;
        } finally {
            genServerLoading = false;
        }
    }

    // ── Issue client cert ──────────────────────────────────────────────────────
    async function submitIssue() {
        issueError = '';
        issueLoading = true;
        issueResult = null;
        try {
            const result = await issueClientCert({ cn: issueCn, days: issueDays });
            issueResult = result;
            issueCn = '';
            await load();
        } catch (e: any) {
            issueError = e.message;
        } finally {
            issueLoading = false;
        }
    }

    async function doRevoke(cert: IssuedCert) {
        if (!confirm(`Revoke certificate for "${cert.cn}" (serial ${cert.serial})?`)) return;
        try {
            await revokeClientCert(cert.serial);
            await load();
        } catch (e: any) {
            actionError = e.message;
        }
    }

    // ── Trusted certs ──────────────────────────────────────────────────────────
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
        const d = new Date(expires);
        return d.toLocaleDateString();
    }
</script>

<div class="certs-page">
    <div class="panel-tabs">
        <button class:active={section === 'ca'}       onclick={() => (section = 'ca')}>Local CA</button>
        <button class:active={section === 'server'}   onclick={() => (section = 'server')}>Server Cert</button>
        <button class:active={section === 'trusted'}  onclick={() => (section = 'trusted')}>Trusted CAs</button>
        <button class:active={section === 'clients'}  onclick={() => (section = 'clients')}>Client Certs</button>
        <button class="reload-btn" onclick={load} title="Refresh">↺</button>
    </div>

    {#if loadError}<div class="err">{loadError}</div>{/if}
    {#if actionError}<div class="err">{actionError}</div>{/if}

    <!-- ── Local CA ─────────────────────────────────────────────────────────── -->
    {#if section === 'ca'}
    <div class="section">
        <div class="section-header">
            <h3>Local Certificate Authority</h3>
            <button onclick={() => { showGenCA = true; genCAError = ''; }}>{caInfo ? 'Regenerate CA' : 'Generate CA'}</button>
        </div>
        {#if caInfo}
        <div class="info-card">
            <dl>
                <dt>CN</dt><dd>{caInfo.cn}</dd>
                <dt>Fingerprint (SHA-256)</dt><dd class="mono small">{caInfo.fingerprint}</dd>
                <dt>Expires</dt><dd class={expiryClass(caInfo.expires)}>{fmtExpiry(caInfo.expires)}</dd>
            </dl>
            <div class="card-actions">
                <a class="btn-download" href="data:application/x-pem-file;charset=utf-8,{encodeURIComponent(caInfo.crt)}" download="ca.crt">Download ca.crt</a>
            </div>
        </div>
        {:else}
        <div class="empty">No local CA generated yet.</div>
        {/if}
    </div>

    <!-- ── Server cert ───────────────────────────────────────────────────────── -->
    {:else if section === 'server'}
    <div class="section">
        <div class="section-header">
            <h3>Server Certificate</h3>
            <button onclick={() => { showGenServer = true; genServerError = ''; genServerResult = null; }}>
                {serverInfo ? 'Regenerate' : 'Generate server cert'}
            </button>
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
        <div class="empty">No managed server certificate yet. Generate one or configure paths manually in Listeners.</div>
        {/if}
    </div>

    <!-- ── Trusted CAs ───────────────────────────────────────────────────────── -->
    {:else if section === 'trusted'}
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
                <td class="actions">
                    <button class="danger" onclick={() => doRemoveTrusted(c.fingerprint)}>✕</button>
                </td>
            </tr>
            {/each}
            </tbody>
        </table>
        {/if}
    </div>

    <!-- ── Client certs ──────────────────────────────────────────────────────── -->
    {:else if section === 'clients'}
    <div class="section">
        <div class="section-header">
            <h3>Issued Client Certificates</h3>
            <button onclick={() => { showIssue = true; issueError = ''; issueResult = null; issueCn = ''; issueDays = 365; }}>+ Issue cert</button>
        </div>
        {#if issuedCerts.length === 0}
        <div class="empty">No client certificates issued yet.</div>
        {:else}
        <table>
            <thead><tr><th>CN</th><th>Serial</th><th>Issued</th><th>Expires</th><th>Status</th><th></th></tr></thead>
            <tbody>
            {#each issuedCerts as c}
            <tr>
                <td class="mono">{c.cn}</td>
                <td class="mono small">{c.serial}</td>
                <td>{new Date(c.issued).toLocaleDateString()}</td>
                <td class={c.revoked ? '' : expiryClass(c.expires)}>{fmtExpiry(c.expires)}</td>
                <td>
                    {#if c.revoked}
                    <span class="badge-revoked">Revoked</span>
                    {:else if expiryClass(c.expires) === 'expired'}
                    <span class="badge-expired">Expired</span>
                    {:else if expiryClass(c.expires) === 'expiring'}
                    <span class="badge-expiring">Expiring soon</span>
                    {:else}
                    <span class="badge-ok">Valid</span>
                    {/if}
                </td>
                <td class="actions">
                    {#if !c.revoked}
                    <a class="btn-dl" href={downloadCertUrl(c.serial, 'p12')} download="{c.cn}.p12">.p12</a>
                    <a class="btn-dl" href={downloadCertUrl(c.serial, 'crt')} download="{c.cn}.crt">.crt</a>
                    <a class="btn-dl" href={downloadCertUrl(c.serial, 'key')} download="{c.cn}.key">.key</a>
                    <button class="danger" onclick={() => doRevoke(c)}>Revoke</button>
                    {/if}
                </td>
            </tr>
            {/each}
            </tbody>
        </table>
        {/if}
    </div>
    {/if}
</div>

<!-- ── Generate CA modal ──────────────────────────────────────────────────── -->
{#if showGenCA}
<div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal">
        <h3>Generate Local CA</h3>
        <label>Common Name<input bind:value={genCACn} /></label>
        <label>Validity (days)<input type="number" bind:value={genCADays} min="1" max="3650" /></label>
        {#if genCAError}<div class="err">{genCAError}</div>{/if}
        <div class="modal-actions">
            <button onclick={() => (showGenCA = false)}>Cancel</button>
            <button class="btn-primary" onclick={submitGenCA} disabled={genCALoading || !genCACn}>
                {genCALoading ? 'Generating…' : 'Generate'}
            </button>
        </div>
    </div>
</div>
{/if}

<!-- ── Generate server cert modal ─────────────────────────────────────────── -->
{#if showGenServer}
<div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal">
        <h3>Generate Server Certificate</h3>
        <label>Common Name (hostname)<input bind:value={genServerCn} placeholder="mybroker.local" /></label>
        <label>SANs (comma-separated IPs/hostnames)<input bind:value={genServerSan} placeholder="192.168.1.10, mybroker.local" /></label>
        <label>Validity (days)<input type="number" bind:value={genServerDays} min="1" max="3650" /></label>
        {#if genServerError}<div class="err">{genServerError}</div>{/if}
        {#if genServerResult}
        <div class="result-box">
            <p>✓ Server cert generated</p>
            <dl>
                <dt>Cert path</dt><dd class="mono small">{genServerResult.certPath}</dd>
                <dt>Key path</dt><dd class="mono small">{genServerResult.keyPath}</dd>
                <dt>Fingerprint</dt><dd class="mono small">{genServerResult.fingerprint}</dd>
            </dl>
            <p class="hint">Update your Listeners config to use these paths, then Apply & Reload.</p>
        </div>
        {/if}
        <div class="modal-actions">
            <button onclick={() => (showGenServer = false)}>Close</button>
            {#if !genServerResult}
            <button class="btn-primary" onclick={submitGenServer} disabled={genServerLoading || !genServerCn}>
                {genServerLoading ? 'Generating…' : 'Generate'}
            </button>
            {/if}
        </div>
    </div>
</div>
{/if}

<!-- ── Issue client cert modal ────────────────────────────────────────────── -->
{#if showIssue}
<div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal modal--wide">
        <h3>Issue Client Certificate</h3>
        {#if !issueResult}
        <label>Common Name (device ID)<input bind:value={issueCn} placeholder="esp32-bedroom" /></label>
        <label>Validity (days)<input type="number" bind:value={issueDays} min="1" max="3650" /></label>
        {#if issueError}<div class="err">{issueError}</div>{/if}
        <div class="modal-actions">
            <button onclick={() => (showIssue = false)}>Cancel</button>
            <button class="btn-primary" onclick={submitIssue} disabled={issueLoading || !issueCn}>
                {issueLoading ? 'Issuing…' : 'Issue'}
            </button>
        </div>
        {:else}
        <div class="result-box">
            <p>✓ Certificate issued for <strong>{issueResult.cn}</strong></p>
            <dl>
                <dt>Serial</dt><dd class="mono">{issueResult.serial}</dd>
                <dt>Fingerprint</dt><dd class="mono small">{issueResult.fingerprint}</dd>
                <dt>Expires</dt><dd>{fmtExpiry(issueResult.expires)}</dd>
                <dt>PKCS#12 passphrase</dt>
                <dd><code class="passphrase">{issueResult.passphrase}</code> <small>(shown once — save it now)</small></dd>
            </dl>
            <div class="download-row">
                <a class="btn-dl" href={downloadCertUrl(issueResult.serial, 'p12')} download="{issueResult.cn}.p12">Download .p12</a>
                <a class="btn-dl" href={downloadCertUrl(issueResult.serial, 'crt')} download="{issueResult.cn}.crt">Download .crt</a>
                <a class="btn-dl" href={downloadCertUrl(issueResult.serial, 'key')} download="{issueResult.cn}.key">Download .key</a>
                <a class="btn-dl" href={downloadCertUrl(issueResult.serial, 'ca')} download="ca.crt">Download CA</a>
            </div>
        </div>
        <div class="modal-actions">
            <button onclick={() => (showIssue = false)}>Close</button>
        </div>
        {/if}
    </div>
</div>
{/if}

<!-- ── Add trusted cert modal ─────────────────────────────────────────────── -->
{#if showAddTrusted}
<div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal modal--wide">
        <h3>Add Trusted CA Certificate</h3>
        <label>
            PEM certificate
            <textarea bind:value={trustedPem} rows="8" placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"></textarea>
        </label>
        {#if addTrustedError}<div class="err">{addTrustedError}</div>{/if}
        <div class="modal-actions">
            <button onclick={() => (showAddTrusted = false)}>Cancel</button>
            <button class="btn-primary" onclick={submitAddTrusted} disabled={addTrustedLoading || !trustedPem}>
                {addTrustedLoading ? 'Adding…' : 'Add'}
            </button>
        </div>
    </div>
</div>
{/if}

<style>
    .certs-page {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .panel-tabs {
        display: flex;
        gap: 2px;
        padding: 8px 16px 0;
        border-bottom: 1px solid var(--border, #333);
        flex-shrink: 0;
    }

    .panel-tabs button {
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        color: var(--text-muted, #888);
        cursor: pointer;
        font-size: 12px;
        padding: 4px 10px 5px;
        margin-bottom: -1px;
    }

    .panel-tabs button.active { color: var(--text, #eee); border-bottom-color: var(--accent, #569cd6); }
    .reload-btn { margin-left: auto; font-size: 14px; padding: 2px 8px; }

    .section {
        flex: 1;
        overflow: auto;
        padding: 14px 16px;
    }

    .section-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 14px;
    }

    .section-header h3 { margin: 0; font-size: 13px; color: var(--text-muted, #aaa); text-transform: uppercase; letter-spacing: 0.04em; }
    .section-header button { margin-left: auto; background: var(--accent-dim, rgba(86,156,214,0.15)); border: 1px solid rgba(86,156,214,0.3); border-radius: 4px; color: var(--accent, #569cd6); cursor: pointer; font-size: 12px; padding: 3px 10px; }

    .info-card {
        background: var(--surface, #1e1e1e);
        border: 1px solid var(--border, #333);
        border-radius: 6px;
        padding: 14px 16px;
    }

    dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 12px; margin: 0; }
    dt { color: var(--text-muted, #888); }
    dd { margin: 0; color: var(--text, #ddd); word-break: break-all; }

    .card-actions { margin-top: 12px; display: flex; gap: 6px; }

    .btn-download, .btn-dl {
        background: var(--accent-dim, rgba(86,156,214,0.12));
        border: 1px solid rgba(86,156,214,0.3);
        border-radius: 4px;
        color: var(--accent, #569cd6);
        cursor: pointer;
        font-size: 11px;
        padding: 3px 9px;
        text-decoration: none;
    }

    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { color: var(--text-muted, #888); font-weight: 500; text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border, #333); }
    td { padding: 5px 8px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: middle; }

    .mono { font-family: monospace; }
    .small { font-size: 10px; }

    .actions { display: flex; gap: 4px; justify-content: flex-end; flex-wrap: wrap; }
    .actions button, .actions a {
        background: none;
        border: 1px solid var(--border, #333);
        border-radius: 3px;
        color: var(--text-muted, #888);
        cursor: pointer;
        font-size: 11px;
        padding: 2px 6px;
        text-decoration: none;
    }
    .actions .btn-dl { background: var(--accent-dim, rgba(86,156,214,0.1)); border-color: rgba(86,156,214,0.25); color: var(--accent, #569cd6); }
    .actions button.danger:hover { background: rgba(220,60,60,0.15); border-color: rgba(220,60,60,0.4); color: #e66; }

    .badge-ok       { background: rgba(70,180,70,0.1); border: 1px solid rgba(70,180,70,0.25); border-radius: 3px; color: #8c8; font-size: 10px; padding: 1px 6px; }
    .badge-expiring { background: rgba(200,150,40,0.1); border: 1px solid rgba(200,150,40,0.25); border-radius: 3px; color: #cc9; font-size: 10px; padding: 1px 6px; }
    .badge-expired  { background: rgba(220,60,60,0.1); border: 1px solid rgba(220,60,60,0.25); border-radius: 3px; color: #e88; font-size: 10px; padding: 1px 6px; }
    .badge-revoked  { background: rgba(100,100,100,0.1); border: 1px solid rgba(100,100,100,0.25); border-radius: 3px; color: #888; font-size: 10px; padding: 1px 6px; }

    .expiring { color: #cc9; }
    .expired  { color: #e88; }

    .empty { color: var(--text-muted, #888); font-size: 12px; padding: 10px 0; }
    .err { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.3); border-radius: 4px; color: #e88; font-size: 12px; padding: 6px 10px; margin-bottom: 8px; }

    /* Modal */
    .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 100; }
    .modal { background: var(--surface, #252526); border: 1px solid var(--border, #444); border-radius: 6px; display: flex; flex-direction: column; gap: 10px; min-width: 320px; max-width: 520px; width: 100%; padding: 18px 20px; max-height: 90vh; overflow: auto; }
    .modal--wide { min-width: 500px; max-width: 700px; }
    .modal h3 { font-size: 13px; margin: 0; }
    .modal label { display: flex; flex-direction: column; font-size: 12px; color: var(--text-muted, #aaa); gap: 4px; }
    .modal input, .modal textarea, .modal select { background: var(--input-bg, #1e1e1e); border: 1px solid var(--border, #555); border-radius: 4px; color: var(--text, #eee); font-size: 12px; padding: 5px 8px; resize: vertical; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
    .modal-actions button { background: none; border: 1px solid var(--border, #555); border-radius: 4px; color: var(--text-muted, #aaa); cursor: pointer; font-size: 12px; padding: 5px 12px; }
    .btn-primary { background: var(--accent-dim, rgba(86,156,214,0.18)) !important; border-color: rgba(86,156,214,0.4) !important; color: var(--accent, #569cd6) !important; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

    .result-box { background: var(--surface, #1e1e1e); border: 1px solid var(--border, #333); border-radius: 5px; padding: 10px 12px; }
    .result-box p { font-size: 12px; margin: 0 0 8px; }
    .passphrase { background: rgba(0,0,0,0.3); border: 1px solid var(--border, #444); border-radius: 3px; font-family: monospace; font-size: 13px; padding: 2px 6px; user-select: all; }
    .download-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .hint { color: var(--text-muted, #888); font-size: 11px; margin: 6px 0 0; }
</style>
