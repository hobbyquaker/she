<script lang="ts">
    /**
     * Pick entities of the home model: a search and filters (room, floor, function, component, and
     * whether hidden and gone ones count) over a checkbox list. Used by the Meta page to put
     * entities into a room and by anything else that needs a set of entities (scenes).
     *
     * It takes the data from its caller (the Meta page holds the model already) and binds the
     * selection, a list of entity document ids. `multiple: false` keeps at most one.
     */
    import type { HomeEntity, HomeDevice, HomeRoom, HomeFloor, HomeFunction } from './api.js';
    import { entitySearchText, roomNames } from './home.js';

    let {
        entities = [],
        devices = [],
        rooms = [],
        floors = [],
        functions = [],
        selected = $bindable<string[]>([]),
        exclude = [],
        multiple = true,
        room = $bindable(''),
        showHidden = $bindable(false),
        limit = 400,
    }: {
        entities?: HomeEntity[];
        devices?: HomeDevice[];
        rooms?: HomeRoom[];
        floors?: HomeFloor[];
        functions?: HomeFunction[];
        selected?: string[];
        /** entity ids not offered (already members, say) */
        exclude?: string[];
        multiple?: boolean;
        /** the room filter: '' every room, '-' unassigned, else a room id */
        room?: string;
        showHidden?: boolean;
        /** rows rendered at most; the rest is counted */
        limit?: number;
    } = $props();

    let search = $state('');
    let floor = $state('');
    let fn = $state('');
    let component = $state('');
    let showGone = $state(false);

    const deviceById = $derived(new Map(devices.map((d) => [d.id, d])));
    const excluded = $derived(new Set(exclude));
    const components = $derived([...new Set(entities.map((e) => e.ha.component))].sort());

    const visible = $derived.by(() => {
        const q = search.trim().toLowerCase();
        return entities
            .filter((e) => {
                if (excluded.has(e.id)) return false;
                if (!showHidden && e.eff.hidden) return false;
                if (!showGone && !e.ha.present) return false;
                if (room === '-' ? e.eff.rooms.length > 0 : room && !e.eff.rooms.includes(room)) return false;
                if (floor && !e.eff.floors.includes(floor)) return false;
                if (fn && !e.eff.functions.includes(fn)) return false;
                if (component && e.ha.component !== component) return false;
                if (q && !q.split(/\s+/).every((w) => entitySearchText(e, deviceById.get(e.ha.device ?? '')).includes(w))) return false;
                return true;
            })
            .sort((a, b) => String(a.eff.name ?? a.id).localeCompare(String(b.eff.name ?? b.id)));
    });
    const shown = $derived(visible.slice(0, limit));
    const selectedSet = $derived(new Set(selected));
    const visibleSelected = $derived(visible.filter((e) => selectedSet.has(e.id)).length);

    function toggle(id: string) {
        if (!multiple) {
            selected = selectedSet.has(id) ? [] : [id];
            return;
        }
        selected = selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id];
    }
    function selectVisible() {
        selected = [...new Set([...selected, ...visible.map((e) => e.id)])];
    }
    function clearVisible() {
        const v = new Set(visible.map((e) => e.id));
        selected = selected.filter((id) => !v.has(id));
    }
</script>

