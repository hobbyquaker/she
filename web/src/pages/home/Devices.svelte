<script lang="ts">
    /**
     * Devices and their entities: filtered (all, in no room, gone, hidden; by room, adapter, text),
     * selected in bulk for rooms, functions, labels and visibility, or one at a time in the panel on
     * the right, which shows what is assigned and what is inherited.
     */
    import { untrack } from 'svelte';
    import { assignHome, removeHomeItems, type HomeModelData, type HomeDevice, type HomeEntity, type HomeUser } from '../../lib/api.js';
    import IdPicker from '../../lib/IdPicker.svelte';
    import { entitySearchText, roomNames, plural, fmtSince } from '../../lib/home.js';
    import type { HomeCtx } from './ctx.js';

    let { data, ctx, busy = false, focus = $bindable(null) }: { data: HomeModelData; ctx: HomeCtx; busy?: boolean; focus?: { room?: string; device?: string; filter?: string } | null } = $props();

    const devices = $derived(data.devices ?? []);
    const entities = $derived(data.entities ?? []);
    const rooms = $derived(data.rooms ?? []);
    const functions = $derived(data.functions ?? []);
    const labels = $derived(data.labels ?? []);
    const roomOpts = $derived(rooms.map((r) => ({ id: r.id, name: r.name })));
    const fnOpts = $derived(functions.map((f) => ({ id: f.id, name: f.name })));
    const labelOpts = $derived(labels.map((l) => ({ id: l.id, name: l.name })));

    type View = 'all' | 'unassigned' | 'gone' | 'hidden';
    let view = $state<View>('all');
    let roomFilter = $state('');
    let adapter = $state('');
    let search = $state('');
    let showHidden = $state(false);
    let expanded = $state<Set<string>>(new Set());
    let selected = $state<Set<string>>(new Set());
    /** the document shown in the panel */
    let current = $state<string | null>(null);

    $effect(() => {
        const f = focus;
        if (!f) return;
        untrack(() => {
            if (f.filter === 'unassigned') view = 'unassigned';
            if (f.device) {
                view = 'all';
                search = '';
                roomFilter = '';
                current = f.device;
                expanded = new Set([...expanded, f.device]);
            }
            focus = null;
        });
    });

    const adapters = $derived([...new Set(devices.map((d) => d.eff.adapter).filter((a): a is string => !!a))].sort());
    const entitiesOf = $derived.by(() => {
        const m = new Map<string, HomeEntity[]>();
        for (const e of entities) {
            const k = e.ha.device ?? '';
            if (!m.has(k)) m.set(k, []);
            m.get(k)!.push(e);
        }
        for (const list of m.values()) list.sort((a, b) => String(a.eff.name).localeCompare(String(b.eff.name)));
        return m;
    });
    const deviceById = $derived(new Map(devices.map((d) => [d.id, d])));

    function entityMatches(e: HomeEntity, q: string[]): boolean {
        if (view === 'unassigned' && (e.eff.rooms.length || !e.ha.present || e.eff.hidden)) return false;
        if (view === 'gone' && e.ha.present) return false;
        if (view === 'hidden' && !e.eff.hidden) return false;
        if (view === 'all' && !showHidden && e.eff.hidden) return false;
        if (roomFilter === '-' ? e.eff.rooms.length > 0 : roomFilter && !e.eff.rooms.includes(roomFilter)) return false;
        if (q.length) {
            const text = entitySearchText(e, deviceById.get(e.ha.device ?? ''));
            if (!q.every((w) => text.includes(w))) return false;
        }
        return true;
    }

    /** the devices shown, each with the entities that pass the filters */
    const rows = $derived.by(() => {
        const q = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const out: { device: HomeDevice | null; list: HomeEntity[]; all: number }[] = [];
        const list = [...devices].sort((a, b) => String(a.eff.name).localeCompare(String(b.eff.name)));
        for (const d of list) {
            if (adapter && d.eff.adapter !== adapter) continue;
            const ents = entitiesOf.get(d.id) ?? [];
            const match = ents.filter((e) => entityMatches(e, q));
            const goneDevice = view === 'gone' && !d.ha.present;
            if (!match.length && !goneDevice) continue;
            out.push({ device: d, list: match, all: ents.length });
        }
        const orphans = (entitiesOf.get('') ?? []).filter((e) => entityMatches(e, q));
        if (orphans.length && !adapter) out.push({ device: null, list: orphans, all: orphans.length });
        return out;
    });
    const shownCount = $derived(rows.reduce((n, r) => n + r.list.length, 0));

    // ── selection ──
    function toggleSel(id: string) {
        const next = new Set(selected);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        selected = next;
    }
    function selectShownEntities() {
        selected = new Set([...selected, ...rows.flatMap((r) => r.list.map((e) => e.id))]);
    }
    function selectShownDevices() {
        selected = new Set([...selected, ...rows.flatMap((r) => (r.device ? [r.device.id] : []))]);
    }
    const selIds = $derived([...selected]);
    const selDevices = $derived(selIds.filter((id) => id.startsWith('she/device/')).length);
    const selEntities = $derived(selIds.length - selDevices);
    const selAllGone = $derived(
        selIds.length > 0 && selIds.every((id) => (id.startsWith('she/device/') ? deviceById.get(id)?.ha.present === false : entities.find((e) => e.id === id)?.ha.present === false)),
    );

    // ── bulk ──
    let bulkRooms = $state<string[]>([]);
    let bulkFns = $state<string[]>([]);
    let bulkLabels = $state<string[]>([]);
    function bulk(ops: Parameters<typeof assignHome>[1], what: string) {
        const ids = selIds;
        ctx.act(() => assignHome(ids, ops), (r) => `${what}: ${plural(r.updated, 'item')} changed${r.errors.length ? `, ${r.errors.length} failed (${r.errors[0].error})` : ''}.`);
    }
    async function removeGone() {
        const ids = selIds;
        if (!(await ctx.confirm(`Delete ${plural(ids.length, 'gone item')} from the home model? A device takes its entities with it. Its assignments are lost; if it is announced again it comes back without them.`, { confirm: 'Delete', danger: true }))) return;
        await ctx.act(() => removeHomeItems(ids), (r) => `${plural(r.removed.length, 'document')} deleted${r.errors.length ? `, ${r.errors.length} failed` : ''}.`);
        selected = new Set();
    }

    // ── the panel ──
    const curDevice = $derived(current?.startsWith('she/device/') ? deviceById.get(current) : undefined);
    const curEntity = $derived(current?.startsWith('she/entity/') ? entities.find((e) => e.id === current) : undefined);
    const cur = $derived<HomeDevice | HomeEntity | undefined>(curDevice ?? curEntity);
    const curParent = $derived(curEntity?.ha.device ? deviceById.get(curEntity.ha.device) : undefined);

    let form = $state({ name: '', rooms: [] as string[], roomsOwn: false, functions: [] as string[], fnOwn: false, labels: [] as string[], hidden: 'inherit', notes: '' });
    // the form follows the item shown and its changes (a save, a bulk edit), but a draft that
    // differs from what was shown survives a re-read of the model
    let base: HomeDevice | HomeEntity | null = null;
    $effect(() => {
        const c = cur;
        if (!c) return;
        untrack(() => {
            if (!base || base.id !== c.id || JSON.stringify(form) === JSON.stringify(formOf(base))) resetForm(c);
            base = c;
        });
    });
    function resetForm(c: HomeDevice | HomeEntity) {
        form = formOf(c);
    }
    function formOf(c: HomeDevice | HomeEntity) {
        const u: HomeUser = c.user ?? {};
        return {
            name: u.name ?? '',
            rooms: Array.isArray(u.rooms) ? [...u.rooms] : [...c.eff.rooms],
            roomsOwn: Array.isArray(u.rooms),
            functions: Array.isArray(u.functions) ? [...u.functions] : 'functions' in c.eff ? [...(c.eff as HomeEntity['eff']).functions] : [],
            fnOwn: Array.isArray(u.functions),
            labels: Array.isArray(u.labels) ? [...u.labels] : [],
            hidden: typeof u.hidden === 'boolean' ? (u.hidden ? 'hidden' : 'shown') : 'inherit',
            notes: u.notes ?? '',
        };
    }
    function save() {
        const c = cur;
        if (!c) return;
        const set: Record<string, unknown> = {
            name: form.name.trim() || null,
            rooms: form.roomsOwn ? form.rooms : null,
            labels: form.labels.length ? form.labels : null,
            hidden: form.hidden === 'inherit' ? null : form.hidden === 'hidden',
            notes: form.notes.trim() || null,
        };
        if (curEntity) set.functions = form.fnOwn ? form.functions : null;
        ctx.act(() => assignHome([c.id], { set }), (r) => (r.errors.length ? null : 'Saved.')).then(() => {
            // what the model made of it (a label created from its name, rooms resolved)
            if (cur && cur.id === c.id) resetForm(cur);
        });
    }
    async function removeOne(id: string, name: string) {
        if (!(await ctx.confirm(`Delete "${name}" from the home model? It has gone; its assignments are lost.`, { confirm: 'Delete', danger: true }))) return;
        await ctx.act(() => removeHomeItems([id]), 'Deleted.');
        current = null;
    }

    const fnName = (id: string) => functions.find((f) => f.id === id)?.name ?? id;
    const labelName = (id: string) => labels.find((l) => l.id === id)?.name ?? id;
    function toggleExpand(id: string) {
        const next = new Set(expanded);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        expanded = next;
    }
    const expandAll = $derived(view !== 'all' || !!search.trim() || !!roomFilter);
