<script lang="ts">
    /* A small checkbox dropdown for table column filters: closed it reads like a select
       ("all hosts", "pi4", "2 of 5 hosts"), open it is a list of checkboxes with an
       all/none row. Nothing selected means no filter, which is why empty reads as "all". */
    let {
        options = [],
        selected = $bindable([]),
        noun = 'items',
        title = '',
    }: {
        options?: string[];
        selected?: string[];
        /** plural noun for the summary: "all hosts", "2 of 5 hosts" */
        noun?: string;
        title?: string;
    } = $props();

    let open = $state(false);
    let root = $state<HTMLDivElement>();

    const label = $derived(
        selected.length === 0
            ? `all ${noun}`
            : selected.length === 1
              ? selected[0]
              : `${selected.length} of ${options.length} ${noun}`,
    );

    function toggle(value: string) {
        selected = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
    }

    function onWindowClick(e: MouseEvent) {
        if (open && root && !root.contains(e.target as Node)) open = false;
    }
</script>

<svelte:window onclick={onWindowClick} onkeydown={(e) => { if (e.key === 'Escape') open = false; }} />

<div class="ms" bind:this={root}>
    <button
        type="button"
        class="ms-btn"
        class:on={selected.length > 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        {title}
        onclick={(e) => { e.stopPropagation(); open = !open; }}
    >
        <span class="ms-label">{label}</span>
        <span class="ms-caret">▾</span>
    </button>

    {#if open}
        <div class="ms-pop" role="listbox" aria-multiselectable="true" tabindex="-1">
            <div class="ms-head">
                <button type="button" class="ms-link" onclick={() => (selected = [...options])} disabled={selected.length === options.length}>all</button>
                <button type="button" class="ms-link" onclick={() => (selected = [])} disabled={selected.length === 0}>none</button>
            </div>
            <div class="ms-list">
                {#each options as o (o)}
                    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
                    <label class="ms-row" role="option" aria-selected={selected.includes(o)}>
                        <input type="checkbox" checked={selected.includes(o)} onchange={() => toggle(o)} />
                        <span class="ms-box"></span>
                        <span class="ms-text" title={o}>{o}</span>
                    </label>
                {/each}
                {#if options.length === 0}<div class="ms-empty">nothing to filter</div>{/if}
            </div>
        </div>
    {/if}
</div>

<style>
    .ms { position: relative; display: block; }

    .ms-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        width: 100%;
        background: var(--bg-input);
        border: 1px solid var(--border);
        border-radius: 3px;
        color: var(--fg);
        cursor: pointer;
        font-size: 11px;
        padding: 2px 4px;
        text-align: left;
    }
    .ms-btn:hover { border-color: var(--fg-muted); }
    .ms-btn.on { border-color: var(--fg-brand); color: var(--fg-text); }
    .ms-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ms-caret { color: var(--fg-muted); font-size: 9px; flex-shrink: 0; }

    .ms-pop {
        position: absolute;
        z-index: 30;
        top: calc(100% + 2px);
        left: 0;
        min-width: 100%;
        max-width: 260px;
        background: var(--bg-panel);
        border: 1px solid var(--border);
        border-radius: 4px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        padding: 4px;
    }

    .ms-head { display: flex; gap: 8px; padding: 2px 4px 4px; border-bottom: 1px solid var(--border-sub); }
    .ms-link {
        background: none; border: none; padding: 0; cursor: pointer;
        color: var(--fg-brand); font-size: 11px;
    }
    .ms-link:disabled { color: var(--fg-dim); cursor: default; }

    .ms-list { max-height: 240px; overflow: auto; padding-top: 3px; }
    .ms-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 4px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 400;
        color: var(--fg);
        white-space: nowrap;
    }
    .ms-row:hover { background: var(--bg-hover); }
    .ms-row input { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .ms-box {
        flex-shrink: 0;
        width: 12px;
        height: 12px;
        border: 1.5px solid var(--border);
        border-radius: 3px;
        background: var(--bg-input);
        position: relative;
    }
    .ms-row input:checked + .ms-box { background: var(--accent); border-color: var(--accent); }
    .ms-row input:checked + .ms-box::after {
        content: '';
        position: absolute;
        left: 3px;
        top: 0;
        width: 3px;
        height: 6px;
        border: 1.5px solid #fff;
        border-top: none;
        border-left: none;
        transform: rotate(45deg);
    }
    .ms-row input:focus-visible + .ms-box { outline: 1px solid var(--fg-brand); outline-offset: 1px; }
    .ms-text { overflow: hidden; text-overflow: ellipsis; }
    .ms-empty { color: var(--fg-muted); font-size: 11px; padding: 4px; }
</style>
