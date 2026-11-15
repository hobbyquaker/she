<script lang="ts">
    /**
     * Floors and rooms: the structure on the left (floors with their rooms, in order), the selected
     * floor or room on the right — its settings, merging other rooms into it, and what is in it.
     */
    import { untrack } from 'svelte';
    import { createHomeItem, updateHomeItem, deleteHomeItem, mergeHomeRooms, restoreHomeRoom, assignHome, type HomeModelData, type HomeRoom, type HomeFloor, type HomeEntity } from '../../lib/api.js';
    import EntityPicker from '../../lib/EntityPicker.svelte';
    import IdPicker from '../../lib/IdPicker.svelte';
    import { plural } from '../../lib/home.js';
    import type { HomeCtx } from './ctx.js';

    let { data, ctx, busy = false, focus = $bindable(null) }: { data: HomeModelData; ctx: HomeCtx; busy?: boolean; focus?: { room?: string; device?: string; filter?: string } | null } = $props();

    const floors = $derived(data.floors ?? []);
    const rooms = $derived(data.rooms ?? []);
    const rejected = $derived(data.rejected ?? []);
    const entities = $derived(data.entities ?? []);
    const devices = $derived(data.devices ?? []);
    const functions = $derived(data.functions ?? []);

    /** 'room:<id>' | 'floor:<id>' | null */
    let sel = $state<string | null>(null);
    $effect(() => {
        const f = focus;
        if (f?.room) untrack(() => {
            sel = 'room:' + f.room;
            focus = null;
        });
    });
    $effect(() => {
        // the first room, and after a delete or a merge whatever is left
        if (sel === null || (sel.startsWith('room:') && !rooms.some((r) => 'room:' + r.id === sel)) || (sel.startsWith('floor:') && !floors.some((f) => 'floor:' + f.id === sel)))
            untrack(() => (sel = rooms[0] ? 'room:' + rooms[0].id : floors[0] ? 'floor:' + floors[0].id : null));
    });

    const room = $derived(sel?.startsWith('room:') ? rooms.find((r) => 'room:' + r.id === sel) : undefined);
    const floor = $derived(sel?.startsWith('floor:') ? floors.find((f) => 'floor:' + f.id === sel) : undefined);

    const count = $derived.by(() => {
        const m = new Map<string, number>();
        for (const e of entities) if (e.ha.present && !e.eff.hidden) for (const r of e.eff.rooms) m.set(r, (m.get(r) ?? 0) + 1);
        return m;
    });
    const unassigned = $derived(entities.filter((e) => e.ha.present && !e.eff.hidden && !e.eff.rooms.length).length);
    const groups = $derived([
        ...floors.map((f) => ({ floor: f as HomeFloor | null, rooms: rooms.filter((r) => r.floor === f.id) })),
        { floor: null, rooms: rooms.filter((r) => !r.floor || !floors.some((f) => f.id === r.floor)) },
    ]);

    // ── structure ──
    async function addFloor() {
        const name = await ctx.prompt('Name of the new floor', { placeholder: 'Ground floor', confirm: 'Create' });
        if (!name) return;
        const r = await ctx.act(() => createHomeItem('floors', { name, level: floors.length, order: floors.length + 1 }), `Floor "${name}" created.`);
        if (r) sel = 'floor:' + r.id;
    }
    async function addRoom(floorId: string | null = null) {
        const name = await ctx.prompt('Name of the new room', { placeholder: 'Kitchen', confirm: 'Create' });
        if (!name) return;
        const siblings = rooms.filter((r) => (r.floor ?? null) === floorId);
        const r = await ctx.act(() => createHomeItem('rooms', { name, floor: floorId, order: siblings.length + 1 }), `Room "${name}" created.`);
        if (r) sel = 'room:' + r.id;
    }
    /** Move an item one up or down among its siblings and write a clean order 1…n. */
    function move<T extends { id: string }>(kind: 'floors' | 'rooms', list: T[], id: string, dir: -1 | 1) {
        const i = list.findIndex((x) => x.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= list.length) return;
        const next = [...list];
        [next[i], next[j]] = [next[j], next[i]];
        ctx.act(() => Promise.all(next.map((x, k) => ((x as unknown as { order: number | null }).order === k + 1 ? null : updateHomeItem(kind, x.id, { order: k + 1 }))).filter(Boolean)));
    }

    // ── a room ──
    let edit = $state<{ id: string; name: string; floor: string; icon: string; aliases: string }>({ id: '', name: '', floor: '', icon: '', aliases: '' });
    const roomForm = (r: HomeRoom) => ({ id: r.id, name: r.name, floor: r.floor ?? '', icon: r.icon ?? '', aliases: (r.aliases ?? []).join(', ') });
    function resetRoom(r: HomeRoom) {
        edit = roomForm(r);
    }
    // the form follows the room shown and its changes (a save, a merge, another tab), but a draft
    // that differs from what was shown survives a re-read of the model
    let roomBase: HomeRoom | null = null;
    $effect(() => {
        const r = room;
        if (!r) return;
        untrack(() => {
            if (!roomBase || roomBase.id !== r.id || JSON.stringify(edit) === JSON.stringify(roomForm(roomBase))) resetRoom(r);
            roomBase = r;
        });
    });
    const roomDirty = $derived(!!room && (edit.name.trim() !== room.name || edit.floor !== (room.floor ?? '') || edit.icon.trim() !== (room.icon ?? '') || edit.aliases !== (room.aliases ?? []).join(', ')));
    function saveRoom() {
        if (!room || !edit.name.trim()) return;
        const aliases = [...new Set(edit.aliases.split(',').map((s) => s.trim()).filter(Boolean))];
        const r = room;
        ctx.act(() => updateHomeItem('rooms', r.id, { name: edit.name.trim(), floor: edit.floor || null, icon: edit.icon.trim() || null, aliases }), 'Room saved.').then(() => room && room.id === r.id && resetRoom(room));
    }
    async function deleteRoom(r: HomeRoom) {
        const n = count.get(r.id) ?? 0;
        const ok = await ctx.confirm(
            `Delete the room "${r.name}"? ${n ? `${plural(n, 'entity', 'entities')} lose${n === 1 ? 's' : ''} it. ` : ''}Its names are remembered, so discovery does not create it again; you can bring it back under "Deleted discovery areas".`,
            { confirm: 'Delete', danger: true },
        );
        if (ok) ctx.act(() => deleteHomeItem('rooms', r.id), `Room "${r.name}" deleted.`);
    }
    let mergeIds = $state<string[]>([]);
    async function merge() {
        if (!room || !mergeIds.length) return;
        const names = mergeIds.map((id) => rooms.find((r) => r.id === id)?.name ?? id);
        const r = room;
        const ok = await ctx.confirm(`Merge ${names.map((n) => `"${n}"`).join(', ')} into "${r.name}"? Their names become aliases of "${r.name}", and every device, entity and scene in them moves over.`, { confirm: 'Merge' });
        if (!ok) return;
        const ids = mergeIds;
        await ctx.act(() => mergeHomeRooms(r.id, ids), `Merged into "${r.name}".`);
        mergeIds = [];
    }

    // ── a floor ──
    let fedit = $state({ name: '', level: '', icon: '' });
    const floorForm = (f: HomeFloor) => ({ name: f.name, level: f.level === null || f.level === undefined ? '' : String(f.level), icon: f.icon ?? '' });
    function resetFloor(f: HomeFloor) {
        fedit = floorForm(f);
    }
    let floorBase: HomeFloor | null = null;
    $effect(() => {
        const f = floor;
        if (!f) return;
        untrack(() => {
            if (!floorBase || floorBase.id !== f.id || JSON.stringify(fedit) === JSON.stringify(floorForm(floorBase))) resetFloor(f);
            floorBase = f;
        });
    });
    const floorDirty = $derived(!!floor && (fedit.name.trim() !== floor.name || fedit.level !== (floor.level === null || floor.level === undefined ? '' : String(floor.level)) || fedit.icon.trim() !== (floor.icon ?? '')));
    function saveFloor() {
        if (!floor || !fedit.name.trim()) return;
        const level = fedit.level.trim() === '' ? null : Number(fedit.level);
        if (level !== null && !Number.isFinite(level)) return;
        const f = floor;
        ctx.act(() => updateHomeItem('floors', f.id, { name: fedit.name.trim(), level, icon: fedit.icon.trim() || null }), 'Floor saved.').then(() => floor && floor.id === f.id && resetFloor(floor));
    }
    async function deleteFloor(f: HomeFloor) {
        if (await ctx.confirm(`Delete the floor "${f.name}"? Its rooms stay, without a floor.`, { confirm: 'Delete', danger: true })) ctx.act(() => deleteHomeItem('floors', f.id), `Floor "${f.name}" deleted.`);
    }

    // ── what is in the room ──
    const members = $derived(room ? entities.filter((e) => e.eff.rooms.includes(room.id) && e.ha.present) : []);
    const byDevice = $derived.by(() => {
        const m = new Map<string, HomeEntity[]>();
        for (const e of members) {
            const k = e.ha.device ?? '';
            if (!m.has(k)) m.set(k, []);
            m.get(k)!.push(e);
        }
        return [...m.entries()].map(([id, list]) => ({ device: devices.find((d) => d.id === id), list })).sort((a, b) => String(a.device?.eff.name ?? '').localeCompare(String(b.device?.eff.name ?? '')));
    });
    const fnName = (id: string) => functions.find((f) => f.id === id)?.name ?? id;
    /** whether the entity is in the room on its own account, not through its device */
    const own = (e: HomeEntity) => Array.isArray(e.user.rooms);

    function removeEntity(e: HomeEntity) {
        if (!room) return;
        const r = room;
        ctx.act(() => assignHome([e.id], { remove: { rooms: [r.id] } }), `"${e.eff.name}" taken out of "${r.name}".`);
    }
    function removeDevice(id: string, name: string) {
        if (!room) return;
        const r = room;
        ctx.act(() => assignHome([id], { remove: { rooms: [r.id] } }), `"${name}" taken out of "${r.name}".`);
    }

    // the "Add entities" dialog
    let adding = $state(false);
    let pick = $state<string[]>([]);
    let pickRoom = $state('-');
    let addMode = $state<'add' | 'move'>('move');
    function openAdd() {
        pick = [];
        pickRoom = '-';
        adding = true;
    }
    async function applyAdd() {
        if (!room || !pick.length) return;
        const r = room;
        const ids = pick;
        const ok = await ctx.act(
            () => assignHome(ids, addMode === 'move' ? { set: { rooms: [r.id] } } : { add: { rooms: [r.id] } }),
            (res) => `${plural(res.updated, 'entity', 'entities')} ${addMode === 'move' ? 'moved to' : 'added to'} "${r.name}"${res.errors.length ? ` — ${res.errors.length} failed: ${res.errors[0].error}` : ''}.`,
        );
        if (ok) adding = false;
    }

    // deleted discovery areas
    let showRejected = $state(false);
