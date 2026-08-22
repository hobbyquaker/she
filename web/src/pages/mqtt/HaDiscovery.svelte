<script lang="ts">
    import { onMount } from 'svelte';
    import { fetchHaDiscovery, clearHaDiscoveryTopics, type HaDevice } from '../../lib/api.js';

    /* ── Data ─────────────────────────────────────────────────────────────── */
    let prefix    = $state('homeassistant');
    let devices   = $state<HaDevice[]>([]);
    let entityCount = $state(0);
    let loading   = $state(false);
    let loadError = $state<string | null>(null);
    let filter    = $state('');
    let expanded  = $state(new Set<string>());
    let selected  = $state(new Set<string>());

    async function load() {
        loading = true; loadError = null;
        try {
            const r = await fetchHaDiscovery(prefix);
            devices = r.devices;
            entityCount = r.entityCount;
            // drop selections that vanished
            const ids = new Set(devices.map(d => d.id));
            selected = new Set([...selected].filter(id => ids.has(id)));
        } catch (e: unknown) {
            loadError = e instanceof Error ? e.message : String(e);
            devices = [];
        } finally {
            loading = false;
        }
    }
    onMount(load);

    /* ── Derived ──────────────────────────────────────────────────────────── */
    let visible = $derived.by(() => {
        const q = filter.trim().toLowerCase();
        if (!q) return devices;
        return devices.filter(d =>
            (d.name ?? '').toLowerCase().includes(q) ||
            d.id.toLowerCase().includes(q) ||
            d.identifiers.some(i => i.toLowerCase().includes(q)) ||
            (d.model ?? '').toLowerCase().includes(q) ||
            (d.manufacturer ?? '').toLowerCase().includes(q) ||
            d.statePrefixes.some(p => p.toLowerCase().includes(q)) ||
            d.configTopics.some(t => t.toLowerCase().includes(q)),
        );
    });
    let orphanCount = $derived(devices.filter(d => d.orphaned).length);
    let dupCount    = $derived(devices.filter(d => d.duplicate).length);
    let selectedDevices = $derived(devices.filter(d => selected.has(d.id)));
    let allVisibleSelected = $derived(visible.length > 0 && visible.every(d => selected.has(d.id)));

    function toggleSel(id: string) {
        const s = new Set(selected);
        s.has(id) ? s.delete(id) : s.add(id);
        selected = s;
    }
    function toggleAllVisible() {
        const s = new Set(selected);
        if (allVisibleSelected) for (const d of visible) s.delete(d.id);
        else for (const d of visible) s.add(d.id);
        selected = s;
    }
    function selectOrphaned() {
        selected = new Set(devices.filter(d => d.orphaned).map(d => d.id));
    }
    function toggleExpand(id: string) {
        const s = new Set(expanded);
        s.has(id) ? s.delete(id) : s.add(id);
        expanded = s;
    }

    /* ── Delete modal ─────────────────────────────────────────────────────── */
    type Plan = { devices: HaDevice[]; configTopics: string[]; stateTopics: string[]; clearState: boolean; showConfig: boolean; showState: boolean };
    let plan = $state<Plan | null>(null);
    let busy = $state(false);
    let result = $state<string | null>(null);

    function openDelete(devs: HaDevice[], onlyConfigTopics?: string[]) {
        const configTopics = onlyConfigTopics ?? [...new Set(devs.flatMap(d => d.configTopics))].sort();
        const stateTopics = onlyConfigTopics ? [] : [...new Set(devs.flatMap(d => d.stateTopics))].sort();
        plan = { devices: devs, configTopics, stateTopics, clearState: stateTopics.length > 0, showConfig: false, showState: false };
    }

    async function confirmDelete() {
        if (!plan) return;
        const topics = [...plan.configTopics, ...(plan.clearState ? plan.stateTopics : [])];
        busy = true; result = null;
        try {
            const r = await clearHaDiscoveryTopics(topics);
            result = r.ok
                ? `Cleared ${r.cleared} retained topic${r.cleared === 1 ? '' : 's'}.`
                : `Cleared ${r.cleared}, ${r.errors.length} failed: ${r.errors.map(e => e.topic + ' (' + e.error + ')').join(', ')}`;
            plan = null;
            selected = new Set();
            // the broker echoes the empty retained publishes back; give it a moment before re-reading state
            setTimeout(load, 400);
        } catch (e: unknown) {
            result = e instanceof Error ? e.message : String(e);
        } finally {
            busy = false;
        }
    }

    /* ── Helpers ──────────────────────────────────────────────────────────── */
    function fmtAge(ts: number | null): string {
        if (!ts) return '—';
        const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        return `${Math.floor(s / 86400)}d ago`;
    }
    function fmtDate(ts: number | null): string {
        return ts ? new Date(ts).toLocaleString() : '';
    }
