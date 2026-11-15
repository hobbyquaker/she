<script lang="ts">
    /**
     * Functions: a purpose per entity, next to the room (lighting, shading, …). Each has rules that
     * pick entities by component, device class and category; the editor shows what a draft of the
     * rules would catch before it is saved. Entities assigned by hand are not affected by the rules.
     */
    import { untrack } from 'svelte';
    import { createHomeItem, updateHomeItem, deleteHomeItem, type HomeModelData, type HomeFunction, type HomeRule } from '../../lib/api.js';
    import { matchRule, fieldToText, textToField, ruleSummary, plural } from '../../lib/home.js';
    import type { HomeCtx } from './ctx.js';

    let { data, ctx, busy = false }: { data: HomeModelData; ctx: HomeCtx; busy?: boolean } = $props();

    const functions = $derived(data.functions ?? []);
    const entities = $derived(data.entities ?? []);
    let sel = $state<string | null>(null);
    $effect(() => {
        if (!sel || !functions.some((f) => f.id === sel)) untrack(() => (sel = functions[0]?.id ?? null));
    });
    const fn = $derived(functions.find((f) => f.id === sel));
    const count = $derived.by(() => {
        const m = new Map<string, number>();
        for (const e of entities) if (e.ha.present) for (const f of e.eff.functions) m.set(f, (m.get(f) ?? 0) + 1);
        return m;
    });

    /** a rule as the editor holds it: text per field; a rule it cannot show as fields stays JSON */
    interface RuleRow { component: string; device_class: string; entity_category: string; except: string; raw: string | null }
    function toRow(r: HomeRule): RuleRow {
        const nots = r.not === undefined ? [] : Array.isArray(r.not) ? r.not : [r.not];
        const simpleNot = nots.every((n) => Object.keys(n).every((k) => k === 'device_class'));
        if (!simpleNot) return { component: '', device_class: '', entity_category: '', except: '', raw: JSON.stringify(r) };
        return {
            component: fieldToText(r.component),
            device_class: fieldToText(r.device_class),
            entity_category: fieldToText(r.entity_category),
            except: nots.map((n) => fieldToText(n.device_class)).join(', '),
            raw: null,
        };
    }
    function fromRow(row: RuleRow): HomeRule {
        if (row.raw !== null) return JSON.parse(row.raw);
        const r: HomeRule = {};
        const c = textToField(row.component);
        const d = textToField(row.device_class);
        const e = textToField(row.entity_category);
        const x = textToField(row.except);
        if (c !== undefined) r.component = c;
        if (d !== undefined) r.device_class = d;
        if (e !== undefined) r.entity_category = e;
        if (x !== undefined) r.not = { device_class: x };
        return r;
    }

    let form = $state({ name: '', icon: '', rows: [] as RuleRow[] });
    const fnForm = (f: HomeFunction) => ({ name: f.name, icon: f.icon ?? '', rows: (f.rules ?? []).map(toRow) });
    function reset(f: HomeFunction) {
        form = fnForm(f);
    }
    // the form follows the function shown and its changes; a draft survives a re-read of the model
    let fnBase: HomeFunction | null = null;
    $effect(() => {
        const f = fn;
        if (!f) return;
        untrack(() => {
            if (!fnBase || fnBase.id !== f.id || JSON.stringify(form) === JSON.stringify(fnForm(fnBase))) reset(f);
            fnBase = f;
        });
    });
    const draft = $derived.by((): { rules: HomeRule[] | null; error: string | null } => {
        try {
            return { rules: form.rows.map(fromRow), error: null };
        } catch (e) {
            return { rules: null, error: 'A rule in JSON does not parse: ' + (e instanceof Error ? e.message : String(e)) };
        }
    });
    const dirty = $derived(!!fn && (form.name.trim() !== fn.name || form.icon.trim() !== (fn.icon ?? '') || JSON.stringify(draft.rules) !== JSON.stringify(fn.rules ?? [])));
    /** what the draft rules catch, among the entities whose functions are not assigned by hand */
    const preview = $derived.by(() => {
        if (!draft.rules) return { list: [], manual: 0 };
        const rules = draft.rules;
        const ruled = entities.filter((e) => e.ha.present && !Array.isArray(e.user.functions));
        return {
            list: ruled.filter((e) => rules.some((r) => matchRule(r, e.ha))),
            manual: entities.filter((e) => e.ha.present && Array.isArray(e.user.functions) && fn && e.user.functions.includes(fn.id)).length,
        };
    });
    const empty = (r: HomeRule) => r.component === undefined && r.device_class === undefined && r.entity_category === undefined;

    function save() {
        if (!fn || !draft.rules || !form.name.trim()) return;
        const f = fn;
        const rules = draft.rules;
        ctx.act(() => updateHomeItem('functions', f.id, { name: form.name.trim(), icon: form.icon.trim() || null, rules }), 'Function saved — the entities follow.').then(() => fn && fn.id === f.id && reset(fn));
    }
    async function create() {
        const name = await ctx.prompt('Name of the new function', { placeholder: 'Garden', confirm: 'Create' });
        if (!name) return;
        const r = await ctx.act(() => createHomeItem('functions', { name, order: functions.length + 1, rules: [] }), `Function "${name}" created.`);
        if (r) sel = r.id;
    }
    async function remove(f: HomeFunction) {
        const n = count.get(f.id) ?? 0;
        if (await ctx.confirm(`Delete the function "${f.name}"? ${n ? `${plural(n, 'entity', 'entities')} lose${n === 1 ? 's' : ''} it, and hand assignments to it are removed. ` : ''}${f.seeded ? 'A default function is not created again.' : ''}`, { confirm: 'Delete', danger: true }))
            ctx.act(() => deleteHomeItem('functions', f.id), `Function "${f.name}" deleted.`);
    }
    function move(id: string, dir: -1 | 1) {
        const i = functions.findIndex((f) => f.id === id);
        const j = i + dir;
        if (j < 0 || j >= functions.length) return;
        const next = [...functions];
        [next[i], next[j]] = [next[j], next[i]];
        ctx.act(() => Promise.all(next.map((f, k) => (f.order === k + 1 ? null : updateHomeItem('functions', f.id, { order: k + 1 }))).filter(Boolean)));
    }
