<script lang="ts">
    import { onMount } from 'svelte';
    import { subscribeWs } from '../lib/ws.js';
    import {
        listDocs,
        getDoc,
        putDoc,
        deleteDoc,
        listViews,
        getView,
        putView,
        deleteView,
        getViewResult,
        type ViewDefinition,
        type ViewResult,
    } from '../lib/api.js';

    // ---- Document state ----
    let docIds: string[] = $state([]);
    let selectedDocId: string | null = $state(null);
    let docEditor: string = $state('{}');
    let docLoading = $state(false);
    let docError: string | null = $state(null);

    // ---- View state ----
    let viewIds: string[] = $state([]);
    let selectedViewId: string | null = $state(null);
    let viewFilter = $state('');
    let viewMap = $state('// emit(this.someProperty)');
    let viewReduce = $state('');
    let viewResult: ViewResult | null = $state(null);
    let viewLoading = $state(false);
    let viewError: string | null = $state(null);

    // ---- Tabs inside DB panel ----
    let panel: 'docs' | 'views' = $state('docs');

    // ---- New document dialog ----
    let newDocId = $state('');
    let showNewDocForm = $state(false);
    let newDocError: string | null = $state(null);

    // ---- New view dialog ----
    let newViewId = $state('');
    let showNewViewForm = $state(false);
    let newViewError: string | null = $state(null);

    // ---- Resizable sidebar ----
    const SIDEBAR_WIDTH_KEY = 'she-db-sidebar-width';
    let sidebarWidth = $state(parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? '220', 10));
    let resizing = false;
    let resizeStartX = 0;
    let resizeStartWidth = 0;

    function onResizeStart(e: MouseEvent) {
        resizing = true;
        resizeStartX = e.clientX;
        resizeStartWidth = sidebarWidth;
        e.preventDefault();
    }

    function onResizeMove(e: MouseEvent) {
        if (!resizing) return;
        sidebarWidth = Math.max(140, Math.min(500, resizeStartWidth + e.clientX - resizeStartX));
    }

    function onResizeEnd() {
        if (!resizing) return;
        resizing = false;
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    }

    async function loadDocs() {
        try {
            docIds = await listDocs();
        } catch {
            /* shedb may not be initialised */
        }
    }

    async function loadViews() {
        try {
            viewIds = await listViews();
        } catch {
            /* shedb may not be initialised */
        }
    }

    async function selectDoc(id: string) {
        selectedDocId = id;
        docError = null;
        docLoading = true;
        try {
            const doc = await getDoc(id);
            docEditor = JSON.stringify(doc, null, 2);
        } catch (e: unknown) {
            docError = e instanceof Error ? e.message : String(e);
        } finally {
            docLoading = false;
        }
    }

    async function saveDoc() {
        if (!selectedDocId) return;
        docError = null;
        try {
            const parsed = JSON.parse(docEditor);
            await putDoc(selectedDocId, parsed);
        } catch (e: unknown) {
            docError = e instanceof Error ? e.message : String(e);
        }
    }

    async function deleteSelectedDoc() {
        if (!selectedDocId) return;
        if (!confirm(`Delete document "${selectedDocId}"?`)) return;
        try {
            await deleteDoc(selectedDocId);
            selectedDocId = null;
            docEditor = '{}';
        } catch (e: unknown) {
            docError = e instanceof Error ? e.message : String(e);
        }
    }

    async function createDoc() {
        const id = newDocId.trim();
        if (!id) return;
        newDocError = null;
        try {
            await putDoc(id, {});
            showNewDocForm = false;
            newDocId = '';
            await selectDoc(id);
        } catch (e: unknown) {
            newDocError = e instanceof Error ? e.message : String(e);
        }
    }

    async function selectView(id: string) {
        selectedViewId = id;
        viewError = null;
        viewLoading = true;
        viewResult = null;
        try {
            const def: ViewDefinition = await getView(id);
            viewFilter = def.filter ?? '';
            viewMap = def.map;
            viewReduce = def.reduce ?? '';
            viewResult = await getViewResult(id).catch(() => null);
        } catch (e: unknown) {
            viewError = e instanceof Error ? e.message : String(e);
        } finally {
            viewLoading = false;
        }
    }

    async function saveView() {
        if (!selectedViewId) return;
        viewError = null;
        try {
            const def: ViewDefinition = { map: viewMap };
            if (viewFilter.trim()) def.filter = viewFilter.trim();
            if (viewReduce.trim()) def.reduce = viewReduce.trim();
            await putView(selectedViewId, def);
        } catch (e: unknown) {
            viewError = e instanceof Error ? e.message : String(e);
        }
    }

    async function refreshViewResult() {
        if (!selectedViewId) return;
        try {
            viewResult = await getViewResult(selectedViewId);
        } catch (e: unknown) {
            viewError = e instanceof Error ? e.message : String(e);
        }
    }

    async function deleteSelectedView() {
        if (!selectedViewId) return;
        if (!confirm(`Delete view "${selectedViewId}"?`)) return;
        try {
            await deleteView(selectedViewId);
            selectedViewId = null;
            viewFilter = '';
            viewMap = '// emit(this.someProperty)';
            viewReduce = '';
            viewResult = null;
        } catch (e: unknown) {
            viewError = e instanceof Error ? e.message : String(e);
        }
    }

    async function createView() {
        if (!newViewId.trim()) return;
        const id = newViewId.trim();
        newViewError = null;
        try {
            await putView(id, { map: '// emit(this.someProperty)' });
            showNewViewForm = false;
            newViewId = '';
            await selectView(id);
        } catch (e: unknown) {
            newViewError = e instanceof Error ? e.message : String(e);
        }
    }

    onMount(() => {
        loadDocs();
        loadViews();

        const unsubIds = subscribeWs('db:ids', (msg) => {
            docIds = (msg.ids as string[]) ?? [];
        });
        const unsubViewIds = subscribeWs('db:viewIds', (msg) => {
            viewIds = (msg.ids as string[]) ?? [];
        });
        const unsubChange = subscribeWs('db:change', async (msg) => {
            const changedId = msg.id as string;
            if (selectedDocId === changedId) {
                if (msg.doc === null) {
                    selectedDocId = null;
                    docEditor = '{}';
                } else {
                    docEditor = JSON.stringify(msg.doc, null, 2);
                }
            }
        });
        const unsubViewUpdate = subscribeWs('db:viewUpdate', async (msg) => {
            const updatedId = msg.id as string;
            if (selectedViewId === updatedId) {
                viewResult = await getViewResult(updatedId).catch(() => null);
            }
        });

        return () => {
            unsubIds();
            unsubViewIds();
            unsubChange();
            unsubViewUpdate();
        };
    });
