<script lang="ts">
    import { onMount } from 'svelte';
    import { subscribeWs } from '../lib/ws.js';
    import {
        listMatterDevices,
        getMatterDevice,
        commissionMatter,
        unpairMatter,
        type MatterDevice,
        type MatterNodeDetail,
    } from '../lib/api.js';

    let devices: MatterDevice[] = $state([]);
    let selected: MatterNodeDetail | null = $state(null);
    let loading = $state(false);
    let error: string | null = $state(null);

    // Commission wizard state
    let showWizard = $state(false);
    let wizardMode: 'passcode' | 'pairingCode' = $state('passcode');
    let wizardPasscode = $state('');
    let wizardDiscriminator = $state('');
    let wizardPairingCode = $state('');
    let wizardBusy = $state(false);
    let wizardError: string | null = $state(null);

    async function loadDevices() {
        try {
            devices = await listMatterDevices();
        } catch {
            /* matter controller may not be running */
            devices = [];
        }
    }

    async function selectDevice(nodeId: string) {
        loading = true;
        error = null;
        try {
            selected = await getMatterDevice(nodeId);
        } catch (e: unknown) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            loading = false;
        }
    }

    async function unpair(nodeId: string) {
        if (!confirm(`Unpair device ${nodeId}?`)) return;
        try {
            await unpairMatter(nodeId);
            if (selected?.nodeId === nodeId) selected = null;
            await loadDevices();
        } catch (e: unknown) {
            error = e instanceof Error ? e.message : String(e);
        }
    }

    async function commission() {
        wizardBusy = true;
        wizardError = null;
        try {
            let opts: { passcode: number; discriminator?: number } | { pairingCode: string };
            if (wizardMode === 'passcode') {
                opts = { passcode: Number(wizardPasscode) };
                if (wizardDiscriminator) opts = { ...opts, discriminator: Number(wizardDiscriminator) };
            } else {
                opts = { pairingCode: wizardPairingCode.trim() };
            }
            await commissionMatter(opts);
            showWizard = false;
            wizardPasscode = '';
            wizardDiscriminator = '';
            wizardPairingCode = '';
            await loadDevices();
        } catch (e: unknown) {
            wizardError = e instanceof Error ? e.message : String(e);
        } finally {
            wizardBusy = false;
        }
    }

    onMount(() => {
        loadDevices();
        // Subscribe to WebSocket events that update device list or status
        const unsub = subscribeWs((msg: { type: string; devices?: MatterDevice[]; nodeId?: string; online?: boolean }) => {
            if (msg.type === 'matter:deviceList' && Array.isArray(msg.devices)) {
                devices = msg.devices;
            } else if (msg.type === 'matter:deviceStatus' && msg.nodeId !== undefined) {
                devices = devices.map((d) => (d.nodeId === msg.nodeId ? { ...d, online: msg.online ?? false } : d));
            }
        });
        return unsub;
    });
</script>