</script>

<div class="rooms">
    <aside class="tree">
        <div class="tree-bar">
            <button class="sm" onclick={() => addRoom(null)} disabled={busy}>+ Room</button>
            <button class="sm ghost" onclick={addFloor} disabled={busy}>+ Floor</button>
        </div>
        <div class="tree-list">
            {#each groups as g (g.floor?.id ?? '-')}
                {#if g.floor || g.rooms.length}
                    <div class="floor-row" class:sel={g.floor && sel === 'floor:' + g.floor.id}>
                        {#if g.floor}
                            {@const f = g.floor}
                            <button class="floor-name" onclick={() => (sel = 'floor:' + f.id)}>{f.name}{#if f.level !== null && f.level !== undefined}<span class="dim"> · level {f.level}</span>{/if}</button>
                            <span class="ord">
                                <button class="link" title="Up" disabled={busy || floors[0]?.id === f.id} onclick={() => move('floors', floors, f.id, -1)}>▲</button>
                                <button class="link" title="Down" disabled={busy || floors[floors.length - 1]?.id === f.id} onclick={() => move('floors', floors, f.id, 1)}>▼</button>
                                <button class="link" title="A room on this floor" disabled={busy} onclick={() => addRoom(f.id)}>+</button>
                            </span>
                        {:else}
                            <span class="floor-name nofloor">{floors.length ? 'No floor' : 'Rooms'}</span>
                        {/if}
                    </div>
                    {#each g.rooms as r (r.id)}
                        <div class="room-row" class:sel={sel === 'room:' + r.id}>
                            <button class="room-name" onclick={() => (sel = 'room:' + r.id)}>
                                {r.name}{#if r.auto}<span class="auto" title="Created from a discovery area">auto</span>{/if}
                            </button>
                            <span class="n dim">{count.get(r.id) ?? 0}</span>
                            <span class="ord">
                                <button class="link" title="Up" disabled={busy || g.rooms[0].id === r.id} onclick={() => move('rooms', g.rooms, r.id, -1)}>▲</button>
                                <button class="link" title="Down" disabled={busy || g.rooms[g.rooms.length - 1].id === r.id} onclick={() => move('rooms', g.rooms, r.id, 1)}>▼</button>
                            </span>
                        </div>
                    {/each}
                {/if}
            {/each}
            {#if !rooms.length}<p class="dim pad">No rooms yet. Rooms are created from the areas devices announce, or by hand.</p>{/if}
            <button class="unassigned" onclick={() => ctx.goto('devices', { filter: 'unassigned' })}>{plural(unassigned, 'entity', 'entities')} in no room →</button>
            {#if rejected.length}
                <button class="link pad" onclick={() => (showRejected = !showRejected)}>{showRejected ? '▾' : '▸'} Deleted discovery areas ({rejected.length})</button>
                {#if showRejected}
                    {#each rejected as r (r.id)}
                        <div class="rej-row">
                            <span title={(r.aliases ?? []).join(', ')}>{r.name}</span>
                            <button class="link" disabled={busy} onclick={() => ctx.act(() => restoreHomeRoom(r.id), `Room "${r.name}" is back.`)}>restore</button>
                            <button class="link" disabled={busy} title="Forget it: the next announcement of this area creates the room again" onclick={() => ctx.act(() => deleteHomeItem('rooms', r.id, { purge: true }), `"${r.name}" forgotten.`)}>forget</button>
                        </div>
                    {/each}
                {/if}
            {/if}
        </div>
    </aside>

    <section class="detail">
        {#if room}
            <div class="form">
                <label>Name <input type="text" bind:value={edit.name} onkeydown={(e) => e.key === 'Enter' && saveRoom()} /></label>
                <label>Floor
                    <select bind:value={edit.floor}>
                        <option value="">—</option>
                        {#each floors as f (f.id)}<option value={f.id}>{f.name}</option>{/each}
                    </select>
                </label>
                <label>Icon <input type="text" bind:value={edit.icon} placeholder="mdi:sofa" spellcheck="false" /></label>
                <label class="wide">Aliases <input type="text" bind:value={edit.aliases} placeholder="other names, comma-separated" spellcheck="false" /></label>
                <div class="form-actions">
                    <button onclick={saveRoom} disabled={busy || !roomDirty || !edit.name.trim()}>Save</button>
                    <span class="dim mono">she/room/{room.id}</span>
                    {#if room.auto}<span class="dim">created from a discovery area</span>{/if}
                    <span class="spacer"></span>
                    <button class="danger sm" onclick={() => deleteRoom(room)} disabled={busy}>Delete room</button>
                </div>
                <p class="dim">A device that announces one of the aliases as its area lands in this room. Merged rooms leave their names and ids here.</p>
            </div>
            {#if rooms.length > 1}
                <div class="merge">
                    <span>Merge into this room:</span>
                    <IdPicker options={rooms.filter((r) => r.id !== room.id).map((r) => ({ id: r.id, name: r.name }))} bind:selected={mergeIds} noun="rooms" placeholder="choose rooms…" disabled={busy} />
                    <button class="sm" onclick={merge} disabled={busy || !mergeIds.length}>Merge</button>
                </div>
            {/if}
            <div class="members-bar">
                <h3>In this room <span class="dim">· {plural(members.length, 'entity', 'entities')} of {plural(byDevice.length, 'device')}</span></h3>
                <span class="spacer"></span>
                <button class="sm" onclick={openAdd} disabled={busy}>Add entities…</button>
            </div>
            <div class="members">
                {#each byDevice as g (g.device?.id ?? g.list[0].id)}
                    <div class="dev-row">
                        <button class="link dev-name" onclick={() => ctx.goto('devices', { device: g.device?.id })}>{g.device?.eff.name ?? '(no device)'}</button>
                        <span class="dim">{[g.device?.ha.manufacturer, g.device?.ha.model].filter(Boolean).join(' · ')}</span>
                        <span class="spacer"></span>
                        {#if g.device && g.device.eff.rooms.includes(room.id)}
                            {@const d = g.device}
                            <button class="link" disabled={busy} title="Take the device out of the room; its entities follow unless they have rooms of their own" onclick={() => removeDevice(d.id, d.eff.name ?? d.id)}>take device out</button>
                        {/if}
                    </div>
                    {#each g.list as e (e.id)}
                        <div class="ent-row">
                            <span class="ent-name">{e.eff.name}</span>
                            <span class="mono dim">{e.ha.component}{e.ha.device_class ? ` · ${e.ha.device_class}` : ''}</span>
                            <span class="chips">
                                {#each e.eff.functions as f (f)}<span class="chip fn" class:inh={!Array.isArray(e.user.functions)}>{fnName(f)}</span>{/each}
                                {#if e.eff.rooms.length > 1}<span class="chip" title="Also in">+{e.eff.rooms.length - 1} room{e.eff.rooms.length > 2 ? 's' : ''}</span>{/if}
                            </span>
                            <span class="dim">{own(e) ? 'own room' : 'from device'}</span>
                            <button class="link" disabled={busy} onclick={() => removeEntity(e)}>take out</button>
                        </div>
                    {/each}
                {/each}
                {#if !members.length}<p class="dim pad">Nothing in this room yet.</p>{/if}
            </div>
        {:else if floor}
            <div class="form">
                <label>Name <input type="text" bind:value={fedit.name} onkeydown={(e) => e.key === 'Enter' && saveFloor()} /></label>
                <label>Level <input type="number" bind:value={fedit.level} step="1" placeholder="0" /></label>
                <label>Icon <input type="text" bind:value={fedit.icon} placeholder="mdi:home-floor-0" spellcheck="false" /></label>
                <div class="form-actions">
                    <button onclick={saveFloor} disabled={busy || !floorDirty || !fedit.name.trim()}>Save</button>
                    <span class="dim mono">she/floor/{floor.id}</span>
                    <span class="spacer"></span>
                    <button class="danger sm" onclick={() => deleteFloor(floor)} disabled={busy}>Delete floor</button>
                </div>
            </div>
            <h3>Rooms on this floor</h3>
            <div class="members">
                {#each rooms.filter((r) => r.floor === floor.id) as r (r.id)}
                    <div class="dev-row"><button class="link dev-name" onclick={() => (sel = 'room:' + r.id)}>{r.name}</button><span class="dim">{plural(count.get(r.id) ?? 0, 'entity', 'entities')}</span></div>
                {:else}
                    <p class="dim pad">No room on this floor. Choose the floor in a room's settings, or add one with + next to the floor.</p>
                {/each}
            </div>
        {:else}
            <p class="dim pad">Create a room or a floor to start.</p>
        {/if}
    </section>
</div>

{#if adding && room}
    <div class="backdrop" role="presentation" onclick={() => (adding = false)}></div>
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Add entities">
        <h3>Add entities to “{room.name}”</h3>
        <EntityPicker {entities} {devices} {rooms} {floors} {functions} bind:selected={pick} bind:room={pickRoom} exclude={members.map((e) => e.id)} />
        <div class="dlg-actions">
            <label class="radio"><input type="radio" bind:group={addMode} value="move" /> move here (replaces their rooms)</label>
            <label class="radio"><input type="radio" bind:group={addMode} value="add" /> add this room to their rooms</label>
            <span class="spacer"></span>
            <button class="ghost" onclick={() => (adding = false)}>Cancel</button>
            <button onclick={applyAdd} disabled={busy || !pick.length}>{addMode === 'move' ? 'Move' : 'Add'} {pick.length || ''}</button>
        </div>
    </div>
{/if}

<style>
    .rooms { flex: 1; display: flex; min-height: 0; }
    .tree { width: 270px; flex-shrink: 0; border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
    .tree-bar { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--border-sub, var(--border)); }
    .tree-list { flex: 1; overflow: auto; padding: 4px 0 12px; }
    .floor-row, .room-row { display: flex; align-items: center; gap: 4px; padding: 0 8px; }
    .floor-row { margin-top: 8px; }
    .floor-row.sel, .room-row.sel { background: var(--bg-active); }
    .room-row:hover, .floor-row:hover { background: var(--bg-hover); }
    .floor-name, .room-name { flex: 1; text-align: left; background: none !important; color: var(--fg) !important; padding: 3px 0 !important; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .floor-name { font-weight: 600; font-size: 11px !important; text-transform: uppercase; letter-spacing: 0.4px; color: var(--fg-muted) !important; }
    .nofloor { padding: 3px 0; }
    .room-name { padding-left: 10px !important; }
    .auto { margin-left: 6px; font-size: 9px; text-transform: uppercase; color: var(--fg-muted); border: 1px solid var(--border); border-radius: 6px; padding: 0 4px; }
    .ord { display: inline-flex; gap: 4px; visibility: hidden; }
    .room-row:hover .ord, .floor-row:hover .ord, .sel .ord { visibility: visible; }
    .ord :global(button.link) { font-size: 9px; color: var(--fg-muted); }
    .n { min-width: 18px; text-align: right; }
    .unassigned { display: block; margin: 12px 8px 4px; background: none !important; color: var(--accent) !important; padding: 0 !important; font-size: 11px !important; text-align: left; }
    .rej-row { display: flex; gap: 8px; align-items: center; padding: 2px 16px; color: var(--fg-muted); }
    .rej-row span { flex: 1; text-decoration: line-through; }
    .pad { padding: 6px 8px; display: block; }
    .detail { flex: 1; min-width: 0; overflow: auto; padding: 10px 14px 20px; display: flex; flex-direction: column; gap: 12px; }
    .form { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: flex-end; }
    .form label { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--fg-muted); }
    .form label.wide { flex: 1 1 320px; }
    .form label.wide input { width: 100%; box-sizing: border-box; }
    .form p { width: 100%; margin: 0; }
    .form-actions { width: 100%; display: flex; align-items: center; gap: 10px; }
    .spacer { flex: 1; }
    .merge { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .members-bar { display: flex; align-items: center; }
    .members-bar h3 { margin: 0; }
    .members { border-top: 1px solid var(--border); }
    .dev-row { display: flex; align-items: center; gap: 10px; padding: 6px 4px 2px; border-bottom: 1px solid var(--border-sub, var(--border)); }
    .dev-name { font-weight: 600; font-size: 12px !important; color: var(--fg-text) !important; }
    .ent-row { display: grid; grid-template-columns: minmax(160px, 2fr) minmax(110px, 1fr) minmax(120px, 2fr) 90px 60px; gap: 8px; align-items: center; padding: 3px 4px 3px 20px; border-bottom: 1px solid var(--border-sub, var(--border)); }
    .ent-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chips { display: flex; gap: 4px; flex-wrap: wrap; }
    .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 100; }
    .dialog { position: fixed; top: 6vh; left: 50%; transform: translateX(-50%); width: min(900px, 94vw); height: 80vh; z-index: 101; background: var(--bg-widget, var(--bg-panel)); border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6); display: flex; flex-direction: column; gap: 8px; }
    .dlg-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .radio { display: inline-flex; align-items: center; gap: 4px; }
</style>
