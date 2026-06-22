<script lang="ts">
    import { onMount } from 'svelte';
    import { getBrokerConf, putBrokerConfRaw, getBrokerBackups, restoreBrokerBackup, brokerReload } from '../../lib/api.js';
    import MonacoEditor from '../../lib/MonacoEditor.svelte';
    import ConfirmDialog from '../../lib/ConfirmDialog.svelte';

    let content = $state('');
    let checksum = $state<string | null>(null);
    let backups = $state<string[]>([]);
    let loading = $state(true);
    let loadError = $state('');
    let saving = $state(false);
    let saveError = $state('');
    let saveOk = $state(false);
    let reloading = $state(false);
    let reloadMsg = $state('');
    let restoring = $state('');

    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean }): Promise<boolean> };

    onMount(() => { load(); });

    async function load() {
        loading = true;
        loadError = '';
        try {
            const conf = await getBrokerConf();
            content = conf.raw ?? '';
            checksum = conf.checksum;
            backups = conf.backups ?? [];
        } catch (e: any) {
            loadError = e.message ?? 'Failed to load config';
        } finally {
            loading = false;
        }
    }

    async function save() {
        saving = true;
        saveError = '';
        saveOk = false;
        try {
            await putBrokerConfRaw(content, checksum);
            saveOk = true;
            // Reload to get fresh checksum + updated backup list
            await load();
            saveOk = true;
        } catch (e: any) {
            if (e.message?.includes('external_modify') || e.status === 409) {
                saveError = 'mosquitto.conf was modified externally since last read. Reload first.';
            } else {
                saveError = e.message ?? 'Save failed';
            }
        } finally {
            saving = false;
        }
    }

    async function reload() {
        reloading = true;
        reloadMsg = '';
        try {
            const r = await brokerReload();
            reloadMsg = r.stderr || r.stdout || 'Reloaded';
        } catch (e: any) {
            reloadMsg = 'Error: ' + (e.message ?? 'reload failed');
        } finally {
            reloading = false;
        }
    }

    async function restore(backup: string) {
        if (!await dialog.show(`Restore backup "${backup}"? Current mosquitto.conf will be overwritten.`, { confirm: 'Restore', danger: true })) return;
        restoring = backup;
        saveError = '';
        try {
            await restoreBrokerBackup(backup);
            await load();
        } catch (e: any) {
            saveError = e.message ?? 'Restore failed';
        } finally {
            restoring = '';
        }
    }

    async function refreshBackups() {
        try {
            const r = await getBrokerBackups();
            backups = r.backups;
        } catch {
            // ignore
        }
    }

    function fmtBackup(name: string): string {
        // mosquitto.conf.bak-20250101T120000 → 2025-01-01 12:00:00
        const m = name.match(/\.bak-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
        if (!m) return name;
        return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
    }
</script>

<div class="advanced-page">
    <div class="page-header">
        <h3>Advanced — mosquitto.conf</h3>
        <div class="header-actions">
            <button class="btn-save" onclick={save} disabled={saving || loading}>{saving ? 'Saving…' : 'Save'}</button>
            <button onclick={reload} disabled={reloading}>{reloading ? 'Reloading…' : 'Apply & Reload'}</button>
        </div>
    </div>

    {#if loadError}<div class="err">{loadError}</div>{/if}
    {#if saveError}<div class="err">{saveError}</div>{/if}
    {#if saveOk}<div class="ok">Saved.</div>{/if}
    {#if reloadMsg}<div class="reload-msg">{reloadMsg}</div>{/if}

    <div class="editor-wrap">
        {#if loading}
        <div class="loading">Loading…</div>
        {:else}
        <MonacoEditor bind:value={content} language="ini" onSave={save} />
        {/if}
    </div>

    {#if backups.length > 0}
    <div class="backups-section">
        <div class="backups-header">
            <span class="backups-title">Backups</span>
            <button class="btn-refresh" onclick={refreshBackups} title="Refresh backup list">↻</button>
        </div>
        <ul class="backup-list">
            {#each backups as backup}
            <li>
                <span class="backup-name">{fmtBackup(backup)}</span>
                <button
                    class="btn-restore"
                    onclick={() => restore(backup)}
                    disabled={restoring === backup}
                >{restoring === backup ? 'Restoring…' : 'Restore'}</button>
            </li>
            {/each}
        </ul>
    </div>
    {/if}
</div>

<ConfirmDialog bind:this={dialog} />

<style>
    .advanced-page {
        padding: 14px 16px;
        height: 100%;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
    }

    .page-header { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .page-header h3 { margin: 0; font-size: 13px; color: var(--text-muted, #aaa); text-transform: uppercase; letter-spacing: 0.04em; }
    .header-actions { display: flex; gap: 6px; margin-left: auto; }
    .header-actions button {
        background: none;
        border: 1px solid var(--border, #444);
        border-radius: 4px;
        color: var(--text-muted, #aaa);
        cursor: pointer;
        font-size: 12px;
        padding: 4px 10px;
    }
    .btn-save { background: var(--accent-dim, rgba(86,156,214,0.15)) !important; border-color: rgba(86,156,214,0.35) !important; color: var(--accent, #569cd6) !important; }

    .err  { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.3); border-radius: 4px; color: #e88; font-size: 12px; padding: 6px 10px; flex-shrink: 0; }
    .ok   { background: rgba(70,180,70,0.1); border: 1px solid rgba(70,180,70,0.25); border-radius: 4px; color: #8c8; font-size: 12px; padding: 6px 10px; flex-shrink: 0; }
    .reload-msg { font-size: 12px; color: var(--text-muted, #aaa); padding: 2px 0; white-space: pre-wrap; flex-shrink: 0; }

    .editor-wrap {
        flex: 1;
        min-height: 0;
        border: 1px solid var(--border, #333);
        border-radius: 6px;
        overflow: hidden;
    }

    .loading { padding: 20px; color: var(--text-muted, #aaa); font-size: 13px; }

    .backups-section {
        flex-shrink: 0;
        background: var(--surface, #1e1e1e);
        border: 1px solid var(--border, #333);
        border-radius: 6px;
        padding: 10px 14px;
        max-height: 160px;
        overflow-y: auto;
    }

    .backups-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
    }

    .backups-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-muted, #aaa);
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .btn-refresh {
        background: none;
        border: none;
        color: var(--text-muted, #888);
        cursor: pointer;
        font-size: 14px;
        padding: 0 2px;
        line-height: 1;
    }
    .btn-refresh:hover { color: var(--text, #eee); }

    .backup-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .backup-list li {
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .backup-name {
        font-size: 12px;
        font-family: monospace;
        color: var(--text, #ddd);
        flex: 1;
    }

    .btn-restore {
        background: none;
        border: 1px solid var(--border, #444);
        border-radius: 3px;
        color: var(--text-muted, #aaa);
        cursor: pointer;
        font-size: 11px;
        padding: 2px 8px;
    }
    .btn-restore:hover { border-color: var(--accent, #569cd6); color: var(--accent, #569cd6); }
    .btn-restore:disabled { opacity: 0.5; cursor: default; }
</style>
