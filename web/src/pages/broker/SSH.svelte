<script lang="ts">
    import { onMount } from 'svelte';
    import { getConfig, putConfig, getBrokerStatus, getBrokerLocalCheck, type BrokerLocalCheck } from '../../lib/api.js';

    // ── Config ─────────────────────────────────────────────────────────────────
    interface SshConfig {
        host?: string;
        port?: number;
        user?: string;
        identityFile?: string;
    }

    let cfg = $state<SshConfig>({});
    let loadError = $state('');
    let saving = $state(false);
    let saveOk = $state(false);
    let saveError = $state('');
    let sshKeyDefault = $state('~/.she/ssh/broker_id_ed25519');

    // ── Mode (local vs SSH) ────────────────────────────────────────────────────
    let mode = $state<'local' | 'ssh'>('local');

    // ── Local tool check ──────────────────────────────────────────────────────
    let localCheck = $state<BrokerLocalCheck | null>(null);
    let localCheckLoading = $state(false);
    let localCheckError = $state('');

    // ── Key generation ─────────────────────────────────────────────────────────
    let pubkey = $state('');
    let genLoading = $state(false);
    let genError = $state('');

    // ── SSH test ───────────────────────────────────────────────────────────────
    let testLoading = $state(false);
    let testResult = $state('');

    // ── Raw config for nested path access ─────────────────────────────────────
    let fullConfig = $state<Record<string, unknown>>({});

    onMount(async () => {
        try {
            const [fullCfg, brokerStatus, pubkeyRes] = await Promise.all([
                getConfig(),
                getBrokerStatus(),
                fetch('/she/broker/ssh/pubkey').then((r) => r.json()).catch(() => ({ publicKey: null })),
            ]);
            fullConfig = fullCfg;
            if (brokerStatus.sshKeyDefault) sshKeyDefault = brokerStatus.sshKeyDefault;
            const broker = (fullConfig.broker ?? {}) as Record<string, unknown>;
            cfg = (broker.ssh ?? {}) as SshConfig;
            if (!cfg.port) cfg.port = 22;
            if (!cfg.identityFile) cfg.identityFile = sshKeyDefault;
            if (pubkeyRes.publicKey) pubkey = pubkeyRes.publicKey;
            // Derive mode from whether a host is configured
            mode = cfg.host ? 'ssh' : 'local';
            if (mode === 'local') runLocalCheck();
        } catch (e: any) {
            loadError = e.message;
        }
    });

    async function runLocalCheck() {
        localCheckLoading = true;
        localCheckError = '';
        try {
            localCheck = await getBrokerLocalCheck();
        } catch (e: any) {
            localCheckError = e.message ?? 'Check failed';
        } finally {
            localCheckLoading = false;
        }
    }

    async function save() {
        saving = true;
        saveError = '';
        saveOk = false;
        try {
            const broker = ((fullConfig.broker ?? {}) as Record<string, unknown>);
            // In local mode clear the host so broker-api routes to local file ops
            const sshToSave = mode === 'local' ? { ...cfg, host: '' } : cfg;
            const updated = { ...fullConfig, broker: { ...broker, ssh: sshToSave } };
            await putConfig(updated);
            saveOk = true;
            setTimeout(() => (saveOk = false), 3000);
        } catch (e: any) {
            saveError = e.message;
        } finally {
            saving = false;
        }
    }

    async function generateKeypair() {
        genLoading = true;
        genError = '';
        try {
            const res = await fetch('/she/broker/ssh/keygen', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? res.statusText);
            pubkey = data.publicKey;
        } catch (e: any) {
            genError = e.message;
        } finally {
            genLoading = false;
        }
    }

    async function testConnection() {
        testLoading = true;
        testResult = '';
        try {
            const res = await fetch('/she/broker/ssh/test', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? res.statusText);
            testResult = data.ok ? '✓ Connection successful' : '✗ ' + (data.error ?? 'Failed');
        } catch (e: any) {
            testResult = '✗ ' + e.message;
        } finally {
            testLoading = false;
        }
    }

    function copyToClipboard(text: string) {
        navigator.clipboard.writeText(text).catch(() => {});
    }

    const installCmd = $derived(
        cfg.identityFile && cfg.user && cfg.host
            ? `ssh-copy-id -i ${cfg.identityFile}.pub ${cfg.user}@${cfg.host}`
            : '',
    );
</script>

