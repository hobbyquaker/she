<script lang="ts">
    /**
     * The Meta page (roadmap U22): the home model that she keeps in sheDB from Home Assistant
     * discovery — floors and rooms, the devices and entities in them, functions and labels.
     *
     * One read of the whole model (`GET /she/home/model`), refreshed when a `she/…` document
     * changes; every edit goes through the model's API, which keeps the inheritance right.
     */
    import { onDestroy, untrack } from 'svelte';
    import { subscribeWs } from '../lib/ws.js';
    import { getHomeModel, setHomeEnabled, type HomeModelData } from '../lib/api.js';
    import ConfirmDialog from '../lib/ConfirmDialog.svelte';
    import InputDialog from '../lib/InputDialog.svelte';
    import Rooms from './home/Rooms.svelte';
    import Devices from './home/Devices.svelte';
    import Functions from './home/Functions.svelte';
    import Labels from './home/Labels.svelte';
    import Scenes from './home/Scenes.svelte';
    import type { HomeCtx } from './home/ctx.js';

    let { active = false, sub = null, onsub }: { active?: boolean; sub?: string | null; onsub?: (s: string) => void } = $props();

    type Tab = 'rooms' | 'devices' | 'scenes' | 'functions' | 'labels';
    const TABS: { id: Tab; label: string }[] = [
        { id: 'rooms', label: 'Rooms' },
        { id: 'devices', label: 'Devices' },
        { id: 'scenes', label: 'Scenes' },
        { id: 'functions', label: 'Functions' },
        { id: 'labels', label: 'Labels' },
    ];
    let tab = $state<Tab>('rooms');
    let data = $state<HomeModelData | null>(null);
    let loaded = $state(false);
    let error = $state<string | null>(null);
    let result = $state<string | null>(null);
    let busy = $state(false);
    let language = $state<'en' | 'de'>('en');
    let confirmDlg = $state<ConfirmDialog>();
    let inputDlg = $state<InputDialog>();

    // the sub-route is the tab
    $effect(() => {
        const s = sub;
        if (s && TABS.some((t) => t.id === s)) untrack(() => (tab = s as Tab));
    });
    $effect(() => {
        if (active) onsub?.(tab);
    });

    async function load() {
        try {
            data = await getHomeModel();
            error = null;
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
        loaded = true;
    }
    $effect(() => {
        if (active && !loaded) untrack(load);
    });

    // a she/… document changed (an edit here, a discovery config, a script): read again, at most every 400 ms
    let timer: ReturnType<typeof setTimeout> | null = null;
    function soon() {
        if (timer || !loaded) return;
        timer = setTimeout(() => {
            timer = null;
            if (active) load();
            else loaded = false; // read when the page is shown again
        }, 400);
    }
    const unsub = subscribeWs('db:change', (msg) => {
        if (typeof msg.id === 'string' && msg.id.startsWith('she/')) soon();
    });
    onDestroy(() => {
        unsub();
        if (timer) clearTimeout(timer);
    });

    /** Run an edit: busy while it runs, its error or a short note shown, the model read again. */
    async function act<T>(fn: () => Promise<T>, done?: string | ((r: T) => string | null)): Promise<T | undefined> {
        busy = true;
        error = null;
        result = null;
        try {
            const r = await fn();
            result = typeof done === 'function' ? done(r) : (done ?? null);
            await load();
            return r;
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
            return undefined;
        } finally {
            busy = false;
        }
    }

    const ctx: HomeCtx = {
        act,
        confirm: (msg, opts) => confirmDlg?.show(msg, opts) ?? Promise.resolve(false),
        prompt: (msg, opts) => inputDlg?.show(msg, opts) ?? Promise.resolve(null),
        goto: (t, focus) => {
            tab = t;
            focusRequest = focus ?? null;
        },
    };
    /** a request from one tab to show something on another (a room, a device) */
    let focusRequest = $state<{ room?: string; device?: string; filter?: string } | null>(null);

    function enable() {
        act(() => setHomeEnabled(true, data?.status.language ? undefined : language), 'The home model is on.');
    }

    const status = $derived(data?.status);
</script>

<div class="home page">
    <ConfirmDialog bind:this={confirmDlg} />
    <InputDialog bind:this={inputDlg} />
    <div class="toolbar">
        {#each TABS as t (t.id)}
            <button class="vt" class:active={tab === t.id} onclick={() => (tab = t.id)} disabled={!status?.enabled}>{t.label}</button>
        {/each}
        <span class="spacer"></span>
        {#if status?.enabled && status.counts}
            <span class="counts">{status.counts.devices} devices · {status.counts.entities} entities · {status.counts.rooms} rooms{status.counts.gone ? ` · ${status.counts.gone} gone` : ''}</span>
        {/if}
        {#if result}<span class="result">{result}</span>{/if}
    </div>
    {#if error}<p class="err">{error}</p>{/if}

    {#if !loaded}
        <div class="info">Loading…</div>
    {:else if !status}
        <div class="info">The home model could not be read.</div>
    {:else if !status.available}
        <div class="intro">
            <h2>Meta</h2>
            <p>{status.reason ?? 'The home model is kept in sheDB, which is switched off.'} Switch sheDB on under Config → sheDB and restart she.</p>
        </div>
    {:else if !status.enabled}
        <div class="intro">
            <h2>Meta</h2>
            <p>she can keep a document in sheDB for every device and entity announced through Home Assistant MQTT discovery and organise them in floors, rooms, functions and labels. A new discovery area becomes a room; functions sort entities by purpose (lighting, shading, heating, …). Scripts read the model through <code>she.home</code>.</p>
            {#if !status.decided}
                <p class="hint">It is off on this installation because it existed before the home model did. Switching it on writes one document per device and entity under <code>she/</code> and leaves your own documents alone. You can switch it off again on the Config page; the documents stay.</p>
            {:else}
                <p class="hint">The home model is switched off. Its documents are still in sheDB; switching it on brings them up to date.</p>
            {/if}
            <div class="enable">
                {#if !status.language}
                    <label>Names of the default functions
                        <select bind:value={language} disabled={busy}>
                            <option value="en">English</option>
                            <option value="de">German</option>
                        </select>
                    </label>
                {/if}
                <button onclick={enable} disabled={busy}>Switch the home model on</button>
            </div>
        </div>
    {:else if data}
        {#if !status.language}
            <div class="notice">
                The default functions have not been created yet — choose the language of their names:
                <select bind:value={language} disabled={busy}>
                    <option value="en">English</option>
                    <option value="de">German</option>
                </select>
                <button class="sm" onclick={enable} disabled={busy}>Create functions</button>
            </div>
        {/if}
        <div class="body">
            {#if tab === 'rooms'}
                <Rooms {data} {ctx} {busy} bind:focus={focusRequest} />
            {:else if tab === 'devices'}
                <Devices {data} {ctx} {busy} bind:focus={focusRequest} />
            {:else if tab === 'scenes'}
                <Scenes {data} {ctx} {busy} active={active && tab === 'scenes'} />
            {:else if tab === 'functions'}
                <Functions {data} {ctx} {busy} />
            {:else}
                <Labels {data} {ctx} {busy} />
            {/if}
        </div>
    {/if}
</div>

<style>
    .page { display: flex; flex-direction: column; height: 100%; overflow: hidden; color: var(--fg); font-size: 12px; }
    .toolbar { display: flex; align-items: center; gap: 2px; padding: 6px 10px 0; border-bottom: 1px solid var(--border-sub); flex-shrink: 0; }
    .vt { display: inline-flex; align-items: center; gap: 6px; background: none; border: none; border-bottom: 2px solid transparent; color: var(--fg-muted); cursor: pointer; font-size: 13px; padding: 5px 12px 6px; margin-bottom: -1px; }
    .vt:hover:not(:disabled) { color: var(--fg); }
    .vt:disabled { opacity: 0.5; cursor: default; }
    .vt.active { color: var(--fg-text); border-bottom-color: var(--fg-brand); }
    .spacer { flex: 1; }
    .counts, .result { color: var(--fg-muted); font-size: 11px; margin: 0 6px 6px; }
    .err { margin: 6px 12px; color: var(--fg-err, #e74c3c); }
    .info { padding: 16px; color: var(--fg-muted); }
    .intro { padding: 16px 20px; max-width: 760px; line-height: 1.5; }
    .intro h2 { font-size: 15px; margin: 0 0 8px; color: var(--fg-text); }
    .intro p { margin: 0 0 10px; }
    .hint { color: var(--fg-muted); }
    .enable { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 12px; }
    .notice { margin: 8px 12px 0; padding: 6px 10px; border: 1px solid var(--border-warn, var(--border)); background: var(--bg-warn-subtle, transparent); border-radius: 3px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    code { color: var(--accent); font-size: 11px; }
    .body { flex: 1; min-height: 0; display: flex; overflow: hidden; }

    /* shared by the tabs */
    .home :global(select), .home :global(input[type='text']), .home :global(input[type='number']), .home :global(input[type='search']), .home :global(textarea) {
        background: var(--bg-input, var(--bg-app)); border: 1px solid var(--border); color: var(--fg-text, var(--fg)); padding: 3px 6px; border-radius: 3px; font-size: 12px; font-family: inherit;
    }
    .home :global(button:not(.cancel)) { background: var(--accent); border: none; color: #fff; padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer; }
    .home :global(button:disabled) { opacity: 0.5; cursor: default; }
    .home :global(button.ghost) { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    .home :global(button.ghost:hover:not(:disabled)) { color: var(--fg); border-color: var(--fg-muted); }
    .home :global(button.danger) { background: var(--accent-del, #c0392b); }
    .home :global(button.sm) { padding: 1px 7px; font-size: 11px; }
    .home :global(button.vt) { background: none; color: var(--fg-muted); font-size: 13px; padding: 5px 12px 6px; border-radius: 0; }
    .home :global(button.vt.active) { color: var(--fg-text); }
    .home :global(button.link) { background: none; color: var(--accent); padding: 0; font-size: 11px; }
    .home :global(.chip) { display: inline-flex; align-items: center; gap: 3px; padding: 0 6px; border-radius: 8px; font-size: 10.5px; line-height: 16px; background: var(--bg-input, rgba(128,128,128,0.15)); color: var(--fg); border: 1px solid var(--border); white-space: nowrap; }
    .home :global(.chip.inh) { border-style: dashed; color: var(--fg-muted); background: none; }
    .home :global(.chip.fn) { border-color: var(--fg-brand); }
    .home :global(.chip.lbl) { border-color: var(--fg-warn, #d19a66); }
    .home :global(.dim) { color: var(--fg-muted); font-size: 11px; }
    .home :global(.mono) { font-family: var(--font-mono, monospace); font-size: 11px; }
    .home :global(h3) { margin: 0 0 6px; font-size: 12px; font-weight: 600; color: var(--fg-text); }
    .home :global(.chk) { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
    .home :global(.chk input[type='checkbox']) { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .home :global(.chk .checkmark) { flex-shrink: 0; width: 13px; height: 13px; border: 1.5px solid var(--border); border-radius: 2px; background: var(--bg-app); position: relative; }
    .home :global(.chk input:checked + .checkmark) { background: var(--accent); border-color: var(--accent); }
    .home :global(.chk input:checked + .checkmark::after) { content: ''; position: absolute; left: 3px; top: 0; width: 4px; height: 7px; border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg); }
    .home :global(.chk input:indeterminate + .checkmark::after) { content: ''; position: absolute; left: 2px; top: 4.5px; width: 7px; border-top: 1.5px solid var(--fg); }
</style>
