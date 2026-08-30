<script lang="ts">
    import { onMount } from 'svelte';
    import { getBrokerStatus, brokerDynsecDeactivate, brokerDynsecDiagnose, type BrokerStatus, type DynsecDiagnosis } from '../lib/api.js';
    import ConfirmDialog from '../lib/ConfirmDialog.svelte';
    import Users from './broker/Users.svelte';
    import Listeners from './broker/Listeners.svelte';
    import BrokerConfig from './broker/BrokerConfig.svelte';
    import Certificates from './broker/Certificates.svelte';
    import SSH from './broker/SSH.svelte';
    import MosquittoLogs from './broker/MosquittoLogs.svelte';
    import Wizard from './broker/Wizard.svelte';
    import Advanced from './broker/Advanced.svelte';
    import PasswdAcl from './broker/PasswdAcl.svelte';

    let showWizard = $state(false);
    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean }): Promise<boolean> };
    let deactivating = $state(false);
    let deactivateError = $state('');
    let diagnosing = $state(false);
    let diagnosis = $state<DynsecDiagnosis | null>(null);

    let { active = false, sub = null, onsub }: { active?: boolean; sub?: string | null; onsub?: (s: string) => void } = $props();

    type SubTab = 'status' | 'users' | 'brokerconfig' | 'listeners' | 'certs' | 'ssh' | 'logs' | 'advanced' | 'passwd';
    const SUB_TABS: SubTab[] = ['status', 'users', 'brokerconfig', 'listeners', 'certs', 'ssh', 'logs', 'advanced', 'passwd'];
    const TAB_KEY = 'she-broker-tab';
    let tab = $state<SubTab>((localStorage.getItem(TAB_KEY) as SubTab) ?? 'status');
    $effect(() => { localStorage.setItem(TAB_KEY, tab); });

    // ── URL: #/broker/<tab> ────────────────────────────────────────────────────
    $effect(() => { if (sub && SUB_TABS.includes(sub as SubTab) && sub !== tab) tab = sub as SubTab; });
    $effect(() => { if (active) onsub?.(tab); });

    let status = $state<BrokerStatus | null>(null);
    let statusError = $state('');
    let loading = $state(true);

    async function loadStatus() {
        try {
            status = await getBrokerStatus();
            statusError = '';
        } catch (e: any) {
            statusError = e.message ?? 'Failed to load broker status';
        } finally {
            loading = false;
        }
    }

    onMount(() => {
        loadStatus();
        const interval = setInterval(loadStatus, 10000);
        return () => clearInterval(interval);
    });

    async function runDiagnosis() {
        diagnosing = true;
        diagnosis = null;
        try {
            diagnosis = await brokerDynsecDiagnose();
        } catch (e: any) {
            diagnosis = { ok: false, dynSecPath: '', issues: [e.message ?? 'Diagnose request failed'] };
        } finally {
            diagnosing = false;
        }
    }

    async function deactivateDynsec() {
        if (!await dialog.show('Remove dynsec plugin lines from mosquitto.conf and clear credentials? You will need to restart mosquitto afterwards.', { confirm: 'Deactivate', danger: true })) return;
        deactivating = true;
        deactivateError = '';
        try {
            await brokerDynsecDeactivate();
            await loadStatus();
        } catch (e: any) {
            deactivateError = e.message ?? 'Deactivate failed';
        } finally {
            deactivating = false;
        }
    }

    function sysVal(key: string): string {
        if (!status?.sys) return '—';
        const entry = status.sys[key];
        if (!entry) return '—';
        return String(entry.val ?? '—');
    }

    function fmtUptime(raw: string): string {
        if (raw === '—') return raw;
        const m = raw.match(/^(\d+)/);
        const secs = m ? parseInt(m[1]) : NaN;
        if (isNaN(secs)) return raw;
        const d = Math.floor(secs / 86400);
        const h = Math.floor((secs % 86400) / 3600);
        const mn = Math.floor((secs % 3600) / 60);
        const s = secs % 60;
        const pad = (n: number) => String(n).padStart(2, '0');
        return d > 0 ? `${d}d ${pad(h)}:${pad(mn)}:${pad(s)}` : `${pad(h)}:${pad(mn)}:${pad(s)}`;
    }

    function fmtBytes(raw: string): string {
        if (raw === '—') return raw;
        const n = parseInt(raw);
        if (isNaN(n)) return raw;
        if (n < 1024) return `${n} B`;
        if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
        return `${(n / 1073741824).toFixed(1)} GB`;
    }
