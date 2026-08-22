<script lang="ts">
    import { onMount } from 'svelte';
    import {
        getServiceInstances, restartServiceInstance, setServiceLogLevel, getServiceRetained, wipeServiceRetained,
        getServiceHosts, serviceUnitAction, uninstallService,
        type ServiceInstance, type ServiceHost, type ServiceHostInstance,
    } from '../../lib/api.js';
    import { subscribeWs } from '../../lib/ws.js';
    import ConfirmDialog from '../../lib/ConfirmDialog.svelte';
    import InstanceDetail from './InstanceDetail.svelte';

    type Status = 'none' | 'ok' | 'warn' | 'err';
    let { onstatus, generation = 0 }: { onstatus?: (status: Status, title: string) => void; generation?: number } = $props();

    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean; alert?: boolean }): Promise<boolean> } = $state(null as any);

    /* ── Data ─────────────────────────────────────────────────────────────── */
    let mqttInstances = $state<ServiceInstance[]>([]);
    let hosts     = $state<ServiceHost[]>([]);
    let loading   = $state(false);
    let loadError = $state<string | null>(null);
    let filter    = $state('');
    // legacy rows (only a <name>/connected topic — ESPHome & co. publish one too) are hidden by default
    const LEGACY_KEY = 'she-services-show-legacy';
    let showLegacy = $state(localStorage.getItem(LEGACY_KEY) === '1');
    $effect(() => { localStorage.setItem(LEGACY_KEY, showLegacy ? '1' : '0'); });
    let expanded  = $state(new Set<string>());
    let busy      = $state(new Set<string>());
    let notice    = $state<string | null>(null);
    let now       = $state(Date.now());

    /** One table row: the MQTT view and/or the systemd view of an instance. */
    type Row = {
        key: string;
        instance: string;
        adapter: string | null;
        mqtt: ServiceInstance | null;
        host: ServiceHost | null;      // configured host the unit lives on (null: not managed)
        unit: ServiceHostInstance | null;
    };

    async function load() {
        loading = true; loadError = null;
        try {
            const [inv, h] = await Promise.all([getServiceInstances(), getServiceHosts().catch(() => ({ hosts: [] as ServiceHost[] }))]);
            mqttInstances = inv.instances;
            hosts = h.hosts;
        } catch (e: unknown) {
            loadError = e instanceof Error ? e.message : String(e);
        } finally {
            loading = false;
        }
    }

    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    function scheduleReload() {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => { reloadTimer = null; load(); }, 400);
    }

    onMount(() => {
        load();
        // retained <x>/info and <x>/connected changes arrive on the mqtt WS feed
        const unsub = subscribeWs('mqtt', (msg) => {
            const t = typeof msg.topic === 'string' ? msg.topic : '';
            const parts = t.split('/');
            if (parts.length === 2 && (parts[1] === 'info' || parts[1] === 'connected')) scheduleReload();
        });
        const tick = setInterval(() => { now = Date.now(); }, 10000);
        return () => { unsub(); clearInterval(tick); if (reloadTimer) clearTimeout(reloadTimer); };
    });

    // host-side changes (update, install, uninstall) from the other tabs
    $effect(() => { if (generation > 0) load(); });

    /* ── Correlation (SV-14): info.host ↔ host.hostname, instance ↔ unit instance ── */
    let rows = $derived.by((): Row[] => {
        const out = new Map<string, Row>();
        for (const m of mqttInstances) {
            out.set(m.instance, { key: m.instance, instance: m.instance, adapter: m.adapter, mqtt: m, host: null, unit: null });
        }
        for (const h of hosts) {
            if (!h.ok) continue;
            for (const u of h.instances ?? []) {
                const existing = out.get(u.instance);
                const sameHost = !existing?.mqtt?.host || existing.mqtt.host === h.hostname || h.local && !existing.mqtt.host;
                if (existing && !existing.unit && (!existing.mqtt || existing.mqtt.adapter === u.adapter || existing.mqtt.legacy) && sameHost) {
                    existing.host = h; existing.unit = u;
                    if (!existing.adapter) existing.adapter = u.adapter;
                } else {
                    const key = `${u.instance}@${h.name}`;
                    out.set(key, { key, instance: u.instance, adapter: u.adapter, mqtt: null, host: h, unit: u });
                }
            }
        }
        return [...out.values()].sort((a, b) => a.instance.localeCompare(b.instance));
    });
    let legacyCount = $derived(rows.filter(r => r.mqtt?.legacy && !r.unit).length);
    // what the table, the counters and the nav dot work on
    let shown = $derived(showLegacy ? rows : rows.filter(r => !(r.mqtt?.legacy && !r.unit)));

    let visible = $derived.by(() => {
        const q = filter.trim().toLowerCase();
        if (!q) return shown;
        return shown.filter(r =>
            r.instance.toLowerCase().includes(q) ||
            (r.adapter ?? '').toLowerCase().includes(q) ||
            (r.mqtt?.host ?? r.host?.hostname ?? '').toLowerCase().includes(q) ||
            (r.mqtt?.version ?? '').toLowerCase().includes(q),
        );
    });
    let updateCount = $derived(mqttInstances.filter(i => i.updateAvailable).length);
    let hostProblems = $derived(hosts.filter(h => !h.ok && h.code !== 'UNSUPPORTED'));

    // Nav dot: worst case — any 0/unknown → err, any 1 → warn, all 2 → ok
    $effect(() => {
        if (!onstatus) return;
        if (shown.length === 0) { onstatus('none', ''); return; }
        const down = shown.filter(r => (r.mqtt ? r.mqtt.connected === 0 || r.mqtt.connected === null : r.unit?.active !== 'active')).map(r => r.instance);
        const half = shown.filter(r => r.mqtt?.connected === 1).map(r => r.instance);
        if (down.length) onstatus('err', `Down: ${down.join(', ')}`);
        else if (half.length) onstatus('warn', `Device offline: ${half.join(', ')}`);
        else onstatus('ok', `${shown.length} service${shown.length === 1 ? '' : 's'} online`);
    });

    /* ── Detail drawer ────────────────────────────────────────────────────── */
    let detail = $state<Row | null>(null);
    function openDetail(r: Row) {
        if (!r.host || !r.unit) return;
        detail = r;
    }
    // keep the drawer's row fresh after reloads
    $effect(() => {
        if (!detail) return;
        const fresh = rows.find(r => r.key === detail!.key);
        if (fresh && fresh !== detail) detail = fresh;
        if (!fresh) detail = null;
    });

    /* ── Actions ──────────────────────────────────────────────────────────── */
    function setBusy(key: string, on: boolean) {
        const s = new Set(busy);
        on ? s.add(key) : s.delete(key);
        busy = s;
    }
    async function run(r: Row, label: string, fn: () => Promise<unknown>, okMsg: string) {
        setBusy(r.key, true); notice = null;
        try {
            await fn();
            notice = okMsg;
            setTimeout(load, 600);
        } catch (e: unknown) {
            notice = `${label} failed: ${e instanceof Error ? e.message : String(e)}`;
        } finally {
            setBusy(r.key, false);
        }
    }

    async function restart(r: Row) {
        if (!await dialog.show(`Restart ${r.instance} (${r.adapter})?`, { confirm: 'Restart' })) return;
        if (r.host && r.unit) {
            return run(r, 'Restart', () => serviceUnitAction(r.host!.name, r.unit!.adapter, r.instance, 'restart'), `systemctl restart ${r.unit.adapter}@${r.instance} on ${r.host.name}.`);
        }
        return run(r, 'Restart', () => restartServiceInstance(r.instance), `Restart requested for ${r.instance} over MQTT.`);
    }
    function unitAction(r: Row, action: 'start' | 'stop' | 'enable' | 'disable') {
        if (!r.host || !r.unit) return;
        return run(r, action, () => serviceUnitAction(r.host!.name, r.unit!.adapter, r.instance, action), `${action}: ${r.unit.adapter}@${r.instance} on ${r.host.name}.`);
    }
    async function loglevel(r: Row, level: string) {
        return run(r, 'Log level', () => setServiceLogLevel(r.instance, level), `${r.instance}: log level ${level} (until the next restart).`);
    }
    async function uninstall(r: Row) {
        if (!r.host || !r.unit) return;
        const ok = await dialog.show(
            `Uninstall ${r.unit.adapter}@${r.instance} from ${r.host.name}? The unit is stopped, disabled and removed together with /etc/${r.unit.adapter}/${r.instance}.env; the state directory /var/lib/${r.unit.adapter}/${r.instance} is kept. Retained MQTT topics can be wiped afterwards.`,
            { confirm: 'Uninstall', danger: true },
        );
        if (!ok) return;
        if (detail?.key === r.key) detail = null;
        return run(r, 'Uninstall', () => uninstallService(r.host!.name, r.unit!.adapter, r.instance), `${r.unit.adapter}@${r.instance} removed from ${r.host.name}.`);
    }
    async function wipe(r: Row) {
        setBusy(r.key, true); notice = null;
        try {
            const plan = await getServiceRetained(r.instance);
            const n = plan.own.length + plan.discovery.length;
            if (n === 0) { notice = `Nothing retained for ${r.instance}.`; return; }
            const ok = await dialog.show(
                `Clear ${n} retained topic${n === 1 ? '' : 's'} of ${r.instance}: ${plan.own.length} status/info/connected` +
                (plan.discovery.length ? ` and ${plan.discovery.length} Home Assistant discovery announcement${plan.discovery.length === 1 ? '' : 's'}` : '') +
                `? Only do this when the instance is gone for good — a running adapter would republish them anyway.`,
                { confirm: 'Clear retained topics', danger: true },
            );
            if (!ok) return;
            const res = await wipeServiceRetained(r.instance, true);
            notice = res.ok ? `Cleared ${res.cleared} retained topics of ${r.instance}.` : `Cleared ${res.cleared}, ${res.errors.length} failed.`;
            setTimeout(load, 400);
        } catch (e: unknown) {
            notice = e instanceof Error ? e.message : String(e);
        } finally {
            setBusy(r.key, false);
        }
    }
    function toggleExpand(key: string) {
        const s = new Set(expanded);
        s.has(key) ? s.delete(key) : s.add(key);
        expanded = s;
    }

    /* ── Helpers ──────────────────────────────────────────────────────────── */
    function connState(r: Row): { cls: 'ok' | 'warn' | 'err' | 'none'; label: string } {
        const m = r.mqtt;
        if (m?.connected === 2) return { cls: 'ok', label: 'online' };
        if (m?.connected === 1) return { cls: 'warn', label: 'device offline' };
        if (m?.connected === 0) return { cls: 'err', label: 'down' };
        if (!m && r.unit) return r.unit.active === 'active' ? { cls: 'warn', label: 'running, not on MQTT' } : { cls: 'err', label: r.unit.active };
        return { cls: 'err', label: 'unknown' };
    }
    function canMaintain(r: Row): boolean {
        return !!r.mqtt && !r.mqtt.legacy && r.mqtt.maintenance && !!r.mqtt.connected && r.mqtt.connected > 0;
    }
    function fmtUptime(r: Row): string {
        const m = r.mqtt;
        if (!m || m.started === null || !(m.connected && m.connected > 0)) return '—';
        const s = Math.max(0, Math.round((now - m.started) / 1000));
        const d = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const mi = Math.floor((s % 3600) / 60);
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${mi}m`;
        return `${mi}m`;
    }
    function fmtAge(ts: number | null): string {
        if (!ts) return '';
        const s = Math.max(0, Math.round((now - ts) / 1000));
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        return `${Math.floor(s / 86400)}d ago`;
    }
    function fmtDate(ts: number | null): string {
        return ts ? new Date(ts).toLocaleString() : '';
    }
</script>

<ConfirmDialog bind:this={dialog} />

<div class="svc" class:with-detail={detail !== null}>
    <div class="main">
        <div class="bar">
            <input class="filter-in" type="search" placeholder="Filter instances…" bind:value={filter} />
            <button class="ghost" onclick={load} disabled={loading} title="Reload">↺</button>
            <span class="count">{visible.length}{#if filter} / {shown.length}{/if} instance{shown.length === 1 ? '' : 's'}{#if updateCount > 0} · {updateCount} update{updateCount === 1 ? '' : 's'} available{/if}</span>
            <label class="chk" title="Topics with only a <name>/connected and no <name>/info — pre-core adapters, but also ESPHome devices and the like">
                <input type="checkbox" bind:checked={showLegacy} />
                <span class="checkmark"></span>
                show legacy ({legacyCount})
            </label>
            <span class="spacer"></span>
            {#if notice}<span class="result">{notice}</span>{/if}
        </div>
        {#if hostProblems.length}
            <div class="bar warn-bar">
                {#each hostProblems as h (h.name)}
                    <span>host <strong>{h.name}</strong>: {h.error}{#if h.code === 'HELPER_MISSING'} — run <code>sudo she --install</code>{/if}</span>
                {/each}
            </div>
        {/if}

        {#if loading && rows.length === 0}
            <div class="info">Loading…</div>
        {:else if loadError}
            <div class="info err">{loadError}</div>
        {:else if shown.length === 0}
            <div class="info">
                No xyz2mqtt services seen{#if legacyCount > 0} — {legacyCount} legacy row{legacyCount === 1 ? '' : 's'} hidden (only a <code>&lt;name&gt;/connected</code> topic; tick <em>show legacy</em>){/if}. Adapters built on
                <a href="https://github.com/hobbyquaker/mqtt-interfaces-core" target="_blank" rel="noopener">mqtt-interfaces-core</a>
                publish a retained <code>&lt;name&gt;/info</code> and <code>&lt;name&gt;/connected</code>; older adapters with only
                <code>&lt;name&gt;/connected</code> show up as <em>legacy</em>. Instances installed on a managed host appear even before they connect.
            </div>
        {:else if visible.length === 0}
            <div class="info">No instances match.</div>
        {:else}
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th class="c-exp"></th>
                            <th>Instance</th>
                            <th>Adapter</th>
                            <th>Host</th>
                            <th>State</th>
                            <th>Uptime</th>
                            <th>Log level</th>
                            <th class="c-act"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each visible as r (r.key)}
                            {@const st = connState(r)}
                            <tr class:down={st.cls === 'err'} class:selected={detail?.key === r.key}>
                                <td class="c-exp">
                                    <button class="exp" onclick={() => toggleExpand(r.key)} title="Show info">{expanded.has(r.key) ? '▾' : '▸'}</button>
                                </td>
                                <td>
                                    <span class="dname">{r.instance}</span>
                                    {#if r.mqtt?.legacy}<span class="badge b-legacy" title="No <name>/info topic — adapter not built on mqtt-interfaces-core">legacy</span>{/if}
                                    {#if !r.mqtt && r.unit}<span class="badge b-legacy" title="Installed on {r.host?.name} but nothing retained on MQTT yet">not on MQTT</span>{/if}
                                </td>
                                <td>
                                    {#if r.adapter}
                                        <span class="mono">{r.adapter}</span>
                                        {#if r.mqtt?.version}<span class="muted"> @{r.mqtt.version}</span>{/if}
                                        {#if r.mqtt?.updateAvailable}<span class="badge b-upd" title="npm has {r.mqtt.latestVersion} — update on the Hosts tab">{r.mqtt.latestVersion}</span>{/if}
                                    {:else}<span class="muted">—</span>{/if}
                                </td>
                                <td>
                                    {r.mqtt?.host ?? r.host?.hostname ?? ''}
                                    {#if r.host}<span class="badge b-host" title="managed via {r.host.name}: systemd {r.unit?.active}/{r.unit?.sub}, {r.unit?.unitFile}">{r.host.name}</span>{/if}
                                    {#if r.mqtt?.pid}<span class="muted"> · pid {r.mqtt.pid}</span>{/if}
                                </td>
                                <td title={r.mqtt?.connectedLc ? 'since ' + fmtDate(r.mqtt.connectedLc) : ''}>
                                    <span class="dot {st.cls}"></span>{st.label}
                                    {#if r.mqtt?.connected === 0 && r.mqtt.connectedLc}<span class="muted"> {fmtAge(r.mqtt.connectedLc)}</span>{/if}
                                    {#if r.unit && r.unit.unitFile === 'disabled'}<span class="muted"> · disabled</span>{/if}
                                </td>
                                <td>{fmtUptime(r)}</td>
                                <td>
                                    {#if canMaintain(r)}
                                        <select class="lvl" disabled={busy.has(r.key)} onchange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) { loglevel(r, v); (e.target as HTMLSelectElement).value = ''; } }}>
                                            <option value="">set…</option>
                                            <option value="error">error</option>
                                            <option value="warn">warn</option>
                                            <option value="info">info</option>
                                            <option value="debug">debug</option>
                                        </select>
                                    {:else if r.mqtt && !r.mqtt.legacy && !r.mqtt.maintenance}
                                        <span class="muted" title="--no-maintenance">disabled</span>
                                    {:else}<span class="muted">—</span>{/if}
                                </td>
                                <td class="c-act">
                                    {#if r.host && r.unit}
                                        <button class="ghost sm" onclick={() => openDetail(r)} disabled={busy.has(r.key)}>Config / Logs</button>
                                        {#if r.unit.active === 'active'}
                                            <button class="ghost sm" onclick={() => restart(r)} disabled={busy.has(r.key)}>Restart</button>
                                            <button class="ghost sm" onclick={() => unitAction(r, 'stop')} disabled={busy.has(r.key)}>Stop</button>
                                        {:else}
                                            <button class="ghost sm" onclick={() => unitAction(r, 'start')} disabled={busy.has(r.key)}>Start</button>
                                        {/if}
                                        {#if r.unit.unitFile === 'disabled'}
                                            <button class="ghost sm" onclick={() => unitAction(r, 'enable')} disabled={busy.has(r.key)} title="Start at boot">Enable</button>
                                        {/if}
                                        <button class="ghost sm danger-text" onclick={() => uninstall(r)} disabled={busy.has(r.key)}>Uninstall</button>
                                    {:else if canMaintain(r)}
                                        <button class="ghost sm" onclick={() => restart(r)} disabled={busy.has(r.key)} title="via {r.instance}/maintenance/set/restart">Restart</button>
                                    {/if}
                                    {#if r.mqtt && !r.mqtt.connected}
                                        <button class="ghost sm" onclick={() => wipe(r)} disabled={busy.has(r.key)} title="Clear the instance's retained topics">Wipe</button>
                                    {/if}
                                </td>
                            </tr>
                            {#if expanded.has(r.key)}
                                <tr class="detail-row">
                                    <td colspan="8">
                                        {#if r.mqtt?.info}
                                            <dl class="kv">
                                                <dt>spec</dt><dd>{r.mqtt.spec ?? '—'}</dd>
                                                <dt>node</dt><dd>{r.mqtt.node ?? '—'}</dd>
                                                <dt>started</dt><dd>{fmtDate(r.mqtt.started)}</dd>
                                                <dt>maintenance</dt><dd>{r.mqtt.maintenance ? 'enabled' : 'disabled'}</dd>
                                                <dt>status topics</dt><dd>{r.mqtt.statusTopics}</dd>
                                                <dt>info updated</dt><dd>{fmtDate(r.mqtt.infoTs)}</dd>
                                                {#if r.unit}<dt>systemd</dt><dd>{r.unit.active} / {r.unit.sub} · {r.unit.unitFile} · {r.unit.restarts} restarts</dd>{/if}
                                            </dl>
                                            <pre class="mono json">{JSON.stringify(r.mqtt.info, null, 2)}</pre>
                                        {:else if r.mqtt}
                                            <span class="muted">Legacy instance — only <code>{r.instance}/connected</code> is known ({r.mqtt.statusTopics} retained status topics).</span>
                                        {:else if r.unit}
                                            <dl class="kv">
                                                <dt>unit</dt><dd class="mono">{r.unit.adapter}@{r.instance}.service</dd>
                                                <dt>systemd</dt><dd>{r.unit.active} / {r.unit.sub} · {r.unit.unitFile} · {r.unit.restarts} restarts</dd>
                                                <dt>since</dt><dd>{r.unit.since || '—'}</dd>
                                            </dl>
                                        {/if}
                                    </td>
                                </tr>
                            {/if}
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}
    </div>

    {#if detail && detail.host && detail.unit}
        {#key detail.key}
            <div class="drawer">
                <InstanceDetail host={detail.host.name} adapter={detail.unit.adapter} instance={detail.instance} unit={detail.unit} mqtt={detail.mqtt}
                    onclose={() => (detail = null)} onchanged={() => setTimeout(load, 600)} />
            </div>
        {/key}
    {/if}
</div>

<style>
    .svc { flex: 1; display: flex; overflow: hidden; }
    .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
    .drawer { width: 46%; min-width: 380px; max-width: 720px; display: flex; flex-direction: column; overflow: hidden; }

    .bar {
        display: flex; align-items: center; gap: 8px;
        padding: 5px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0;
        font-size: 12px; color: var(--fg);
    }
    .warn-bar { background: rgba(230,126,34,0.10); color: #e67e22; flex-wrap: wrap; }
    .warn-bar code { color: var(--accent); }
    .spacer { flex: 1; }
    .filter-in {
        background: var(--bg-app); border: 1px solid var(--border); color: var(--fg);
        padding: 3px 6px; font-size: 12px; border-radius: 3px; width: 220px;
    }
    .count, .muted { color: var(--fg-muted); font-size: 11px; white-space: nowrap; }
    /* themed checkbox — same pattern as the MQTT / HA discovery views */
    .chk { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fg-muted); cursor: pointer; user-select: none; white-space: nowrap; }
    .chk input[type='checkbox'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .chk .checkmark { flex-shrink: 0; width: 13px; height: 13px; border: 1.5px solid var(--border); border-radius: 2px; background: var(--bg-app); position: relative; transition: background 0.12s, border-color 0.12s; }
    .chk input:checked + .checkmark { background: var(--accent); border-color: var(--accent); }
    .chk input:checked + .checkmark::after { content: ''; position: absolute; left: 3px; top: 0; width: 4px; height: 7px; border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg); }
    .chk:hover .checkmark { border-color: var(--accent); }
    .result { color: var(--fg-muted); font-size: 11px; white-space: normal; }

    button {
        background: var(--accent); border: none; color: #fff;
        padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer;
    }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    button.sm { padding: 1px 7px; font-size: 11px; margin-left: 4px; }
    button.danger-text:hover:not(:disabled) { color: #e74c3c; border-color: #e74c3c; }
    button.exp { background: none; border: none; color: var(--fg-muted); padding: 0 4px; font-size: 11px; }

    .info { padding: 16px; color: var(--fg-muted); font-size: 12px; line-height: 1.5; }
    .info.err { color: #e74c3c; }
    .info code { color: var(--accent); }
    .info a { color: var(--accent); }

    .table-wrap { flex: 1; overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; color: var(--fg); }
    th {
        text-align: left; font-weight: 600; font-size: 11px; color: var(--fg-muted);
        padding: 5px 8px; border-bottom: 1px solid var(--border); position: sticky; top: 0;
        background: var(--bg-app); white-space: nowrap;
    }
    td { padding: 5px 8px; border-bottom: 1px solid var(--border-sub, var(--border)); vertical-align: top; white-space: nowrap; }
    tr.down .dname { color: #e74c3c; }
    tr.selected td { background: rgba(86,156,214,0.08); }
    .c-exp { width: 24px; text-align: center; }
    .c-act { text-align: right; white-space: nowrap; }
    .dname { font-weight: 600; display: inline-block; margin-right: 6px; }
    .mono { font-family: var(--font-mono, monospace); font-size: 11px; }

    .badge {
        display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600;
        margin-left: 4px; line-height: 16px;
    }
    .b-legacy { background: rgba(127,140,141,0.2); color: var(--fg-muted); }
    .b-upd { background: rgba(241,196,15,0.18); color: #d4ac0d; }
    .b-host { background: rgba(86,156,214,0.15); color: var(--accent); }

    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--fg-muted); vertical-align: middle; }
    .dot.ok { background: #27ae60; }
    .dot.warn { background: #f1c40f; }
    .dot.err { background: #e74c3c; }

    select.lvl {
        background: var(--bg-app); color: var(--fg); border: 1px solid var(--border);
        border-radius: 3px; font-size: 11px; padding: 1px 4px;
    }

    .detail-row > td { background: var(--bg-panel); padding: 8px 8px 10px 32px; white-space: normal; }
    .kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 8px; font-size: 11px; }
    .kv dt { color: var(--fg-muted); }
    .kv dd { margin: 0; }
    pre.json { margin: 0; max-height: 240px; overflow: auto; background: var(--bg-app); border: 1px solid var(--border); border-radius: 3px; padding: 6px 8px; }
</style>
