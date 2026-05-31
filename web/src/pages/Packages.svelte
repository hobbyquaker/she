<script lang="ts">
    import { onMount } from 'svelte';
    import {
        listDeps,
        searchNpm,
        installDep,
        removeDep,
        updateDep,
        restartDaemon,
        type DepEntry,
        type NpmSearchResult,
    } from '../lib/api.js';

    let installed = $state<DepEntry[]>([]);
    let searchQuery = $state('');
    let searchResults = $state<NpmSearchResult[]>([]);
    let pendingRestart = $state(false);
    let searching = $state(false);
    let error = $state('');
    let output = $state('');
    let busy = $state<Record<string, boolean>>({});
    let restarting = $state(false);

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

    async function restart() {
        restarting = true;
        try {
            await restartDaemon();
        } catch {
            // Connection will drop — expected
        }
        // Show message; daemon may take a moment to come back
        restarting = false;
        pendingRestart = false;
        output = 'Restart signal sent. The daemon is restarting — refresh the page in a moment.';
    }
</script>

<div class="pkg-page">
    <header>
        <h2>Packages</h2>
        <p class="subtitle">
            Install npm packages into <code>~/.she/</code>. Scripts can then
            <code>require('package-name')</code> directly. Restart the daemon after changes.
        </p>
    </header>

    {#if pendingRestart}
        <div class="restart-banner">
            <span>⚠ Package changes require a daemon restart to take effect.</span>
            <button class="restart-btn" onclick={restart} disabled={restarting}>
                {restarting ? 'Restarting…' : 'Restart Daemon'}
            </button>
        </div>
    {/if}

    {#if error}
        <div class="err">{error}</div>
    {/if}

    <!-- Installed packages -->
    <section>
        <h3>Installed</h3>
        {#if installed.length === 0}
            <p class="empty">No packages installed yet.</p>
        {:else}
            <table class="pkg-table">
                <thead>
                    <tr><th>Package</th><th>Version</th><th></th></tr>
                </thead>
                <tbody>
                    {#each installed as dep (dep.name)}
                        <tr>
                            <td class="pkg-name">{dep.name}</td>
                            <td class="pkg-ver">{dep.version}</td>
                            <td class="pkg-actions">
                                <button
                                    onclick={() => update(dep.name)}
                                    disabled={!!busy[dep.name]}
                                    title="Update to latest"
                                >
                                    {busy[dep.name] ? '…' : 'Update'}
                                </button>
                                <button
                                    class="danger"
                                    onclick={() => remove(dep.name)}
                                    disabled={!!busy[dep.name]}
                                    title="Uninstall"
                                >
                                    Remove
                                </button>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        {/if}
    </section>

    <!-- Search -->
    <section>
        <h3>Search npm</h3>
        <div class="search-row">
            <input
                type="text"
                placeholder="e.g. axios, lodash, mqtt…"
                bind:value={searchQuery}
                onkeydown={(e) => e.key === 'Enter' && search()}
            />
            <button onclick={search} disabled={searching}>
                {searching ? 'Searching…' : 'Search'}
            </button>
        </div>
        {#if searchResults.length > 0}
            <table class="pkg-table">
                <thead>
                    <tr><th>Package</th><th>Version</th><th>Description</th><th></th></tr>
                </thead>
                <tbody>
                    {#each searchResults as r (r.name)}
                        <tr>
                            <td class="pkg-name">{r.name}</td>
                            <td class="pkg-ver">{r.version}</td>
                            <td class="pkg-desc">{r.description}</td>
                            <td class="pkg-actions">
                                <button
                                    onclick={() => install(r.name)}
                                    disabled={!!busy[r.name]}
                                >
                                    {busy[r.name] ? 'Installing…' : 'Install'}
                                </button>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        {/if}
    </section>

    <!-- npm output -->
    {#if output}
        <section>
            <h3>Output</h3>
            <pre class="npm-output">{output}</pre>
        </section>
    {/if}
</div>

<style>
    .pkg-page {
        padding: 24px 32px;
        color: var(--fg);
        font-size: 13px;
        overflow-y: auto;
        height: 100%;
        box-sizing: border-box;
    }
    h2 {
        margin: 0 0 4px;
        font-size: 18px;
        color: var(--fg-text);
    }
    h3 {
        margin: 20px 0 8px;
        font-size: 13px;
        color: var(--fg-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
    .subtitle {
        margin: 0 0 20px;
        color: var(--fg-muted);
        font-size: 12px;
        line-height: 1.5;
    }
    code {
        background: var(--bg-active);
        padding: 1px 5px;
        border-radius: 3px;
        font-family: monospace;
        font-size: 11px;
    }
    /* Restart banner */
    .restart-banner {
        display: flex;
        align-items: center;
        gap: 16px;
        background: var(--bg-warn-subtle);
        border: 1px solid var(--border-warn);
        border-radius: 4px;
        padding: 10px 16px;
        margin-bottom: 16px;
        font-size: 12px;
        color: var(--fg-warn-subtle);
    }
    .restart-btn {
        background: var(--fg-warn-subtle);
        color: var(--bg-app);
        border: none;
        padding: 5px 12px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        flex-shrink: 0;
    }
    .restart-btn:hover:not(:disabled) { opacity: 0.85; }
    .restart-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    /* Error */
    .err {
        color: var(--fg-err);
        background: var(--bg-err-subtle);
        border: 1px solid var(--border-err);
        border-radius: 4px;
        padding: 8px 12px;
        margin-bottom: 12px;
        font-size: 12px;
    }
    .empty { color: var(--fg-muted); font-size: 12px; margin: 4px 0; }
    /* Tables */
    .pkg-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
    }
    .pkg-table th {
        text-align: left;
        color: var(--fg-muted);
        font-weight: normal;
        padding: 4px 10px 4px 0;
        border-bottom: 1px solid var(--border-sub);
    }
    .pkg-table td {
        padding: 5px 10px 5px 0;
        border-bottom: 1px solid var(--border-sub);
        vertical-align: middle;
    }
    .pkg-name { font-family: monospace; color: var(--fg-value); }
    .pkg-ver  { font-family: monospace; color: var(--fg-muted); white-space: nowrap; }
    .pkg-desc { color: var(--fg-muted); max-width: 380px; }
    .pkg-actions { white-space: nowrap; }
    .pkg-actions button {
        background: var(--bg-active);
        color: var(--fg);
        border: none;
        padding: 3px 10px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 11px;
        margin-left: 6px;
    }
    .pkg-actions button:hover:not(:disabled) { background: var(--bg-hover); }
    .pkg-actions button:disabled { opacity: 0.4; cursor: not-allowed; }
    .pkg-actions button.danger { color: var(--fg-err); }
    .pkg-actions button.danger:hover:not(:disabled) { background: var(--bg-err-subtle); }
    /* Search row */
    .search-row {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
    }
    .search-row input {
        flex: 1;
        background: var(--bg-input);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: 3px;
        padding: 5px 10px;
        font-size: 12px;
        outline: none;
    }
    .search-row input:focus { border-color: var(--fg-brand); }
    .search-row button {
        background: var(--accent);
        color: #fff;
        border: none;
        padding: 5px 14px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 12px;
    }
    .search-row button:hover:not(:disabled) { background: var(--accent-hov); }
    .search-row button:disabled { opacity: 0.5; cursor: not-allowed; }
    /* npm output */
    .npm-output {
        background: var(--bg-app);
        border: 1px solid var(--border-sub);
        border-radius: 4px;
        padding: 10px 14px;
        font-size: 11px;
        font-family: monospace;
        color: var(--fg-muted);
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 200px;
        overflow-y: auto;
    }
</style>
