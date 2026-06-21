<script lang="ts">
    import { onMount } from 'svelte';
    import { getBrokerConf, putBrokerConf, brokerReload, type BrokerConf } from '../../lib/api.js';

    let conf = $state<BrokerConf | null>(null);
    let loadError = $state('');
    let saving = $state(false);
    let saveError = $state('');
    let saveOk = $state(false);
    let reloading = $state(false);
    let reloadMsg = $state('');
    let checksum = $state<string | null>(null);

    // Local copies of managed keys
    let maxConnections     = $state('');
    let maxInflight        = $state('');
    let maxQueued          = $state('');
    let maxPacketSize      = $state('');
    let messageSizeLimit   = $state('');
    let maxKeepalive       = $state('');
    let persistentExpiry   = $state('');
    let retainAvailable    = $state('');   // 'true' | 'false' | ''
    let tcpNodelay         = $state('');   // 'true' | 'false' | ''
    let connectionMessages = $state('');   // 'true' | 'false' | ''

    // log_dest / log_type — multi-value (stored as Set for UI)
    const LOG_DEST_OPTIONS = ['file', 'stdout', 'stderr', 'syslog', 'topic', 'none'] as const;

    // log_type grouped for UI display
    const LOG_TYPE_SEVERITY = ['error', 'warning', 'notice', 'information', 'debug'] as const;
    const LOG_TYPE_EVENTS   = ['connect', 'disconnect', 'subscribe', 'unsubscribe', 'publish', 'receive', 'websockets'] as const;
    const LOG_TYPE_OTHER    = ['all'] as const;
    const LOG_TYPE_OPTIONS  = [...LOG_TYPE_SEVERITY, ...LOG_TYPE_EVENTS, ...LOG_TYPE_OTHER] as const;

    let logDest = $state<Set<string>>(new Set());
    let logType = $state<Set<string>>(new Set());

    function toggleSet(s: Set<string>, v: string): Set<string> {
        const n = new Set(s); n.has(v) ? n.delete(v) : n.add(v); return n;
    }

    function m(key: string): string {
        if (!conf) return '';
        const v = conf.managed[key];
        return Array.isArray(v) ? v[0] : (v ?? '');
    }

    function mSet(key: string): Set<string> {
        if (!conf) return new Set();
        const v = conf.managed[key];
        if (!v) return new Set();
        return new Set(Array.isArray(v) ? v : [v]);
    }

    onMount(() => load());

    async function load() {
        try {
            conf = await getBrokerConf();
            checksum = conf.checksum;
            maxConnections     = m('max_connections');
            maxInflight        = m('max_inflight_messages');
            maxQueued          = m('max_queued_messages');
            maxPacketSize      = m('max_packet_size');
            messageSizeLimit   = m('message_size_limit');
            maxKeepalive       = m('max_keepalive');
            persistentExpiry   = m('persistent_client_expiration');
            retainAvailable    = m('retain_available');
            tcpNodelay         = m('set_tcp_nodelay');
            connectionMessages = m('connection_messages');
            logDest = mSet('log_dest');
            logType = mSet('log_type');
            loadError = '';
        } catch (e: any) {
            loadError = e.message ?? 'Failed to load config';
        }
    }

    async function save() {
        if (!conf) return;
        saving = true;
        saveError = '';
        saveOk = false;
        try {
            const managed = { ...conf.managed };
            function set(key: string, val: string) {
                if (val !== '') managed[key] = val; else delete managed[key];
            }
            set('max_connections',            maxConnections);
            set('max_inflight_messages',       maxInflight);
            set('max_queued_messages',         maxQueued);
            set('max_packet_size',             maxPacketSize);
            set('message_size_limit',          messageSizeLimit);
            set('max_keepalive',               maxKeepalive);
            set('persistent_client_expiration',persistentExpiry);
            set('retain_available',            retainAvailable);
            set('set_tcp_nodelay',             tcpNodelay);
            set('connection_messages',         connectionMessages);
            // multi-value keys
            if (logDest.size > 0) managed['log_dest'] = logDest.size === 1 ? [...logDest][0] : [...logDest];
            else delete managed['log_dest'];
            if (logType.size > 0) managed['log_type'] = logType.size === 1 ? [...logType][0] : [...logType];
            else delete managed['log_type'];
            await putBrokerConf({ listeners: conf.listeners, managed, passthrough: conf.passthrough, checksum });
            saveOk = true;
            setTimeout(() => (saveOk = false), 3000);
            await load();
        } catch (e: any) {
            saveError = e.message ?? 'Save failed';
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
</script>

<div class="config-page">
    <div class="page-header">
        <h3>Global config</h3>
        <div class="header-actions">
            <button class="btn-save" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            <button class="btn-reload" onclick={reload} disabled={reloading}>{reloading ? 'Reloading…' : 'Apply & Reload'}</button>
        </div>
    </div>

    {#if loadError}<div class="err">{loadError}</div>{/if}
    {#if saveError}<div class="err">{saveError}</div>{/if}
    {#if saveOk}<div class="ok">Saved.</div>{/if}
    {#if reloadMsg}<div class="reload-msg">{reloadMsg}</div>{/if}

    {#if conf}
    <!-- ── Logging ──────────────────────────────────────────────────────── -->
    <div class="section">
        <h4>Logging</h4>
        <div class="field">
            <span class="field-key">log_dest</span>
            <div class="checkbox-group">
                {#each LOG_DEST_OPTIONS as opt}
                <label class="check-label">
                    <input type="checkbox" checked={logDest.has(opt)} onchange={() => { logDest = toggleSet(logDest, opt); }} />
                    {opt}
                </label>
                {/each}
            </div>
            <p class="hint">Log destinations. Enable <code>topic</code> to stream logs to <code>$SYS/broker/log/*</code> and view them in the Logs tab. <code>none</code> disables logging entirely.</p>
        </div>
        <div class="field">
            <span class="field-key">log_type</span>
            <div class="log-type-grid">
                <div class="log-type-group">
                    <span class="log-type-group-label">Severity</span>
                    {#each LOG_TYPE_SEVERITY as opt}
                    <label class="check-label">
                        <input type="checkbox" checked={logType.has(opt)} onchange={() => { logType = toggleSet(logType, opt); }} />
                        {opt}
                    </label>
                    {/each}
                </div>
                <div class="log-type-group">
                    <span class="log-type-group-label">Events</span>
                    {#each LOG_TYPE_EVENTS as opt}
                    <label class="check-label">
                        <input type="checkbox" checked={logType.has(opt)} onchange={() => { logType = toggleSet(logType, opt); }} />
                        {opt}
                    </label>
                    {/each}
                </div>
                <div class="log-type-group log-type-group--other">
                    {#each LOG_TYPE_OTHER as opt}
                    <label class="check-label">
                        <input type="checkbox" checked={logType.has(opt)} onchange={() => { logType = toggleSet(logType, opt); }} />
                        <strong>{opt}</strong>
                    </label>
                    {/each}
                    <span class="all-hint">enables all types above</span>
                </div>
            </div>
            <p class="hint">Types of messages to log. Leave all unchecked to use the broker default.</p>
        </div>
    </div>

    <!-- ── Connection limits ─────────────────────────────────────────────── -->
    <div class="section">
        <h4>Connection limits</h4>
        <div class="field-grid">
            <div class="field">
                <label>
                    <span>max_connections</span>
                    <input bind:value={maxConnections} placeholder="−1 (unlimited)" />
                </label>
                <p class="hint">Maximum simultaneous client connections. <code>-1</code> = unlimited.</p>
            </div>
            <div class="field">
                <label>
                    <span>max_keepalive</span>
                    <input bind:value={maxKeepalive} placeholder="65535" />
                </label>
                <p class="hint">Maximum keepalive value (seconds) a client may request. <code>0</code> = unlimited.</p>
            </div>
            <div class="field">
                <label>
                    <span>max_inflight_messages</span>
                    <input bind:value={maxInflight} placeholder="20" />
                </label>
                <p class="hint">Max simultaneous unacknowledged QoS 1/2 messages per client.</p>
            </div>
            <div class="field">
                <label>
                    <span>max_queued_messages</span>
                    <input bind:value={maxQueued} placeholder="100" />
                </label>
                <p class="hint">Max messages queued for a disconnected persistent client.</p>
            </div>
        </div>
    </div>

    <!-- ── Packet / payload size ─────────────────────────────────────────── -->
    <div class="section">
        <h4>Packet &amp; payload size</h4>
        <div class="field-grid">
            <div class="field">
                <label>
                    <span>max_packet_size</span>
                    <input bind:value={maxPacketSize} placeholder="0 (no limit)" />
                </label>
                <p class="hint">Maximum MQTT packet size in bytes (MQTT v5 only). <code>0</code> = no limit.</p>
            </div>
            <div class="field">
                <label>
                    <span>message_size_limit</span>
                    <input bind:value={messageSizeLimit} placeholder="0 (no limit)" />
                </label>
                <p class="hint">Maximum payload size in bytes for published messages. <code>0</code> = no limit.</p>
            </div>
        </div>
    </div>

    <!-- ── Sessions & persistence ────────────────────────────────────────── -->
    <div class="section">
        <h4>Sessions &amp; persistence</h4>
        <div class="field-grid">
            <div class="field">
                <label>
                    <span>persistent_client_expiration</span>
                    <input bind:value={persistentExpiry} placeholder="e.g. 7d, 2h, 30m" />
                </label>
                <p class="hint">Expire persistent sessions after this duration. Suffix: <code>d</code>/<code>h</code>/<code>m</code>/<code>s</code>. Empty = never expire.</p>
            </div>
            <div class="field">
                <label>
                    <span>retain_available</span>
                    <select bind:value={retainAvailable}>
                        <option value="">auto (broker default)</option>
                        <option value="true">true — allow retained messages</option>
                        <option value="false">false — disable retained messages globally</option>
                    </select>
                </label>
                <p class="hint">Disable retained messages broker-wide.</p>
            </div>
        </div>
    </div>

    <!-- ── Performance ─────────────────────────────────────────────────── -->
    <div class="section">
        <h4>Performance</h4>
        <div class="field-grid">
            <div class="field">
                <label>
                    <span>set_tcp_nodelay</span>
                    <select bind:value={tcpNodelay}>
                        <option value="">auto (broker default)</option>
                        <option value="true">true — disable Nagle (lower latency)</option>
                        <option value="false">false — enable Nagle</option>
                    </select>
                </label>
                <p class="hint">Disable Nagle's algorithm to reduce latency at the cost of slightly more packets.</p>
            </div>
            <div class="field">
                <label>
                    <span>connection_messages</span>
                    <select bind:value={connectionMessages}>
                        <option value="">auto (broker default)</option>
                        <option value="true">true — log connect/disconnect</option>
                        <option value="false">false — suppress</option>
                    </select>
                </label>
                <p class="hint">Log a message on every client connect and disconnect.</p>
            </div>
        </div>
    </div>
    {/if}
</div>

<style>
    .config-page {
        padding: 14px 16px;
        overflow: auto;
        height: 100%;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 16px;
    }

    .page-header { display: flex; align-items: center; gap: 10px; }
    .page-header h3 { margin: 0; font-size: 13px; color: var(--text-muted, #aaa); text-transform: uppercase; letter-spacing: 0.04em; }
    .header-actions { display: flex; gap: 6px; margin-left: auto; }
    .header-actions button { background: none; border: 1px solid var(--border, #444); border-radius: 4px; color: var(--text-muted, #aaa); cursor: pointer; font-size: 12px; padding: 4px 10px; }
    .btn-save  { background: var(--accent-dim, rgba(86,156,214,0.15)) !important; border-color: rgba(86,156,214,0.35) !important; color: var(--accent, #569cd6) !important; }
    .btn-reload { }

    .section {
        background: var(--surface, #1e1e1e);
        border: 1px solid var(--border, #333);
        border-radius: 6px;
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
    }
    .section h4 { margin: 0; font-size: 11px; font-weight: 600; color: var(--text-muted, #aaa); text-transform: uppercase; letter-spacing: 0.04em; }

    .field-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
    .field { display: flex; flex-direction: column; gap: 4px; }

    .field label { display: flex; flex-direction: column; gap: 3px; }
    .field label span { font-size: 11px; color: var(--text-muted, #999); font-family: monospace; }

    input:not([type='checkbox']), select {
        background: var(--input-bg, #2a2a2a);
        border: 1px solid var(--border, #444);
        border-radius: 4px;
        color: var(--text, #eee);
        font-size: 12px;
        padding: 4px 8px;
    }

    .hint { margin: 0; font-size: 10.5px; color: var(--text-muted, #777); line-height: 1.4; }
    .hint code { font-size: 10px; background: rgba(255,255,255,0.06); border-radius: 2px; padding: 0 3px; }

    .field-key { font-size: 11px; color: var(--text-muted, #999); font-family: monospace; display: block; margin-bottom: 5px; }

    .checkbox-group { display: flex; flex-wrap: wrap; gap: 5px 16px; margin-bottom: 2px; }
    .check-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text, #ddd); cursor: pointer; font-family: monospace; user-select: none; }
    .check-label input[type='checkbox'] { accent-color: var(--accent, #569cd6); width: 14px; height: 14px; cursor: pointer; flex-shrink: 0; }

    .log-type-grid { display: flex; flex-direction: column; gap: 8px; }
    .log-type-group { display: flex; flex-wrap: wrap; gap: 5px 16px; }
    .log-type-group-label { font-size: 10px; font-weight: 600; color: var(--text-muted, #666); text-transform: uppercase; letter-spacing: 0.06em; width: 100%; margin-bottom: 1px; }
    .log-type-group--other { display: flex; align-items: center; gap: 12px; border-top: 1px solid var(--border, #333); padding-top: 8px; }
    .all-hint { font-size: 11px; color: var(--text-muted, #666); font-style: italic; }

    .err  { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.3); border-radius: 4px; color: #e88; font-size: 12px; padding: 6px 10px; }
    .ok   { background: rgba(70,180,70,0.1); border: 1px solid rgba(70,180,70,0.25); border-radius: 4px; color: #8c8; font-size: 12px; padding: 6px 10px; }
    .reload-msg { font-size: 12px; color: var(--text-muted, #aaa); padding: 4px 0; white-space: pre-wrap; }
</style>
