<script lang="ts">
    /**
     * The Bindings tab of the Matter page (roadmap M14): switch-to-device bindings — a device
     * drives another directly, without she in the loop — listed per source, created with a
     * source/target picker over the controller's candidates, deleted again. Bindings of other
     * fabrics are shown read-only (D-10).
     */
    import { onDestroy, untrack } from 'svelte';
    import { subscribeWs } from '../../lib/ws.js';
    import {
        listMatterBindings,
        getMatterBindingCandidates,
        addMatterBinding,
        removeMatterBinding,
        listMatterGroups,
        createMatterGroup,
        renameMatterGroup,
        deleteMatterGroup,
        addMatterGroupMember,
        removeMatterGroupMember,
        sendMatterGroupCommand,
        type MatterBinding,
        type MatterBindingCandidates,
        type MatterBindingEndpoint,
        type MatterBindingCluster,
        type MatterGroups,
        type MatterGroup,
    } from '../../lib/api.js';
    import InputDialog from '../../lib/InputDialog.svelte';
    import ConfirmDialog from '../../lib/ConfirmDialog.svelte';

    let { active = false }: { active?: boolean } = $props();

    let bindings = $state<MatterBinding[]>([]);
    let candidates = $state<MatterBindingCandidates>({ sources: [], targets: [], notBindable: [] });
    let loading = $state(false);
    let loadError = $state<string | null>(null);
    let loaded = $state(false);
    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean; alert?: boolean }): Promise<boolean> };

    let groupsData = $state<MatterGroups>({ available: false, error: null, groups: [], keySets: [] });
    let inputDialog: { show(msg: string, opts?: { placeholder?: string; confirm?: string; initial?: string }): Promise<string | null> };

    async function loadGroups() {
        try { groupsData = await listMatterGroups(); } catch (e) { groupsData = { available: false, error: e instanceof Error ? e.message : String(e), groups: [], keySets: [] }; }
    }
    async function load() {
        loading = true;
        loadError = null;
        try {
            const [b, c] = await Promise.all([listMatterBindings(), getMatterBindingCandidates(), loadGroups()]);
            bindings = b;
            candidates = c;
            loaded = true;
        } catch (e) {
            loadError = e instanceof Error ? e.message : String(e);
        } finally {
            loading = false;
        }
    }

    // load when the tab is first shown, reload when the daemon reports a change
    $effect(() => {
        if (active && !loaded) untrack(load);
    });
    const unsubBindings = subscribeWs('matter:bindings', () => { if (loaded) load(); });
    const unsubDevices = subscribeWs('matter:deviceList', () => { if (loaded) load(); });
    const unsubGroups = subscribeWs('matter:groups', () => { if (loaded) loadGroups(); });
    // a member's on/off or level changes → the derived state
    const unsubAttr = subscribeWs('matter:attr', (msg) => {
        if (!loaded || (msg.clusterName !== 'onOff' && msg.clusterName !== 'levelControl')) return;
        if (groupsData.groups.some((g) => g.members.some((m) => m.nodeId === String(msg.nodeId) && m.endpointId === msg.endpointId))) loadGroups();
    });
    onDestroy(() => { unsubBindings(); unsubDevices(); unsubGroups(); unsubAttr(); });

    function epLabel(ep: MatterBindingEndpoint): string {
        const dev = ep.nodeName ?? `Node ${ep.nodeId}`;
        const sub = ep.name ?? (ep.deviceTypeName ? `${ep.deviceTypeName}, ep ${ep.endpointId}` : `ep ${ep.endpointId}`);
        return `${dev} · ${sub}`;
    }
    function epKey(ep: { nodeId: string; endpointId: number }): string {
        return `${ep.nodeId}/${ep.endpointId}`;
    }

    // ── Rows: one per source → target, the clusters together ─────────────────
    interface Row {
        key: string;
        sourceNodeId: string;
        sourceEndpointId: number;
        source: string;
        target: string;
        targetNodeId: string | null;
        targetEndpointId: number | null;
        clusters: { id: number; name: string | null; label: string }[];
        own: boolean;
        fabricIndex?: number;
        group: number | null;
    }
    const CLUSTER_LABELS: Record<string, string> = { onOff: 'on/off', levelControl: 'dimming', colorControl: 'colour', windowCovering: 'blinds', thermostat: 'thermostat', fanControl: 'fan', doorLock: 'lock' };
    function clusterLabel(id: number | null, name: string | null): string {
        if (name && CLUSTER_LABELS[name]) return CLUSTER_LABELS[name];
        if (name) return name;
        return id === null ? '?' : `cluster 0x${id.toString(16).padStart(4, '0')}`;
    }
    let rows = $derived.by<Row[]>(() => {
        const map = new Map<string, Row>();
        for (const b of bindings) {
            const key = [b.sourceNodeId, b.sourceEndpointId, b.own ? 'own' : `f${b.fabricIndex ?? '?'}`, b.node ?? '', b.endpoint ?? '', b.group ?? ''].join('/');
            let row = map.get(key);
            if (!row) {
                const source = `${b.sourceName ?? `Node ${b.sourceNodeId}`} · ${b.sourceEndpointName ?? `ep ${b.sourceEndpointId}`}`;
                let target: string;
                if (b.group !== null) target = b.targetName ?? `group ${b.group}`;
                else if (b.own && b.targetName) target = `${b.targetName} · ${b.targetEndpointName ?? `ep ${b.endpoint}`}`;
                else if (b.own) target = `node ${b.node} · ep ${b.endpoint} (not paired with she)`;
                else target = `node ${b.node} · ep ${b.endpoint} (that fabric's numbering)`;
                row = { key, sourceNodeId: b.sourceNodeId, sourceEndpointId: b.sourceEndpointId, source, target, targetNodeId: b.node, targetEndpointId: b.endpoint, clusters: [], own: b.own, fabricIndex: b.fabricIndex, group: b.group };
                map.set(key, row);
            }
            if (b.cluster !== null || b.clusterName) row.clusters.push({ id: b.cluster ?? -1, name: b.clusterName, label: clusterLabel(b.cluster, b.clusterName) });
        }
        return [...map.values()].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
    });

    // ── Add ──────────────────────────────────────────────────────────────────
    let showAdd = $state(false);
    let sourceKey = $state('');
    let targetKey = $state('');
    let chosen = $state(new Set<string>());
    let creating = $state(false);
    let progress = $state<string | null>(null);
    let addError = $state<string | null>(null);
    let result = $state<string | null>(null);

    let source = $derived(candidates.sources.find((s) => epKey(s) === sourceKey) ?? null);
    /** targets with at least one server cluster the source has as client — never the source endpoint itself */
    let targets = $derived.by(() => {
        if (!source) return [] as MatterBindingEndpoint[];
        const want = new Set(source.clusters.map((c) => c.name));
        return candidates.targets.filter((t) => epKey(t) !== sourceKey && t.clusters.some((c) => want.has(c.name)));
    });
    const CLUSTER_IDS: Record<string, number> = { onOff: 6, levelControl: 8, colorControl: 0x300, windowCovering: 0x102, thermostat: 0x201, fanControl: 0x202, doorLock: 0x101 };
    /** a group is a target when a member serves one of the source's clusters */
    let groupTargets = $derived.by(() => {
        if (!source) return [] as MatterGroup[];
        const want = new Set(source.clusters.map((c) => CLUSTER_IDS[c.name]));
        return groupsData.groups.filter((g) => g.members.some((m) => m.clusters.some((id) => want.has(id))));
    });
    let target = $derived(targets.find((t) => epKey(t) === targetKey) ?? null);
    let targetGroup = $derived(targetKey.startsWith('group:') ? (groupTargets.find((g) => `group:${g.id}` === targetKey) ?? null) : null);
    let common = $derived.by<MatterBindingCluster[]>(() => {
        if (!source) return [];
        if (targetGroup) {
            const have = new Set(targetGroup.members.flatMap((m) => m.clusters));
            return source.clusters.filter((c) => have.has(CLUSTER_IDS[c.name]));
        }
        if (!target) return [];
        const have = new Set(target.clusters.map((c) => c.name));
        return source.clusters.filter((c) => have.has(c.name));
    });
    // a new pair pre-selects every cluster both sides support
    $effect(() => {
        const names = common.map((c) => c.name);
        untrack(() => { chosen = new Set(names); });
    });
    $effect(() => {
        if (target === null && targetGroup === null && targetKey) untrack(() => { targetKey = ''; });
    });
    let preview = $derived.by(() => {
        if (!source || (!target && !targetGroup)) return '';
        const parts = common.filter((c) => chosen.has(c.name)).map((c) => c.label);
        const to = targetGroup ? `group ${targetGroup.name} (${targetGroup.members.length} member${targetGroup.members.length === 1 ? '' : 's'})` : epLabel(target!);
        return `${epLabel(source)} → ${to}: ${parts.length ? parts.join(', ') : 'nothing selected'}`;
    });
    function toggleCluster(name: string) {
        const next = new Set(chosen);
        if (next.has(name)) next.delete(name); else next.add(name);
        chosen = next;
    }

    async function create() {
        if (!source || (!target && !targetGroup) || chosen.size === 0) return;
        creating = true;
        addError = null;
        result = null;
        progress = targetGroup ? `writing the group key to ${source.nodeName ?? 'the switch'} …` : `granting access on ${target?.nodeName ?? 'the target'} …`;
        const timer = setTimeout(() => { if (creating) progress = `binding ${source?.nodeName ?? 'the switch'} …`; }, 2500);
        try {
            const r = await addMatterBinding({
                source: { nodeId: source.nodeId, endpointId: source.endpointId },
                target: targetGroup ? { group: targetGroup.id } : { nodeId: target!.nodeId, endpointId: target!.endpointId },
                clusters: [...chosen],
            });
            result = `Binding created (${r.clusters.length} cluster${r.clusters.length === 1 ? '' : 's'}${r.aclChanged ? ', access granted' : ''}).`;
            showAdd = false;
            await load();
        } catch (e) {
            addError = e instanceof Error ? e.message : String(e);
        } finally {
            clearTimeout(timer);
            creating = false;
            progress = null;
        }
    }

    async function remove(row: Row) {
        if (!row.own || (row.group === null && (row.targetNodeId === null || row.targetEndpointId === null))) return;
        const ok = await dialog.show(`Remove the binding ${row.source} → ${row.target} (${row.clusters.map((c) => c.label).join(', ')})? The switch stops controlling the target directly; its access grant is revoked when no other binding needs it.`, { confirm: 'Remove', danger: true });
        if (!ok) return;
        result = null;
        try {
            const r = await removeMatterBinding({
                source: { nodeId: row.sourceNodeId, endpointId: row.sourceEndpointId },
                target: row.group !== null ? { group: row.group } : { nodeId: row.targetNodeId!, endpointId: row.targetEndpointId! },
                clusters: row.clusters.map((c) => c.id),
            });
            result = r.warning ? `Binding removed — ${r.warning}.` : `Binding removed${r.aclRevoked ? ', access revoked' : ''}.`;
            await load();
        } catch (e) {
            await dialog.show(`Removing the binding failed: ${e instanceof Error ? e.message : String(e)}`, { alert: true });
        }
    }
    // ── Groups (M23) ─────────────────────────────────────────────────────────
    let groupBusy = $state<string | null>(null);
    let groupError = $state<string | null>(null);
    let addMemberFor = $state<number | null>(null);
    let memberKey = $state('');
    async function newGroup() {
        const name = await inputDialog.show('Name of the new group (up to 16 characters). Every member gets the shared key set — a group of its own key set can be made with the "own key" button; devices hold only a few key sets.', { placeholder: 'Wohnzimmer', confirm: 'Create' });
        if (!name) return;
        await groupAction('create', () => createMatterGroup(name, 'shared'));
    }
    async function newGroupOwnKey() {
        const name = await inputDialog.show('Name of the new group with a key set of its own (up to 16 characters). Mind the devices\' limit of group key sets — the fabric\'s own key counts, so often only two groups with own keys fit.', { placeholder: 'Schlafzimmer', confirm: 'Create' });
        if (!name) return;
        await groupAction('create', () => createMatterGroup(name, 'own'));
    }
    async function groupAction(key: string, fn: () => Promise<unknown>) {
        groupBusy = key;
        groupError = null;
        try {
            await fn();
            await loadGroups();
        } catch (e) {
            groupError = e instanceof Error ? e.message : String(e);
        } finally {
            groupBusy = null;
        }
    }
    async function rename(g: MatterGroup) {
        const name = await inputDialog.show('New name (she only — the name the devices hold stays):', { initial: g.name, confirm: 'Rename' });
        if (!name || name === g.name) return;
        await groupAction(`g${g.id}`, () => renameMatterGroup(g.id, name));
    }
    async function removeGroup(g: MatterGroup) {
        const ok = await dialog.show(`Delete group "${g.name}"? Its ${g.members.length} member${g.members.length === 1 ? ' is' : 's are'} removed from the group on the devices (an offline device keeps it until it is removed again).`, { confirm: 'Delete group', danger: true });
        if (!ok) return;
        await groupAction(`g${g.id}`, async () => {
            const r = await deleteMatterGroup(g.id);
            if (r.problems.length) groupError = r.problems.join('; ');
        });
    }
    async function addMember(g: MatterGroup) {
        const t = candidates.targets.find((x) => epKey(x) === memberKey);
        if (!t) return;
        await groupAction(`g${g.id}`, () => addMatterGroupMember(g.id, t.nodeId, t.endpointId));
        addMemberFor = null;
        memberKey = '';
    }
    async function removeMember(g: MatterGroup, nodeId: string, endpointId: number) {
        await groupAction(`g${g.id}`, async () => {
            const r = await removeMatterGroupMember(g.id, nodeId, endpointId);
            if (r.problems.length) groupError = r.problems.join('; ');
        });
    }
    function groupCommand(g: MatterGroup, clusterName: string, command: string, args?: Record<string, unknown>) {
        return groupAction(`c${g.id}`, () => sendMatterGroupCommand(g.id, clusterName, command, args));
    }
    function memberCandidates(g: MatterGroup) {
        return candidates.targets.filter((t) => !g.members.some((m) => m.nodeId === t.nodeId && m.endpointId === t.endpointId));
    }