</script>

<div class="devs">
    <div class="main">
        <div class="filters">
            <span class="views">
                {#each [['all', 'All'], ['unassigned', 'In no room'], ['gone', 'Gone'], ['hidden', 'Hidden']] as [v, l] (v)}
                    <button class="vbtn" class:on={view === v} onclick={() => (view = v as View)}>{l}</button>
                {/each}
            </span>
            <select bind:value={roomFilter} title="Room">
                <option value="">all rooms</option>
                <option value="-">no room</option>
                {#each rooms as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
            </select>
            <select bind:value={adapter} title="Adapter (discovery origin)">
                <option value="">all adapters</option>
                {#each adapters as a (a)}<option value={a}>{a}</option>{/each}
            </select>
            <input type="search" placeholder="Search…" bind:value={search} spellcheck="false" />
            {#if view === 'all'}<label class="chk"><input type="checkbox" bind:checked={showHidden} /><span class="checkmark"></span> hidden entities</label>{/if}
            <span class="spacer"></span>
            <span class="dim" title="Dashed: inherited (rooms from the device or its announced area, functions from the rules); solid: assigned"><span class="chip inh">inherited</span> <span class="chip">assigned</span></span>
            <span class="dim">{plural(rows.length, 'device')}, {plural(shownCount, 'entity', 'entities')}</span>
        </div>

        {#if selected.size}
            <div class="bulk">
                <span class="bulk-n">{selDevices ? plural(selDevices, 'device') : ''}{selDevices && selEntities ? ', ' : ''}{selEntities ? plural(selEntities, 'entity', 'entities') : ''}</span>
                <span class="grp">
                    Rooms <IdPicker options={roomOpts} bind:selected={bulkRooms} noun="rooms" placeholder="choose…" disabled={busy} />
                    <button class="sm" disabled={busy || !bulkRooms.length} onclick={() => bulk({ add: { rooms: bulkRooms } }, 'Rooms added')}>add</button>
                    <button class="sm ghost" disabled={busy || !bulkRooms.length} onclick={() => bulk({ remove: { rooms: bulkRooms } }, 'Rooms removed')}>remove</button>
                    <button class="sm ghost" disabled={busy || !bulkRooms.length} onclick={() => bulk({ set: { rooms: bulkRooms } }, 'Rooms set')}>set</button>
                    <button class="sm ghost" disabled={busy} title="Forget the rooms assigned here: devices follow their area again, entities their device" onclick={() => bulk({ set: { rooms: null } }, 'Rooms inherited')}>inherit</button>
                </span>
                {#if selEntities}
                    <span class="grp">
                        Functions <IdPicker options={fnOpts} bind:selected={bulkFns} noun="functions" placeholder="choose…" disabled={busy} />
                        <button class="sm" disabled={busy || !bulkFns.length} onclick={() => bulk({ add: { functions: bulkFns } }, 'Functions added')}>add</button>
                        <button class="sm ghost" disabled={busy || !bulkFns.length} onclick={() => bulk({ remove: { functions: bulkFns } }, 'Functions removed')}>remove</button>
                        <button class="sm ghost" disabled={busy} title="Back to the functions' rules" onclick={() => bulk({ set: { functions: null } }, 'Functions from the rules')}>by rules</button>
                    </span>
                {/if}
                <span class="grp">
                    Labels <IdPicker options={labelOpts} bind:selected={bulkLabels} noun="labels" placeholder="choose…" create disabled={busy} />
                    <button class="sm" disabled={busy || !bulkLabels.length} onclick={() => bulk({ add: { labels: bulkLabels } }, 'Labels added')}>add</button>
                    <button class="sm ghost" disabled={busy || !bulkLabels.length} onclick={() => bulk({ remove: { labels: bulkLabels } }, 'Labels removed')}>remove</button>
                </span>
                <span class="grp">
                    <button class="sm ghost" disabled={busy} onclick={() => bulk({ set: { hidden: true } }, 'Hidden')}>hide</button>
                    <button class="sm ghost" disabled={busy} onclick={() => bulk({ set: { hidden: false } }, 'Shown')}>show</button>
                    <button class="sm ghost" disabled={busy} title="Hidden as discovery says (diagnostic and config entities)" onclick={() => bulk({ set: { hidden: null } }, 'Visibility inherited')}>default</button>
                </span>
                {#if selAllGone}<button class="sm danger" disabled={busy} onclick={removeGone}>delete</button>{/if}
                <span class="spacer"></span>
                <button class="link" onclick={() => (selected = new Set())}>clear selection</button>
            </div>
        {:else}
            <div class="bulk dim">
                Tick devices or entities to assign several at once —
                <button class="link" onclick={selectShownDevices} disabled={!rows.length}>all shown devices</button> ·
                <button class="link" onclick={selectShownEntities} disabled={!shownCount}>all shown entities</button>
            </div>
        {/if}

        <div class="list">
            {#each rows as r (r.device?.id ?? '-')}
                {@const d = r.device}
                {@const open = expandAll || (d ? expanded.has(d.id) : true)}
                <div class="drow" class:cur={d && current === d.id} class:gone={d && !d.ha.present}>
                    {#if d}
                        <label class="chk"><input type="checkbox" checked={selected.has(d.id)} onchange={() => toggleSel(d.id)} /><span class="checkmark"></span></label>
                        <button class="caret" onclick={() => toggleExpand(d.id)} aria-label="Expand">{open ? '▾' : '▸'}</button>
                        <button class="dname" onclick={() => (current = d.id)}>{d.eff.name}</button>
                        <span class="dim meta">{[d.ha.manufacturer, d.ha.model].filter(Boolean).join(' · ')}{d.eff.adapter ? ` · ${d.eff.adapter}` : ''}</span>
                        <span class="chips">
                            {#each roomNames(d.eff.rooms, rooms) as n (n)}<span class="chip" class:inh={!Array.isArray(d.user.rooms)} title={Array.isArray(d.user.rooms) ? 'assigned' : `from the area "${d.ha.suggested_area ?? ''}"`}>{n}</span>{/each}
                            {#each d.eff.labels as l (l)}<span class="chip lbl">{labelName(l)}</span>{/each}
                            {#if !d.ha.present}<span class="chip gone-chip">gone {fmtSince(d.ha.gone_since)}</span>{/if}
                        </span>
                        <span class="dim cnt">{r.list.length}{r.list.length !== r.all ? `/${r.all}` : ''}</span>
                    {:else}
                        <span></span><span></span><span class="dname dim">Entities without a device</span><span></span><span></span><span></span>
                    {/if}
                </div>
                {#if open}
                    {#each r.list as e (e.id)}
                        <div class="erow" class:cur={current === e.id} class:gone={!e.ha.present} class:hid={e.eff.hidden}>
                            <label class="chk"><input type="checkbox" checked={selected.has(e.id)} onchange={() => toggleSel(e.id)} /><span class="checkmark"></span></label>
                            <button class="ename" onclick={() => (current = e.id)}>{e.eff.name}</button>
                            <span class="mono dim">{e.ha.component}{e.ha.device_class ? ` · ${e.ha.device_class}` : ''}</span>
                            <span class="chips">
                                {#each roomNames(e.eff.rooms, rooms) as n (n)}<span class="chip" class:inh={!Array.isArray(e.user.rooms)}>{n}</span>{/each}
                                {#each e.eff.functions as f (f)}<span class="chip fn" class:inh={!Array.isArray(e.user.functions)}>{fnName(f)}</span>{/each}
                                {#each e.eff.labels as l (l)}<span class="chip lbl">{labelName(l)}</span>{/each}
                                {#if e.eff.hidden}<span class="chip inh">hidden</span>{/if}
                                {#if !e.ha.present}<span class="chip gone-chip">gone</span>{/if}
                            </span>
                        </div>
                    {/each}
                {/if}
            {/each}
            {#if !rows.length}
                <p class="dim pad">{view === 'unassigned' ? 'Every visible entity is in a room.' : view === 'gone' ? 'Nothing has gone.' : view === 'hidden' ? 'Nothing is hidden.' : devices.length ? 'Nothing matches.' : 'No devices yet: they come from Home Assistant discovery on the broker.'}</p>
            {/if}
        </div>
    </div>

    {#if cur}
        <aside class="panel">
            <div class="ptitle">
                <span class="kind">{curDevice ? 'Device' : 'Entity'}</span>
                <span class="spacer"></span>
                <button class="link" onclick={() => (current = null)}>close</button>
            </div>
            <h3>{cur.eff.name}</h3>
            {#if curEntity && curParent}<p class="dim">of <button class="link" onclick={() => (current = curParent.id)}>{curParent.eff.name}</button></p>{/if}
            <label>Name <input type="text" bind:value={form.name} placeholder={(curDevice ? curDevice.ha.name : curEntity?.ha.name) ?? cur.eff.name ?? ''} /></label>
            <div class="fld">
                <span class="flabel">Rooms</span>
                {#if form.roomsOwn}
                    <IdPicker options={roomOpts} bind:selected={form.rooms} noun="rooms" placeholder="none (on purpose)" />
                    <button class="link" onclick={() => { form.roomsOwn = false; form.rooms = [...cur!.eff.rooms]; }}>inherit</button>
                {:else}
                    <span class="inh-val">{roomNames(cur.eff.rooms, rooms).join(', ') || 'none'} <span class="dim">— {curDevice ? (curDevice.ha.suggested_area ? `from the area "${curDevice.ha.suggested_area}"` : 'no area announced') : 'from the device'}</span></span>
                    <button class="link" onclick={() => (form.roomsOwn = true)}>assign</button>
                {/if}
            </div>
            {#if curEntity}
                <div class="fld">
                    <span class="flabel">Functions</span>
                    {#if form.fnOwn}
                        <IdPicker options={fnOpts} bind:selected={form.functions} noun="functions" placeholder="none (on purpose)" />
                        <button class="link" onclick={() => { form.fnOwn = false; form.functions = [...curEntity!.eff.functions]; }}>by rules</button>
                    {:else}
                        <span class="inh-val">{curEntity.eff.functions.map(fnName).join(', ') || 'none'} <span class="dim">— from the rules</span></span>
                        <button class="link" onclick={() => (form.fnOwn = true)}>assign</button>
                    {/if}
                </div>
            {/if}
            <div class="fld">
                <span class="flabel">Labels</span>
                <IdPicker options={labelOpts} bind:selected={form.labels} noun="labels" placeholder="none" create />
                {#if curEntity && curParent?.eff.labels.length}<span class="dim">+ from the device: {curParent.eff.labels.map(labelName).join(', ')}</span>{/if}
            </div>
            <label>Visibility
                <select bind:value={form.hidden}>
                    <option value="inherit">default ({curEntity ? (curParent && typeof curParent.user.hidden === 'boolean' ? (curParent.user.hidden ? 'hidden, like the device' : 'shown, like the device') : curEntity.ha.entity_category ? `hidden: ${curEntity.ha.entity_category}` : 'shown') : 'shown'})</option>
                    <option value="shown">shown</option>
                    <option value="hidden">hidden</option>
                </select>
            </label>
            <label>Notes <textarea rows="3" bind:value={form.notes}></textarea></label>
            <div class="pactions">
                <button onclick={save} disabled={busy}>Save</button>
                <button class="ghost" onclick={() => cur && resetForm(cur)} disabled={busy}>Revert</button>
                {#if !cur.ha.present}<span class="spacer"></span><button class="danger sm" disabled={busy} onclick={() => removeOne(cur!.id, cur!.eff.name ?? cur!.id)}>Delete</button>{/if}
            </div>
            <dl>
                {#if curDevice}
                    <dt>Identifiers</dt><dd class="mono">{curDevice.ha.identifiers.join(', ')}</dd>
                    {#if curDevice.ha.manufacturer || curDevice.ha.model}<dt>Model</dt><dd>{[curDevice.ha.manufacturer, curDevice.ha.model].filter(Boolean).join(' · ')}</dd>{/if}
                    <dt>Area</dt><dd>{curDevice.ha.suggested_area ?? '—'}</dd>
                    <dt>Adapter</dt><dd>{curDevice.eff.adapter ?? '—'}</dd>
                    <dt>Entities</dt><dd>{(entitiesOf.get(curDevice.id) ?? []).length}</dd>
                {:else if curEntity}
                    <dt>Unique id</dt><dd class="mono">{curEntity.ha.unique_id}</dd>
                    <dt>Component</dt><dd class="mono">{curEntity.ha.component}{curEntity.ha.device_class ? ` · ${curEntity.ha.device_class}` : ''}{curEntity.ha.unit ? ` (${curEntity.ha.unit})` : ''}</dd>
                    {#if curEntity.ha.state_topic}<dt>State topic</dt><dd class="mono">{curEntity.ha.state_topic}</dd>{/if}
                    {#if curEntity.ha.entity_category}<dt>Category</dt><dd>{curEntity.ha.entity_category}</dd>{/if}
                {/if}
                <dt>Document</dt><dd class="mono">{cur.id}</dd>
                {#if !cur.ha.present}<dt>Gone since</dt><dd>{fmtSince(cur.ha.gone_since)}</dd>{/if}
            </dl>
        </aside>
    {/if}
</div>

<style>
    .devs { flex: 1; display: flex; min-height: 0; }
    .main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
    .filters { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex-wrap: wrap; border-bottom: 1px solid var(--border-sub, var(--border)); }
    .views { display: inline-flex; border: 1px solid var(--border); border-radius: 3px; overflow: hidden; }
    .vbtn { background: none !important; color: var(--fg-muted) !important; border-radius: 0 !important; padding: 2px 10px !important; }
    .vbtn.on { background: var(--bg-active) !important; color: var(--fg-text) !important; }
    .spacer { flex: 1; }
    .bulk { display: flex; align-items: center; gap: 6px 14px; padding: 6px 12px; flex-wrap: wrap; border-bottom: 1px solid var(--border); background: var(--bg-panel); min-height: 24px; }
    .bulk-n { font-weight: 600; }
    .grp { display: inline-flex; align-items: center; gap: 4px; }
    .list { flex: 1; overflow: auto; }
    .drow, .erow { display: grid; align-items: center; gap: 8px; padding: 3px 12px; border-bottom: 1px solid var(--border-sub, var(--border)); }
    .drow { grid-template-columns: 16px 14px minmax(160px, 1.6fr) minmax(120px, 1.2fr) minmax(140px, 2fr) 36px; background: var(--bg-panel); }
    .erow { grid-template-columns: 16px minmax(180px, 1.8fr) minmax(110px, 1fr) minmax(180px, 2.6fr); padding-left: 34px; }
    .drow.cur, .erow.cur { background: var(--bg-active); }
    .drow.gone .dname, .erow.gone .ename { text-decoration: line-through; color: var(--fg-dim) !important; }
    .erow.hid .ename { font-style: italic; color: var(--fg-muted) !important; }
    .caret { background: none !important; color: var(--fg-muted) !important; padding: 0 !important; font-size: 10px !important; }
    .dname, .ename { background: none !important; color: var(--fg-text) !important; padding: 0 !important; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dname { font-weight: 600; }
    .meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chips { display: flex; gap: 4px; flex-wrap: wrap; }
    .gone-chip { color: var(--fg-err, #e06c75); border-color: var(--fg-err, #e06c75); }
    .cnt { text-align: right; }
    .pad { padding: 12px; }
    .panel { width: 330px; flex-shrink: 0; border-left: 1px solid var(--border); overflow: auto; padding: 10px 12px 20px; display: flex; flex-direction: column; gap: 8px; }
    .ptitle { display: flex; align-items: center; }
    .kind { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg-muted); }
    .panel h3 { margin: 0; font-size: 13px; }
    .panel p { margin: 0; }
    .panel label { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--fg-muted); }
    .panel input[type='text'], .panel textarea, .panel select { width: 100%; box-sizing: border-box; }
    .fld { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
    .flabel { width: 100%; font-size: 11px; color: var(--fg-muted); }
    .inh-val { flex: 1; color: var(--fg); }
    .pactions { display: flex; gap: 8px; align-items: center; }
    dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 8px 0 0; font-size: 11px; }
    dt { color: var(--fg-muted); }
    dd { margin: 0; word-break: break-all; }
</style>