</script>

<div class="ha">
    <div class="bar">
        <label class="pl">
            <span>Discovery prefix</span>
            <input type="text" bind:value={prefix} onchange={load} spellcheck="false" />
        </label>
        <button class="ghost" onclick={load} disabled={loading} title="Reload">↺</button>
        <input class="filter-in" type="search" placeholder="Filter devices…" bind:value={filter} />
        <span class="count" title="devices / entities">{visible.length}{#if filter} / {devices.length}{/if} devices · {entityCount} entities</span>
    </div>

    <div class="bar actions">
        <button class="ghost" onclick={selectOrphaned} disabled={orphanCount === 0} title="Select every device whose state topics no longer exist">
            Select orphaned ({orphanCount})
        </button>
        {#if dupCount > 0}
            <span class="hint">{dupCount} device{dupCount === 1 ? '' : 's'} with duplicate names</span>
        {/if}
        <span class="spacer"></span>
        {#if result}<span class="result">{result}</span>{/if}
        <button class="danger" onclick={() => openDelete(selectedDevices)} disabled={selectedDevices.length === 0}>
            Delete selected ({selectedDevices.length})
        </button>
    </div>

    {#if loading && devices.length === 0}
        <div class="info">Loading…</div>
    {:else if loadError}
        <div class="info err">{loadError}</div>
    {:else if devices.length === 0}
        <div class="info">No discovery announcements found under <code>{prefix}/</code>.</div>
    {:else if visible.length === 0}
        <div class="info">No devices match.</div>
    {:else}
        <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th class="c-check">
                            <label class="chk" title="Select all visible">
                                <input type="checkbox" checked={allVisibleSelected} onchange={toggleAllVisible} />
                                <span class="checkmark"></span>
                            </label>
                        </th>
                        <th class="c-exp"></th>
                        <th>Device</th>
                        <th>Model</th>
                        <th class="c-num">Entities</th>
                        <th>Topic prefix</th>
                        <th>Last seen</th>
                        <th>Status</th>
                        <th class="c-act"></th>
                    </tr>
                </thead>
                <tbody>
                    {#each visible as d (d.id)}
                        <tr class:sel={selected.has(d.id)} class:orph={d.orphaned}>
                            <td class="c-check">
                                <label class="chk">
                                    <input type="checkbox" checked={selected.has(d.id)} onchange={() => toggleSel(d.id)} />
                                    <span class="checkmark"></span>
                                </label>
                            </td>
                            <td class="c-exp">
                                <button class="exp" onclick={() => toggleExpand(d.id)} title="Show entities">{expanded.has(d.id) ? '▾' : '▸'}</button>
                            </td>
                            <td>
                                <div class="dname">{d.name ?? d.id}</div>
                                <div class="dsub" title={d.identifiers.join(', ')}>{d.identifiers.join(', ') || d.id}</div>
                            </td>
                            <td>
                                {#if d.manufacturer}<span class="muted">{d.manufacturer}</span>{/if}{#if d.manufacturer && d.model}{' '}{/if}{d.model ?? ''}
                            </td>
                            <td class="c-num">{d.entities.length}</td>
                            <td class="mono" title={d.statePrefixes.join('\n')}>
                                {#if d.statePrefixes.length === 0}<span class="muted">—</span>
                                {:else}{d.statePrefixes[0]}{#if d.statePrefixes.length > 1} <span class="muted">+{d.statePrefixes.length - 1}</span>{/if}{/if}
                            </td>
                            <td title={fmtDate(d.lastSeen)}>{fmtAge(d.lastSeen)}</td>
                            <td>
                                {#if d.orphaned}<span class="badge b-orph" title="None of the device's state topics exist any more">orphaned</span>{/if}
                                {#if d.duplicate}<span class="badge b-dup" title="Another device with the same name exists">duplicate</span>{/if}
                                {#if !d.orphaned && !d.duplicate}<span class="muted">ok</span>{/if}
                            </td>
                            <td class="c-act">
                                <button class="ghost sm" onclick={() => openDelete([d])}>Delete</button>
                            </td>
                        </tr>
                        {#if expanded.has(d.id)}
                            <tr class="ent-row">
                                <td colspan="9">
                                    <table class="ent">
                                        <thead>
                                            <tr><th>Component</th><th>Entity</th><th>Config topic</th><th>Referenced topics</th><th></th></tr>
                                        </thead>
                                        <tbody>
                                            {#each d.entities as e (e.configTopic + '|' + e.objectId)}
                                                <tr>
                                                    <td>{e.component}</td>
                                                    <td>{e.name}<div class="dsub mono">{e.uniqueId ?? e.objectId}</div></td>
                                                    <td class="mono">{e.configTopic}</td>
                                                    <td class="mono">{#each e.topics as t (t)}<div>{t}</div>{/each}</td>
                                                    <td class="c-act"><button class="ghost sm" onclick={() => openDelete([d], [e.configTopic])} title="Clear only this announcement">Clear</button></td>
                                                </tr>
                                            {/each}
                                        </tbody>
                                    </table>
                                    {#if d.stateTopics.length > 0}
                                        <div class="st-list">
                                            <span class="muted">State topics that would be wiped with the device ({d.stateTopics.length}):</span>
                                            <div class="mono">{#each d.stateTopics as t (t)}<div>{t}</div>{/each}</div>
                                        </div>
                                    {/if}
                                </td>
                            </tr>
                        {/if}
                    {/each}
                </tbody>
            </table>
        </div>
    {/if}

    {#if plan}
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="modal-bd" onclick={() => { if (!busy) plan = null; }}></div>
        <div class="modal">
            <div class="modal-title">Delete discovery announcements</div>
            <div class="modal-body">
                <p>
                    {#if plan.devices.length === 1}
                        Device <strong>{plan.devices[0].name ?? plan.devices[0].id}</strong>
                    {:else}
                        <strong>{plan.devices.length} devices</strong>
                    {/if}
                    — clears <strong>{plan.configTopics.length}</strong> retained config topic{plan.configTopics.length === 1 ? '' : 's'}.
                </p>
                <button class="link" onclick={() => (plan!.showConfig = !plan!.showConfig)}>{plan.showConfig ? '▾' : '▸'} show config topics</button>
                {#if plan.showConfig}
                    <div class="topic-list mono">{#each plan.configTopics as t (t)}<div>{t}</div>{/each}</div>
                {/if}

                {#if plan.stateTopics.length > 0}
                    <label class="modal-check">
                        <input type="checkbox" bind:checked={plan.clearState} />
                        <span class="checkmark"></span>
                        Also clear the device's state and availability topics ({plan.stateTopics.length})
                    </label>
                    <button class="link" onclick={() => (plan!.showState = !plan!.showState)}>{plan.showState ? '▾' : '▸'} show state topics</button>
                    {#if plan.showState}
                        <div class="topic-list mono">{#each plan.stateTopics as t (t)}<div>{t}</div>{/each}</div>
                    {/if}
                {:else if plan.devices.length > 0 && plan.devices.every(d => d.stateTopics.length === 0)}
                    <label class="modal-check disabled" title="No device-specific topic prefix could be derived from the announcements, or no retained state topics exist">
                        <input type="checkbox" disabled />
                        <span class="checkmark"></span>
                        Also clear state topics — none found
                    </label>
                {/if}
            </div>
            <div class="modal-footer">
                <button class="btn-cancel" onclick={() => (plan = null)} disabled={busy}>Cancel</button>
                <button class="btn-confirm" onclick={confirmDelete} disabled={busy}>
                    {busy ? 'Clearing…' : `Clear ${plan.configTopics.length + (plan.clearState ? plan.stateTopics.length : 0)} topics`}
                </button>
            </div>
        </div>
    {/if}
</div>

<style>
    .ha { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

    .bar {
        display: flex; align-items: center; gap: 8px;
        padding: 5px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0;
        font-size: 12px; color: var(--fg);
    }
    .bar.actions { background: var(--bg-panel); }
    .spacer { flex: 1; }
    .pl { display: flex; align-items: center; gap: 6px; color: var(--fg-muted); white-space: nowrap; }
    .pl input, .filter-in {
        background: var(--bg-app); border: 1px solid var(--border); color: var(--fg);
        padding: 3px 6px; font-size: 12px; border-radius: 3px;
    }
    .pl input { width: 140px; font-family: var(--font-mono, monospace); }
    .filter-in { flex: 1; min-width: 120px; }
    .count, .hint, .muted { color: var(--fg-muted); font-size: 11px; white-space: nowrap; }
    .result { color: var(--fg-muted); font-size: 11px; }

    button {
        background: var(--accent); border: none; color: #fff;
        padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer;
    }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    button.sm { padding: 1px 7px; font-size: 11px; }
    button.danger { background: #c0392b; }
    button.danger:hover:not(:disabled) { background: #e74c3c; }
    button.link { background: none; border: none; color: var(--accent); padding: 0; font-size: 11px; text-align: left; }
    button.exp { background: none; border: none; color: var(--fg-muted); padding: 0 4px; font-size: 11px; }

    .info { padding: 16px; color: var(--fg-muted); font-size: 12px; }
    .info.err { color: #e74c3c; }
    .info code { color: var(--accent); }

    .table-wrap { flex: 1; overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; color: var(--fg); }
    th {
        text-align: left; font-weight: 600; font-size: 11px; color: var(--fg-muted);
        padding: 5px 8px; border-bottom: 1px solid var(--border); position: sticky; top: 0;
        background: var(--bg-app); white-space: nowrap;
    }
    td { padding: 5px 8px; border-bottom: 1px solid var(--border-sub, var(--border)); vertical-align: top; }
    tr.sel td { background: rgba(86,156,214,0.08); }
    tr.orph .dname { color: #e67e22; }
    .c-check, .c-exp { width: 24px; text-align: center; }
    .c-num { text-align: right; }
    .c-act { text-align: right; white-space: nowrap; }
    .dname { font-weight: 600; }
    .dsub { font-size: 10px; color: var(--fg-muted); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mono { font-family: var(--font-mono, monospace); font-size: 11px; }

    .badge {
        display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600;
        margin-right: 4px; line-height: 16px;
    }
    .b-orph { background: rgba(230,126,34,0.18); color: #e67e22; }
    .b-dup  { background: rgba(241,196,15,0.18); color: #d4ac0d; }

    .ent-row > td { background: var(--bg-panel); padding: 6px 8px 8px 32px; }
    table.ent th { position: static; background: none; }
    table.ent td { border-bottom: 1px solid var(--border-sub, var(--border)); }
    .st-list { margin-top: 8px; font-size: 11px; }
    .st-list .mono { max-height: 120px; overflow: auto; margin-top: 2px; }

    /* ── Modal (same look as the MQTT page's clear-retained modal) ── */
    .modal-bd { position: fixed; inset: 0; z-index: 110; background: rgba(0, 0, 0, 0.4); }
    .modal {
        position: fixed; z-index: 111; top: 50%; left: 50%; transform: translate(-50%, -50%);
        background: var(--bg-panel); border: 1px solid var(--border); border-radius: 6px;
        min-width: 360px; max-width: 560px; max-height: 80vh; overflow: auto;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); padding: 16px;
        display: flex; flex-direction: column; gap: 12px;
    }
    .modal-title { font-size: 13px; font-weight: 600; color: var(--fg); }
    .modal-body { font-size: 12px; color: var(--fg); display: flex; flex-direction: column; gap: 8px; }
    .modal-body p { margin: 0; }
    .topic-list { max-height: 180px; overflow: auto; background: var(--bg-app); border: 1px solid var(--border); border-radius: 3px; padding: 4px 6px; }
    /* Custom checkboxes (theme-aware; native ones ignore the dark palette) — same pattern as the MQTT page */
    .modal-check, .chk { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg); cursor: pointer; user-select: none; }
    .chk { display: inline-flex; vertical-align: middle; }
    .modal-check.disabled { color: var(--fg-muted); cursor: default; }
    .modal-check input[type='checkbox'], .chk input[type='checkbox'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .modal-check .checkmark, .chk .checkmark {
        flex-shrink: 0; width: 13px; height: 13px; border: 1.5px solid var(--border); border-radius: 2px;
        background: var(--bg-app); position: relative; transition: background 0.12s, border-color 0.12s;
    }
    .modal-check input:checked + .checkmark, .chk input:checked + .checkmark { background: var(--accent); border-color: var(--accent); }
    .modal-check input:checked + .checkmark::after, .chk input:checked + .checkmark::after {
        content: ''; position: absolute; left: 3px; top: 0; width: 4px; height: 7px;
        border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg);
    }
    .modal-check:not(.disabled):hover .checkmark, .chk:hover .checkmark { border-color: var(--accent); }
    .modal-footer { display: flex; justify-content: flex-end; gap: 8px; }
    .btn-cancel { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    .btn-confirm { background: #c0392b; }
</style>