</script>

<div class="db-root" role="presentation" onmousemove={onResizeMove} onmouseup={onResizeEnd} onmouseleave={onResizeEnd}>
    <!-- Panel tabs -->
    <div class="panel-tabs">
        <button class:active={panel === 'docs'} onclick={() => (panel = 'docs')}>Documents</button>
        <button class:active={panel === 'views'} onclick={() => (panel = 'views')}>Views</button>
    </div>

    {#if panel === 'docs'}
        <div class="panel">
            <!-- Left sidebar: doc list -->
            <aside class="sidebar" style:width="{sidebarWidth}px">
                <div class="sidebar-header">
                    <span>Documents ({docIds.length})</span>
                    <button class="btn-icon" onclick={() => { showNewDocForm = !showNewDocForm; newDocError = null; }} title="New document">+</button>
                </div>
                {#if showNewDocForm}
                    <div class="new-item-form">
                        <input bind:value={newDocId} placeholder="device/lamp1" onkeydown={(e) => e.key === 'Enter' && createDoc()} />
                        <button onclick={createDoc}>Create</button>
                    </div>
                    {#if newDocError}<div class="form-error">{newDocError}</div>{/if}
                {/if}
                <ul>
                    {#each docIds as id (id)}
                        <li class:selected={selectedDocId === id}>
                            <button onclick={() => selectDoc(id)}>{id}</button>
                        </li>
                    {/each}
                </ul>
            </aside>
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div class="resize-handle" role="separator" onmousedown={onResizeStart}></div>

            <!-- Right editor area -->
            <main class="editor-area">
                {#if selectedDocId}
                    <div class="editor-toolbar">
                        <span class="editor-title">{selectedDocId}</span>
                        <button onclick={saveDoc}>Save</button>
                        <button class="btn-danger" onclick={deleteSelectedDoc}>Delete</button>
                    </div>
                    {#if docError}
                        <div class="error-bar">{docError}</div>
                    {/if}
                    {#if docLoading}
                        <div class="loading">Loading…</div>
                    {:else}
                        <textarea class="json-editor" bind:value={docEditor} spellcheck="false" rows="30"></textarea>
                    {/if}
                {:else}
                    <div class="empty-state">Select a document or create a new one.</div>
                {/if}
            </main>
        </div>
    {:else}
        <div class="panel">
            <!-- Left sidebar: view list -->
            <aside class="sidebar" style:width="{sidebarWidth}px">
                <div class="sidebar-header">
                    <span>Views ({viewIds.length})</span>
                    <button class="btn-icon" onclick={() => { showNewViewForm = !showNewViewForm; newViewError = null; }} title="New view">+</button>
                </div>
                {#if showNewViewForm}
                    <div class="new-item-form">
                        <input bind:value={newViewId} placeholder="myView" onkeydown={(e) => e.key === 'Enter' && createView()} />
                        <button onclick={createView}>Create</button>
                    </div>
                    {#if newViewError}<div class="form-error">{newViewError}</div>{/if}
                {/if}
                <ul>
                    {#each viewIds as id (id)}
                        <li class:selected={selectedViewId === id}>
                            <button onclick={() => selectView(id)}>{id}</button>
                        </li>
                    {/each}
                </ul>
            </aside>
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div class="resize-handle" role="separator" onmousedown={onResizeStart}></div>

            <!-- Right: view definition editor + result -->
            <main class="editor-area">
                {#if selectedViewId}
                    <div class="editor-toolbar">
                        <span class="editor-title">{selectedViewId}</span>
                        <button onclick={saveView}>Save</button>
                        <button onclick={refreshViewResult} title="Re-run view">Refresh</button>
                        <button class="btn-danger" onclick={deleteSelectedView}>Delete</button>
                    </div>
                    {#if viewError}
                        <div class="error-bar">{viewError}</div>
                    {/if}
                    {#if viewLoading}
                        <div class="loading">Loading…</div>
                    {:else}
                        <label class="field-label">
                            Filter (MQTT wildcard, optional)
                            <input class="filter-input" bind:value={viewFilter} placeholder="devices/#" />
                        </label>
                        <label class="field-label">
                            Map function — use <code>emit(value)</code> or <code>this.prop</code>
                            <textarea class="js-editor" bind:value={viewMap} spellcheck="false" rows="8"></textarea>
                        </label>
                        <label class="field-label">
                            Reduce function — receives <code>result</code> array, return new array (optional)
                            <textarea class="js-editor" bind:value={viewReduce} spellcheck="false" rows="5"></textarea>
                        </label>

                        {#if viewResult}
                            <div class="view-result">
                                <div class="result-header">
                                    Result
                                    {#if viewResult.error}
                                        <span class="badge-error">error</span>
                                    {:else}
                                        <span class="badge-ok">{viewResult.length ?? 0} items · rev {viewResult._rev}</span>
                                    {/if}
                                </div>
                                {#if viewResult.error}
                                    <pre class="result-error">{viewResult.error}</pre>
                                {:else}
                                    <pre class="result-json">{JSON.stringify(viewResult.result, null, 2)}</pre>
                                {/if}
                            </div>
                        {/if}
                    {/if}
                {:else}
                    <div class="empty-state">Select a view or create a new one.</div>
                {/if}
            </main>
        </div>
    {/if}
</div>

<style>
    .db-root {
        display: flex;
        flex-direction: column;
        height: 100%;
        font-size: 0.9rem;
    }

    .panel-tabs {
        display: flex;
        gap: 4px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--border-sub);
    }

    .panel-tabs button {
        background: none;
        border: 1px solid var(--border);
        color: var(--fg);
        padding: 3px 12px;
        border-radius: 4px;
        cursor: pointer;
    }

    .panel-tabs button.active {
        background: var(--bg-active);
        color: var(--fg-text);
    }

    .panel {
        display: flex;
        flex: 1;
        overflow: hidden;
    }

    .sidebar {
        min-width: 140px;
        max-width: 500px;
        flex-shrink: 0;
        border-right: none;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background: var(--bg-panel);
    }

    .resize-handle {
        width: 5px;
        flex-shrink: 0;
        cursor: col-resize;
        background: var(--border-sub);
        transition: background 0.15s;
        position: relative;
    }
    .resize-handle:hover,
    .resize-handle:active {
        background: var(--accent);
    }

    .new-item-form {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding: 4px 6px;
        border-bottom: 1px solid var(--border-sub);
    }

    .new-item-form input {
        flex: 1 1 0;
        min-width: 60px;
        background: var(--bg-app);
        border: 1px solid var(--border);
        color: var(--fg);
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 0.82rem;
    }

    .new-item-form button {
        flex-shrink: 0;
        background: var(--accent);
        border: none;
        color: #fff;
        padding: 2px 8px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 0.82rem;
    }

    .form-error {
        padding: 2px 6px 4px;
        font-size: 0.78rem;
        color: var(--error, #e05252);
        border-bottom: 1px solid var(--border-sub);
    }

    .sidebar ul {
        list-style: none;
        margin: 0;
        padding: 0;
        overflow-y: auto;
        flex: 1;
    }

    .sidebar li button {
        display: block;
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        color: var(--fg);
        padding: 5px 10px;
        cursor: pointer;
        font-size: 0.82rem;
        word-break: break-all;
    }

    .sidebar li.selected button,
    .sidebar li button:hover {
        background: var(--bg-active);
        color: var(--fg-text);
    }

    .editor-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding: 0;
    }

    .editor-toolbar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border-sub);
    }

    .editor-title {
        flex: 1;
        font-weight: bold;
        font-size: 0.85rem;
        color: var(--fg);
        word-break: break-all;
    }

    .editor-toolbar button {
        background: var(--accent);
        border: none;
        color: #fff;
        padding: 3px 10px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 0.82rem;
    }

    .btn-danger {
        background: var(--accent-del) !important;
    }

    .error-bar {
        background: var(--bg-err-subtle);
        color: var(--fg-err-subtle);
        padding: 4px 10px;
        font-size: 0.82rem;
    }

    .loading,
    .empty-state {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--fg-dim);
        font-size: 0.9rem;
    }

    .json-editor,
    .js-editor {
        flex: 1;
        width: 100%;
        background: var(--bg-app);
        color: var(--fg-text);
        border: none;
        font-family: 'Cascadia Code', 'Fira Mono', monospace;
        font-size: 0.82rem;
        padding: 8px;
        resize: none;
        box-sizing: border-box;
    }

    .field-label {
        display: flex;
        flex-direction: column;
        padding: 6px 8px 0;
        font-size: 0.78rem;
        color: var(--fg-muted);
        gap: 3px;
    }

    .filter-input {
        background: var(--bg-app);
        border: 1px solid var(--border);
        color: var(--fg);
        padding: 3px 8px;
        border-radius: 3px;
        font-size: 0.82rem;
    }

    .view-result {
        margin: 8px;
        border: 1px solid var(--border-sub);
        border-radius: 4px;
        overflow: hidden;
    }

    .result-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 10px;
        background: var(--bg-app);
        border-bottom: 1px solid var(--border-sub);
        font-size: 0.8rem;
        color: var(--fg-muted);
    }

    .badge-ok {
        background: var(--bg-diff-add);
        color: var(--fg-diff-add);
        padding: 1px 6px;
        border-radius: 3px;
        font-size: 0.75rem;
    }

    .badge-error {
        background: var(--bg-diff-del);
        color: var(--fg-diff-del);
        padding: 1px 6px;
        border-radius: 3px;
        font-size: 0.75rem;
    }

    .result-json,
    .result-error {
        margin: 0;
        padding: 8px;
        background: var(--bg-app);
        color: var(--fg-text);
        font-family: 'Cascadia Code', 'Fira Mono', monospace;
        font-size: 0.8rem;
        overflow: auto;
        max-height: 260px;
        white-space: pre-wrap;
    }

    .result-error {
        color: var(--fg-err-subtle);
    }
</style>