</script>

<ConfirmDialog bind:this={dialog} />
<InputDialog bind:this={inputDialog} />
<div class="bindings">
    <div class="bar">
        <span class="title">Bindings</span>
        <span class="count">{rows.length} binding{rows.length === 1 ? '' : 's'} · {candidates.sources.length} source{candidates.sources.length === 1 ? '' : 's'} · {candidates.targets.length} target{candidates.targets.length === 1 ? '' : 's'}</span>
        <button class="ghost" onclick={load} disabled={loading} title="Reload">↺</button>
        <span class="spacer"></span>
        {#if result}<span class="result">{result}</span>{/if}
        <button onclick={() => { showAdd = !showAdd; addError = null; }} disabled={candidates.sources.length === 0} title={candidates.sources.length === 0 ? 'No device in she\'s fabric can be a binding source' : 'Bind a switch to a device'}>＋ Add binding</button>
    </div>

    {#if showAdd}
        <div class="add">
            <label class="field">
                <span>Source — the device that sends (a switch, a dimmer)</span>
                <select bind:value={sourceKey}>
                    <option value="">choose a source…</option>
                    {#each candidates.sources as s (epKey(s))}
                        <option value={epKey(s)} disabled={!s.online}>{epLabel(s)}{s.online ? '' : ' (offline)'}</option>
                    {/each}
                </select>
            </label>
            <label class="field">
                <span>Target — the device it controls</span>
                <select bind:value={targetKey} disabled={!source}>
                    <option value="">{source ? (targets.length ? 'choose a target…' : 'no device supports what this source sends') : 'choose a source first'}</option>
                    {#each targets as t (epKey(t))}
                        <option value={epKey(t)} disabled={!t.online}>{epLabel(t)}{t.online ? '' : ' (offline)'}</option>
                    {/each}
                    {#each groupTargets as g (g.id)}
                        <option value={`group:${g.id}`}>Group · {g.name} ({g.members.length} member{g.members.length === 1 ? '' : 's'})</option>
                    {/each}
                </select>
            </label>
            {#if common.length}
                <div class="field">
                    <span>What to bind</span>
                    <div class="clusters">
                        {#each common as c (c.name)}
                            <label class="chk"><input type="checkbox" checked={chosen.has(c.name)} onchange={() => toggleCluster(c.name)} /> {c.label} <span class="dim">({c.name})</span></label>
                        {/each}
                    </div>
                </div>
            {/if}
            {#if preview}<p class="preview">{preview}</p>{/if}
            {#if addError}<p class="err">{addError}</p>{/if}
            <div class="actions">
                <button onclick={create} disabled={creating || !source || (!target && !targetGroup) || chosen.size === 0}>{creating ? (progress ?? 'Creating…') : 'Create'}</button>
                <button class="ghost" onclick={() => (showAdd = false)} disabled={creating}>Cancel</button>
                <span class="hint">Both devices must be in she's fabric — a device paired in another app is shared into she from there (Devices tab). A binding fires on the physical press only, not when she or another app switches the target.</span>
            </div>
        </div>
    {/if}

    {#if loading && !loaded}
        <div class="info">Loading…</div>
    {:else if loadError}
        <div class="info err">{loadError}</div>
    {:else if rows.length === 0}
        <div class="info">No bindings yet.{#if candidates.sources.length === 0} None of the paired devices can be a binding source — a source needs a Binding cluster and a client cluster (On/Off Light Switch, Dimmer Switch, Window Covering Controller); retail buttons that only send events are listed below.{/if}</div>
    {:else}
        <div class="table-wrap">
            <table>
                <thead>
                    <tr><th>Source</th><th>Target</th><th>Binds</th><th>Fabric</th><th class="c-act"></th></tr>
                </thead>
                <tbody>
                    {#each rows as row (row.key)}
                        <tr class:foreign={!row.own}>
                            <td>{row.source}</td>
                            <td>{row.target}</td>
                            <td>{row.clusters.map((c) => c.label).join(', ') || '—'}</td>
                            <td>{#if row.own}<span class="badge b-own">she</span>{:else}<span class="badge b-other" title="Made by another controller (Apple Home, Home Assistant, …) — she shows it but cannot edit it">another fabric{row.fabricIndex !== undefined ? ` #${row.fabricIndex}` : ''}</span>{/if}</td>
                            <td class="c-act">{#if row.own && (row.group !== null || row.targetNodeId !== null)}<button class="ghost sm" onclick={() => remove(row)}>Remove</button>{/if}</td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {/if}

    <div class="groups">
        <div class="bar">
            <span class="title">Groups</span>
            <span class="count">{groupsData.groups.length} group{groupsData.groups.length === 1 ? '' : 's'}{groupsData.keySets.length ? ` · ${groupsData.keySets.length} key set${groupsData.keySets.length === 1 ? '' : 's'}` : ''}</span>
            <span class="spacer"></span>
            {#if groupError}<span class="err-inline">{groupError}</span>{/if}
            <button class="ghost sm" onclick={newGroupOwnKey} disabled={!groupsData.available || groupBusy !== null} title="A group with a key set of its own">own key…</button>
            <button class="sm" onclick={newGroup} disabled={!groupsData.available || groupBusy !== null} title="A group with the shared key set (recommended)">＋ New group</button>
        </div>
        {#if !groupsData.available}
            <div class="info">Groups are not available{groupsData.error ? `: ${groupsData.error}` : ''}.</div>
        {:else if groupsData.groups.length === 0}
            <div class="info">No groups yet. A group gets one multicast command instead of one per device — for a switch bound to all lights of a room, or <code>she.matter.send('group:Wohnzimmer', null, 'onOff', 'on')</code> in a script.</div>
        {:else}
            {#each groupsData.groups as g (g.id)}
                <div class="group">
                    <div class="g-hdr">
                        <span class="g-name">{g.name}</span>
                        <span class="dim">#{g.id} · key set {g.keySet ? (g.keySet.shared ? 'shared' : `own (${g.keySet.id})`) : g.keySetId}</span>
                        <span class="g-state" class:on={g.state.on === 'all'} class:some={g.state.on === 'some'}>{g.state.on === null ? '—' : g.state.on === 'all' ? 'all on' : g.state.on === 'some' ? `${g.state.onCount} of ${g.state.memberCount} on` : 'all off'}{g.state.level !== null ? ` · level ${g.state.level}` : ''}</span>
                        <span class="spacer"></span>
                        <button class="ghost sm" disabled={groupBusy !== null || g.members.length === 0} onclick={() => groupCommand(g, 'onOff', 'on')}>On</button>
                        <button class="ghost sm" disabled={groupBusy !== null || g.members.length === 0} onclick={() => groupCommand(g, 'onOff', 'off')}>Off</button>
                        <button class="ghost sm" disabled={groupBusy !== null || g.members.length === 0} onclick={() => groupCommand(g, 'onOff', 'toggle')}>Toggle</button>
                        <button class="ghost sm" disabled={groupBusy !== null || !g.members.some((m) => m.clusters.includes(8))} onclick={() => groupCommand(g, 'levelControl', 'moveToLevelWithOnOff', { level: 254, transitionTime: 5 })} title="Level 254 (full)">▲</button>
                        <button class="ghost sm" disabled={groupBusy !== null || !g.members.some((m) => m.clusters.includes(8))} onclick={() => groupCommand(g, 'levelControl', 'moveToLevelWithOnOff', { level: 64, transitionTime: 5 })} title="Level 64 (dim)">▼</button>
                        <button class="ghost sm" disabled={groupBusy !== null} onclick={() => rename(g)}>Rename</button>
                        <button class="ghost sm" disabled={groupBusy !== null} onclick={() => removeGroup(g)}>Delete</button>
                    </div>
                    <ul class="members">
                        {#each g.members as m (`${m.nodeId}/${m.endpointId}`)}
                            <li class:m-err={m.status === 'error'}>
                                <span class="m-name">{m.name ?? `Node ${m.nodeId}`} · {m.endpointName ?? `ep ${m.endpointId}`}</span>
                                <span class="dim">{m.clusterNames.join(', ')}{m.online ? '' : ' · offline'}{m.paired ? '' : ' · not paired'}</span>
                                {#if m.status === 'error'}<span class="m-error" title={m.error ?? ''}>failed: {m.error}</span>{:else if m.status === 'pending'}<span class="dim">provisioning…</span>{:else}<span class="m-state">{m.state.onOff === null ? '' : m.state.onOff ? 'on' : 'off'}{m.state.level !== null ? ` · ${m.state.level}` : ''}</span>{/if}
                                <button class="ghost sm" disabled={groupBusy !== null} onclick={() => removeMember(g, m.nodeId, m.endpointId)}>Remove</button>
                            </li>
                        {/each}
                        <li class="m-add">
                            {#if addMemberFor === g.id}
                                <select bind:value={memberKey}>
                                    <option value="">choose an endpoint…</option>
                                    {#each memberCandidates(g) as t (epKey(t))}
                                        <option value={epKey(t)} disabled={!t.online}>{epLabel(t)}{t.online ? '' : ' (offline)'}</option>
                                    {/each}
                                </select>
                                <button class="sm" disabled={!memberKey || groupBusy !== null} onclick={() => addMember(g)}>{groupBusy === `g${g.id}` ? 'provisioning…' : 'Add'}</button>
                                <button class="ghost sm" onclick={() => { addMemberFor = null; memberKey = ''; }}>Cancel</button>
                            {:else}
                                <button class="ghost sm" disabled={groupBusy !== null} onclick={() => { addMemberFor = g.id; memberKey = ''; }}>＋ Add member</button>
                            {/if}
                        </li>
                    </ul>
                </div>
            {/each}
        {/if}
    </div>

    {#if candidates.notBindable.length}
        <details class="nb">
            <summary>{candidates.notBindable.length} endpoint{candidates.notBindable.length === 1 ? '' : 's'} cannot be a binding source</summary>
            <ul>
                {#each candidates.notBindable as ep (epKey(ep))}
                    <li><span class="nb-name">{epLabel(ep)}</span> — {ep.reason}</li>
                {/each}
            </ul>
        </details>
    {/if}
</div>

<style>
    .bindings { flex: 1; display: flex; flex-direction: column; overflow: hidden; color: var(--fg); font-size: 12px; }
    .bar {
        display: flex; align-items: center; gap: 8px;
        padding: 5px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .title { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg-muted); }
    .count, .hint, .dim { color: var(--fg-muted); font-size: 11px; }
    .count { white-space: nowrap; }
    .spacer { flex: 1; }
    .result { color: var(--fg-muted); font-size: 11px; }

    button {
        background: var(--accent); border: none; color: #fff;
        padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer;
    }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    button.sm { padding: 1px 7px; font-size: 11px; }

    .add { padding: 10px 12px; border-bottom: 1px solid var(--border); background: var(--bg-panel); display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
    .field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--fg-muted); max-width: 640px; }
    select {
        background: var(--bg-app); border: 1px solid var(--border); color: var(--fg-text);
        padding: 3px 6px; border-radius: 3px; font-size: 12px;
    }
    .clusters { display: flex; flex-wrap: wrap; gap: 12px; color: var(--fg); font-size: 12px; }
    .chk { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
    .preview { margin: 0; color: var(--fg-text); font-size: 12px; }
    .err { margin: 0; color: #e74c3c; font-size: 12px; }
    .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .actions .hint { flex-basis: 100%; }

    .info { padding: 16px; color: var(--fg-muted); font-size: 12px; }
    .info.err { color: #e74c3c; }

    .table-wrap { flex: 1; overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; color: var(--fg); }
    th {
        text-align: left; font-weight: 600; font-size: 11px; color: var(--fg-muted);
        padding: 5px 8px; border-bottom: 1px solid var(--border); position: sticky; top: 0;
        background: var(--bg-app); white-space: nowrap;
    }
    td { padding: 5px 8px; border-bottom: 1px solid var(--border-sub, var(--border)); vertical-align: top; }
    tr.foreign td { color: var(--fg-muted); }
    .c-act { text-align: right; white-space: nowrap; }
    .badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600; line-height: 16px; }
    .b-own { background: rgba(86,156,214,0.18); color: var(--accent, #569cd6); }
    .b-other { background: rgba(230,126,34,0.18); color: #e67e22; }

    .groups { border-top: 1px solid var(--border); flex-shrink: 0; max-height: 45%; overflow: auto; }
    .err-inline { color: #e74c3c; font-size: 11px; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .info code { color: var(--accent); }
    .group { padding: 6px 12px; border-bottom: 1px solid var(--border-sub, var(--border)); }
    .g-hdr { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .g-name { font-weight: 600; color: var(--fg-text); }
    .g-state { font-size: 11px; color: var(--fg-muted); }
    .g-state.on { color: #98c379; }
    .g-state.some { color: #e5a86b; }
    .members { list-style: none; margin: 4px 0 0; padding: 0 0 0 12px; display: flex; flex-direction: column; gap: 3px; }
    .members li { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .m-name { color: var(--fg); }
    .m-state { color: var(--fg-muted); font-size: 11px; }
    .m-error { color: #e74c3c; font-size: 11px; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    li.m-err .m-name { color: #e67e22; }
    .m-add select { max-width: 320px; }
    .nb { padding: 6px 12px 10px; border-top: 1px solid var(--border); font-size: 11px; color: var(--fg-muted); flex-shrink: 0; }
    .nb summary { cursor: pointer; }
    .nb ul { margin: 6px 0 0; padding-left: 18px; }
    .nb-name { color: var(--fg); }
</style>
