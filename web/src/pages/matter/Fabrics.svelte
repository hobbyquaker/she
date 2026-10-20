<script lang="ts">
    /**
     * The "Fabrics" panel of a device on the Matter page (roadmap M20): which controllers the
     * device belongs to, a pairing window with QR and manual code to share it with another app,
     * and the removal of a stale fabric.
     */
    import { onDestroy, untrack } from 'svelte';
    import QRCode from 'qrcode';
    import { subscribeWs } from '../../lib/ws.js';
    import { getMatterFabrics, openMatterCommissioningWindow, closeMatterCommissioningWindow, removeMatterFabric, type MatterFabrics, type MatterWindowCodes } from '../../lib/api.js';
    import ConfirmDialog from '../../lib/ConfirmDialog.svelte';

    let { nodeId, online = false }: { nodeId: string; online?: boolean } = $props();

    let data = $state<MatterFabrics | null>(null);
    let error = $state<string | null>(null);
    let busy = $state(false);
    let codes = $state<MatterWindowCodes | null>(null);
    let qrUrl = $state<string | null>(null);
    let now = $state(Date.now());
    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean; alert?: boolean }): Promise<boolean> };

    async function load() {
        error = null;
        try {
            data = await getMatterFabrics(nodeId);
            codes = data.window.codes;
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
    }
    $effect(() => {
        void nodeId;
        untrack(() => { data = null; codes = null; load(); });
    });
    $effect(() => {
        if (!codes) { qrUrl = null; return; }
        QRCode.toDataURL(codes.qrCode, { margin: 1, width: 180 }).then((u) => (qrUrl = u)).catch(() => (qrUrl = null));
    });
    const tick = setInterval(() => { now = Date.now(); }, 1000);
    const unsub = subscribeWs('matter:fabrics', (msg) => { if (String(msg.nodeId) === nodeId) load(); });
    onDestroy(() => { clearInterval(tick); unsub(); });

    let remaining = $derived(codes ? Math.max(0, Math.round((codes.expiresAt - now) / 1000)) : 0);
    let windowOpen = $derived((data?.window.status ?? 0) !== 0 || remaining > 0);

    async function share() {
        busy = true;
        error = null;
        try {
            codes = await openMatterCommissioningWindow(nodeId);
            await load();
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            busy = false;
        }
    }
    async function closeWindow() {
        busy = true;
        try {
            await closeMatterCommissioningWindow(nodeId);
            codes = null;
            await load();
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            busy = false;
        }
    }
    async function remove(fabricIndex: number, name: string) {
        const ok = await dialog.show(`Remove the fabric "${name}" (index ${fabricIndex}) from this device? That controller loses the device and has to pair it again.`, { confirm: 'Remove fabric', danger: true });
        if (!ok) return;
        busy = true;
        try {
            await removeMatterFabric(nodeId, fabricIndex);
            await load();
        } catch (e) {
            await dialog.show(`Removing the fabric failed: ${e instanceof Error ? e.message : String(e)}`, { alert: true });
        } finally {
            busy = false;
        }
    }
    function fmtRemaining(s: number): string {
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
</script>

<ConfirmDialog bind:this={dialog} />
<details class="fabrics" open>
    <summary>
        Fabrics
        <span class="count">{data ? `${data.fabrics.length}${data.supportedFabrics ? ` / ${data.supportedFabrics}` : ''}` : '…'}</span>
        {#if windowOpen}<span class="badge b-open">pairing window open{remaining > 0 ? ` · ${fmtRemaining(remaining)}` : ''}</span>{/if}
    </summary>
    {#if error}<p class="err">{error}</p>{/if}
    {#if data}
        <table class="fab-table">
            <thead><tr><th>Controller</th><th>Vendor</th><th>Fabric ID</th><th>Node ID there</th><th></th></tr></thead>
            <tbody>
                {#each data.fabrics as f (f.fabricIndex ?? f.fabricId)}
                    <tr class:own={f.own}>
                        <td>{f.name}{#if f.own}<span class="badge b-own">she</span>{/if}</td>
                        <td>{f.vendorName ?? (f.vendorId !== null ? `0x${f.vendorId.toString(16).padStart(4, '0')}` : '—')}</td>
                        <td class="mono">{f.fabricId ?? '—'}</td>
                        <td class="mono">{f.nodeId ?? '—'}</td>
                        <td class="c-act">{#if !f.own && f.fabricIndex !== null}<button class="ghost sm" disabled={busy || !online} onclick={() => remove(f.fabricIndex!, f.name)} title={online ? 'Remove this controller from the device' : 'The device is offline'}>Remove</button>{/if}</td>
                    </tr>
                {/each}
                {#if data.fabrics.length === 0}<tr><td colspan="5" class="dim">{data.fresh ? 'The device reports no fabrics.' : 'Offline — no cached fabric list.'}</td></tr>{/if}
            </tbody>
        </table>
        <div class="actions">
            {#if codes && remaining > 0}
                <div class="share">
                    {#if qrUrl}<img class="qr" src={qrUrl} alt="pairing QR code" />{/if}
                    <div class="share-text">
                        <div>Scan the code in the other app, or enter the manual code <span class="mono code">{codes.manualCode}</span>.</div>
                        <div class="dim">Passcode {codes.passcode} · discriminator {codes.discriminator} · the window closes in {fmtRemaining(remaining)}.</div>
                        <div class="dim">Pairing a device into a second app keeps it in she; the other app gets its own fabric.</div>
                        <button class="ghost sm" disabled={busy} onclick={closeWindow}>Close window</button>
                    </div>
                </div>
            {:else if windowOpen}
                <span class="dim">A pairing window is open (opened by {data.window.adminFabricIndex !== null ? (data.fabrics.find((f) => f.fabricIndex === data!.window.adminFabricIndex)?.name ?? `fabric ${data.window.adminFabricIndex}`) : 'another controller'}).</span>
                <button class="ghost sm" disabled={busy || !online} onclick={closeWindow}>Close window</button>
            {:else}
                <button class="sm" disabled={busy || !online} onclick={share} title={online ? 'Open a 15-minute pairing window and show the code for another app' : 'The device is offline'}>{busy ? 'Opening…' : 'Share with another app…'}</button>
                <span class="dim">Opens a pairing window so Apple Home, Home Assistant or another controller can add this device.</span>
            {/if}
        </div>
    {/if}
</details>

<style>
    .fabrics { margin: 0 0 14px; font-size: 12px; color: var(--fg); }
    .fabrics summary { cursor: pointer; font-weight: 600; color: var(--fg-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px; }
    .count { font-weight: 400; text-transform: none; letter-spacing: 0; }
    .badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600; line-height: 16px; text-transform: none; letter-spacing: 0; margin-left: 6px; }
    .b-own { background: rgba(86,156,214,0.18); color: var(--accent, #569cd6); }
    .b-open { background: rgba(152,195,121,0.18); color: #98c379; }
    .fab-table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 12px; }
    .fab-table th { text-align: left; font-weight: 600; font-size: 11px; color: var(--fg-muted); padding: 3px 6px; border-bottom: 1px solid var(--border); }
    .fab-table td { padding: 3px 6px; border-bottom: 1px solid var(--border-sub, var(--border)); vertical-align: top; }
    tr.own td { color: var(--fg-text); }
    .mono { font-family: var(--font-mono, monospace); font-size: 11px; }
    .code { font-size: 13px; color: var(--fg-text); }
    .c-act { text-align: right; white-space: nowrap; }
    .dim { color: var(--fg-muted); font-size: 11px; }
    .err { margin: 4px 0; color: #e74c3c; }
    .actions { margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .share { display: flex; gap: 12px; align-items: flex-start; }
    .qr { width: 180px; height: 180px; background: #fff; border-radius: 4px; padding: 4px; box-sizing: content-box; }
    .share-text { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
    button {
        background: var(--accent); border: none; color: #fff;
        padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer;
    }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    button.sm { padding: 1px 7px; font-size: 11px; }
</style>
