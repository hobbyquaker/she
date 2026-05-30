<script lang="ts">
    import { onMount } from 'svelte';
    import { getConfig, putConfig } from '../lib/api.js';

    let raw = $state('');
    let parseError = $state('');
    let saving = $state(false);
    let msg = $state('');
    let loading = $state(true);

    onMount(async () => {
        try {
            const cfg = await getConfig();
            raw = JSON.stringify(cfg, null, 2);
        } catch (e: any) {
            parseError = e.message;
        } finally {
            loading = false;
        }
    });

    async function save() {
        parseError = '';
        msg = '';
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(raw);
        } catch (e: any) {
            parseError = 'JSON parse error: ' + e.message;
            return;
        }
        saving = true;
        try {
            const res = await putConfig(parsed);
            msg = res.restartRequired ? 'Saved — restart required to apply changes.' : 'Saved.';
        } catch (e: any) {
            parseError = e.message;
        } finally {
            saving = false;
        }
    }
</script>

<div class="page">
    <div class="toolbar">
        <h2>Config</h2>
        <button onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    </div>

    {#if loading}
        <p class="note">Loading…</p>
    {:else}
        {#if parseError}<p class="err">{parseError}</p>{/if}
        {#if msg}<p class="ok">{msg}</p>{/if}
        <textarea bind:value={raw} spellcheck="false"></textarea>
    {/if}
</div>

<style>
    .page { display: flex; flex-direction: column; height: 100%; padding: 16px; gap: 8px; }
    .toolbar { display: flex; align-items: center; gap: 12px; }
    h2 { font-size: 14px; font-weight: 600; flex: 1; }
    button {
        background: #0e639c; color: #fff; border: none;
        padding: 4px 14px; border-radius: 3px; cursor: pointer; font-size: 13px;
    }
    button:disabled { opacity: 0.4; cursor: default; }
    button:not(:disabled):hover { background: #1177bb; }
    textarea {
        flex: 1; background: #1e1e1e; color: #d4d4d4; border: 1px solid #444;
        padding: 12px; font-family: 'Cascadia Code', 'Fira Code', monospace;
        font-size: 13px; resize: none; border-radius: 3px; outline: none;
    }
    textarea:focus { border-color: #569cd6; }
    .err { color: #f48771; font-size: 13px; }
    .ok { color: #89d185; font-size: 13px; }
    .note { color: #888; font-size: 13px; }
</style>
