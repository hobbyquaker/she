<script lang="ts">
    import { onMount } from 'svelte';
    import {
        getBrokerCA, generateBrokerCA, importBrokerCA,
        getBrokerServerCert, generateBrokerServerCert,
        listIssuedCerts, issueClientCert, revokeClientCert, downloadCertUrl,
        listTrustedCerts, addTrustedCert, removeTrustedCert,
        getBrokerStatus, createBrokerUser, listBrokerUsers,
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
    let issueCreateUser = $state(false);

    // Dynsec user linkage
    let dynsecReady = $state(false);
    let allUsernames = $state<string[]>([]);

    // Trusted cert paste
    let showAddTrusted = $state(false);
    let trustedPem = $state('');
    let addTrustedLoading = $state(false);
    let addTrustedError = $state('');

    let actionError = $state('');

    // ── Import CA ──────────────────────────────────────────────────────────────
    let showImportCA = $state(false);
    let importMode = $state<'pem' | 'p12'>('pem');
    let importCertPem = $state('');
    let importKeyPem = $state('');
    let importChainPem = $state('');
    let showChainField = $state(false);
    let importP12B64 = $state('');
    let importP12Name = $state('');
    let importPassphrase = $state('');
    let showImportPassphrase = $state(false);
    let importLoading = $state(false);
    let importError = $state('');

    function handleP12FileChange(e: Event) {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        importP12Name = file.name;
        const reader = new FileReader();
        reader.onload = () => {
            const ab = reader.result as ArrayBuffer;
            importP12B64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
        };
        reader.readAsArrayBuffer(file);
    }

    async function submitImportCA() {
        importError = '';
        importLoading = true;
        try {
            const chain = showChainField && importChainPem.trim() ? importChainPem : undefined;
            if (importMode === 'p12') {
                if (!importP12B64) throw new Error('Select a .p12 / .pfx file');
                await importBrokerCA({ p12base64: importP12B64, passphrase: importPassphrase, chain });
            } else {
                if (!importCertPem.trim() || !importKeyPem.trim()) throw new Error('Certificate and key are required');
                await importBrokerCA({ cert: importCertPem, key: importKeyPem, chain });
            }
            showImportCA = false;
            await load();
        } catch (e: any) {
            importError = e.message;
        } finally {
            importLoading = false;
        }
    }

    async function load() {
        try {
            const [caR, srvR, issuedR, trustedR, statusR] = await Promise.allSettled([
                getBrokerCA(),
                getBrokerServerCert(),
                listIssuedCerts(),
                listTrustedCerts(),
                getBrokerStatus(),
            ]);
            if (caR.status === 'fulfilled') caInfo = caR.value.ca;
            if (srvR.status === 'fulfilled') serverInfo = srvR.value.server;
            if (issuedR.status === 'fulfilled') issuedCerts = issuedR.value.certs;
            if (trustedR.status === 'fulfilled') trustedCerts = trustedR.value.certs;
            if (statusR.status === 'fulfilled') dynsecReady = statusR.value.dynsec.dynsecReady;
            if (dynsecReady) {
                try {
                    const { users } = await listBrokerUsers();
                    allUsernames = users.map((u) => u.username);
                } catch { allUsernames = []; }
            }
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
            if (issueCreateUser && dynsecReady && !allUsernames.includes(issueCn)) {
                const pw = Array.from(crypto.getRandomValues(new Uint8Array(16)))
                    .map((b) => b.toString(16).padStart(2, '0')).join('');
                try { await createBrokerUser(issueCn, pw); } catch { /* user may already exist */ }
            }
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
            <button class="btn-secondary" onclick={() => {
                showImportCA = true; importError = ''; importMode = 'pem';
                importCertPem = ''; importKeyPem = ''; importChainPem = '';
                importP12B64 = ''; importP12Name = ''; importPassphrase = '';
                showChainField = false; showImportPassphrase = false;
            }}>Import CA</button>
            <button onclick={() => { showGenCA = true; genCAError = ''; }}>{caInfo ? 'Regenerate CA' : 'Generate CA'}</button>
        </div>
        {#if caInfo}
        <div class="info-card">
            <dl>
                <dt>CN</dt><dd>{caInfo.cn}</dd>
                <dt>Fingerprint (SHA-256)</dt><dd class="mono small">{caInfo.fingerprint}</dd>
                <dt>Expires</dt><dd class={expiryClass(caInfo.expires)}>{fmtExpiry(caInfo.expires)}</dd>
                {#if caInfo.hasChain}
                <dt>Chain</dt><dd class="mono small">{caInfo.chainCn ?? 'present'} <span class="badge-chain">chain</span></dd>
                {/if}
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
            <button onclick={() => { showIssue = true; issueError = ''; issueResult = null; issueCn = ''; issueDays = 365; issueCreateUser = false; }}>+ Issue cert</button>
        </div>
        {#if issuedCerts.length === 0}
        <div class="empty">No client certificates issued yet.</div>
        {:else}
        <table>
            <thead><tr><th>CN</th><th>Serial</th><th>Issued</th><th>Expires</th><th>Status</th>{#if dynsecReady}<th>User</th>{/if}<th></th></tr></thead>
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
                {#if dynsecReady}
                <td>
                    {#if allUsernames.includes(c.cn)}
                    <span class="badge-user-linked" title="dynsec user exists with matching username">linked</span>
                    {:else}
                    <button class="btn-link-user" title="Create dynsec user with CN as username" onclick={async () => {
                        const pw = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2,'0')).join('');
                        try { await createBrokerUser(c.cn, pw); allUsernames = [...allUsernames, c.cn]; } catch (e: any) { actionError = e.message; }
                    }}>+ Link</button>
                    {/if}
                </td>
                {/if}
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

<!-- ── Import CA modal ───────────────────────────────────────────────────── -->
{#if showImportCA}
<div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal modal--wide">
        <h3>Import existing CA</h3>
        <div class="import-mode-tabs">
            <button class:active={importMode === 'pem'} onclick={() => (importMode = 'pem')}>PEM files</button>
            <button class:active={importMode === 'p12'} onclick={() => (importMode = 'p12')}>PKCS#12 (.p12 / .pfx)</button>
        </div>
        {#if importMode === 'pem'}
        <label>CA certificate (PEM)
            <textarea bind:value={importCertPem} rows="5" placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----"></textarea>
        </label>
        <label>CA private key (PEM)
            <textarea bind:value={importKeyPem} rows="5" placeholder="-----BEGIN PRIVATE KEY-----&#10;…&#10;-----END PRIVATE KEY-----"></textarea>
        </label>
        {:else}
        <label>PKCS#12 file
            <div class="file-row">
                <input type="file" accept=".p12,.pfx" onchange={handleP12FileChange} />
                {#if importP12Name}<span class="file-name mono small">{importP12Name}</span>{/if}
            </div>
        </label>
        <label>Passphrase
            <div class="pw-row">
                <input type={showImportPassphrase ? 'text' : 'password'} bind:value={importPassphrase} autocomplete="off" />
                <button class="toggle-pw" onclick={() => (showImportPassphrase = !showImportPassphrase)}>{showImportPassphrase ? 'Hide' : 'Show'}</button>
            </div>
        </label>
        {/if}
        <div class="chain-toggle">
            <button class="btn-text" onclick={() => (showChainField = !showChainField)}>
                {showChainField ? '▾' : '▸'} {showChainField ? 'Hide chain field' : 'This CA is signed by an intermediate / root — add chain'}
            </button>
        </div>
        {#if showChainField}
        <label>Signing chain (PEM — intermediate and/or root CA certs)
            <textarea bind:value={importChainPem} rows="5" placeholder="Paste the certificate(s) that signed this CA, from intermediate to root."></textarea>
            <span class="field-hint">The chain is bundled into issued client .p12 files so clients can verify the full trust path.</span>
        </label>
        {/if}
        {#if caInfo}<div class="import-warning">⚠ This will overwrite the existing local CA keypair. All previously issued certificates remain valid.</div>{/if}
        {#if importError}<div class="err">{importError}</div>{/if}
        <div class="modal-actions">
            <button onclick={() => (showImportCA = false)}>Cancel</button>
            <button class="btn-primary" onclick={submitImportCA} disabled={importLoading}>
                {importLoading ? 'Importing…' : 'Import CA'}
            </button>
        </div>
    </div>
</div>
{/if}

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
        <label>
            Common Name (device ID)
            <input bind:value={issueCn} placeholder="esp32-bedroom" list="issue-cn-list" autocomplete="off" />
        </label>
        {#if dynsecReady}
        <datalist id="issue-cn-list">
            {#each allUsernames as u}<option value={u}></option>{/each}
        </datalist>
        <div class="mtls-hint">ℹ For mTLS auth the CN must match a dynsec username. Enable <em>use_identity_as_username</em> in the Listeners tab.</div>
        <label class="toggle-label">
            <input type="checkbox" bind:checked={issueCreateUser} />
            Also create dynsec user "{issueCn || '…'}"{allUsernames.includes(issueCn) ? ' (already exists)' : ''}
        </label>
        {/if}
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

    .mtls-hint {
        background: rgba(86,156,214,0.08);
        border: 1px solid rgba(86,156,214,0.2);
        border-radius: 4px;
        color: var(--text-muted, #aaa);
        font-size: 11px;
        padding: 5px 9px;
    }
    .toggle-label {
        display: flex !important;
        align-items: center;
        flex-direction: row !important;
        gap: 7px;
        cursor: pointer;
    }
    .toggle-label input[type='checkbox'] { width: auto; cursor: pointer; }
    .badge-user-linked { background: rgba(70,180,70,0.1); border: 1px solid rgba(70,180,70,0.25); border-radius: 3px; color: #8c8; font-size: 10px; padding: 1px 6px; }
    .badge-user-none { color: var(--text-muted, #666); font-size: 12px; }
    .badge-chain { background: rgba(86,156,214,0.12); border: 1px solid rgba(86,156,214,0.25); border-radius: 3px; color: #7ab; font-size: 10px; padding: 1px 5px; }
    .btn-link-user { background: none; border: 1px solid rgba(86,156,214,0.3); border-radius: 3px; color: var(--accent, #569cd6); cursor: pointer; font-size: 10px; padding: 1px 6px; }
    .btn-link-user:hover { background: rgba(86,156,214,0.1); }
    .btn-secondary { background: none; border: 1px solid var(--border, #444); border-radius: 4px; color: var(--text-muted, #aaa); cursor: pointer; font-size: 12px; padding: 3px 10px; }
    .import-mode-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border, #333); margin-bottom: 4px; }
    .import-mode-tabs button { background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-muted, #888); cursor: pointer; font-size: 12px; padding: 4px 10px 5px; margin-bottom: -1px; }
    .import-mode-tabs button.active { color: var(--text, #eee); border-bottom-color: var(--accent, #569cd6); }
    .chain-toggle { margin: 2px 0; }
    .btn-text { background: none; border: none; color: var(--accent, #569cd6); cursor: pointer; font-size: 11px; padding: 0; }
    .field-hint { color: var(--text-muted, #777); font-size: 10.5px; margin-top: 3px; display: block; }
    .file-row { display: flex; align-items: center; gap: 8px; }
    .file-name { color: var(--text-muted, #aaa); }
    .pw-row { display: flex; gap: 4px; }
    .pw-row input { flex: 1; }
    .toggle-pw { background: none; border: 1px solid var(--border, #555); border-radius: 4px; color: var(--text-muted, #aaa); cursor: pointer; font-size: 11px; padding: 4px 8px; }
    .import-warning { background: rgba(200,140,40,0.1); border: 1px solid rgba(200,140,40,0.3); border-radius: 4px; color: #ca8; font-size: 11px; padding: 6px 9px; }
</style>