</script>

<div class="fns">
    <aside class="list">
        <div class="bar"><button class="sm" onclick={create} disabled={busy}>+ Function</button></div>
        {#each functions as f, i (f.id)}
            <div class="row" class:sel={sel === f.id}>
                <button class="name" onclick={() => (sel = f.id)}>{f.name}</button>
                <span class="dim">{count.get(f.id) ?? 0}</span>
                <span class="ord">
                    <button class="link" title="Up" disabled={busy || i === 0} onclick={() => move(f.id, -1)}>▲</button>
                    <button class="link" title="Down" disabled={busy || i === functions.length - 1} onclick={() => move(f.id, 1)}>▼</button>
                </span>
            </div>
        {/each}
        {#if !functions.length}<p class="dim pad">No functions.</p>{/if}
    </aside>
    <section class="detail">
        {#if fn}
            <div class="form">
                <label>Name <input type="text" bind:value={form.name} /></label>
                <label>Icon <input type="text" bind:value={form.icon} placeholder="mdi:lightbulb" spellcheck="false" /></label>
                <span class="dim mono">she/function/{fn.id}{fn.seeded ? ' · default' : ''}</span>
            </div>
            <h3>Rules</h3>
            <p class="dim">An entity belongs to the function when one rule matches. Each field takes one value or several, comma-separated; <code>-</code> stands for "not set" (no device class, no category); an empty field matches anything. "Except" leaves out device classes. Entities whose functions were assigned by hand are not touched by the rules.</p>
            <div class="rules">
                <div class="rhead"><span>Component</span><span>Device class</span><span>Category</span><span>Except device class</span><span></span></div>
                {#each form.rows as row, i (i)}
                    {#if row.raw !== null}
                        <div class="rrow raw">
                            <input type="text" bind:value={row.raw} spellcheck="false" class="mono" />
                            <button class="link" onclick={() => (form.rows = form.rows.filter((_, k) => k !== i))}>remove</button>
                        </div>
                    {:else}
                        <div class="rrow" class:bad={empty(fromRow(row))}>
                            <input type="text" bind:value={row.component} placeholder="light" spellcheck="false" />
                            <input type="text" bind:value={row.device_class} placeholder="any" spellcheck="false" />
                            <input type="text" bind:value={row.entity_category} placeholder="any" spellcheck="false" />
                            <input type="text" bind:value={row.except} placeholder="—" spellcheck="false" />
                            <button class="link" onclick={() => (form.rows = form.rows.filter((_, k) => k !== i))}>remove</button>
                        </div>
                    {/if}
                {/each}
                <div class="radd"><button class="link" onclick={() => (form.rows = [...form.rows, { component: '', device_class: '', entity_category: '', except: '', raw: null }])}>+ rule</button></div>
            </div>
            {#if draft.error}<p class="err">{draft.error}</p>{/if}
            {#if draft.rules?.some(empty)}<p class="err">A rule that names no component, device class or category matches nothing.</p>{/if}
            <div class="actions">
                <button onclick={save} disabled={busy || !dirty || !draft.rules || !form.name.trim()}>Save</button>
                <button class="ghost" onclick={() => fn && reset(fn)} disabled={busy || !dirty}>Revert</button>
                <span class="spacer"></span>
                <button class="danger sm" onclick={() => fn && remove(fn)} disabled={busy}>Delete function</button>
            </div>
            <h3>The rules catch <span class="dim">· {plural(preview.list.length, 'entity', 'entities')}{preview.manual ? `, plus ${preview.manual} assigned by hand` : ''}{dirty ? ' (draft)' : ''}</span></h3>
            <div class="preview">
                {#each preview.list.slice(0, 200) as e (e.id)}
                    <div class="prow"><span>{e.eff.name}</span><span class="mono dim">{e.ha.component}{e.ha.device_class ? ` · ${e.ha.device_class}` : ''}{e.ha.entity_category ? ` · ${e.ha.entity_category}` : ''}</span></div>
                {/each}
                {#if preview.list.length > 200}<p class="dim pad">{preview.list.length - 200} more</p>{/if}
            </div>
            {#if fn.rules?.length}<p class="dim">Saved: {fn.rules.map(ruleSummary).join(' · ')}</p>{/if}
        {:else}
            <p class="dim pad">Create a function to start.</p>
        {/if}
    </section>
</div>

<style>
    .fns { flex: 1; display: flex; min-height: 0; }
    .list { width: 240px; flex-shrink: 0; border-right: 1px solid var(--border); overflow: auto; }
    .bar { padding: 8px; border-bottom: 1px solid var(--border-sub, var(--border)); }
    .row { display: flex; align-items: center; gap: 6px; padding: 0 8px; }
    .row:hover { background: var(--bg-hover); }
    .row.sel { background: var(--bg-active); }
    .name { flex: 1; text-align: left; background: none !important; color: var(--fg) !important; padding: 4px 0 !important; }
    .ord { display: inline-flex; gap: 4px; visibility: hidden; }
    .row:hover .ord, .row.sel .ord { visibility: visible; }
    .ord :global(button.link) { font-size: 9px; color: var(--fg-muted); }
    .pad { padding: 8px; }
    .detail { flex: 1; min-width: 0; overflow: auto; padding: 10px 14px 20px; display: flex; flex-direction: column; gap: 8px; }
    .detail p { margin: 0; line-height: 1.5; }
    .form { display: flex; gap: 14px; align-items: flex-end; flex-wrap: wrap; }
    .form label { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--fg-muted); }
    code { color: var(--accent); font-size: 11px; }
    .rules { display: flex; flex-direction: column; gap: 4px; }
    .rhead, .rrow { display: grid; grid-template-columns: 1fr 1.6fr 0.8fr 1.2fr 50px; gap: 6px; align-items: center; }
    .rhead { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--fg-muted); }
    .rrow.raw { grid-template-columns: 1fr 50px; }
    .rrow.bad input { border-color: var(--fg-err, #e06c75) !important; }
    .rrow input { min-width: 0; }
    .err { color: var(--fg-err, #e06c75); }
    .actions { display: flex; align-items: center; gap: 8px; }
    .spacer { flex: 1; }
    .preview { border-top: 1px solid var(--border); max-height: 40vh; overflow: auto; }
    .prow { display: grid; grid-template-columns: 2fr 1fr; gap: 8px; padding: 2px 4px; border-bottom: 1px solid var(--border-sub, var(--border)); }
</style>
