<script lang="ts">
    import { onMount } from 'svelte';
    import {
        listDeps,
        searchNpm,
        installDep,
        removeDep,
        updateDep,
        type DepEntry,
        type NpmSearchResult,
    } from '../lib/api.js';

    let installed = $state<DepEntry[]>([]);
    let installedFilter = $state('');
    let searchQuery = $state('');
    let searchResults = $state<NpmSearchResult[]>([]);
    let pendingRestart = $state(false);
    let searching = $state(false);
    let error = $state('');
    let output = $state('');
    let busy = $state<Record<string, boolean>>({});

    const filteredInstalled = $derived(
        installedFilter.trim()
            ? installed.filter(d => d.name.toLowerCase().includes(installedFilter.toLowerCase()))
            : installed
    );

    onMount(async () => {
        await loadInstalled();
    });

    async function loadInstalled() {
        try {
            installed = await listDeps();
            error = '';
        } catch (e: any) {
            error = e.message;
        }
    }

    async function search() {
        const q = searchQuery.trim();
        if (!q) { searchResults = []; return; }
        searching = true;
        error = '';
        try {
            searchResults = await searchNpm(q);
        } catch (e: any) {
            error = e.message;
        } finally {
            searching = false;
        }
    }

    async function install(name: string, version?: string) {
        busy[name] = true;
        error = '';
        output = '';
        try {
            const res = await installDep(name, version);
            output = res.stdout || res.stderr || 'Done.';
            pendingRestart = true;
            await loadInstalled();
        } catch (e: any) {
            error = e.message;
        } finally {
            busy[name] = false;
        }
    }

    async function remove(name: string) {
        busy[name] = true;
        error = '';
        output = '';
        try {
            const res = await removeDep(name);
            output = res.stdout || res.stderr || 'Done.';
            pendingRestart = true;
            await loadInstalled();
        } catch (e: any) {
            error = e.message;
        } finally {
            busy[name] = false;
        }
    }

    async function update(name: string) {
        busy[name] = true;
        error = '';
        output = '';
        try {
            const res = await updateDep(name);
            output = res.stdout || res.stderr || 'Done.';
            pendingRestart = true;
            await loadInstalled();
        } catch (e: any) {
            error = e.message;
        } finally {
            busy[name] = false;
        }
    }
</script>

