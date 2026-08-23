<script lang="ts">
    /* Panel under a host card: remove she from the host (I11) — this she's key only, or everything. */
    import { removeServiceHelper, type HelperRemoveResult } from '../../lib/api';

    let { host, label, local = false, onclose, ondone }: { host: string; label: string; local?: boolean; onclose: () => void; ondone: (r: HelperRemoveResult) => void } = $props();

    // svelte-ignore state_referenced_locally — the initial choice only
    let mode = $state<'key' | 'all'>(local ? 'all' : 'key');
    let busy = $state(false);
    let result = $state<HelperRemoveResult | null>(null);
    let error = $state<string | null>(null);

    async function run(force = false) {
        busy = true;
        error = null;
        try {
            const r = await removeServiceHelper(host, mode, force);
            result = r;
            if (r.ok) ondone(r);
        } catch (e: any) {
            error = e.message ?? String(e);
        } finally {
            busy = false;
        }
    }
</script>

<div class="rm-box">
    <div class="rm-title">Remove she from {label}</div>
    <label class="rm-opt" class:disabled={local}>
        <input type="radio" bind:group={mode} value="key" disabled={local || busy} />
        <span><b>Disconnect</b> — remove only this she's SSH key from the host. Helper, sudoers rule and the <span class="mono">she-services</span> user stay, so another she instance can keep managing the host.{#if local} (not applicable to the she host){/if}</span>
    </label>
    <label class="rm-opt">
        <input type="radio" bind:group={mode} value="all" disabled={busy} />
        <span><b>Remove everything</b> — {#if !local}this she's key, {/if}the sudoers rule, <span class="mono">/usr/local/bin/she-servicectl</span>{#if !local} and the <span class="mono">she-services</span> user with its home directory{/if}.</span>
    </label>
    <div class="rm-note">Adapters, their instances, units, config files and <span class="mono">/etc/mqtt-interfaces/broker.env</span> are not touched — everything keeps running. The host is removed from she's settings.</div>
    {#if result && !result.ok && result.code === 'OTHER_KEYS'}
        <div class="rm-warn">{result.error}</div>
    {:else if error}
        <div class="rm-err">{error}</div>
    {/if}
    <div class="rm-actions">
        <button class="ghost sm" onclick={onclose} disabled={busy}>Cancel</button>
        {#if result && !result.ok && result.code === 'OTHER_KEYS'}
            <button class="sm danger" onclick={() => run(true)} disabled={busy}>{busy ? 'Removing…' : 'Remove everything anyway'}</button>
        {:else}
            <button class="sm danger" onclick={() => run(false)} disabled={busy}>{busy ? 'Removing…' : mode === 'key' ? 'Disconnect' : 'Remove everything'}</button>
        {/if}
    </div>
</div>

<style>
    .rm-box { background: rgba(220,60,60,0.08); border: 1px solid rgba(220,60,60,0.35); border-radius: 3px; padding: 8px 10px; margin-bottom: 8px; font-size: 12px; display: flex; flex-direction: column; gap: 6px; color: var(--fg); }
    .rm-title { font-weight: 600; }
    .rm-opt { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
    .rm-opt.disabled { opacity: 0.55; cursor: default; }
    .rm-opt input { margin-top: 2px; }
    .rm-note, .rm-warn, .rm-err { font-size: 11px; }
    .rm-note { color: var(--fg-muted); }
    .rm-warn { color: #e67e22; }
    .rm-err { color: #e88; }
    .mono { font-family: var(--font-mono, monospace); font-size: 11px; }
    .rm-actions { display: flex; gap: 6px; justify-content: flex-end; }
    button { background: var(--accent); border: none; color: #fff; padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    button.sm { padding: 1px 7px; font-size: 11px; }
    button.danger { background: #c0392b; }
</style>