</script>

<div class="broker-page">
    <div class="sub-nav">
        <button class:active={tab === 'status'} onclick={() => (tab = 'status')}>Status</button>
        <button class:active={tab === 'users'} onclick={() => (tab = 'users')}>Directory</button>
        <button class:active={tab === 'brokerconfig'} onclick={() => (tab = 'brokerconfig')}>Config</button>
        <button class:active={tab === 'advanced'} onclick={() => (tab = 'advanced')}>Advanced</button>
        <button class:active={tab === 'passwd'} onclick={() => (tab = 'passwd')}>Auth Files</button>
        <button class:active={tab === 'listeners'} onclick={() => (tab = 'listeners')}>Listeners</button>
        <button class:active={tab === 'certs'} onclick={() => (tab = 'certs')}>Certificates</button>
        <button class:active={tab === 'ssh'} onclick={() => (tab = 'ssh')}>Connection</button>
        <button class:active={tab === 'logs'} onclick={() => (tab = 'logs')}>Logs</button>
    </div>

    {#if tab === 'status'}
    <div class="tab-content">
        {#if loading}
        <div class="loading">Loading…</div>
        {:else if statusError}
        <div class="error-banner">{statusError}</div>
        {:else if status}
    <div class="status-layout">
        <!-- ── Connection status ─────────────────────────────────────── -->
        <div class="conn-block">
            <div class="conn-row">
                <span class="dot ok"></span>
                <span class="conn-name">mosquitto</span>
                <span class="conn-detail">{status.sshConfigured ? `ssh — ${status.sshHost}` : 'local'}</span>
            </div>
            {#if status.dynsec.configured}
            <div class="conn-row">
                <span class="dot" class:ok={status.dynsec.dynsecReady} class:warn={status.dynsec.connected && !status.dynsec.dynsecReady} class:dot-err={!status.dynsec.connected}></span>
                <span class="conn-name">dynamic security</span>
                <span class="conn-detail" class:ok={status.dynsec.dynsecReady} class:warn={status.dynsec.connected && !status.dynsec.dynsecReady} class:err={!status.dynsec.connected}>
                    {#if status.dynsec.dynsecReady}plugin active
                    {:else if status.dynsec.connected}connected — plugin not responding
                    {:else}disconnected{/if}
                </span>
                <button class="btn-deactivate" onclick={deactivateDynsec} disabled={deactivating}>{deactivating ? '…' : 'deactivate'}</button>
            </div>
            {:else}
            <div class="conn-row">
                <span class="dot dot-off"></span>
                <span class="conn-name">dynamic security</span>
                <span class="conn-detail muted">not configured</span>
                {#if !showWizard}<button class="btn-wizard-inline" onclick={() => (showWizard = true)}>Setup Wizard ↗</button>{/if}
            </div>
            {/if}
            {#if deactivateError}<div class="error-inline">{deactivateError}</div>{/if}
        </div>

        <!-- ── Diagnosis (dynsec connected but plugin not responding) ──── -->
        {#if status.dynsec.configured && status.dynsec.connected && !status.dynsec.dynsecReady}
        <div class="diag-area">
            {#if !diagnosis}
            <button class="diag-btn" onclick={runDiagnosis} disabled={diagnosing}>{diagnosing ? 'Running diagnostics…' : 'Run diagnostics'}</button>
            {:else}
            <div class="diag-card" class:diag-ok={diagnosis.ok} class:diag-fail={!diagnosis.ok}>
                {#if diagnosis.error}
                <p class="diag-issue">⚠ {diagnosis.error}</p>
                {:else}
                <p class="diag-row"><span>File</span><code>{diagnosis.dynSecPath}</code></p>
                <p class="diag-row"><span>Admin user exists</span><span class={diagnosis.adminClientExists ? 'ok' : 'fail'}>{diagnosis.adminClientExists ? '✓ yes' : '✗ no'}</span></p>
                <p class="diag-row"><span>Has admin role</span><span class={diagnosis.hasAdminRole ? 'ok' : 'fail'}>{diagnosis.hasAdminRole ? '✓ yes' : '✗ no'}</span></p>
                <p class="diag-row"><span>$CONTROL publish ACL</span><span class={diagnosis.hasControlSendAcl ? 'ok' : 'fail'}>{diagnosis.hasControlSendAcl ? '✓ present' : '✗ missing'}</span></p>
                {#each diagnosis.issues as issue}<p class="diag-issue">⚠ {issue}</p>{/each}
                {#if diagnosis.ok}<p class="diag-ok-msg">✓ dynamic-security.json looks correct. Verify mosquitto restarted with the plugin loaded.</p>{/if}
                {/if}
            </div>
            <button class="diag-btn" onclick={runDiagnosis} disabled={diagnosing} style="margin-top:6px">{diagnosing ? 'Running…' : 'Re-run'}</button>
            {/if}
            {#if !showWizard}<button class="wizard-btn" onclick={() => (showWizard = true)}>Run Setup Wizard</button>{/if}
        </div>
        {/if}

        <!-- ── Broker stats ───────────────────────────────────────────── -->
        {#if Object.keys(status.sys).length > 0}
        <div class="stats-block">
            <dl>
                <dt>Version</dt><dd>{sysVal('$SYS/broker/version')}</dd>
                <dt>Uptime</dt><dd>{fmtUptime(sysVal('$SYS/broker/uptime'))}</dd>
                <dt>Clients</dt><dd>{sysVal('$SYS/broker/clients/connected')} connected · {sysVal('$SYS/broker/clients/maximum')} max · {sysVal('$SYS/broker/clients/total')} total</dd>
                <dt>Messages</dt><dd>{sysVal('$SYS/broker/messages/received')} rcv · {sysVal('$SYS/broker/messages/sent')} sent · {sysVal('$SYS/broker/messages/stored')} stored</dd>
                <dt>Topics</dt><dd>{sysVal('$SYS/broker/retained messages/count')} retained · {sysVal('$SYS/broker/subscriptions/count')} subscriptions</dd>
                <dt>Traffic</dt><dd>{fmtBytes(sysVal('$SYS/broker/bytes/received'))} in · {fmtBytes(sysVal('$SYS/broker/bytes/sent'))} out</dd>
            </dl>
        </div>
        {/if}
    </div>

    {#if showWizard && (!status.dynsec.configured || !status.dynsec.dynsecReady)}
    <div style="margin-top: 20px;">
        <Wizard onDone={() => { showWizard = false; loadStatus(); }} />
    </div>
    {/if}
    {/if}
    </div>

    {:else if tab === 'users'}
    <Users dynsecReady={status?.dynsec.dynsecReady ?? false} />

    {:else if tab === 'brokerconfig'}
    <BrokerConfig />

    {:else if tab === 'advanced'}
    <Advanced />

    {:else if tab === 'passwd'}
    <PasswdAcl />

    {:else if tab === 'listeners'}
    <Listeners />

    {:else if tab === 'certs'}
    <Certificates />

    {:else if tab === 'ssh'}
    <SSH />

    {:else if tab === 'logs'}
    <MosquittoLogs />
    {/if}
</div>

<ConfirmDialog bind:this={dialog} />

<style>
    .broker-page {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    /* menubar tabs — the sub-navigation look shared by the Broker, MQTT, Adapters and DB pages */
    .sub-nav {
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 6px 10px 0;
        border-bottom: 1px solid var(--border-sub);
        flex-shrink: 0;
    }

    .sub-nav button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        color: var(--fg-muted);
        cursor: pointer;
        font-size: 13px;
        padding: 5px 12px 6px;
        margin-bottom: -1px;
    }

    .sub-nav button:hover { color: var(--fg); }

    .sub-nav button.active {
        color: var(--fg-text);
        border-bottom-color: var(--fg-brand);
    }

    .tab-content {
        flex: 1;
        overflow: auto;
        padding: 16px;
    }

    .loading {
        color: var(--text-muted, #888);
        padding: 20px 0;
    }

    .error-banner {
        background: rgba(220, 60, 60, 0.15);
        border: 1px solid rgba(220, 60, 60, 0.4);
        border-radius: 4px;
        color: #e88;
        padding: 8px 12px;
        margin-bottom: 12px;
    }

    .status-grid {
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
    }

    .status-card {
        background: var(--surface, #1e1e1e);
        border: 1px solid var(--border, #333);
        border-radius: 6px;
        padding: 14px 18px;
        min-width: 240px;
    }

    .card-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
    }

    .card-header h3 {
        font-size: 13px;
        font-weight: 600;
        margin: 0;
        flex: 1;
    }

    .deactivate-btn {
        background: none;
        border: 1px solid rgba(200, 80, 80, 0.5);
        border-radius: 3px;
        color: #c85050;
        cursor: pointer;
        font-size: 11px;
        padding: 2px 8px;
    }

    .deactivate-btn:hover:not(:disabled) {
        background: rgba(200, 80, 80, 0.12);
    }

    .deactivate-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .error-inline {
        background: rgba(220, 60, 60, 0.12);
        border: 1px solid rgba(220, 60, 60, 0.35);
        border-radius: 3px;
        color: #e88;
        font-size: 12px;
        padding: 4px 8px;
        margin-bottom: 8px;
    }

    .status-card h3 {
        font-size: 13px;
        font-weight: 600;
        margin: 0 0 10px;
        color: var(--text-muted, #aaa);
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .status-badge {
        display: inline-block;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 600;
        padding: 2px 9px;
    }

    .status-badge.ok   { background: rgba(70,180,70,0.15); color: #7c7; border: 1px solid rgba(70,180,70,0.3); }
    .status-badge.err  { background: rgba(220,60,60,0.15); color: #e88; border: 1px solid rgba(220,60,60,0.3); }
    .status-badge.warn { background: rgba(200,150,40,0.15); color: #cc9; border: 1px solid rgba(200,150,40,0.3); }

    .status-card dl {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 3px 12px;
        font-size: 12px;
        margin: 0;
    }

    .status-card dt { color: var(--text-muted, #888); }
    .status-card dd { margin: 0; color: var(--text, #ddd); font-variant-numeric: tabular-nums; }

    .hint {
        color: var(--text-muted, #888);
        font-size: 12px;
        margin: 8px 0 0;
        line-height: 1.5;
    }

    .hint-code {
        background: var(--bg-input, #1e1e1e);
        border: 1px solid var(--border-sub, #333);
        border-radius: 4px;
        padding: 8px 10px;
        font-size: 11px;
        color: var(--fg, #ccc);
        margin: 6px 0 0;
        white-space: pre-wrap;
        line-height: 1.6;
    }

    .hint-code {
        background: var(--bg-input, #1e1e1e);
        border: 1px solid var(--border-sub, #333);
        border-radius: 4px;
        padding: 8px 10px;
        font-size: 11px;
        color: var(--fg, #ccc);
        margin: 6px 0 0;
        white-space: pre-wrap;
        line-height: 1.6;
    }

    .diag-btn {
        margin-top: 8px;
        background: var(--accent-dim, rgba(86,156,214,0.1));
        border: 1px solid rgba(86,156,214,0.35);
        border-radius: 3px;
        color: var(--accent, #569cd6);
        cursor: pointer;
        font-size: 12px;
        padding: 4px 10px;
    }
    .diag-btn:hover:not(:disabled) { background: rgba(86,156,214,0.18); }
    .diag-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .diag-card {
        margin-top: 8px;
        background: rgba(0,0,0,0.2);
        border: 1px solid var(--border, #333);
        border-radius: 4px;
        padding: 8px 10px;
        font-size: 12px;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .diag-card.diag-fail { border-color: rgba(200,80,80,0.4); }
    .diag-card.diag-ok   { border-color: rgba(80,180,80,0.4); }

    .diag-row { display: flex; gap: 8px; align-items: baseline; margin: 0; }
    .diag-row span:first-child { color: var(--text-muted, #888); width: 160px; flex-shrink: 0; }
    .diag-row code { font-size: 11px; word-break: break-all; }
    .diag-row .ok  { color: #6bce6b; }
    .diag-row .fail { color: #e88; }

    .diag-issue {
        color: #e2a84b;
        font-size: 11px;
        line-height: 1.5;
        margin: 2px 0 0;
    }
    .diag-ok-msg { color: #6bce6b; font-size: 11px; margin: 2px 0 0; }

    .hint code {
        background: var(--code-bg, #2a2a2a);
        border-radius: 3px;
        font-size: 11px;
        padding: 1px 4px;
    }

    .wizard-btn {
        margin-top: 6px;
        background: var(--accent-dim, rgba(86,156,214,0.12));
        border: 1px solid rgba(86,156,214,0.3);
        border-radius: 4px;
        color: var(--accent, #569cd6);
        cursor: pointer;
        font-size: 12px;
        padding: 4px 12px;
        align-self: flex-start;
    }

    /* ── New status layout ──────────────────────────────────────────────────────── */
    .status-layout { display: flex; flex-direction: column; gap: 14px; max-width: 520px; }

    .conn-block { display: flex; flex-direction: column; gap: 7px; }
    .conn-row   { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .conn-name  { color: var(--text, #ddd); font-weight: 500; min-width: 120px; }
    .conn-detail { color: var(--text-muted, #888); flex: 1; }
    .conn-detail.ok   { color: #4b9; }
    .conn-detail.warn { color: #c90; }
    .conn-detail.err  { color: #e88; }
    .conn-detail.muted { color: var(--text-muted, #777); }

    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: #555; }
    .dot.ok      { background: #4b9; }
    .dot.warn    { background: #c90; }
    .dot.dot-err { background: #c44; }
    .dot.dot-off { background: #555; }

    .btn-deactivate {
        background: none;
        border: 1px solid rgba(180, 80, 80, 0.2);
        border-radius: 3px;
        color: rgba(200, 100, 100, 0.55);
        cursor: pointer;
        font-size: 10px;
        padding: 1px 7px;
        margin-left: auto;
        white-space: nowrap;
    }
    .btn-deactivate:hover:not(:disabled) { color: #c85050; border-color: rgba(200,80,80,0.45); background: rgba(200,80,80,0.06); }
    .btn-deactivate:disabled { opacity: 0.35; cursor: not-allowed; }

    .btn-wizard-inline { background: none; border: none; color: var(--accent, #569cd6); cursor: pointer; font-size: 11px; padding: 0; margin-left: auto; opacity: 0.8; }
    .btn-wizard-inline:hover { opacity: 1; }

    .diag-area { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; background: rgba(0,0,0,0.12); border: 1px solid var(--border, #333); border-radius: 5px; }

    .stats-block { border-top: 1px solid var(--border, #333); padding-top: 12px; }
    .stats-block dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 12px; margin: 0; }
    .stats-block dt { color: var(--text-muted, #888); }
    .stats-block dd { margin: 0; color: var(--text, #ddd); font-variant-numeric: tabular-nums; }
</style>
