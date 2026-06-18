<script lang="ts">
    import { onMount } from 'svelte';
    import { getBrokerStatus, type BrokerStatus } from '../lib/api.js';
    import Users from './broker/Users.svelte';
    import Listeners from './broker/Listeners.svelte';
    import Certificates from './broker/Certificates.svelte';
    import SSH from './broker/SSH.svelte';

    type SubTab = 'status' | 'users' | 'listeners' | 'certs' | 'ssh';
    let tab = $state<SubTab>('status');

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

    function sysVal(key: string): string {
        if (!status?.sys) return '—';
        const entry = status.sys[key];
        if (!entry) return '—';
        return String(entry.val ?? '—');
    }
</script>

<div class="broker-page">
    <div class="sub-nav">
        <button class:active={tab === 'status'} onclick={() => (tab = 'status')}>Status</button>
        <button class:active={tab === 'users'} onclick={() => (tab = 'users')}>Users & Roles</button>
        <button class:active={tab === 'listeners'} onclick={() => (tab = 'listeners')}>Listeners</button>
        <button class:active={tab === 'certs'} onclick={() => (tab = 'certs')}>Certificates</button>
        <button class:active={tab === 'ssh'} onclick={() => (tab = 'ssh')}>SSH / Remote</button>
    </div>

    {#if tab === 'status'}
    <div class="tab-content">
        {#if loading}
        <div class="loading">Loading…</div>
        {:else if statusError}
        <div class="error-banner">{statusError}</div>
        {:else if status}
        <div class="status-grid">
            <div class="status-card">
                <h3>Dynamic Security</h3>
                {#if status.dynsec.configured}
                    {#if status.dynsec.connected}
                    <div class="status-badge ok">Connected</div>
                    {:else}
                    <div class="status-badge err">Disconnected</div>
                    {/if}
                {:else}
                <div class="status-badge warn">Not configured</div>
                <p class="hint">Set <code>broker.dynsec.adminUsername</code> and <code>broker.dynsec.adminPassword</code> in Config to enable dynsec management.</p>
                {/if}
            </div>

            <div class="status-card">
                <h3>Broker</h3>
                <dl>
                    <dt>Version</dt>
                    <dd>{sysVal('$SYS/broker/version')}</dd>
                    <dt>Uptime</dt>
                    <dd>{sysVal('$SYS/broker/uptime')}</dd>
                    <dt>Clients connected</dt>
                    <dd>{sysVal('$SYS/broker/clients/connected')}</dd>
                    <dt>Clients total</dt>
                    <dd>{sysVal('$SYS/broker/clients/total')}</dd>
                    <dt>Messages received</dt>
                    <dd>{sysVal('$SYS/broker/messages/received')}</dd>
                    <dt>Messages sent</dt>
                    <dd>{sysVal('$SYS/broker/messages/sent')}</dd>
                </dl>
            </div>
        </div>
        {/if}
    </div>

    {:else if tab === 'users'}
    <Users />

    {:else if tab === 'listeners'}
    <Listeners />

    {:else if tab === 'certs'}
    <Certificates />

    {:else if tab === 'ssh'}
    <SSH />
    {/if}
</div>

<style>
    .broker-page {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .sub-nav {
        display: flex;
        gap: 2px;
        padding: 6px 10px 0;
        border-bottom: 1px solid var(--border, #333);
        flex-shrink: 0;
    }

    .sub-nav button {
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        color: var(--text-muted, #888);
        cursor: pointer;
        font-size: 13px;
        padding: 5px 12px 6px;
        margin-bottom: -1px;
    }

    .sub-nav button.active {
        color: var(--text, #eee);
        border-bottom-color: var(--accent, #569cd6);
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

    .hint code {
        background: var(--code-bg, #2a2a2a);
        border-radius: 3px;
        font-size: 11px;
        padding: 1px 4px;
    }
</style>
