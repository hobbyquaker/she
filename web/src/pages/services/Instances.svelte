<script lang="ts">
    import { onMount, untrack } from 'svelte';
    import {
        getServiceInstances, restartServiceInstance, setServiceLogLevel, getServiceRetained, wipeServiceRetained,
        getServiceHosts, serviceUnitAction, uninstallService, migrateServiceLegacy, LEGACY_INSTANCE,
        type ServiceInstance, type ServiceHost, type ServiceHostInstance,
    } from '../../lib/api.js';
    import InputDialog from '../../lib/InputDialog.svelte';
    import { subscribeWs } from '../../lib/ws.js';
    import ConfirmDialog from '../../lib/ConfirmDialog.svelte';
    import MultiSelect from '../../lib/MultiSelect.svelte';
    import InstanceDetail from './InstanceDetail.svelte';

    type Status = 'none' | 'ok' | 'warn' | 'err';
    let {
        onstatus,
        generation = 0,
        origin = null,
        onchanged,
    }: {
        onstatus?: (status: Status, title: string) => void;
        generation?: number;
        /** which tab made the change — this one does not reload its own work */
        origin?: string | null;
        onchanged?: () => void;
    } = $props();

    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean; alert?: boolean }): Promise<boolean> } = $state(null as any);

    /* ── Data ─────────────────────────────────────────────────────────────── */
    let mqttInstances = $state<ServiceInstance[]>([]);
    let hosts     = $state<ServiceHost[]>([]);
    let loading   = $state(false);
    let loadError = $state<string | null>(null);
    let filter    = $state('');
    // unmanaged rows (only a <name>/connected topic — ESPHome & co. publish one too) are hidden by default
    const UNMANAGED_KEY = 'she-services-show-legacy'; // key kept: it holds the same preference
    let showUnmanaged = $state(localStorage.getItem(UNMANAGED_KEY) === '1');
    $effect(() => { localStorage.setItem(UNMANAGED_KEY, showUnmanaged ? '1' : '0'); });
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
        legacy?: boolean;              // unit is a pre-core <adapter>.service (instance "-" towards the helper)
    };

    // the WS feed reloads in the background on every retained change — only an explicit
    // refresh turns the glyph, otherwise it would flicker on every message
    let refreshing = $state(false);
    async function load(refresh = false) {
        loading = true; refreshing = refreshing || refresh; loadError = null;
        try {
            const [inv, h] = await Promise.all([getServiceInstances(), getServiceHosts(refresh).catch(() => ({ hosts: [] as ServiceHost[] }))]);
            mqttInstances = inv.instances;
            hosts = h.hosts;
        } catch (e: unknown) {
            loadError = e instanceof Error ? e.message : String(e);
        } finally {
            loading = false; refreshing = false;
        }
    }

    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    function scheduleReload() {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => { reloadTimer = null; load(); }, 400);
    }

    onMount(() => {
        load();
        // retained <x>/info and <x>/connected changes arrive on the mqtt WS feed (host listing stays cached)
        const unsub = subscribeWs('mqtt', (msg) => {
            const t = typeof msg.topic === 'string' ? msg.topic : '';
            const parts = t.split('/');
            if (parts.length === 2 && (parts[1] === 'info' || parts[1] === 'connected')) scheduleReload();
        });
        const tick = setInterval(() => { now = Date.now(); }, 10000);
        return () => { unsub(); clearInterval(tick); if (reloadTimer) clearTimeout(reloadTimer); };
    });

    // host-side changes (update, install, a host added or removed) from the other tabs.
    // Guarded and untracked on purpose: load() reads state it also writes, so an unguarded
    // effect would keep re-triggering itself (see subnav-routing.test.js for the same trap).
    let seenGeneration = 0;
    $effect(() => {
        const g = generation;
        if (g === seenGeneration) return;
        seenGeneration = g;
        untrack(() => { if (origin !== 'instances') load(true); });
    });

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
            // pre-core single-instance units: match the MQTT instance of the same adapter on that host
            for (const l of h.legacy ?? []) {
                const unit: ServiceHostInstance = { adapter: l.adapter, instance: LEGACY_INSTANCE, active: l.active, sub: l.sub, unitFile: l.unitFile, since: l.since, restarts: l.restarts };
                const match = [...out.values()].find(r => !r.unit && r.mqtt && r.mqtt.adapter === l.adapter && (!r.mqtt.host || r.mqtt.host === h.hostname));
                if (match) {
                    match.host = h; match.unit = unit; match.legacy = true;
                } else {
                    const key = `${l.adapter}.service@${h.name}`;
                    out.set(key, { key, instance: l.adapter, adapter: l.adapter, mqtt: null, host: h, unit, legacy: true });
                }
            }
        }
        return [...out.values()].sort((a, b) => a.instance.localeCompare(b.instance));
    });
    let unmanagedCount = $derived(rows.filter(r => r.mqtt?.legacy && !r.unit).length);

    /* ── Sorting and per-column filters (instance, adapter, host, state) ───── */
    type SortKey = 'instance' | 'adapter' | 'host' | 'state';
    let sortKey = $state<SortKey>('instance');
    let sortDir = $state<1 | -1>(1);
    function toggleSort(k: SortKey) {
        if (sortKey === k) sortDir = sortDir === 1 ? -1 : 1;
        else { sortKey = k; sortDir = 1; }
    }
    let fInstance = $state('');
    let fAdapter  = $state('');
    let fHosts    = $state<string[]>([]);
    let fStates   = $state<string[]>([]);
    const colFiltered = $derived(!!fInstance || !!fAdapter || fHosts.length > 0 || fStates.length > 0);

    const hostOf  = (r: Row) => r.mqtt?.host ?? r.host?.hostname ?? r.host?.name ?? '';
    const stateOf = (r: Row) => connState(r).label;
    /* worst first, so one click on State brings what needs attention to the top */
    const SEVERITY = { err: 0, warn: 1, ok: 2, none: 3 } as const;

    // what the table, the counters and the nav dot work on
    let shown = $derived(showUnmanaged ? rows : rows.filter(r => !(r.mqtt?.legacy && !r.unit)));
    let hostOptions    = $derived([...new Set(shown.map(hostOf).filter(Boolean))].sort((a, b) => a.localeCompare(b)));
    let stateOptions   = $derived([...new Set(shown.map(stateOf))].sort((a, b) => a.localeCompare(b)));

    let visible = $derived.by(() => {
        const q = filter.trim().toLowerCase();
        const qi = fInstance.trim().toLowerCase();
        let out = shown;
        if (q) {
            out = out.filter(r =>
                r.instance.toLowerCase().includes(q) ||
                (r.adapter ?? '').toLowerCase().includes(q) ||
                (r.mqtt?.host ?? r.host?.hostname ?? '').toLowerCase().includes(q) ||
                (r.mqtt?.version ?? '').toLowerCase().includes(q),
            );
        }
        const qa = fAdapter.trim().toLowerCase();
        if (qi) out = out.filter(r => r.instance.toLowerCase().includes(qi));
        if (qa) out = out.filter(r => (r.adapter ?? '').toLowerCase().includes(qa));
        if (fHosts.length)  out = out.filter(r => fHosts.includes(hostOf(r)));
        if (fStates.length) out = out.filter(r => fStates.includes(stateOf(r)));

        const cmp = (a: Row, b: Row) => {
            switch (sortKey) {
                case 'adapter': return (a.adapter ?? '').localeCompare(b.adapter ?? '');
                case 'host':    return hostOf(a).localeCompare(hostOf(b));
                case 'state': {
                    const d = SEVERITY[connState(a).cls] - SEVERITY[connState(b).cls];
                    return d !== 0 ? d : stateOf(a).localeCompare(stateOf(b));
                }
                default: return 0;
            }
        };
        // instance is the tie-breaker everywhere, so rows never jump around between equal keys
        return [...out].sort((a, b) => (cmp(a, b) || a.instance.localeCompare(b.instance)) * sortDir);
    });
    let hostProblems = $derived(hosts.filter(h => !h.ok && h.code !== 'UNSUPPORTED'));

    // The action column is only as wide as the widest row's buttons: a width sized for the
    // worst case (every action at once) leaves a hole in front of every ordinary row and pushes
    // the table into a horizontal scroll. Measured after each render, since which buttons a row
    // shows depends on its state — and measured from the buttons themselves, because the strip
    // around them is stretched by whatever width the column happens to have.
    const ACT_GAP = 4; // .acts gap
    const ACT_PAD = 16; // td padding, left + right
    let tableEl: HTMLTableElement | null = $state(null);
    let actWidth = $state(0);
    $effect(() => {
        void visible; // re-measure whenever the rows change
        const table = tableEl;
        if (!table) return;
        let max = 0;
        for (const strip of table.querySelectorAll<HTMLElement>('.acts')) {
            const buttons = [...strip.children];
            if (!buttons.length) continue;
            const w = buttons.reduce((sum, b) => sum + b.getBoundingClientRect().width, 0)
                + ACT_GAP * (buttons.length - 1);
            max = Math.max(max, w);
        }
        if (max) actWidth = Math.ceil(max) + ACT_PAD;
    });

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
    // only the key is state; the row is derived so it is always the fresh one after a reload
    // (holding the row object in $state would proxy it and never compare equal → effect loop)
    let detailKey = $state<string | null>(null);
    let detailTab = $state<'config' | 'files' | 'logs' | 'info'>('config');
    let detail = $derived(detailKey === null ? null : (rows.find(r => r.key === detailKey) ?? null));
    function openDetail(r: Row) {
        detailKey = r.key;
    }
    // drawer width — draggable, remembered (same pattern as the Scripts page panels)
    const DRAWER_KEY = 'she-services-drawer-width';
    let drawerWidth = $state(Math.max(360, Math.min(1200, Number(localStorage.getItem(DRAWER_KEY)) || 560)));
    let drawerResizing = $state(false);
    let drawerStartX = 0;
    let drawerStartW = 0;
    function onDrawerResizeStart(e: MouseEvent) { drawerResizing = true; drawerStartX = e.clientX; drawerStartW = drawerWidth; e.preventDefault(); }
    function onWinMouseMove(e: MouseEvent) {
        if (!drawerResizing) return;
        drawerWidth = Math.max(360, Math.min(Math.max(360, window.innerWidth - 320), drawerStartW - (e.clientX - drawerStartX)));
    }
    function onWinMouseUp() {
        if (!drawerResizing) return;
        drawerResizing = false;
        localStorage.setItem(DRAWER_KEY, String(drawerWidth));
    }

    /* ── Actions ──────────────────────────────────────────────────────────── */
    function setBusy(key: string, on: boolean) {
        const s = new Set(busy);
        on ? s.add(key) : s.delete(key);
        busy = s;
    }
    async function run(r: Row, label: string, fn: () => Promise<unknown>, okMsg: string, { tellOthers = false } = {}) {
        setBusy(r.key, true); notice = null;
        try {
            await fn();
            notice = okMsg;
            setTimeout(load, 600);
            // an instance that came or went changes what the other tabs list, too
            if (tellOthers) onchanged?.();
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
    let inputDialog: { show(msg: string, opts?: { placeholder?: string; initial?: string; confirm?: string }): Promise<string | null> } = $state(null as any);
    async function migrate(r: Row) {
        if (!r.host || !r.unit || !r.legacy) return;
        const name = await inputDialog.show(
            `Turn ${r.unit.adapter}.service into a proper instance ${r.unit.adapter}@<name>. The adapter's own --install runs with the current settings (state such as logins or pairing keys is carried over by the adapter), then the old unit is disabled and its files are kept as .migrated. Instance name = the MQTT topic prefix:`,
            { initial: r.mqtt?.instance ?? '', placeholder: 'instance name', confirm: 'Migrate' },
        );
        if (!name) return;
        return run(r, 'Migrate', () => migrateServiceLegacy(r.host!.name, r.unit!.adapter, name.trim()), `${r.unit.adapter}.service migrated to ${r.unit.adapter}@${name.trim()} on ${r.host.name}.`, { tellOthers: true });
    }
    async function uninstall(r: Row) {
        if (!r.host || !r.unit) return;
        const ok = await dialog.show(
            `Uninstall ${r.unit.adapter}@${r.instance} from ${r.host.name}? The unit is stopped, disabled and removed together with /etc/${r.unit.adapter}/${r.instance}.env; the state directory /var/lib/${r.unit.adapter}/${r.instance} is kept. Retained MQTT topics can be wiped afterwards.`,
            { confirm: 'Uninstall', danger: true },
        );
        if (!ok) return;
        if (detailKey === r.key) detailKey = null;
        return run(r, 'Uninstall', () => uninstallService(r.host!.name, r.unit!.adapter, r.instance), `${r.unit.adapter}@${r.instance} removed from ${r.host.name}.`, { tellOthers: true });
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
    function fmtBytes(b: number): string {
        if (b < 1024 * 1024) return `${Math.round(b / 1024)} kB`;
        if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
        return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }
    function fmtDate(ts: number | null): string {
        return ts ? new Date(ts).toLocaleString() : '';
    }
</script>

{#snippet sortable(key: SortKey, label: string)}
    <button class="sort" class:on={sortKey === key} onclick={() => toggleSort(key)}>
        {label}<span class="arrow">{sortKey === key ? (sortDir === 1 ? '▲' : '▼') : ''}</span>
    </button>
{/snippet}

<!-- one glyph per action: the row's buttons differ in width, so the icon carries the recognition -->
{#snippet icon(name: 'config' | 'info' | 'restart' | 'start' | 'stop' | 'enable' | 'migrate' | 'wipe' | 'uninstall')}
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        {#if name === 'config'}
            <line x1="2" y1="5" x2="14" y2="5" /><circle cx="6" cy="5" r="1.8" fill="var(--bg-app)" />
            <line x1="2" y1="11" x2="14" y2="11" /><circle cx="10.5" cy="11" r="1.8" fill="var(--bg-app)" />
        {:else if name === 'info'}
            <circle cx="8" cy="8" r="6.2" /><line x1="8" y1="7.4" x2="8" y2="11" /><line x1="8" y1="4.9" x2="8" y2="4.9" />
        {:else if name === 'restart'}
            <path d="M13 8A5 5 0 1 1 10.5 3.67" /><polyline points="10.5,1.4 10.5,4 13.1,4" />
        {:else if name === 'start'}
            <path d="M5 3.2 12.5 8 5 12.8Z" fill="currentColor" />
        {:else if name === 'stop'}
            <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
        {:else if name === 'enable'}
            <line x1="8" y1="2" x2="8" y2="7.5" /><path d="M11.9 4.4a5.5 5.5 0 1 1-7.8 0" />
        {:else if name === 'migrate'}
            <line x1="2" y1="8" x2="11.5" y2="8" /><polyline points="8,4.5 11.5,8 8,11.5" /><path d="M13.5 3v10" />
        {:else if name === 'wipe'}
            <line x1="2.5" y1="4.2" x2="13.5" y2="4.2" /><path d="M6 4.2V2.6h4v1.6" /><path d="M4.2 4.2 4.9 13.4h6.2l.7-9.2" />
        {:else if name === 'uninstall'}
            <line x1="3" y1="3" x2="13" y2="13" /><line x1="13" y1="3" x2="3" y2="13" />
        {/if}
    </svg>
{/snippet}

<ConfirmDialog bind:this={dialog} />
<InputDialog bind:this={inputDialog} />
<svelte:window onmousemove={onWinMouseMove} onmouseup={onWinMouseUp} />

<div class="svc" class:with-detail={detail !== null} class:resizing={drawerResizing}>
    <div class="main">
        <div class="bar">
            <input class="filter-in" type="search" placeholder="Filter instances…" bind:value={filter} />
            <button class="ghost" onclick={() => load(true)} disabled={loading} title="Reload, asking every host again"><span class:spinning={refreshing}>↺</span></button>
            <span class="count">{visible.length}{#if filter || colFiltered} / {shown.length}{/if} instance{shown.length === 1 ? '' : 's'}</span>
            {#if colFiltered}
                <button class="ghost sm" onclick={() => { fInstance = ''; fAdapter = ''; fHosts = []; fStates = []; }} title="Clear the column filters">clear filters</button>
            {/if}
            <label class="chk" title="Topics with only a <name>/connected and no <name>/info — pre-core adapters, but also ESPHome devices and the like">
                <input type="checkbox" bind:checked={showUnmanaged} />
                <span class="checkmark"></span>
                show unmanaged ({unmanagedCount})
            </label>
            <span class="bar-hint">To add an instance click <em>+ instance</em> on the Installations tab</span>
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
                No xyz2mqtt services seen{#if unmanagedCount > 0} — {unmanagedCount} unmanaged row{unmanagedCount === 1 ? '' : 's'} hidden (only a <code>&lt;name&gt;/connected</code> topic; tick <em>show unmanaged</em>){/if}. Adapters built on
                <a href="https://github.com/hobbyquaker/mqtt-interfaces-core" target="_blank" rel="noopener">mqtt-interfaces-core</a>
                publish a retained <code>&lt;name&gt;/info</code> and <code>&lt;name&gt;/connected</code>; anything publishing just
                <code>&lt;name&gt;/connected</code> — an ESPHome device, a script, a pre-core adapter — shows up as <em>unmanaged</em>. Instances installed on a managed host appear even before they connect.
            </div>
        {:else if visible.length === 0}
            <div class="info">No instances match.</div>
        {:else}
            <div class="table-wrap">
                <table bind:this={tableEl}>
                    <!-- fixed widths: neither a filter nor the detail drawer may move the columns -->
                    <colgroup>
                        <col class="w-inst" /><col class="w-adapter" /><col class="w-host" /><col class="w-state" />
                        <col class="w-up" /><col class="w-mem" /><col class="w-cpu" /><col class="w-ell" />
                        <col class="w-lvl" /><col class="w-act" style:width={actWidth ? `${actWidth}px` : null} />
                        <!-- auto width: in a fixed layout this column takes whatever is left over,
                             so a window wider than the table does not stretch the real columns -->
                        <col />
                    </colgroup>
                    <thead>
                        <tr>
                            <th>{@render sortable('instance', 'Instance')}</th>
                            <th>{@render sortable('adapter', 'Adapter')}</th>
                            <th>{@render sortable('host', 'Host')}</th>
                            <th title="Sorted worst first: down, then device offline, then online">{@render sortable('state', 'State')}</th>
                            <th class="c-up">Uptime</th>
                            <th class="num c-mem" title="resident memory — reported by the adapter (core 0.8+) or by systemd on the host">Mem</th>
                            <th class="num c-cpu" title="share of one core — reported by the adapter over its stats interval, or from systemd between two host listings">CPU</th>
                            <th class="num c-ell" title="event loop lag — the peak the adapter measured over its stats interval (core 0.8+); no systemd fallback">EL lag</th>
                            <th>Log level</th>
                            <th class="c-act"></th>
                            <th class="w-fill"></th>
                        </tr>
                        <tr class="filter-row">
                            <th><input class="col-f" type="search" placeholder="filter…" bind:value={fInstance} aria-label="Filter by instance" /></th>
                            <th><input class="col-f" type="search" placeholder="filter…" bind:value={fAdapter} aria-label="Filter by adapter" /></th>
                            <th><MultiSelect bind:selected={fHosts} options={hostOptions} noun="hosts" title="Show only these hosts" /></th>
                            <th><MultiSelect bind:selected={fStates} options={stateOptions} noun="states" title="Show only these states" /></th>
                            <th colspan="7"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each visible as r (r.key)}
                            {@const st = connState(r)}
                            {@const ps = r.mqtt?.stats}
                            <tr class:down={st.cls === 'err'} class:selected={detail?.key === r.key}>
                                <td>
                                    <button class="dname dname-link" onclick={() => openDetail(r)} title={r.host && r.unit ? `Config, logs and info of ${r.instance}` : `Info of ${r.instance}`}>{r.instance}</button>
                                    {#if r.mqtt?.legacy && r.host}<span class="badge b-legacy" title="Only a <name>/connected topic and no <name>/info — version, uptime and stats stay unknown">no info</span>{/if}
                                    {#if r.legacy}<span class="badge b-upd" title="Runs as {r.unit?.adapter}.service (pre-core unit, env in /etc/default) — migrate it to a template instance">old unit</span>{/if}
                                    {#if !r.mqtt && r.unit}<span class="badge b-legacy" title="Installed on {r.host?.name} but nothing retained on MQTT yet">not on MQTT</span>{/if}
                                </td>
                                <td>
                                    {#if r.adapter}
                                        <span class="mono">{r.adapter}</span>
                                    {:else}<span class="muted">—</span>{/if}
                                </td>
                                <td>
                                    {r.mqtt?.host ?? r.host?.hostname ?? ''}
                                    <!-- managed is the normal case and stays unmarked; the pill calls out what she cannot act on -->
                                    {#if r.host}
                                        {#if (r.host.hostname ?? r.host.name) !== (r.mqtt?.host ?? r.host.hostname)}<span class="badge b-host" title="managed via {r.host.name}: systemd {r.unit?.active}/{r.unit?.sub}, {r.unit?.unitFile}">{r.host.hostname ?? r.host.name}</span>{/if}
                                    {:else}<span class="badge b-unmanaged" title={r.mqtt?.legacy ? 'Only a <name>/connected topic — she sees it come and go, nothing more (ESPHome devices and the like publish one too)' : 'The host this runs on is not configured on the Hosts tab — no systemd control, no logs, no config from here'}>unmanaged</span>{/if}
                                    {#if r.mqtt?.pid}<span class="muted"> · pid {r.mqtt.pid}</span>{/if}
                                </td>
                                <td title={r.mqtt?.connectedLc ? 'since ' + fmtDate(r.mqtt.connectedLc) : ''}>
                                    <span class="dot {st.cls}"></span>{st.label}
                                    {#if r.mqtt?.connected === 0 && r.mqtt.connectedLc}<span class="muted"> {fmtAge(r.mqtt.connectedLc)}</span>{/if}
                                    {#if r.unit && r.unit.unitFile === 'disabled'}<span class="muted"> · disabled</span>{/if}
                                </td>
                                <td class="c-up">{fmtUptime(r)}</td>
                                <td class="num c-mem" title={ps ? `adapter: rss ${fmtBytes(ps.rss)}${ps.heapUsed ? `, heap ${fmtBytes(ps.heapUsed)}` : ''}${ps.heapTotal ? ` of ${fmtBytes(ps.heapTotal)}` : ''} (${fmtAge(ps.receivedTs)})` : r.unit?.memory ? `systemd on ${r.host?.hostname ?? r.host?.name}: MemoryCurrent` : ''}>{ps ? fmtBytes(ps.rss) : r.unit?.memory ? fmtBytes(r.unit.memory) : '—'}</td>
                                <td class="num c-cpu" title={ps && ps.cpu !== undefined ? `adapter: ${ps.cpu} % of one core over its stats interval` : r.unit?.cpu !== undefined && r.unit?.cpu !== null ? `systemd on ${r.host?.hostname ?? r.host?.name}: since the previous listing` : ''}>{ps && ps.cpu !== undefined ? `${ps.cpu} %` : r.unit?.cpu !== undefined && r.unit?.cpu !== null ? `${r.unit.cpu} %` : '—'}</td>
                                <td class="num c-ell" class:hot={(ps?.eventLoopLag ?? 0) >= 100} title={ps && ps.eventLoopLag !== undefined ? `adapter: peak event loop lag over its stats interval (${fmtAge(ps.receivedTs)})` : ''}>{ps && ps.eventLoopLag !== undefined ? `${ps.eventLoopLag} ms` : '—'}</td>
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
                                <!-- the actions pack against the right edge with one gap between them;
                                     the icon, not the column position, says which button is which.
                                     start/restart and stop/wipe share a width, so the button an
                                     inactive row shows lines up with the one it replaces above -->
                                <td class="c-act">
                                    <span class="acts">
                                        {#if r.host && r.unit}
                                            <button class="ghost sm" onclick={() => openDetail(r)} disabled={busy.has(r.key)}>{@render icon('config')}<span class="lbl">Config / Logs</span></button>
                                        {:else}
                                            <button class="ghost sm" onclick={() => openDetail(r)} disabled={busy.has(r.key)}>{@render icon('info')}<span class="lbl">Info</span></button>
                                        {/if}
                                        {#if r.host && r.unit && r.unit.active === 'active'}
                                            <button class="ghost sm w-run" onclick={() => restart(r)} disabled={busy.has(r.key)}>{@render icon('restart')}<span class="lbl">Restart</span></button>
                                        {:else if r.host && r.unit}
                                            <button class="ghost sm w-run" onclick={() => unitAction(r, 'start')} disabled={busy.has(r.key)}>{@render icon('start')}<span class="lbl">Start</span></button>
                                        {:else if canMaintain(r)}
                                            <button class="ghost sm w-run" onclick={() => restart(r)} disabled={busy.has(r.key)} title="via {r.instance}/maintenance/set/restart">{@render icon('restart')}<span class="lbl">Restart</span></button>
                                        {/if}
                                        {#if r.host && r.unit && r.unit.active === 'active'}
                                            <button class="ghost sm w-halt" onclick={() => unitAction(r, 'stop')} disabled={busy.has(r.key)}>{@render icon('stop')}<span class="lbl">Stop</span></button>
                                        {/if}
                                        {#if r.host && r.unit && r.unit.unitFile === 'disabled'}
                                            <button class="ghost sm" onclick={() => unitAction(r, 'enable')} disabled={busy.has(r.key)} title="Start at boot">{@render icon('enable')}<span class="lbl">Enable</span></button>
                                        {:else if r.legacy && r.unit}
                                            <button class="ghost sm" onclick={() => migrate(r)} disabled={busy.has(r.key)} title="Turn the old {r.unit.adapter}.service into {r.unit.adapter}@<name>">{@render icon('migrate')}<span class="lbl">Migrate</span></button>
                                        {/if}
                                        {#if r.mqtt && !r.mqtt.connected}
                                            <button class="ghost sm w-halt" onclick={() => wipe(r)} disabled={busy.has(r.key)} title="Clear the instance's retained topics">{@render icon('wipe')}<span class="lbl">Wipe</span></button>
                                        {/if}
                                        {#if r.host && r.unit && !r.legacy}
                                            <button class="ghost sm danger-text" onclick={() => uninstall(r)} disabled={busy.has(r.key)}>{@render icon('uninstall')}<span class="lbl">Uninstall</span></button>
                                        {/if}
                                    </span>
                                </td>
                                <td class="w-fill"></td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}
    </div>

    {#if detail}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="drawer-resize-handle" role="separator" aria-orientation="vertical" onmousedown={onDrawerResizeStart}></div>
        {#key detail.key}
            <div class="drawer" style:width={`${drawerWidth}px`}>
                <InstanceDetail host={detail.host?.name ?? null} adapter={detail.adapter} instance={detail.legacy ? LEGACY_INSTANCE : detail.instance} label={detail.instance} unit={detail.unit} mqtt={detail.mqtt} legacy={detail.legacy === true}
                    hostname={detail.mqtt?.host ?? detail.host?.hostname ?? null}
                    bind:tab={detailTab} onclose={() => (detailKey = null)} onchanged={() => setTimeout(load, 600)} />
            </div>
        {/key}
    {/if}
</div>

<style>
    .svc { flex: 1; display: flex; overflow: hidden; }
    .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
    .drawer { flex-shrink: 0; display: flex; flex-direction: column; overflow: hidden; }
    .drawer-resize-handle { width: 5px; cursor: col-resize; flex-shrink: 0; background: var(--border-sub, var(--border)); transition: background 0.15s; }
    .drawer-resize-handle:hover, .drawer-resize-handle:active, .svc.resizing .drawer-resize-handle { background: var(--accent); }
    .svc.resizing { user-select: none; cursor: col-resize; }

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
    /* where the thing this tab cannot do itself is done */
    .bar-hint { color: var(--fg-muted); font-size: 11px; }
    .bar-hint em { font-style: normal; color: var(--fg); }

    button {
        background: var(--accent); border: none; color: #fff;
        padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer;
    }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    button.sm { padding: 1px 7px; font-size: 11px; margin-left: 4px; }
    button.danger-text:hover:not(:disabled) { color: #e74c3c; border-color: #e74c3c; }

    .info { padding: 16px; color: var(--fg-muted); font-size: 12px; line-height: 1.5; }
    .info.err { color: #e74c3c; }
    .info code { color: var(--accent); }
    .info a { color: var(--accent); }

    .table-wrap { flex: 1; overflow: auto; }
    /* the reload glyph turns while the listing is being fetched — same as the Catalog tab */
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinning { display: inline-block; animation: spin 0.8s linear infinite; }
    table {
        border-collapse: collapse;
        font-size: 12px;
        color: var(--fg);
        /* fixed layout + explicit widths: the columns stay put whatever is filtered away, and
           the drawer squeezes the wrapper into a scroll instead of re-laying out the table */
        table-layout: fixed;
        width: max-content;
        min-width: 100%;
    }
    .w-inst { width: 200px; }
    .w-adapter { width: 150px; }
    .w-host { width: 180px; }
    .w-state { width: 150px; }
    .w-up { width: 74px; }
    .w-mem { width: 74px; }
    .w-cpu { width: 62px; }
    .w-ell { width: 74px; }
    .w-lvl { width: 84px; }
    .w-act { width: 528px; } /* replaced by the measured width once the rows are laid out */
    .w-fill { padding: 0; }
    td { overflow: hidden; text-overflow: ellipsis; }
    th {
        text-align: left; font-weight: 600; font-size: 11px; color: var(--fg-muted);
        padding: 5px 8px; border-bottom: 1px solid var(--border); position: sticky; top: 0;
        background: var(--bg-app); white-space: nowrap; height: 26px;
    }

    /* sort + filter header: the filter row sticks right below the label row */
    .sort {
        background: none; border: none; padding: 0; cursor: pointer;
        font: inherit; color: inherit; display: inline-flex; align-items: center; gap: 4px;
    }
    .sort:hover { color: var(--fg); }
    .sort.on { color: var(--fg-text); }
    .arrow { font-size: 8px; }

    .filter-row th { top: 26px; padding: 3px 6px 5px; height: auto; font-weight: 400; }
    .col-f {
        width: 100%; min-width: 70px; max-width: 160px;
        background: var(--bg-input); border: 1px solid var(--border); border-radius: 3px;
        color: var(--fg); font-size: 11px; padding: 2px 4px;
    }
    .col-f:focus { outline: 1px solid var(--fg-brand); }
    td { padding: 5px 8px; border-bottom: 1px solid var(--border-sub, var(--border)); vertical-align: top; white-space: nowrap; }
    tr.down .dname { color: #e74c3c; }
    tr.selected td { background: rgba(86,156,214,0.08); }
    .c-act { text-align: right; white-space: nowrap; }
    .acts { display: flex; justify-content: flex-end; gap: 4px; }
    /* [icon][label]: the icon keeps the same inset in every button, the label is centred in
       what is left, so a button widened to match its pair grows around the text, not the icon */
    .acts button.sm { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 5px; margin: 0; flex: none; }
    .acts button.sm svg { opacity: 0.85; }
    .acts button.sm .lbl { text-align: center; }
    /* the pairs that swap with the unit state keep a common width so they align down the table */
    .acts button.w-run { min-width: 72px; }
    .acts button.w-halt { min-width: 62px; }
    .dname { font-weight: 600; display: inline-block; margin-right: 6px; }
    /* managed instances: the name opens / switches the drawer */
    button.dname-link { background: none; border: none; padding: 0; font: inherit; font-weight: 600; color: var(--fg); cursor: pointer; text-align: left; }
    button.dname-link:hover { color: var(--accent); text-decoration: underline; }
    tr.selected button.dname-link { color: var(--accent); }
    .mono { font-family: var(--font-mono, monospace); font-size: 11px; }

    .badge {
        display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600;
        margin-left: 4px; line-height: 16px;
    }
    .b-legacy { background: rgba(127,140,141,0.2); color: var(--fg-muted); }
    .b-upd { background: rgba(241,196,15,0.18); color: #d4ac0d; }
    .b-host { background: rgba(86,156,214,0.15); color: var(--accent); }
    .b-unmanaged { background: rgba(127,140,141,0.2); color: var(--fg-muted); }

    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--fg-muted); vertical-align: middle; }
    .dot.ok { background: #27ae60; }
    .dot.warn { background: #f1c40f; }
    .dot.err { background: #e74c3c; }

    select.lvl {
        background: var(--bg-app); color: var(--fg); border: 1px solid var(--border);
        border-radius: 3px; font-size: 11px; padding: 1px 4px;
    }

    th.num, td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    /* values that tick (uptime, mem, cpu, lag) get a fixed width so the table stops reflowing on every stats update */
    /* event loop lag past 100 ms — the adapter's loop was blocked that long */
    td.num.hot { color: #d4ac0d; }
</style>