<div class="mosquitto-page">
    {#if loadError}<div class="err">{loadError}</div>{/if}

    <!-- ── Mode bar ──────────────────────────────────────────────────────────── -->
    <div class="mode-bar">
        <span class="mode-label">Connection mode</span>
        <div class="mode-toggle">
            <button class:active={mode === 'local'} onclick={() => { mode = 'local'; if (!localCheck) runLocalCheck(); }}>Local</button>
            <button class:active={mode === 'ssh'} onclick={() => (mode = 'ssh')}>SSH / Remote</button>
        </div>
        <span class="mode-desc">
            {mode === 'local' ? 'she and mosquitto run on the same machine — local filesystem access' : 'mosquitto runs on a remote host — file operations go through SSH'}
        </span>
    </div>

    <!-- ── Local mode ────────────────────────────────────────────────────────── -->
    {#if mode === 'local'}
    <div class="section">
        <h3>Tool availability</h3>
        <p class="hint">These tools must be installed and in the PATH of the she process. They are used by the Setup Wizard and cert installation.</p>
        {#if localCheckError}<div class="err">{localCheckError}</div>{/if}
        {#if localCheck}
        <div class="check-list">
            <div class="check-row">
                <span class="check-icon" class:ok={localCheck.mosquittoCtrl} class:fail={!localCheck.mosquittoCtrl}>{localCheck.mosquittoCtrl ? '✓' : '✗'}</span>
                <code>mosquitto_ctrl</code>
                <span class="check-note" class:ok={localCheck.mosquittoCtrl} class:fail={!localCheck.mosquittoCtrl}>
                    {localCheck.mosquittoCtrl ? 'found in PATH' : 'not found — install the mosquitto or mosquitto-clients package'}
                </span>
            </div>
            <div class="check-row">
                <span class="check-icon" class:ok={localCheck.mosquitto} class:fail={!localCheck.mosquitto}>{localCheck.mosquitto ? '✓' : '✗'}</span>
                <code>mosquitto</code>
                <span class="check-note" class:ok={localCheck.mosquitto} class:fail={!localCheck.mosquitto}>
                    {localCheck.mosquitto ? 'found in PATH' : 'not found — install the mosquitto package'}
                </span>
            </div>
        </div>
        {:else if localCheckLoading}
        <div class="checking">Checking…</div>
        {/if}
        <div class="row">
            <button onclick={runLocalCheck} disabled={localCheckLoading}>{localCheckLoading ? 'Checking…' : localCheck ? 'Re-check' : 'Check tools'}</button>
        </div>
    </div>
    {/if}

    <!-- ── SSH mode ──────────────────────────────────────────────────────────── -->
    {#if mode === 'ssh'}
    <div class="section">
        <h3>SSH connection</h3>
        <p class="hint">Used for file operations: reading/writing mosquitto.conf and installing certificates on the broker host. User/ACL management always uses the MQTT port directly.</p>
        <div class="fields">
            <label>Host<input bind:value={cfg.host} placeholder="192.168.1.10 or broker.local" /></label>
            <label>Port<input type="number" bind:value={cfg.port} min="1" max="65535" /></label>
            <label>SSH user<input bind:value={cfg.user} placeholder="root" /></label>
            <label>Identity file (private key)<input bind:value={cfg.identityFile} placeholder={sshKeyDefault} /></label>
        </div>
    </div>

    <div class="section">
        <h3>SSH keypair</h3>
        <p class="hint">Dedicated Ed25519 keypair for she to authenticate to the broker host. Private key stored at <code>{cfg.identityFile || sshKeyDefault}</code>.</p>
        {#if pubkey}
        <label>
            Public key
            <div class="pubkey-row">
                <textarea readonly rows="3">{pubkey}</textarea>
                <button class="copy-btn" onclick={() => copyToClipboard(pubkey)}>Copy</button>
            </div>
        </label>
        {#if installCmd}
        <label>
            Install command (run locally)
            <div class="pubkey-row">
                <input readonly value={installCmd} />
                <button class="copy-btn" onclick={() => copyToClipboard(installCmd)}>Copy</button>
            </div>
        </label>
        {/if}
        <div class="row">
            <button onclick={generateKeypair} disabled={genLoading}>{genLoading ? 'Generating…' : 'Regenerate keypair'}</button>
        </div>
        {:else}
        <div class="row">
            <button onclick={generateKeypair} disabled={genLoading}>{genLoading ? 'Generating…' : 'Generate keypair'}</button>
        </div>
        {/if}
        {#if genError}<div class="err">{genError}</div>{/if}
    </div>

    <div class="section">
        <h3>Test connection</h3>
        <div class="row">
            <button onclick={testConnection} disabled={testLoading || !cfg.host}>{testLoading ? 'Testing…' : 'Test SSH connection'}</button>
            {#if testResult}
            <span class="test-result" class:ok={testResult.startsWith('✓')} class:fail={testResult.startsWith('✗')}>{testResult}</span>
            {/if}
        </div>
    </div>
    {/if}

    {#if saveError}<div class="err">{saveError}</div>{/if}
    {#if saveOk}<div class="ok">Saved.</div>{/if}
    <div class="row">
        <button class="btn-primary" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    </div>
</div>

<style>
    .mosquitto-page {
        padding: 14px 16px;
        overflow: auto;
        height: 100%;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 16px;
    }

    /* ── Mode bar ── */
    .mode-bar {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        background: var(--surface, #1e1e1e);
        border: 1px solid var(--border, #333);
        border-radius: 6px;
        flex-wrap: wrap;
    }
    .mode-label { font-size: 11px; color: var(--text-muted, #888); white-space: nowrap; text-transform: uppercase; letter-spacing: 0.04em; }
    .mode-toggle { display: flex; }
    .mode-toggle button {
        background: none;
        border: 1px solid var(--border, #444);
        color: var(--text-muted, #888);
        cursor: pointer;
        font-size: 12px;
        padding: 4px 14px;
    }
    .mode-toggle button:first-child { border-radius: 4px 0 0 4px; border-right: none; }
    .mode-toggle button:last-child  { border-radius: 0 4px 4px 0; }
    .mode-toggle button.active { background: var(--accent-dim, rgba(86,156,214,0.15)); border-color: rgba(86,156,214,0.4); color: var(--accent, #569cd6); }
    .mode-desc { font-size: 11px; color: var(--text-muted, #777); flex: 1; }

    .section {
        background: var(--surface, #1e1e1e);
        border: 1px solid var(--border, #333);
        border-radius: 6px;
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .section h3 {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-muted, #aaa);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 0;
    }

    .hint { color: var(--text-muted, #888); font-size: 12px; margin: 0; line-height: 1.5; }
    .hint code { background: var(--code-bg, #2a2a2a); border-radius: 3px; font-size: 11px; padding: 1px 4px; }

    /* ── Local check ── */
    .check-list { display: flex; flex-direction: column; gap: 6px; }
    .check-row  { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .check-row code { font-size: 11px; }
    .check-icon { font-size: 13px; width: 16px; text-align: center; flex-shrink: 0; }
    .check-icon.ok   { color: #4b9; }
    .check-icon.fail { color: #c44; }
    .check-note { color: var(--text-muted, #888); }
    .check-note.ok   { color: #4b9; }
    .check-note.fail { color: #c66; }
    .checking { font-size: 12px; color: var(--text-muted, #888); }

    .fields { display: flex; flex-direction: column; gap: 8px; }

    label {
        display: flex;
        flex-direction: column;
        font-size: 12px;
        color: var(--text-muted, #aaa);
        gap: 4px;
    }

    input, textarea {
        background: var(--input-bg, #2a2a2a);
        border: 1px solid var(--border, #444);
        border-radius: 4px;
        color: var(--text, #eee);
        font-size: 12px;
        padding: 5px 8px;
        resize: vertical;
    }

    .row { display: flex; align-items: center; gap: 10px; }

    button {
        background: none;
        border: 1px solid var(--border, #444);
        border-radius: 4px;
        color: var(--text-muted, #aaa);
        cursor: pointer;
        font-size: 12px;
        padding: 5px 12px;
    }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    .btn-primary {
        background: var(--accent-dim, rgba(86,156,214,0.15));
        border-color: rgba(86,156,214,0.35);
        color: var(--accent, #569cd6);
    }

    .copy-btn { padding: 4px 8px; flex-shrink: 0; }

    .pubkey-row { display: flex; gap: 6px; align-items: flex-start; }
    .pubkey-row textarea, .pubkey-row input { flex: 1; font-family: monospace; font-size: 11px; }

    .test-result { font-size: 12px; }
    .test-result.ok { color: #8c8; }
    .test-result.fail { color: #e88; }

    .err { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.3); border-radius: 4px; color: #e88; font-size: 12px; padding: 6px 10px; }
    .ok  { background: rgba(70,180,70,0.1); border: 1px solid rgba(70,180,70,0.25); border-radius: 4px; color: #8c8; font-size: 12px; padding: 6px 10px; }
</style>
