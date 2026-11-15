<script lang="ts">
    /**
     * Labels: free tags for whatever rooms and functions do not say ("Christmas", "night light").
     * Created here or on the fly when assigning; renaming keeps the assignments, deleting removes them.
     */
    import { createHomeItem, updateHomeItem, deleteHomeItem, type HomeModelData, type HomeLabel } from '../../lib/api.js';
    import { plural } from '../../lib/home.js';
    import type { HomeCtx } from './ctx.js';

    let { data, ctx, busy = false }: { data: HomeModelData; ctx: HomeCtx; busy?: boolean } = $props();

    const labels = $derived(data.labels ?? []);
    const uses = $derived.by(() => {
        const m = new Map<string, { devices: number; entities: number }>();
        const bump = (id: string, k: 'devices' | 'entities') => {
            if (!m.has(id)) m.set(id, { devices: 0, entities: 0 });
            m.get(id)![k]++;
        };
        for (const d of data.devices ?? []) for (const l of d.user.labels ?? []) bump(l, 'devices');
        for (const e of data.entities ?? []) for (const l of e.user.labels ?? []) bump(l, 'entities');
        return m;
    });

    let editing = $state<string | null>(null);
    let editName = $state('');
    let editIcon = $state('');

    async function create() {
        const name = await ctx.prompt('Name of the new label', { placeholder: 'Night light', confirm: 'Create' });
        if (name) ctx.act(() => createHomeItem('labels', { name }), `Label "${name}" created.`);
    }
    function start(l: HomeLabel) {
        editing = l.id;
        editName = l.name;
        editIcon = l.icon ?? '';
    }
    async function save(l: HomeLabel) {
        const ok = await ctx.act(() => updateHomeItem('labels', l.id, { name: editName.trim(), icon: editIcon.trim() || null }), 'Label saved.');
        if (ok) editing = null;
    }
    async function remove(l: HomeLabel) {
        const u = uses.get(l.id);
        const n = (u?.devices ?? 0) + (u?.entities ?? 0);
        if (await ctx.confirm(`Delete the label "${l.name}"?${n ? ` It is taken off ${plural(n, 'device or entity', 'devices and entities')}.` : ''}`, { confirm: 'Delete', danger: true }))
            ctx.act(() => deleteHomeItem('labels', l.id), `Label "${l.name}" deleted.`);
    }
</script>

<div class="labels">
    <div class="bar">
        <button class="sm" onclick={create} disabled={busy}>+ Label</button>
        <span class="dim">Labels can also be created while assigning them on the Devices tab. Scripts find labelled entities with <code>she.home</code>.</span>
    </div>
    <table>
        <thead><tr><th>Label</th><th>Icon</th><th>Id</th><th>Used by</th><th></th></tr></thead>
        <tbody>
            {#each labels as l (l.id)}
                {@const u = uses.get(l.id)}
                <tr>
                    {#if editing === l.id}
                        <td><input type="text" bind:value={editName} onkeydown={(e) => { if (e.key === 'Enter') save(l); if (e.key === 'Escape') editing = null; }} /></td>
                        <td><input type="text" bind:value={editIcon} placeholder="mdi:tag" spellcheck="false" /></td>
                    {:else}
                        <td>{l.name}</td>
                        <td class="mono dim">{l.icon ?? ''}</td>
                    {/if}
                    <td class="mono dim">{l.id}</td>
                    <td class="dim">{u ? [u.devices ? plural(u.devices, 'device') : '', u.entities ? plural(u.entities, 'entity', 'entities') : ''].filter(Boolean).join(', ') : 'nothing'}</td>
                    <td class="act">
                        {#if editing === l.id}
                            <button class="sm" onclick={() => save(l)} disabled={busy || !editName.trim()}>Save</button>
                            <button class="sm ghost" onclick={() => (editing = null)}>Cancel</button>
                        {:else}
                            <button class="sm ghost" onclick={() => start(l)} disabled={busy}>Rename</button>
                            <button class="sm ghost" onclick={() => remove(l)} disabled={busy}>Delete</button>
                        {/if}
                    </td>
                </tr>
            {/each}
            {#if !labels.length}<tr><td colspan="5" class="dim">No labels yet.</td></tr>{/if}
        </tbody>
    </table>
</div>

<style>
    .labels { flex: 1; overflow: auto; padding: 8px 12px 20px; }
    .bar { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    code { color: var(--accent); font-size: 11px; }
    table { border-collapse: collapse; width: 100%; max-width: 900px; }
    th { text-align: left; font-size: 11px; font-weight: 600; color: var(--fg-muted); padding: 4px 8px; border-bottom: 1px solid var(--border); }
    td { padding: 4px 8px; border-bottom: 1px solid var(--border-sub, var(--border)); }
    .act { text-align: right; white-space: nowrap; }
</style>
