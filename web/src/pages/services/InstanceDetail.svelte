<script lang="ts">
    /**
     * Drawer for one adapter instance on a host: config (env file via schema form),
     * live journal, and the raw <name>/info payload when the instance is seen on MQTT.
     */
    import { onMount } from 'svelte';
    import {
        getServiceEnv, putServiceEnv, getServiceLogs, followServiceLogs, unfollowServiceLogs,
        type ServiceSchema, type ServiceLogEntry, type ServiceInstance, type ServiceHostInstance,
    } from '../../lib/api.js';
    import { subscribeWs } from '../../lib/ws.js';
    import SchemaForm from './SchemaForm.svelte';

    let {
        host,
        adapter,
        instance,
        unit = null,
        mqtt = null,
        onclose,
        onchanged,
    }: {
        host: string;
        adapter: string;
        instance: string;
        unit?: ServiceHostInstance | null;
        mqtt?: ServiceInstance | null;
        onclose: () => void;
        onchanged?: () => void;
    } = $props();

    type Tab = 'config' | 'logs' | 'info';
    let tab = $state<Tab>('config');

    /* ── Config ───────────────────────────────────────────────────────────── */
    let env      = $state<Record<string, string>>({});
    let secrets  = $state<string[]>([]);
    let schema   = $state<ServiceSchema | null>(null);
    let cfgLoading = $state(true);
    let cfgError = $state('');
    let saving   = $state(false);
    let saveMsg  = $state('');

    async function loadConfig() {
        cfgLoading = true; cfgError = '';
        try {
            const r = await getServiceEnv(host, adapter, instance);
            env = r.env; secrets = r.secrets; schema = r.schema;
        } catch (e: any) {
            cfgError = e.message ?? String(e);
        } finally {
            cfgLoading = false;
        }
    }

    async function save(restart: boolean) {
        saving = true; saveMsg = ''; cfgError = '';
        try {
            const r = await putServiceEnv(host, adapter, instance, env, restart);
            saveMsg = r.restarted ? 'Saved and restarted.' : 'Saved — takes effect on the next restart.';
            onchanged?.();
            await loadConfig();
        } catch (e: any) {
            cfgError = e.message ?? String(e);
        } finally {
            saving = false;
        }
    }

    /* ── Logs ─────────────────────────────────────────────────────────────── */
    let entries   = $state<ServiceLogEntry[]>([]);
    let logError  = $state('');
    let following = $state(false);
    let logEl     = $state<HTMLDivElement | undefined>(undefined);
    let unsubLog: (() => void) | null = null;
    let renewTimer: ReturnType<typeof setInterval> | null = null;
    let unitName = $derived(`${adapter}@${instance}`);

    async function loadLogs() {
        logError = '';
        try {
            entries = (await getServiceLogs(host, adapter, instance, 200)).entries;
            scrollLogs();
        } catch (e: any) {
            logError = e.message ?? String(e);
        }
    }
    function scrollLogs() {
        requestAnimationFrame(() => { if (logEl) logEl.scrollTop = logEl.scrollHeight; });
    }
    async function startFollow() {
        if (following) return;
        try {
            await followServiceLogs(host, adapter, instance);
            following = true;
            unsubLog = subscribeWs('serviceLog', (msg) => {
                if (msg.host !== host || msg.unit !== unitName) return;
                entries = [...entries.slice(-1999), { ts: msg.ts, level: msg.level, msg: msg.msg, pid: msg.pid ?? null }];
                scrollLogs();
            });
            renewTimer = setInterval(() => { followServiceLogs(host, adapter, instance).catch(() => {}); }, 5 * 60 * 1000);
        } catch (e: any) {
            logError = e.message ?? String(e);
        }
    }
    function stopFollow() {
        if (!following) return;
        following = false;
        unsubLog?.(); unsubLog = null;
        if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
        unfollowServiceLogs(host, adapter, instance).catch(() => {});
    }

    $effect(() => {
        if (tab === 'logs' && entries.length === 0 && !logError) loadLogs();
    });

    onMount(() => {
        loadConfig();
        return () => stopFollow();
    });

    function fmtTs(ts: number): string {
        const d = new Date(ts);
        const p = (n: number) => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
</script>

<div class="detail">
    <div class="head">
        <div>
            <span class="title">{instance}</span>
            <span class="sub mono">{adapter}{#if mqtt?.version} @{mqtt.version}{/if} · {host}</span>
            {#if unit}
                <span class="badge" class:ok={unit.active === 'active'} class:err={unit.active === 'failed'} title="systemd: {unit.active}/{unit.sub}, {unit.unitFile}">{unit.active}{unit.unitFile === 'disabled' ? ' · disabled' : ''}</span>
            {/if}
        </div>
        <button class="ghost sm" onclick={onclose}>Close</button>
    </div>
    <div class="tabs">
        <button class:active={tab === 'config'} onclick={() => (tab = 'config')}>Config</button>
        <button class:active={tab === 'logs'} onclick={() => (tab = 'logs')}>Logs</button>
        <button class:active={tab === 'info'} onclick={() => (tab = 'info')}>Info</button>
    </div>

    {#if tab === 'config'}
        <div class="body">
            {#if cfgLoading}
                <div class="muted">Loading /etc/{adapter}/{instance}.env…</div>
            {:else}
                {#if cfgError}<div class="err-box">{cfgError}</div>{/if}
                <SchemaForm {schema} bind:env {secrets} mode="edit" />
                <div class="actions">
                    <button onclick={() => save(false)} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                    <button onclick={() => save(true)} disabled={saving}>Save &amp; restart</button>
                    {#if saveMsg}<span class="muted">{saveMsg}</span>{/if}
                </div>
            {/if}
        </div>
    {:else if tab === 'logs'}
        <div class="logbar">
            <button class="ghost sm" onclick={loadLogs}>↺ last 200</button>
            {#if following}
                <button class="ghost sm" onclick={stopFollow}>■ stop following</button>
            {:else}
                <button class="ghost sm" onclick={startFollow}>▶ follow</button>
            {/if}
            <span class="muted mono">journalctl -u {unitName}</span>
            {#if logError}<span class="err">{logError}</span>{/if}
        </div>
        <div class="log" bind:this={logEl}>
            {#each entries as e, idx (idx)}
                <div class="line {e.level}"><span class="ts">{fmtTs(e.ts)}</span><span class="lvl">{e.level}</span><span class="msg">{e.msg}</span></div>
            {/each}
            {#if entries.length === 0 && !logError}<div class="muted">No journal entries.</div>{/if}
        </div>
    {:else}
        <div class="body">
            {#if unit}
                <dl class="kv">
                    <dt>unit</dt><dd class="mono">{unitName}.service</dd>
                    <dt>state</dt><dd>{unit.active} / {unit.sub} · {unit.unitFile}</dd>
                    <dt>since</dt><dd>{unit.since || '—'}</dd>
                    <dt>restarts</dt><dd>{unit.restarts}</dd>
                    <dt>env file</dt><dd class="mono">/etc/{adapter}/{instance}.env</dd>
                    <dt>state dir</dt><dd class="mono">/var/lib/{adapter}/{instance}/</dd>
                </dl>
            {/if}
            {#if mqtt?.info}
                <div class="muted" style="margin-bottom:4px">{instance}/info</div>
                <pre class="mono json">{JSON.stringify(mqtt.info, null, 2)}</pre>
            {:else}
                <div class="muted">Not seen on MQTT (no retained {instance}/info).</div>
            {/if}
        </div>
    {/if}
</div>

<style>
    .detail { display: flex; flex-direction: column; height: 100%; overflow: hidden; border-left: 1px solid var(--border); background: var(--bg-panel); }
    .head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--border); gap: 8px; }
    .title { font-weight: 600; font-size: 13px; margin-right: 8px; }
    .sub { font-size: 11px; color: var(--fg-muted); }
    .mono { font-family: var(--font-mono, monospace); }
    .badge { display: inline-block; margin-left: 8px; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600; line-height: 16px; background: rgba(127,140,141,0.2); color: var(--fg-muted); }
    .badge.ok { background: rgba(39,174,96,0.18); color: #27ae60; }
    .badge.err { background: rgba(231,76,60,0.18); color: #e74c3c; }
    .tabs { display: flex; gap: 2px; padding: 4px 8px 0; border-bottom: 1px solid var(--border); }
    .tabs button { background: none; border: none; border-bottom: 2px solid transparent; color: var(--fg-muted); font-size: 12px; padding: 4px 10px 5px; margin-bottom: -1px; cursor: pointer; }
    .tabs button.active { color: var(--fg); border-bottom-color: var(--accent); }
    .body { flex: 1; overflow: auto; padding: 12px; font-size: 12px; }
    .actions { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
    button { background: var(--accent); border: none; color: #fff; padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    button.sm { padding: 1px 7px; font-size: 11px; }
    .muted { color: var(--fg-muted); font-size: 11px; }
    .err { color: #e74c3c; font-size: 11px; }
    .err-box { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.35); border-radius: 3px; color: #e88; font-size: 12px; padding: 4px 8px; margin-bottom: 10px; }
    .logbar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--border); }
    .log { flex: 1; overflow: auto; padding: 6px 12px; font-family: var(--font-mono, monospace); font-size: 11px; line-height: 1.5; }
    .line { display: flex; gap: 8px; white-space: pre-wrap; word-break: break-word; }
    .line .ts { color: var(--fg-muted); flex-shrink: 0; }
    .line .lvl { width: 40px; flex-shrink: 0; color: var(--fg-muted); }
    .line.warn .lvl { color: #d4ac0d; }
    .line.error .lvl, .line.error .msg { color: #e74c3c; }
    .line.debug { opacity: 0.7; }
    .kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 10px; font-size: 11px; }
    .kv dt { color: var(--fg-muted); }
    .kv dd { margin: 0; }
    pre.json { margin: 0; max-height: 320px; overflow: auto; background: var(--bg-app); border: 1px solid var(--border); border-radius: 3px; padding: 6px 8px; font-size: 11px; }
</style>
