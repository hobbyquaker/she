<script lang="ts">
    /**
     * Drawer for one adapter instance on a host: config (env file via schema form),
     * live journal, and the raw <name>/info payload when the instance is seen on MQTT.
     */
    import { onMount } from 'svelte';
    import {
        getServiceEnv, putServiceEnv, getServiceLogs, followServiceLogs, unfollowServiceLogs,
        type ServiceSchema, type ServiceLogEntry, type ServiceInstance, type ServiceHostInstance, type SheBrokerInfo, type DynsecInfo, type BrokerMode,
    } from '../../lib/api.js';
    import { subscribeWs } from '../../lib/ws.js';
    import { fmtLogTs } from '../../lib/format.js';
    import SchemaForm from './SchemaForm.svelte';

    let {
        host,
        adapter,
        instance,
        unit = null,
        mqtt = null,
        hostname = null,
        onclose,
        onchanged,
        tab = $bindable('config'),
    }: {
        /** managed host the unit lives on — null: not managed, Info only */
        host: string | null;
        adapter: string | null;
        instance: string;
        unit?: ServiceHostInstance | null;
        mqtt?: ServiceInstance | null;
        hostname?: string | null;
        onclose: () => void;
        onchanged?: () => void;
        /** bound by the parent so the tab survives switching to another instance */
        tab?: Tab;
    } = $props();

    type Tab = 'config' | 'logs' | 'info';
    let managed = $derived(!!host && !!unit && !!adapter);
    // an unmanaged instance has nothing but Info
    $effect(() => { if (!managed && tab !== 'info') tab = 'info'; });
    const h = () => host as string;
    const a = () => adapter as string;

    /* ── Config ───────────────────────────────────────────────────────────── */
    let env      = $state<Record<string, string>>({});
    let secrets  = $state<string[]>([]);
    let schema   = $state<ServiceSchema | null>(null);
    let sheBroker = $state<SheBrokerInfo | null>(null);
    let dynsec = $state<DynsecInfo | null>(null);
    let brokerMode = $state<BrokerMode>('own');
    let savedMode = $state<BrokerMode>('own');
    let cfgLoading = $state(true);
    let cfgError = $state('');
    let saving   = $state(false);
    let saveMsg  = $state('');

    async function loadConfig() {
        cfgLoading = true; cfgError = '';
        try {
            const r = await getServiceEnv(h(), a(), instance);
            env = r.env; secrets = r.secrets; schema = r.schema; sheBroker = r.sheBroker; dynsec = r.dynsec; brokerMode = r.brokerMode; savedMode = r.brokerMode;
        } catch (e: any) {
            cfgError = e.message ?? String(e);
        } finally {
            cfgLoading = false;
        }
    }

    async function save(restart: boolean, rotate = false) {
        saving = true; saveMsg = ''; cfgError = '';
        try {
            const r = await putServiceEnv(h(), a(), instance, env, restart, brokerMode, { rotate });
            saveMsg = rotate ? 'New password set on the broker' + (r.restarted ? ' and instance restarted.' : ' — restart the instance to use it.') : r.restarted ? 'Saved and restarted.' : 'Saved — takes effect on the next restart.';
            onchanged?.();
            await loadConfig();
        } catch (e: any) {
            cfgError = e.message ?? String(e);
        } finally {
            saving = false;
        }
    }

    /* ── Logs — same controls as the Logs page: level, text/regex filter, auto-scroll; following by default ── */
    type Level = 'debug' | 'info' | 'warn' | 'error';
    const LEVELS = ['all', 'debug', 'info', 'warn', 'error'] as const;
    const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    const LOG_MAX = 3000;
    let entries   = $state<ServiceLogEntry[]>([]);
    let logError  = $state('');
    let logLoading = $state(false);
    let following = $state(false);
    let follow    = $state(true);   // wanted state; starts following when the Logs tab is shown
    let autoscroll = $state(true);
    let filterLevel = $state<'all' | Level>('all');
    let filterText  = $state('');
    let filterRegex = $state(false);
    let logEl     = $state<HTMLDivElement | undefined>(undefined);
    let logsOpened = $state(false);
    let unsubLog: (() => void) | null = null;
    let renewTimer: ReturnType<typeof setInterval> | null = null;
    let unitName = $derived(`${adapter}@${instance}`);

    let visibleEntries = $derived.by(() => {
        let re: RegExp | null = null;
        if (filterText && filterRegex) { try { re = new RegExp(filterText, 'i'); } catch { re = null; } }
        const q = filterText.toLowerCase();
        return entries.filter(e => {
            if (filterLevel !== 'all' && LEVEL_ORDER[e.level] < LEVEL_ORDER[filterLevel]) return false;
            if (!filterText) return true;
            return re ? re.test(e.msg) : e.msg.toLowerCase().includes(q);
        });
    });

    async function loadLogs() {
        logError = ''; logLoading = true;
        try {
            entries = (await getServiceLogs(h(), a(), instance, 500)).entries;
            scrollLogs();
        } catch (e: any) {
            logError = e.message ?? String(e);
        } finally {
            logLoading = false;
        }
    }
    function scrollLogs() {
        if (!autoscroll) return;
        requestAnimationFrame(() => { if (logEl) logEl.scrollTop = logEl.scrollHeight; });
    }
    async function startFollow() {
        if (following) return;
        try {
            await followServiceLogs(h(), a(), instance);
            following = true;
            unsubLog = subscribeWs('serviceLog', (msg) => {
                if (msg.host !== host || msg.unit !== unitName) return;
                entries = [...entries.slice(-(LOG_MAX - 1)), { ts: msg.ts, level: msg.level, msg: msg.msg, pid: msg.pid ?? null }];
                scrollLogs();
            });
            renewTimer = setInterval(() => { followServiceLogs(h(), a(), instance).catch(() => {}); }, 5 * 60 * 1000);
        } catch (e: any) {
            logError = e.message ?? String(e);
            follow = false;
        }
    }
    function stopFollow() {
        if (!following) return;
        following = false;
        unsubLog?.(); unsubLog = null;
        if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
        unfollowServiceLogs(h(), a(), instance).catch(() => {});
    }
    function clearLogs() {
        entries = [];
    }

    // first time the Logs tab is shown: tail + follow; the Follow switch drives the follower afterwards
    $effect(() => {
        if (!managed || tab !== 'logs' || logsOpened) return;
        logsOpened = true;
        loadLogs();
    });
    $effect(() => {
        if (!logsOpened) return;
        if (follow) startFollow(); else stopFollow();
    });
    $effect(() => {
        // re-scroll when auto-scroll gets switched on
        if (autoscroll) scrollLogs();
    });

    onMount(() => {
        if (managed) loadConfig();
        return () => stopFollow();
    });

    function fmtDate(ts: number | null | undefined): string { return ts ? new Date(ts).toLocaleString() : '—'; }
    function fmtUptime(): string {
        const m = mqtt;
        if (!m || m.started === null || !(m.connected && m.connected > 0)) return '—';
        const s = Math.max(0, Math.round((Date.now() - m.started) / 1000));
        const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
        return d > 0 ? `${d}d ${hh}h` : hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
    }
    function connLabel(): string {
        const c = mqtt?.connected;
        return c === 2 ? 'online (2)' : c === 1 ? 'device offline (1)' : c === 0 ? 'down (0)' : 'unknown';
    }