<div class="picker">
    <div class="filters">
        <input class="search" type="search" placeholder="Search name, device, topic…" bind:value={search} spellcheck="false" />
        <select bind:value={room} title="Room">
            <option value="">all rooms</option>
            <option value="-">unassigned</option>
            {#each rooms as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
        </select>
        {#if floors.length}
            <select bind:value={floor} title="Floor">
                <option value="">all floors</option>
                {#each floors as f (f.id)}<option value={f.id}>{f.name}</option>{/each}
            </select>
        {/if}
        <select bind:value={fn} title="Function">
            <option value="">all functions</option>
            {#each functions as f (f.id)}<option value={f.id}>{f.name}</option>{/each}
        </select>
        <select bind:value={component} title="Component">
            <option value="">all components</option>
            {#each components as c (c)}<option value={c}>{c}</option>{/each}
        </select>
        <label class="chk"><input type="checkbox" bind:checked={showHidden} /><span class="checkmark"></span> hidden</label>
        <label class="chk"><input type="checkbox" bind:checked={showGone} /><span class="checkmark"></span> gone</label>
    </div>
    <div class="bar">
        <span class="dim">{visible.length} entit{visible.length === 1 ? 'y' : 'ies'}{selected.length ? ` · ${selected.length} selected` : ''}</span>
        {#if multiple}
            <span class="spacer"></span>
            <button type="button" class="link" onclick={selectVisible} disabled={!visible.length || visibleSelected === visible.length}>select all shown</button>
            <button type="button" class="link" onclick={clearVisible} disabled={!visibleSelected}>clear shown</button>
        {/if}
    </div>
    <div class="list" role="listbox" aria-multiselectable={multiple}>
        {#each shown as e (e.id)}
            {@const dev = deviceById.get(e.ha.device ?? '')}
            <label class="row" class:sel={selectedSet.has(e.id)} class:gone={!e.ha.present} class:hidden-e={e.eff.hidden}>
                <input class="box" type={multiple ? 'checkbox' : 'radio'} checked={selectedSet.has(e.id)} onchange={() => toggle(e.id)} />
                <span class="name">{e.eff.name ?? e.ha.unique_id}</span>
                <span class="comp">{e.ha.component}{e.ha.device_class ? ` · ${e.ha.device_class}` : ''}</span>
                <span class="dev dim">{dev?.eff.name ?? ''}</span>
                <span class="rooms dim">{roomNames(e.eff.rooms, rooms).join(', ')}</span>
            </label>
        {/each}
        {#if visible.length > shown.length}<div class="more dim">{visible.length - shown.length} more — narrow the search</div>{/if}
        {#if !visible.length}<div class="more dim">No entities match.</div>{/if}
    </div>
</div>

<style>
    .picker { display: flex; flex-direction: column; min-height: 0; flex: 1; gap: 6px; font-size: 12px; color: var(--fg); }
    .filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .search { flex: 1 1 180px; min-width: 140px; }
    input[type='search'], select { background: var(--bg-input, var(--bg-app)); border: 1px solid var(--border); color: var(--fg-text, var(--fg)); padding: 3px 6px; border-radius: 3px; font-size: 12px; }
    .bar { display: flex; align-items: center; gap: 8px; }
    .spacer { flex: 1; }
    .dim { color: var(--fg-muted); font-size: 11px; }
    .link { background: none; border: none; color: var(--accent); font-size: 11px; cursor: pointer; padding: 0; }
    .link:disabled { color: var(--fg-dim); cursor: default; }
    .list { flex: 1; min-height: 120px; overflow: auto; border: 1px solid var(--border); border-radius: 3px; }
    .row { display: grid; grid-template-columns: 16px minmax(140px, 2fr) minmax(90px, 1fr) minmax(90px, 1.3fr) minmax(70px, 1fr); gap: 8px; align-items: center; padding: 3px 8px; border-bottom: 1px solid var(--border-sub, var(--border)); cursor: pointer; }
    .row:hover { background: var(--bg-hover); }
    .row.sel { background: var(--bg-active); }
    .row.gone .name { text-decoration: line-through; color: var(--fg-dim); }
    .row.hidden-e .name { color: var(--fg-muted); font-style: italic; }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .comp { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dev, .rooms { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .more { padding: 8px; }
    .chk { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
    .box { margin: 0; accent-color: var(--accent); }
    .chk input { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .checkmark { flex-shrink: 0; width: 13px; height: 13px; border: 1.5px solid var(--border); border-radius: 2px; background: var(--bg-app); position: relative; }
    .chk input:checked + .checkmark { background: var(--accent); border-color: var(--accent); }
    .chk input:checked + .checkmark::after { content: ''; position: absolute; left: 3px; top: 0; width: 4px; height: 7px; border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg); }
    .chk input:focus-visible + .checkmark { outline: 1px solid var(--accent); outline-offset: 1px; }
</style>