<div class="matter-page">
    <div class="sidebar">
        <div class="sidebar-header">
            <span class="sidebar-title">Matter Devices</span>
            <button class="add-btn" onclick={() => (showWizard = !showWizard)} title="Commission new device">＋</button>
        </div>

        {#if showWizard}
            <div class="wizard">
                <div class="wizard-tabs">
                    <button class:active={wizardMode === 'passcode'} onclick={() => (wizardMode = 'passcode')}>Passcode</button>
                    <button class:active={wizardMode === 'pairingCode'} onclick={() => (wizardMode = 'pairingCode')}>QR / Code</button>
                </div>
                {#if wizardMode === 'passcode'}
                    <label>
                        Passcode
                        <input type="number" placeholder="20202021" bind:value={wizardPasscode} />
                    </label>
                    <label>
                        Discriminator (optional)
                        <input type="number" placeholder="3840" bind:value={wizardDiscriminator} />
                    </label>
                {:else}
                    <label>
                        Pairing Code / QR
                        <input type="text" placeholder="MT:..." bind:value={wizardPairingCode} />
                    </label>
                {/if}
                {#if wizardError}
                    <p class="err">{wizardError}</p>
                {/if}
                <button class="commission-btn" disabled={wizardBusy} onclick={commission}>
                    {wizardBusy ? 'Commissioning…' : 'Commission'}
                </button>
            </div>
        {/if}

        <ul class="device-list">
            {#each devices as device (device.nodeId)}
                <li class:selected={selected?.nodeId === device.nodeId}>
                    <button
                        class="device-select-btn"
                        onclick={() => selectDevice(device.nodeId)}
                    >
                        <span class="status-dot" class:online={device.online}></span>
                        <span class="node-id">{device.nodeId}</span>
                    </button>
                    <button
                        class="unpair-btn"
                        title="Unpair"
                        onclick={() => unpair(device.nodeId)}
                    >✕</button>
                </li>
            {/each}
            {#if devices.length === 0}
                <li class="empty">No paired devices</li>
            {/if}
        </ul>
    </div>

    <div class="detail">
        {#if loading}
            <p class="info">Loading…</p>
        {:else if error}
            <p class="err">{error}</p>
        {:else if selected}
            <h2>Node {selected.nodeId}</h2>
            {#each selected.endpoints as ep (ep.endpointId)}
                <details open>
                    <summary>Endpoint {ep.endpointId}</summary>
                    <ul class="cluster-list">
                        {#each ep.clusters as cluster}
                            <li>{cluster}</li>
                        {/each}
                    </ul>
                </details>
            {/each}
        {:else}
            <p class="info">Select a device to view its endpoints.</p>
        {/if}
    </div>
</div>

<style>
    .matter-page {
        display: flex;
        height: 100%;
        color: var(--fg);
        font-size: 13px;
    }

    /* Sidebar */
    .sidebar {
        width: 220px;
        min-width: 160px;
        border-right: 1px solid var(--border-sub);
        display: flex;
        flex-direction: column;
        background: var(--bg-panel);
        overflow-y: auto;
    }
    .sidebar-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 10px;
        border-bottom: 1px solid var(--border-sub);
    }
    .sidebar-title {
        font-weight: 600;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--fg-muted);
    }
    .add-btn {
        background: none;
        border: none;
        color: var(--fg-brand);
        cursor: pointer;
        font-size: 16px;
        padding: 0 4px;
        line-height: 1;
    }
    .add-btn:hover {
        color: var(--fg-value);
    }

    /* Wizard */
    .wizard {
        padding: 8px 10px;
        border-bottom: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .wizard-tabs {
        display: flex;
        gap: 4px;
    }
    .wizard-tabs button {
        flex: 1;
        background: var(--bg-widget);
        border: 1px solid var(--border);
        color: var(--fg);
        cursor: pointer;
        padding: 3px 6px;
        border-radius: 3px;
        font-size: 11px;
    }
    .wizard-tabs button.active {
        background: var(--bg-active);
        color: var(--fg-text);
        border-color: var(--fg-brand);
    }
    label {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 11px;
        color: var(--fg-muted);
    }
    input {
        background: var(--bg-app);
        border: 1px solid var(--border);
        color: var(--fg-text);
        padding: 3px 6px;
        border-radius: 3px;
        font-size: 12px;
        width: 100%;
        box-sizing: border-box;
    }
    input:focus {
        outline: none;
        border-color: var(--fg-brand);
    }
    .commission-btn {
        background: var(--accent);
        border: none;
        color: #fff;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 3px;
        font-size: 12px;
    }
    .commission-btn:hover:not(:disabled) {
        background: var(--accent-hov);
    }
    .commission-btn:disabled {
        opacity: 0.5;
        cursor: default;
    }

    /* Device list */
    .device-list {
        list-style: none;
        margin: 0;
        padding: 4px 0;
        flex: 1;
    }
    .device-list li {
        display: flex;
        align-items: center;
        padding: 5px 10px;
        cursor: pointer;
        border-radius: 3px;
        margin: 1px 4px;
    }
    .device-select-btn {
        background: none;
        border: none;
        color: inherit;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1;
        min-width: 0;
        padding: 0;
        font: inherit;
        text-align: left;
    }
    .device-list li:hover {
        background: var(--bg-hover);
    }
    .device-list li.selected {
        background: var(--bg-active);
    }
    .device-list li.empty {
        cursor: default;
        color: var(--fg-dim);
        font-style: italic;
    }
    .device-list li.empty:hover {
        background: none;
    }
    .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--fg-dim);
        flex-shrink: 0;
    }
    .status-dot.online {
        background: var(--fg-ok);
    }
    .node-id {
        flex: 1;
        font-family: monospace;
        font-size: 11px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .unpair-btn {
        background: none;
        border: none;
        color: var(--fg-dim);
        cursor: pointer;
        font-size: 11px;
        padding: 0 2px;
        opacity: 0;
    }
    .device-list li:hover .unpair-btn {
        opacity: 1;
        color: var(--fg-err);
    }

    /* Detail pane */
    .detail {
        flex: 1;
        padding: 16px 20px;
        overflow-y: auto;
    }
    .detail h2 {
        font-size: 14px;
        font-weight: 600;
        margin: 0 0 12px;
        color: var(--fg-text);
    }
    details {
        margin-bottom: 8px;
        background: var(--bg-panel);
        border: 1px solid var(--border-sub);
        border-radius: 4px;
    }
    summary {
        padding: 6px 10px;
        cursor: pointer;
        font-weight: 500;
        color: var(--fg-value);
        font-size: 12px;
    }
    .cluster-list {
        list-style: none;
        margin: 0;
        padding: 4px 10px 8px;
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
    }
    .cluster-list li {
        background: var(--bg-widget);
        border: 1px solid var(--border);
        border-radius: 3px;
        padding: 2px 6px;
        font-family: monospace;
        font-size: 11px;
        color: #ce9178;
    }
    .info {
        color: var(--fg-dim);
        font-style: italic;
    }
    .err {
        color: var(--fg-err);
    }
</style>