<div class="pkg-shell">

    {#if pendingRestart}
        <div class="restart-banner">
            ⚠ Package changes require a daemon restart to take effect. Use the ↺ button in the topbar.
        </div>
    {/if}

    {#if error}
        <div class="err">{error}</div>
    {/if}

    <div class="pkg-body">
        <!-- Left pane: installed list + filter -->
        <div class="pkg-left">
            <div class="pane-hdr">
                <span class="pane-title">Installed</span>
                <span class="pane-count">{installed.length}</span>
            </div>
            <div class="filter-row">
                <input
                    class="filter-in"
                    type="search"
                    placeholder="Filter…"
                    bind:value={installedFilter}
                />
            </div>
            <div class="installed-list">
                {#if installed.length === 0}
                    <p class="empty">No packages installed.</p>
                {:else if filteredInstalled.length === 0}
                    <p class="empty">No match.</p>
                {:else}
                    {#each filteredInstalled as dep (dep.name)}
                        <div class="dep-row" class:dep-busy={!!busy[dep.name]}>
                            <div class="dep-info">
                                <span class="dep-name">{dep.name}</span>
                                <span class="dep-ver">{dep.version}</span>
                            </div>
                            <div class="dep-btns">
                                <button
                                    class="icon-btn"
                                    onclick={() => update(dep.name)}
                                    disabled={!!busy[dep.name]}
                                    title="Update to latest"
                                >
                                    {#if busy[dep.name]}
                                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="6" stroke-dasharray="18" stroke-dashoffset="4" /></svg>
                                    {:else}
                                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13.65 2.35A8 8 0 1 0 15 8"/><polyline points="15,2 15,8 9,8"/></svg>
                                    {/if}
                                </button>
                                <button
                                    class="icon-btn icon-btn--danger"
                                    onclick={() => remove(dep.name)}
                                    disabled={!!busy[dep.name]}
                                    title="Uninstall"
                                >
                                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>
                                </button>
                            </div>
                        </div>
                    {/each}
                {/if}
            </div>
        </div>

        <!-- Right pane: search + results + output -->
        <div class="pkg-right">
            <div class="pane-hdr">
                <span class="pane-title">Search npm</span>
            </div>
            <div class="search-row">
                <input
                    class="search-in"
                    type="text"
                    placeholder="Package name, e.g. axios, lodash…"
                    bind:value={searchQuery}
                    onkeydown={(e) => e.key === 'Enter' && search()}
                />
                <button class="search-btn" onclick={search} disabled={searching}>
                    {searching ? 'Searching…' : 'Search'}
                </button>
            </div>

            {#if searchResults.length > 0}
                <div class="results-list">
                    {#each searchResults as r (r.name)}
                        <div class="result-row">
                            <div class="result-info">
                                <span class="result-name">{r.name}</span>
                                <span class="result-ver">{r.version}</span>
                                {#if r.description}
                                    <span class="result-desc">{r.description}</span>
                                {/if}
                            </div>
                            <button
                                class="install-btn"
                                onclick={() => install(r.name)}
                                disabled={!!busy[r.name]}
                            >
                                {busy[r.name] ? 'Installing…' : 'Install'}
                            </button>
                        </div>
                    {/each}
                </div>
            {/if}

            {#if output}
                <pre class="npm-output">{output}</pre>
            {/if}

            {#if !searchResults.length && !output}
                <p class="hint">Install npm packages into <code>~/.she/</code>. Scripts can then <code>require('package-name')</code> directly.</p>
            {/if}
        </div>
    </div>
</div>

<style>
    .pkg-shell {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
        font-size: 13px;
        color: var(--fg);
    }

    /* Banners */
    .restart-banner {
        flex-shrink: 0;
        background: var(--bg-warn-subtle);
        border-bottom: 1px solid var(--border-warn);
        padding: 8px 16px;
        font-size: 12px;
        color: var(--fg-warn-subtle);
    }
    .err {
        flex-shrink: 0;
        color: var(--fg-err);
        background: var(--bg-err-subtle);
        border-bottom: 1px solid var(--border-err);
        padding: 8px 16px;
        font-size: 12px;
    }

    /* Two-pane body */
    .pkg-body {
        display: flex;
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }

    /* Left pane */
    .pkg-left {
        width: 240px;
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        border-right: 1px solid var(--border-sub);
        overflow: hidden;
    }

    .pane-hdr {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px 6px;
        border-bottom: 1px solid var(--border-sub);
        flex-shrink: 0;
    }
    .pane-title {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--fg-muted);
    }
    .pane-count {
        font-size: 10px;
        background: var(--bg-active);
        color: var(--fg-muted);
        padding: 1px 5px;
        border-radius: 8px;
    }

    .filter-row {
        padding: 6px 8px;
        flex-shrink: 0;
        border-bottom: 1px solid var(--border-sub);
    }
    .filter-in {
        width: 100%;
        box-sizing: border-box;
        background: var(--bg-input);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: 3px;
        padding: 4px 8px;
        font-size: 12px;
        outline: none;
    }
    .filter-in:focus { border-color: var(--fg-brand); }

    .installed-list {
        flex: 1;
        overflow-y: auto;
    }
    .dep-row {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 5px 8px 5px 12px;
        border-bottom: 1px solid var(--border-sub);
        transition: background 0.1s;
    }
    .dep-row:hover { background: var(--bg-hover); }
    .dep-row.dep-busy { opacity: 0.5; }
    .dep-info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
    }
    .dep-name {
        font-family: monospace;
        font-size: 12px;
        color: var(--fg-value);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .dep-ver {
        font-family: monospace;
        font-size: 10px;
        color: var(--fg-muted);
    }
    .dep-btns {
        display: flex;
        gap: 2px;
        flex-shrink: 0;
    }
    .icon-btn {
        background: none;
        border: none;
        color: var(--fg-muted);
        cursor: pointer;
        padding: 3px;
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .icon-btn:hover:not(:disabled) { background: var(--bg-active); color: var(--fg); }
    .icon-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .icon-btn--danger:hover:not(:disabled) { color: var(--fg-err); background: var(--bg-err-subtle); }

    /* Right pane */
    .pkg-right {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding: 0;
    }
    .pkg-right .pane-hdr {
        border-left: none;
    }

    .search-row {
        display: flex;
        gap: 6px;
        padding: 6px 12px;
        border-bottom: 1px solid var(--border-sub);
        flex-shrink: 0;
    }
    .search-in {
        flex: 1;
        background: var(--bg-input);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: 3px;
        padding: 5px 10px;
        font-size: 12px;
        outline: none;
    }
    .search-in:focus { border-color: var(--fg-brand); }
    .search-btn {
        background: var(--accent);
        color: #fff;
        border: none;
        padding: 5px 14px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 12px;
        white-space: nowrap;
    }
    .search-btn:hover:not(:disabled) { background: var(--accent-hov); }
    .search-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .results-list {
        flex: 1;
        overflow-y: auto;
    }
    .result-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 7px 12px;
        border-bottom: 1px solid var(--border-sub);
    }
    .result-row:hover { background: var(--bg-hover); }
    .result-info {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-wrap: wrap;
    }
    .result-name { font-family: monospace; font-size: 12px; color: var(--fg-value); white-space: nowrap; }
    .result-ver  { font-family: monospace; font-size: 11px; color: var(--fg-muted); white-space: nowrap; }
    .result-desc { font-size: 11px; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .install-btn {
        background: var(--bg-active);
        color: var(--fg);
        border: none;
        padding: 4px 12px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 11px;
        white-space: nowrap;
        flex-shrink: 0;
    }
    .install-btn:hover:not(:disabled) { background: var(--accent); color: #fff; }
    .install-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .npm-output {
        margin: 12px;
        background: var(--bg-app);
        border: 1px solid var(--border-sub);
        border-radius: 4px;
        padding: 10px 14px;
        font-size: 11px;
        font-family: monospace;
        color: var(--fg-muted);
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 180px;
        overflow-y: auto;
        flex-shrink: 0;
    }

    .hint {
        padding: 16px;
        font-size: 12px;
        color: var(--fg-muted);
        line-height: 1.6;
    }
    code {
        background: var(--bg-active);
        padding: 1px 5px;
        border-radius: 3px;
        font-family: monospace;
        font-size: 11px;
    }
    .empty { color: var(--fg-muted); font-size: 12px; padding: 8px 12px; }
</style>