</script>

<div class="detail">
    <div class="head">
        <div>
            <span class="title">{instance}</span>
            <span class="sub mono">{adapter ?? (mqtt?.legacy ? 'legacy' : '')}{#if mqtt?.version} @{mqtt.version}{/if} · {host ?? hostname ?? 'not managed'}</span>
            {#if unit}
                <span class="badge" class:ok={unit.active === 'active'} class:err={unit.active === 'failed'} title="systemd: {unit.active}/{unit.sub}, {unit.unitFile}">{unit.active}{unit.unitFile === 'disabled' ? ' · disabled' : ''}</span>
            {/if}
        </div>
        <button class="ghost sm" onclick={onclose}>Close</button>
    </div>
    <div class="tabs">
        {#if managed}
            <button class:active={tab === 'config'} onclick={() => (tab = 'config')}>Config</button>
            <button class:active={tab === 'logs'} onclick={() => (tab = 'logs')}>Logs</button>
        {/if}
        <button class:active={tab === 'info'} onclick={() => (tab = 'info')}>Info</button>
        {#if !managed}<span class="muted tabs-note">{host === null ? 'host not managed — add it under Settings → Services' : 'not installed on a managed host'}</span>{/if}
    </div>

    {#if tab === 'config'}
        <div class="body">
            {#if cfgLoading}
                <div class="muted">Loading /etc/{adapter}/{instance}.env…</div>
            {:else}
                {#if cfgError}<div class="err-box">{cfgError}</div>{/if}
                <SchemaForm {schema} bind:env {secrets} mode="edit" {sheBroker} {dynsec} bind:brokerMode />
                <div class="actions">
                    <button onclick={() => save(false)} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                    <button onclick={() => save(true)} disabled={saving}>Save &amp; restart</button>
                    {#if brokerMode === 'dynsec' && savedMode === 'dynsec'}
                        <button class="ghost" onclick={() => save(true, true)} disabled={saving} title="Set a new random password for the dynsec client and restart the instance">Rotate password</button>
                    {/if}
                    {#if saveMsg}<span class="muted">{saveMsg}</span>{/if}
                </div>
            {/if}
        </div>
    {:else if tab === 'logs'}
        <div class="logbar">
            <select bind:value={filterLevel}>
                {#each LEVELS as l (l)}<option value={l}>{l}</option>{/each}
            </select>
            <input class="filter-in" type="search" placeholder="Filter messages…" bind:value={filterText} />
            <label class="check-label" title="Interpret filter as a regular expression">
                <input type="checkbox" bind:checked={filterRegex} />
                <span class="checkmark"></span> Regex
            </label>
            <label class="check-label" title="Keep receiving new journal lines">
                <input type="checkbox" bind:checked={follow} />
                <span class="checkmark"></span> Follow
            </label>
            <label class="check-label">
                <input type="checkbox" bind:checked={autoscroll} />
                <span class="checkmark"></span> Auto-scroll
            </label>
            <button class="ghost sm" onclick={loadLogs} disabled={logLoading} title="Reload the last 500 journal lines">↺</button>
            <button class="ghost sm" onclick={clearLogs}>Clear</button>
        </div>
        <div class="logmeta">
            <span class="muted mono">journalctl -u {unitName}</span>
            <span class="muted">{visibleEntries.length}{#if visibleEntries.length !== entries.length} / {entries.length}{/if} lines{#if following} · following{/if}</span>
            {#if logError}<span class="err">{logError}</span>{/if}
        </div>
        <div class="log" bind:this={logEl}>
            <!-- unkeyed on purpose: identical lines are legal in a journal stream -->
            {#each visibleEntries as e}
                <div class="line {e.level}"><span class="ts">{fmtLogTs(e.ts)}</span><span class="lvl">{e.level.toUpperCase()}</span><span class="msg">{e.msg}</span></div>
            {/each}
            {#if entries.length === 0 && !logError && !logLoading}<div class="muted empty">No journal entries.</div>{/if}
        </div>
    {:else}
        <div class="body">
            <div class="info-title">MQTT</div>
            {#if mqtt}
                <dl class="kv">
                    <dt>adapter</dt><dd class="mono">{mqtt.adapter ?? '—'}{#if mqtt.version} @{mqtt.version}{/if}{#if mqtt.updateAvailable} <span class="badge-upd" title="npm has {mqtt.latestVersion}">update: {mqtt.latestVersion}</span>{/if}</dd>
                    <dt>connected</dt><dd>{connLabel()}{#if mqtt.connectedLc} · since {fmtDate(mqtt.connectedLc)}{/if}</dd>
                    <dt>uptime</dt><dd>{fmtUptime()}</dd>
                    <dt>host</dt><dd>{mqtt.host ?? '—'}{#if mqtt.pid} · pid {mqtt.pid}{/if}</dd>
                    <dt>spec</dt><dd>{mqtt.spec ?? '—'}</dd>
                    <dt>node</dt><dd>{mqtt.node ?? '—'}</dd>
                    <dt>started</dt><dd>{fmtDate(mqtt.started)}</dd>
                    <dt>maintenance</dt><dd>{mqtt.legacy ? '— (legacy: no maintenance topics)' : mqtt.maintenance ? 'enabled' : 'disabled (--no-maintenance)'}</dd>
                    <dt>status topics</dt><dd>{mqtt.statusTopics} retained under <span class="mono">{instance}/status/</span></dd>
                    <dt>info updated</dt><dd>{fmtDate(mqtt.infoTs)}</dd>
                </dl>
                {#if mqtt.info}
                    <div class="muted" style="margin:6px 0 4px">{instance}/info</div>
                    <pre class="mono json">{JSON.stringify(mqtt.info, null, 2)}</pre>
                {:else}
                    <div class="muted">Legacy instance — only <span class="mono">{instance}/connected</span> is known; no <span class="mono">{instance}/info</span>.</div>
                {/if}
            {:else}
                <div class="muted">Not seen on MQTT (no retained {instance}/connected or {instance}/info yet).</div>
            {/if}

            <div class="info-title" style="margin-top:14px">systemd</div>
            {#if unit}
                <dl class="kv">
                    <dt>unit</dt><dd class="mono">{unit.adapter}@{instance}.service</dd>
                    <dt>host</dt><dd>{host}{#if hostname && hostname !== host} · hostname {hostname}{/if}</dd>
                    <dt>state</dt><dd>{unit.active} / {unit.sub} · {unit.unitFile}</dd>
                    <dt>since</dt><dd>{unit.since || '—'}</dd>
                    <dt>restarts</dt><dd>{unit.restarts}</dd>
                    <dt>env file</dt><dd class="mono">/etc/{unit.adapter}/{instance}.env</dd>
                    <dt>state dir</dt><dd class="mono">/var/lib/{unit.adapter}/{instance}/</dd>
                </dl>
            {:else}
                <div class="muted">{host === null ? 'Not installed on a managed host — or the host is not configured under Settings → Services.' : 'No systemd unit for this instance on the managed host.'}</div>
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
    /* ── logs: same look as the Logs page ── */
    .logbar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--border-sub, var(--border)); background: var(--bg-panel); flex-wrap: wrap; }
    .logbar select { background: var(--bg-input, var(--bg-app)); color: var(--fg); border: 1px solid var(--border); padding: 2px 6px; border-radius: 3px; font-size: 12px; }
    .filter-in { flex: 1; min-width: 120px; max-width: 320px; background: var(--bg-input, var(--bg-app)); color: var(--fg); border: 1px solid var(--border); padding: 2px 6px; border-radius: 3px; font-size: 12px; }
    .check-label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; color: var(--fg-muted); user-select: none; white-space: nowrap; }
    .check-label input[type='checkbox'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .checkmark { flex-shrink: 0; width: 13px; height: 13px; border: 1.5px solid var(--border); border-radius: 3px; background: var(--bg-input, var(--bg-app)); position: relative; transition: background 0.12s, border-color 0.12s; }
    .check-label input:checked + .checkmark { background: var(--accent); border-color: var(--accent); }
    .check-label input:checked + .checkmark::after { content: ''; position: absolute; left: 3px; top: 0; width: 4px; height: 7px; border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg); }
    .check-label:hover .checkmark { border-color: var(--accent); }
    .logmeta { display: flex; align-items: center; gap: 12px; padding: 3px 12px; border-bottom: 1px solid var(--border-sub, var(--border)); }
    .log { flex: 1; overflow-y: auto; padding: 4px 0; font-family: 'Cascadia Code', 'Fira Code', var(--font-mono, monospace); font-size: 12px; }
    .log .empty { padding: 8px 12px; }
    .line { display: flex; gap: 8px; padding: 1px 12px; white-space: pre-wrap; word-break: break-word; }
    .line:hover { background: var(--bg-hover); }
    .line .ts { color: var(--fg-dim, var(--fg-muted)); flex-shrink: 0; }
    .line .lvl { width: 48px; flex-shrink: 0; font-weight: bold; }
    .line.debug .lvl { color: var(--fg-muted); }
    .line.info .lvl { color: #4fc1ff; }
    .line.warn .lvl { color: var(--fg-warn, #d4ac0d); }
    .line.error .lvl { color: var(--fg-err, #e74c3c); }
    .line .msg { color: var(--fg-text, var(--fg)); }
    .info-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-muted); margin-bottom: 6px; }
    .tabs-note { align-self: center; margin-left: 8px; font-size: 11px; }
    .badge-upd { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600; line-height: 16px; background: rgba(241,196,15,0.18); color: #d4ac0d; }
    .kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 10px; font-size: 11px; }
    .kv dt { color: var(--fg-muted); }
    .kv dd { margin: 0; }
    pre.json { margin: 0; max-height: 320px; overflow: auto; background: var(--bg-app); border: 1px solid var(--border); border-radius: 3px; padding: 6px 8px; font-size: 11px; }
</style>
