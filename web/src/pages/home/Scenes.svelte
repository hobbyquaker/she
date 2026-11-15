<script lang="ts">
    /**
     * Scenes: stored states of entities that are datapoints themselves — true while every member is
     * in its state. On the left the scenes and groups by room with their live state and the buttons
     * to recall and deactivate; on the right the editor of a scene (members, attributes with
     * tolerance, role, order and delay, the deactivation, the settle time) or of a group.
     *
     * Live: the states of scenes and groups come over the WebSocket (`scenes:scene`,
     * `scenes:group`); the current values of the open scene's members are read every few seconds,
     * because a value that moves inside its tolerance changes no state.
     */
    import { onDestroy, untrack } from 'svelte';
    import { subscribeWs } from '../../lib/ws.js';
    import {
        getScenes, getScene, saveScene, deleteScene, sceneAction, sceneEntities, saveSceneGroup, deleteSceneGroup, setSceneGroup, SceneConfirmError,
        type HomeModelData, type SceneListItem, type SceneGroup, type SceneDoc, type SceneMember, type SceneState, type SceneEntityLive, type SceneRole, type SceneActionResult,
    } from '../../lib/api.js';
    import EntityPicker from '../../lib/EntityPicker.svelte';
    import { plural } from '../../lib/home.js';
    import type { HomeCtx } from './ctx.js';

    let { data, ctx, busy = false, active = true }: { data: HomeModelData; ctx: HomeCtx; busy?: boolean; active?: boolean } = $props();

    const rooms = $derived(data.rooms ?? []);
    const entities = $derived(data.entities ?? []);
    const devices = $derived(data.devices ?? []);
    const entityById = $derived(new Map(entities.map((e) => [e.id, e])));
    const entityName = (id: string) => entityById.get(id)?.eff.name ?? id.replace(/^she\/entity\//, '');
    const roomName = (id: string | null | undefined) => (id ? (rooms.find((r) => r.id === id)?.name ?? id) : 'No room');

    let available = $state(true);
    let reason = $state('');
    let scenes = $state<SceneListItem[]>([]);
    let groups = $state<SceneGroup[]>([]);
    let loaded = $state(false);

    async function loadList() {
        try {
            const r = await getScenes();
            available = r.available;
            reason = r.reason ?? '';
            scenes = r.scenes;
            groups = r.groups;
        } catch (e) {
            reason = e instanceof Error ? e.message : String(e);
        }
        loaded = true;
    }
    $effect(() => {
        if (active && !loaded) untrack(loadList);
    });

    // live: a scene or group changed, was created or deleted
    const unsubScene = subscribeWs('scenes:scene', (msg) => {
        const id = msg.id as string;
        const st = msg.state as SceneState | null;
        const i = scenes.findIndex((s) => s.id === id);
        if (!st || i < 0) {
            loadList();
        } else {
            scenes[i] = { ...scenes[i], val: st.val, matched: st.matched, total: st.total, settling: st.settling };
        }
        if (sel === 'scene:' + id && st) liveState = st;
    });
    const unsubGroup = subscribeWs('scenes:group', (msg) => {
        const id = msg.id as string;
        const st = msg.state as SceneGroup | null;
        const i = groups.findIndex((g) => g.id === id);
        if (!st || i < 0) loadList();
        else groups[i] = st;
    });
    onDestroy(() => {
        unsubScene();
        unsubGroup();
        if (poll) clearInterval(poll);
    });

    // ── the list ──
    const areas = $derived.by(() => {
        const ids = new Set<string | null>([...scenes.map((s) => s.area ?? null), ...groups.map((g) => g.area ?? null)]);
        const ordered = rooms.filter((r) => ids.has(r.id)).map((r) => r.id as string | null);
        for (const id of ids) if (!ordered.includes(id) && id !== null) ordered.push(id);
        if (ids.has(null)) ordered.push(null);
        return ordered;
    });

    /** 'scene:<id>' | 'group:<id>' | 'new-scene' | 'new-group' | null */
    let sel = $state<string | null>(null);

    function result(r: SceneActionResult | undefined, what: string): string | null {
        if (!r) return null;
        if (r.ok === false) return `${what}: ${r.reason}`;
        const parts = [what];
        if (r.sent !== undefined) parts.push(`${r.sent} commanded${r.skipped ? `, ${r.skipped} already there` : ''}`);
        if (r.reason) parts.push(r.reason);
        if (r.problems?.length) parts.push(r.problems.join('; '));
        return parts.join(' — ') + '.';
    }
    function act(id: string, action: 'recall' | 'deactivate', force = false) {
        const name = scenes.find((s) => s.id === id)?.name ?? id;
        ctx.act(() => sceneAction(id, action, force), (r) => result(r, `${name}: ${action === 'recall' ? (force ? 'recalled (every member)' : 'recalled') : 'deactivated'}`));
    }
    function setGroup(g: SceneGroup, scene: string) {
        ctx.act(() => setSceneGroup(g.id, scene), (r) => result(r, `${g.name}: ${scene ? (scenes.find((s) => s.id === scene)?.name ?? scene) : 'none'}`)).then(loadList);
    }

    // ── the scene editor ──
    interface Row { entity: string; role: SceneRole; order: string; delay: string; attrs: { key: string; value: string; tol: string }[]; confirmed?: boolean; extra: Record<string, unknown> }
    let form = $state<{ id: string; name: string; area: string; icon: string; deactivate: string; settle: string; rows: Row[] } | null>(null);
    let base = $state('');
    let liveState = $state<SceneState | null>(null);
    let live = $state<Record<string, SceneEntityLive | null>>({});
    let poll: ReturnType<typeof setInterval> | null = null;

    const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
    function parse(text: string): unknown {
        const t = text.trim();
        if (t === '') return '';
        try {
            return JSON.parse(t);
        } catch {
            return t;
        }
    }
    function toRow(m: SceneMember): Row {
        const { entity, attributes, tolerance, role, order, delay, confirmed, ...extra } = m;
        return {
            entity,
            role: role ?? 'recall+match',
            order: order === null || order === undefined ? '' : String(order),
            delay: delay === null || delay === undefined ? '' : String(delay),
            attrs: Object.entries(attributes ?? {}).map(([key, v]) => ({ key, value: show(v), tol: tolerance?.[key] === undefined ? '' : show(tolerance[key]) })),
            confirmed,
            extra,
        };
    }
    function toMember(r: Row): SceneMember {
        const attributes: Record<string, unknown> = {};
        const tolerance: Record<string, number | number[]> = {};
        for (const a of r.attrs) {
            if (!a.key.trim()) continue;
            attributes[a.key.trim()] = parse(a.value);
            if (a.tol.trim() !== '') tolerance[a.key.trim()] = parse(a.tol) as number;
        }
        const m: SceneMember = { ...r.extra, entity: r.entity, attributes, role: r.role };
        if (Object.keys(tolerance).length) m.tolerance = tolerance;
        if (r.order.trim() !== '') m.order = Number(r.order);
        if (r.delay.trim() !== '') m.delay = Number(r.delay);
        if (r.confirmed) m.confirmed = true;
        return m;
    }
    function docOf(f: NonNullable<typeof form>): SceneDoc {
        return {
            name: f.name.trim(),
            area: f.area || null,
            icon: f.icon.trim() || null,
            deactivate: f.deactivate,
            settle: f.settle.trim() === '' ? 10 : Number(f.settle),
            members: f.rows.map(toMember),
        };
    }
    const dirty = $derived(!!form && JSON.stringify(docOf(form)) !== base);

    async function refreshLive() {
        if (!form || !form.rows.length) return;
        try {
            live = { ...live, ...(await sceneEntities(form.rows.map((r) => r.entity))) };
        } catch {
            /* the next tick tries again */
        }
    }
    function startPoll() {
        if (poll) clearInterval(poll);
        poll = setInterval(() => {
            if (active && form) refreshLive();
        }, 3000);
    }

    async function openScene(id: string) {
        if (dirty && !(await ctx.confirm('Discard the changes to this scene?', { confirm: 'Discard' }))) return;
        sel = 'scene:' + id;
        try {
            const r = await getScene(id);
            form = {
                id,
                name: r.doc.name,
                area: r.doc.area ?? '',
                icon: r.doc.icon ?? '',
                deactivate: r.doc.deactivate,
                settle: String(r.doc.settle ?? 10),
                rows: r.doc.members.map(toRow),
            };
            base = JSON.stringify(docOf(form));
            liveState = r.state;
            live = r.members;
            startPoll();
        } catch (e) {
            ctx.confirm(e instanceof Error ? e.message : String(e), { alert: true });
        }
    }
    async function newScene() {
        if (dirty && !(await ctx.confirm('Discard the changes to this scene?', { confirm: 'Discard' }))) return;
        sel = 'new-scene';
        form = { id: '', name: '', area: '', icon: '', deactivate: 'none', settle: '10', rows: [] };
        base = JSON.stringify(docOf(form));
        liveState = null;
        live = {};
        startPoll();
    }
    const isNew = $derived(sel === 'new-scene');
    const slugOf = (s: string) =>
        s
            .replace(/ß/g, 'ss')
            .normalize('NFKD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    let idTouched = $state(false);
    $effect(() => {
        if (isNew && form && !idTouched) {
            const s = slugOf(form.name);
            untrack(() => form && (form.id = s));
        }
    });

    async function save(confirmSensitive = false): Promise<void> {
        if (!form) return;
        const f = form;
        if (!f.name.trim() || !/^[A-Za-z0-9_-]+$/.test(f.id)) return;
        if (isNew && scenes.some((s) => s.id === f.id)) {
            await ctx.confirm(`A scene with the id "${f.id}" exists.`, { alert: true });
            return;
        }
        const doc = docOf(f);
        let needs: string[] | null = null;
        const saved = await ctx.act(
            async () => {
                try {
                    return await saveScene(f.id, doc, confirmSensitive);
                } catch (e) {
                    if (e instanceof SceneConfirmError) {
                        needs = e.confirm;
                        return null;
                    }
                    throw e;
                }
            },
            (r) => (r ? `Scene "${doc.name}" saved.` : null),
        );
        if (needs) {
            const locks = f.rows.filter((r) => ['lock', 'alarm_control_panel'].includes(live[r.entity]?.component ?? entityById.get(r.entity)?.ha.component ?? '') && r.role !== 'match');
            const names = locks.length ? locks.map((r) => entityName(r.entity)) : needs;
            const ok = await ctx.confirm(
                `This scene commands ${names.join(', ')} — ${names.length === 1 ? 'a lock or an alarm panel' : 'locks or alarm panels'}. Recalling it (from here, a script, a group, Home Assistant or a button) will lock, unlock or arm them without asking again. Save it with that permission?`,
                { confirm: 'Allow and save', danger: true },
            );
            if (ok) return save(true);
            return;
        }
        if (saved) {
            await loadList();
            idTouched = false;
            await openSceneQuiet(f.id);
        }
    }
    /** re-read the open scene without asking about a draft (after a save) */
    async function openSceneQuiet(id: string) {
        base = '';
        form = null;
        await openScene(id);
    }
    async function remove() {
        if (!form || isNew) return;
        const f = form;
        const groupsOf = groups.filter((g) => g.scenes.includes(f.id));
        if (!(await ctx.confirm(`Delete the scene "${f.name}"?${groupsOf.length ? ` It is taken out of ${groupsOf.map((g) => `"${g.name}"`).join(', ')}.` : ''} Its status topic is cleared.`, { confirm: 'Delete', danger: true }))) return;
        const ok = await ctx.act(() => deleteScene(f.id), `Scene "${f.name}" deleted.`);
        if (ok) {
            form = null;
            base = '';
            sel = null;
            await loadList();
        }
    }

    // members
    let picking = $state(false);
    let pick = $state<string[]>([]);
    let pickRoom = $state('');
    function openPicker() {
        pick = [];
        pickRoom = form?.area ?? '';
        picking = true;
    }
    async function addPicked() {
        if (!form || !pick.length) return;
        const ids = pick;
        picking = false;
        const got = await sceneEntities(ids).catch(() => ({}) as Record<string, SceneEntityLive | null>);
        live = { ...live, ...got };
        for (const id of ids) {
            const l = got[id];
            const writable = !!l && (l.stateless || Object.values(l.attributes).some((a) => a.write));
            form.rows.push(toRow({ entity: id, attributes: l?.snapshot ?? {}, role: writable ? 'recall+match' : 'match' }));
        }
    }
    function takeCurrent(r: Row) {
        const l = live[r.entity];
        if (!l) return;
        const tol = new Map(r.attrs.map((a) => [a.key, a.tol]));
        r.attrs = Object.entries(l.snapshot).map(([key, v]) => ({ key, value: show(v), tol: tol.get(key) ?? '' }));
    }
    async function takeAllCurrent() {
        await refreshLive();
        if (form) for (const r of form.rows) takeCurrent(r);
    }
    function addAttr(r: Row, key: string) {
        if (!key || r.attrs.some((a) => a.key === key)) return;
        const v = live[r.entity]?.state?.[key];
        r.attrs.push({ key, value: v === undefined ? '' : show(v), tol: '' });
    }
    /** does the current value match the stored one? (a rough check for the editor; the engine decides) */
    function near(key: string, want: string, tol: string, is: unknown): boolean | null {
        if (is === undefined) return null;
        const w = parse(want);
        if (typeof w === 'number' && typeof is === 'number') {
            const t = tol.trim() === '' ? (DEFAULT_TOL[key] ?? 0) : Number(parse(tol));
            return Math.abs(w - is) <= (Number.isFinite(t) ? t : 0) + 1e-9;
        }
        if (typeof w === 'string' && typeof is === 'string') return w.toLowerCase() === is.toLowerCase();
        return JSON.stringify(w) === JSON.stringify(is);
    }
    const DEFAULT_TOL: Record<string, number> = { brightness: 2, white: 2, color_temp: 5, position: 2, tilt: 2, percentage: 2, temperature: 0.25, temperature_low: 0.25, temperature_high: 0.25, target_humidity: 1 };
    function move(i: number, dir: -1 | 1) {
        if (!form) return;
        const j = i + dir;
        if (j < 0 || j >= form.rows.length) return;
        const rows = [...form.rows];
        [rows[i], rows[j]] = [rows[j], rows[i]];
        form.rows = rows;
    }
    const sensitiveRow = (r: Row) => ['lock', 'alarm_control_panel'].includes(live[r.entity]?.component ?? entityById.get(r.entity)?.ha.component ?? '');

    // ── the group editor ──
    let gform = $state<{ id: string; name: string; area: string; scenes: string[]; def: string } | null>(null);
    let gbase = $state('');
    const gIsNew = $derived(sel === 'new-group');
    const gdirty = $derived(!!gform && JSON.stringify(gform) !== gbase);
    let gIdTouched = $state(false);
    $effect(() => {
        if (gIsNew && gform && !gIdTouched) {
            const s = slugOf(gform.name);
            untrack(() => gform && (gform.id = s));
        }
    });
    function openGroup(g: SceneGroup) {
        sel = 'group:' + g.id;
        form = null;
        if (poll) clearInterval(poll);
        gform = { id: g.id, name: g.name, area: g.area ?? '', scenes: [...g.scenes], def: g.default ?? '' };
        gbase = JSON.stringify(gform);
    }
    function newGroup() {
        sel = 'new-group';
        form = null;
        if (poll) clearInterval(poll);
        gform = { id: '', name: '', area: '', scenes: [], def: '' };
        gbase = JSON.stringify(gform);
        gIdTouched = false;
    }
    let addSceneId = $state('');
    async function saveGroup() {
        if (!gform || !gform.name.trim() || !/^[A-Za-z0-9_-]+$/.test(gform.id)) return;
        const g = gform;
        if (gIsNew && groups.some((x) => x.id === g.id)) {
            await ctx.confirm(`A group with the id "${g.id}" exists.`, { alert: true });
            return;
        }
        const ok = await ctx.act(() => saveSceneGroup(g.id, { name: g.name.trim(), area: g.area || null, scenes: g.scenes, default: g.def || null }), `Group "${g.name}" saved.`);
        if (ok) {
            await loadList();
            const fresh = groups.find((x) => x.id === g.id);
            if (fresh) openGroup(fresh);
        }
    }
    async function removeGroup() {
        if (!gform || gIsNew) return;
        const g = gform;
        if (!(await ctx.confirm(`Delete the group "${g.name}"? Its scenes stay.`, { confirm: 'Delete', danger: true }))) return;
        const ok = await ctx.act(() => deleteSceneGroup(g.id), `Group "${g.name}" deleted.`);
        if (ok) {
            gform = null;
            sel = null;
            await loadList();
        }
    }
    function gmove(i: number, dir: -1 | 1) {
        if (!gform) return;
        const j = i + dir;
        if (j < 0 || j >= gform.scenes.length) return;
        const s = [...gform.scenes];
        [s[i], s[j]] = [s[j], s[i]];
        gform.scenes = s;
    }
    const sceneName = (id: string) => scenes.find((s) => s.id === id)?.name ?? id;
    const fmtTime = (ts: number | null) => (ts ? new Date(ts).toLocaleTimeString() : '');
</script>

<div class="scenes">
    {#if !loaded}
        <p class="dim pad">Loading…</p>
    {:else if !available}
        <p class="dim pad">{reason || 'Scenes are not available.'}</p>
    {:else}
        <aside class="list">
            <div class="bar">
                <button class="sm" onclick={newScene} disabled={busy}>+ Scene</button>
                <button class="sm ghost" onclick={newGroup} disabled={busy}>+ Group</button>
            </div>
            <div class="items">
                {#each areas as area (area ?? '-')}
                    <div class="area">{roomName(area)}</div>
                    {#each groups.filter((g) => (g.area ?? null) === area) as g (g.id)}
                        <div class="grp-row" class:sel={sel === 'group:' + g.id}>
                            <button class="gname" onclick={() => openGroup(g)} title="Scene group">⧉ {g.name}</button>
                            <select value={g.val} onchange={(e) => setGroup(g, (e.currentTarget as HTMLSelectElement).value)} disabled={busy} title="Recall a scene of the group; none = the group's deactivation">
                                <option value="">none</option>
                                {#each g.scenes as s (s)}<option value={s}>{sceneName(s)}</option>{/each}
                            </select>
                        </div>
                    {/each}
                    {#each scenes.filter((s) => (s.area ?? null) === area) as s (s.id)}
                        <div class="srow" class:sel={sel === 'scene:' + s.id}>
                            <span class="dot" class:on={s.val} class:settling={s.settling && !s.val} title={s.val ? 'active: every member matches' : s.settling ? 'settling after a recall' : 'not active'}></span>
                            <button class="sname" onclick={() => openScene(s.id)}>{s.name}{#if s.sensitive}<span class="lockmark" title="commands a lock or an alarm panel">🔒</span>{/if}</button>
                            <span class="dim n">{s.matched}/{s.total}</span>
                            <button class="link" title="Recall" disabled={busy} onclick={() => act(s.id, 'recall')}>▶</button>
                            <button class="link" title="Deactivate ({s.deactivate})" disabled={busy} onclick={() => act(s.id, 'deactivate')}>■</button>
                        </div>
                    {/each}
                {/each}
                {#if !scenes.length && !groups.length}<p class="dim pad">No scenes yet. A scene stores the state of some entities — lamps, blinds, a thermostat — and is on while they are in it.</p>{/if}
            </div>
        </aside>

        <section class="detail">
            {#if form}
                {@const f = form}
                <div class="form">
                    <label>Name <input type="text" bind:value={f.name} placeholder="Movie night" /></label>
                    {#if isNew}
                        <label>Id <input type="text" bind:value={f.id} oninput={() => (idTouched = true)} spellcheck="false" class="mono" /></label>
                    {/if}
                    <label>Room
                        <select bind:value={f.area}>
                            <option value="">—</option>
                            {#each rooms as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
                        </select>
                    </label>
                    <label>Icon <input type="text" bind:value={f.icon} placeholder="mdi:movie" spellcheck="false" /></label>
                    <label title="What setting the scene false does">Deactivate
                        <select bind:value={f.deactivate}>
                            <option value="none">nothing (default)</option>
                            <option value="restore">restore what it changed (untouched entities only)</option>
                            <option value="off">switch its lights, switches and fans off</option>
                            {#each scenes.filter((s) => s.id !== f.id) as s (s.id)}<option value={'scene:' + s.id}>recall “{s.name}”</option>{/each}
                        </select>
                    </label>
                    <label title="Seconds after a recall during which a mismatch is not yet reported">Settle (s) <input type="number" min="0" max="3600" step="1" bind:value={f.settle} /></label>
                </div>
                {#if !isNew}<p class="dim mono">she/scene/{f.id} · topics {`<name>/status/scene/${f.id}`}, {`<name>/set/scene/${f.id}`}</p>{/if}

                {#if liveState && !isNew}
                    <div class="state" class:on={liveState.val}>
                        <strong>{liveState.val ? 'Active' : liveState.settling ? 'Settling…' : 'Not active'}</strong>
                        <span class="dim">{liveState.matched} of {plural(liveState.total, 'member')} match{liveState.recalled ? ` · recalled ${fmtTime(liveState.recalled)}` : ''}</span>
                        <span class="spacer"></span>
                        <button class="sm" disabled={busy || dirty} title={dirty ? 'Save first' : 'Command the members that differ'} onclick={() => act(f.id, 'recall')}>Recall</button>
                        <button class="sm ghost" disabled={busy || dirty} title="Command every member" onclick={() => act(f.id, 'recall', true)}>Force</button>
                        <button class="sm ghost" disabled={busy || dirty} onclick={() => act(f.id, 'deactivate')}>Deactivate</button>
                    </div>
                    {#if liveState.mismatch.length || liveState.unknown.length}
                        <ul class="mismatch">
                            {#each liveState.mismatch as m, i (i)}<li><span>{m.name}</span> <code>{m.attribute}</code> is <b>{show(m.is)}</b>, wants <b>{show(m.want)}</b></li>{/each}
                            {#each liveState.unknown as u, i (i)}<li class="unk"><span>{u.name}</span>{#if u.attribute} <code>{u.attribute}</code>{/if}: {u.reason}</li>{/each}
                        </ul>
                    {/if}
                {/if}

                <div class="mbar">
                    <h3>Members <span class="dim">· {f.rows.length}</span></h3>
                    <span class="spacer"></span>
                    <button class="sm ghost" onclick={takeAllCurrent} disabled={busy || !f.rows.length} title="Every member's stored state from its state now (save to keep)">Update all from current state</button>
                    <button class="sm" onclick={openPicker} disabled={busy}>Add entities…</button>
                </div>
                <div class="members">
                    {#each f.rows as r, i (r.entity)}
                        {@const l = live[r.entity]}
                        <div class="member" class:sens={sensitiveRow(r)}>
                            <div class="mhead">
                                <span class="ord">
                                    <button class="link" disabled={i === 0} onclick={() => move(i, -1)}>▲</button>
                                    <button class="link" disabled={i === f.rows.length - 1} onclick={() => move(i, 1)}>▼</button>
                                </span>
                                <span class="mname">{entityName(r.entity)}</span>
                                <span class="mono dim">{l?.component ?? entityById.get(r.entity)?.ha.component ?? '?'}</span>
                                {#if !l}<span class="warn">not announced</span>{:else if l.available === false}<span class="warn">unavailable</span>{/if}
                                {#if sensitiveRow(r) && r.role !== 'match'}<span class="warn" title="Locks and alarm panels are commanded only after a confirmed save">{r.confirmed ? '🔒 confirmed' : '🔒 needs confirmation'}</span>{/if}
                                <span class="spacer"></span>
                                <label class="inl" title="recall+match: set and checked; match: only checked (a condition); recall: only set">Role
                                    <select bind:value={r.role}>
                                        <option value="recall+match">recall + match</option>
                                        <option value="match">match only</option>
                                        <option value="recall">recall only</option>
                                    </select>
                                </label>
                                <label class="inl" title="Members are commanded by order (lower first), then as listed">Order <input type="number" step="1" bind:value={r.order} class="num" placeholder="0" /></label>
                                <label class="inl" title="Seconds to wait before commanding this member">Delay <input type="number" min="0" step="0.5" bind:value={r.delay} class="num" placeholder="0" /></label>
                                <button class="link" disabled={!l} onclick={() => takeCurrent(r)} title="Its stored state from its state now">take current</button>
                                <button class="link" onclick={() => (f.rows = f.rows.filter((x) => x !== r))}>remove</button>
                            </div>
                            <div class="attrs">
                                {#if r.attrs.length}
                                    <div class="ahead"><span>Attribute</span><span>Value</span><span>Tolerance</span><span>Now</span><span></span></div>
                                {/if}
                                {#each r.attrs as a, k (k)}
                                    {@const now = l?.state?.[a.key]}
                                    {@const ok = near(a.key, a.value, a.tol, now)}
                                    <div class="arow">
                                        <input type="text" bind:value={a.key} spellcheck="false" class="mono" />
                                        {#if l?.attributes?.[a.key]?.options}
                                            <select bind:value={a.value}>{#each l.attributes[a.key].options ?? [] as o (o)}<option value={o}>{o}</option>{/each}</select>
                                        {:else}
                                            <input type="text" bind:value={a.value} spellcheck="false" />
                                        {/if}
                                        <input type="text" bind:value={a.tol} placeholder={DEFAULT_TOL[a.key] !== undefined ? `±${DEFAULT_TOL[a.key]}` : 'exact'} spellcheck="false" />
                                        <span class="now" class:ok={ok === true} class:bad={ok === false}>{now === undefined ? '—' : show(now)}</span>
                                        <button class="link" onclick={() => (r.attrs = r.attrs.filter((_, x) => x !== k))}>×</button>
                                    </div>
                                {/each}
                                {#if l && !l.stateless}
                                    {@const more = Object.keys(l.attributes).filter((key) => !r.attrs.some((a) => a.key === key))}
                                    {#if more.length}
                                        <select class="addattr" value="" onchange={(e) => { addAttr(r, (e.currentTarget as HTMLSelectElement).value); (e.currentTarget as HTMLSelectElement).value = ''; }}>
                                            <option value="">+ attribute…</option>
                                            {#each more as key (key)}<option value={key}>{key}</option>{/each}
                                        </select>
                                    {/if}
                                {:else if l?.stateless}
                                    <span class="dim">a {l.component}: pressed on recall, never matched</span>
                                {/if}
                            </div>
                        </div>
                    {/each}
                    {#if !f.rows.length}<p class="dim pad">No members yet. <button class="link" onclick={openPicker}>Add entities</button> — their present state becomes the scene's.</p>{/if}
                </div>
                <div class="actions">
                    <button onclick={() => save()} disabled={busy || !f.name.trim() || !/^[A-Za-z0-9_-]+$/.test(f.id) || (!dirty && !isNew)}>{isNew ? 'Create scene' : 'Save'}</button>
                    {#if !isNew}<button class="ghost" disabled={busy || !dirty} onclick={() => openSceneQuiet(f.id)}>Revert</button>{/if}
                    {#if dirty && !isNew}<span class="dim">unsaved changes — recall works on the saved scene</span>{/if}
                    <span class="spacer"></span>
                    {#if !isNew}<button class="danger sm" disabled={busy} onclick={remove}>Delete scene</button>{/if}
                </div>
            {:else if gform}
                {@const g = gform}
                <div class="form">
                    <label>Name <input type="text" bind:value={g.name} placeholder="Living room light" /></label>
                    {#if gIsNew}<label>Id <input type="text" bind:value={g.id} oninput={() => (gIdTouched = true)} spellcheck="false" class="mono" /></label>{/if}
                    <label>Room
                        <select bind:value={g.area}>
                            <option value="">—</option>
                            {#each rooms as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
                        </select>
                    </label>
                    <label title="What setting the group to none recalls; without one, none deactivates the active scene">Default
                        <select bind:value={g.def}>
                            <option value="">— (none deactivates)</option>
                            {#each g.scenes as s (s)}<option value={s}>{sceneName(s)}</option>{/each}
                        </select>
                    </label>
                </div>
                {#if !gIsNew}<p class="dim mono">she/scenegroup/{g.id} · topics {`<name>/status/scenegroup/${g.id}`}, {`<name>/set/scenegroup/${g.id}`}</p>{/if}
                <p class="dim">A group shows the first of its scenes that is active (the order below decides when several are), and recalling one of them stops what another one of the group was still sending.</p>
                <h3>Scenes</h3>
                <div class="gscenes">
                    {#each g.scenes as s, i (s)}
                        <div class="gsrow">
                            <span class="ord">
                                <button class="link" disabled={i === 0} onclick={() => gmove(i, -1)}>▲</button>
                                <button class="link" disabled={i === g.scenes.length - 1} onclick={() => gmove(i, 1)}>▼</button>
                            </span>
                            <span class="dot" class:on={scenes.find((x) => x.id === s)?.val}></span>
                            <span>{sceneName(s)}</span>
                            {#if !scenes.some((x) => x.id === s)}<span class="warn">no such scene</span>{/if}
                            <span class="spacer"></span>
                            <button class="link" onclick={() => { g.scenes = g.scenes.filter((x) => x !== s); if (g.def === s) g.def = ''; }}>remove</button>
                        </div>
                    {/each}
                    <div class="gsadd">
                        <select bind:value={addSceneId}>
                            <option value="">add a scene…</option>
                            {#each scenes.filter((s) => !g.scenes.includes(s.id)) as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
                        </select>
                        <button class="sm ghost" disabled={!addSceneId} onclick={() => { g.scenes = [...g.scenes, addSceneId]; addSceneId = ''; }}>Add</button>
                    </div>
                </div>
                <div class="actions">
                    <button onclick={saveGroup} disabled={busy || !g.name.trim() || !/^[A-Za-z0-9_-]+$/.test(g.id) || (!gdirty && !gIsNew)}>{gIsNew ? 'Create group' : 'Save'}</button>
                    <span class="spacer"></span>
                    {#if !gIsNew}<button class="danger sm" disabled={busy} onclick={removeGroup}>Delete group</button>{/if}
                </div>
            {:else}
                <p class="dim pad">Choose a scene or a group, or create one. A scene is active while every member is in its stored state, whoever brought it there; recalling it commands only the members that differ.</p>
            {/if}
        </section>
    {/if}
</div>

{#if picking && form}
    <div class="backdrop" role="presentation" onclick={() => (picking = false)}></div>
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Add entities">
        <h3>Add entities to “{form.name || 'the new scene'}”</h3>
        <EntityPicker {entities} {devices} {rooms} floors={data.floors ?? []} functions={data.functions ?? []} bind:selected={pick} bind:room={pickRoom} exclude={form.rows.map((r) => r.entity)} />
        <div class="dlg-actions">
            <span class="dim">Their present state becomes what the scene stores; edit it afterwards.</span>
            <span class="spacer"></span>
            <button class="ghost" onclick={() => (picking = false)}>Cancel</button>
            <button onclick={addPicked} disabled={!pick.length}>Add {pick.length || ''}</button>
        </div>
    </div>
{/if}

<style>
    .scenes { flex: 1; display: flex; min-height: 0; }
    .pad { padding: 10px 12px; }
    .list { width: 290px; flex-shrink: 0; border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
    .bar { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--border-sub, var(--border)); }
    .items { flex: 1; overflow: auto; padding-bottom: 12px; }
    .area { margin: 10px 8px 2px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--fg-muted); }
    .srow, .grp-row { display: flex; align-items: center; gap: 6px; padding: 1px 8px 1px 12px; }
    .srow:hover, .grp-row:hover { background: var(--bg-hover); }
    .srow.sel, .grp-row.sel { background: var(--bg-active); }
    .sname, .gname { flex: 1; text-align: left; background: none !important; color: var(--fg) !important; padding: 3px 0 !important; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gname { color: var(--fg-muted) !important; }
    .grp-row select { max-width: 120px; font-size: 11px !important; padding: 1px 4px !important; }
    .lockmark { margin-left: 4px; font-size: 10px; }
    .n { min-width: 26px; text-align: right; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-dim); flex-shrink: 0; }
    .dot.on { background: var(--fg-ok, #98c379); }
    .dot.settling { background: var(--fg-warn, #d19a66); }
    .detail { flex: 1; min-width: 0; overflow: auto; padding: 10px 14px 20px; display: flex; flex-direction: column; gap: 8px; }
    .detail p { margin: 0; line-height: 1.5; }
    .form { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: flex-end; }
    .form label { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--fg-muted); }
    .form input[type='number'] { width: 80px; }
    .state { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 4px; border-left: 3px solid var(--fg-dim); }
    .state.on { border-left-color: var(--fg-ok, #98c379); }
    .spacer { flex: 1; }
    .mismatch { margin: 0; padding: 4px 10px 4px 28px; font-size: 12px; border: 1px dashed var(--border); border-radius: 4px; }
    .mismatch li { margin: 1px 0; }
    .mismatch li span { font-weight: 600; }
    .mismatch li.unk { color: var(--fg-muted); }
    code { color: var(--accent); font-size: 11px; }
    .mbar { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
    .mbar h3 { margin: 0; }
    .members { display: flex; flex-direction: column; gap: 6px; }
    .member { border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px 6px; }
    .member.sens { border-color: var(--fg-warn, #d19a66); }
    .mhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .mname { font-weight: 600; }
    .warn { color: var(--fg-warn, #d19a66); font-size: 11px; }
    .inl { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--fg-muted); }
    .num { width: 56px; }
    .ord { display: inline-flex; gap: 2px; }
    .ord :global(button.link) { font-size: 9px; color: var(--fg-muted); }
    .attrs { margin: 4px 0 0 30px; display: flex; flex-direction: column; gap: 3px; }
    .ahead, .arow { display: grid; grid-template-columns: 150px minmax(120px, 1fr) 90px minmax(90px, 1fr) 20px; gap: 6px; align-items: center; }
    .ahead { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--fg-muted); }
    .arow input, .arow select { min-width: 0; }
    .now { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .now.ok { color: var(--fg-ok, #98c379); }
    .now.bad { color: var(--fg-err, #e06c75); }
    .addattr { width: 150px; font-size: 11px !important; }
    .actions { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
    .gscenes { display: flex; flex-direction: column; gap: 2px; max-width: 520px; }
    .gsrow { display: flex; align-items: center; gap: 8px; padding: 3px 4px; border-bottom: 1px solid var(--border-sub, var(--border)); }
    .gsadd { display: flex; gap: 6px; margin-top: 6px; }
    .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 100; }
    .dialog { position: fixed; top: 6vh; left: 50%; transform: translateX(-50%); width: min(900px, 94vw); height: 80vh; z-index: 101; background: var(--bg-widget, var(--bg-panel)); border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6); display: flex; flex-direction: column; gap: 8px; }
    .dlg-actions { display: flex; align-items: center; gap: 12px; }
</style>
