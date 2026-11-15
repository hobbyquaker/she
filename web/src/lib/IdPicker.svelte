<script lang="ts">
    /**
     * A dropdown of checkboxes over things with an id and a name (rooms, functions, labels). Closed
     * it reads like a select ("Bath, Kitchen", "3 rooms"); open it filters as you type and, with
     * `create`, offers to make a new one from the text (the caller gets the text and decides).
     * `onchange` fires with the new selection; `selected` is bindable as well.
     */
    let {
        options = [],
        selected = $bindable<string[]>([]),
        noun = 'items',
        placeholder = '—',
        create = false,
        disabled = false,
        single = false,
        onchange,
    }: {
        options?: { id: string; name: string }[];
        selected?: string[];
        noun?: string;
        placeholder?: string;
        /** offer "create <text>": the text is handed over in the selection, as it was typed */
        create?: boolean;
        disabled?: boolean;
        single?: boolean;
        onchange?: (ids: string[]) => void;
    } = $props();

    let open = $state(false);
    let q = $state('');
    let root = $state<HTMLDivElement>();
    let input = $state<HTMLInputElement>();

    const names = $derived(new Map(options.map((o) => [o.id, o.name])));
    const label = $derived(selected.length === 0 ? placeholder : selected.length <= 2 ? selected.map((id) => names.get(id) ?? id).join(', ') : `${selected.length} ${noun}`);
    const shown = $derived(options.filter((o) => !q.trim() || o.name.toLowerCase().includes(q.trim().toLowerCase()) || o.id.includes(q.trim().toLowerCase())));
    const canCreate = $derived(create && !!q.trim() && !options.some((o) => o.name.toLowerCase() === q.trim().toLowerCase()));

    function set(next: string[]) {
        selected = next;
        onchange?.(next);
    }
    function toggle(id: string) {
        if (single) {
            set(selected.includes(id) ? [] : [id]);
            open = false;
            return;
        }
        set(selected.includes(id) ? selected.filter((v) => v !== id) : [...selected, id]);
    }
    function doCreate() {
        const name = q.trim();
        q = '';
        set(single ? [name] : [...selected, name]);
        if (single) open = false;
    }
    function onWindowClick(e: MouseEvent) {
        if (open && root && !root.contains(e.target as Node)) open = false;
    }
    function toggleOpen(e: MouseEvent) {
        e.stopPropagation();
        open = !open;
        if (open) setTimeout(() => input?.focus(), 0);
    }
</script>

<svelte:window onclick={onWindowClick} onkeydown={(e) => { if (e.key === 'Escape') open = false; }} />

<div class="ip" bind:this={root}>
    <button type="button" class="ip-btn" class:empty={!selected.length} {disabled} aria-haspopup="listbox" aria-expanded={open} onclick={toggleOpen}>
        <span class="ip-label">{label}</span><span class="ip-caret">▾</span>
    </button>
    {#if open}
        <div class="ip-pop" role="listbox" aria-multiselectable={!single} tabindex="-1">
            <input bind:this={input} class="ip-q" type="text" placeholder={create ? 'filter or create…' : 'filter…'} bind:value={q} spellcheck="false"
                onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (canCreate) doCreate(); else if (shown.length === 1) toggle(shown[0].id); } }} />
            <div class="ip-list">
                {#each shown as o (o.id)}
                    <label class="ip-item">
                        <input type={single ? 'radio' : 'checkbox'} checked={selected.includes(o.id)} onchange={() => toggle(o.id)} />
                        <span>{o.name}</span>
                    </label>
                {/each}
                {#if canCreate}<button type="button" class="ip-create" onclick={doCreate}>+ create “{q.trim()}”</button>{/if}
                {#if !shown.length && !canCreate}<div class="ip-none">no {noun}</div>{/if}
            </div>
            {#if !single && selected.length}<button type="button" class="ip-clear" onclick={() => set([])}>none</button>{/if}
        </div>
    {/if}
</div>

<style>
    .ip { position: relative; display: inline-block; min-width: 120px; max-width: 100%; }
    .ip-btn { display: flex !important; align-items: center; gap: 6px; width: 100%; background: var(--bg-input, var(--bg-app)) !important; border: 1px solid var(--border) !important; color: var(--fg-text, var(--fg)) !important; padding: 2px 6px !important; border-radius: 3px; font-size: 12px !important; text-align: left; cursor: pointer; }
    .ip-btn.empty .ip-label { color: var(--fg-dim); }
    .ip-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ip-caret { color: var(--fg-muted); font-size: 10px; }
    .ip-pop { position: absolute; z-index: 50; top: calc(100% + 2px); left: 0; min-width: 100%; width: max-content; max-width: 320px; background: var(--bg-widget, var(--bg-panel)); border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); padding: 4px; }
    .ip-q { width: 100%; box-sizing: border-box; margin-bottom: 4px; }
    .ip-list { max-height: 240px; overflow: auto; }
    .ip-item { display: flex; align-items: center; gap: 6px; padding: 2px 4px; cursor: pointer; font-size: 12px; border-radius: 2px; }
    .ip-item:hover { background: var(--bg-hover); }
    .ip-create, .ip-clear { display: block; width: 100%; text-align: left; background: none !important; color: var(--accent) !important; font-size: 11px !important; padding: 3px 4px !important; }
    .ip-none { color: var(--fg-dim); padding: 4px; font-size: 11px; }
</style>
