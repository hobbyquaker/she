<script lang="ts">
    import { onMount } from 'svelte';
    import { subscribeWs } from '../lib/ws.js';
    import { listDocs, getDoc, putDoc, deleteDoc, listViews, getView, putView, deleteView, getViewResult, getConfig, type ViewDefinition, type ViewResult } from '../lib/api.js';
    import { mqttWildcard } from '../lib/mqtt-wildcards.js';
    import ConfirmDialog from '../lib/ConfirmDialog.svelte';
    import ViewChat from './ViewChat.svelte';
    import MonacoEditor from '../lib/MonacoEditor.svelte';

    // ---- Document state ----
    let docIds: string[] = $state([]);
    let selectedDocId: string | null = $state(null);
    let docEditor: string = $state('{}');
    let docLoading = $state(false);
    let docError: string | null = $state(null);

    // ---- View state ----
    const SELECTED_VIEW_KEY = 'she-db-selected-view';
    let viewIds: string[] = $state([]);
    let selectedViewId: string | null = $state(localStorage.getItem(SELECTED_VIEW_KEY));
    let viewFilter = $state('#');
    let viewMap = $state('// emit(this.someProperty)');
    let viewReduce = $state('');
    let viewDescription = $state('');
    let viewMqttPub = $state(false);
    let viewRetain  = $state(false);
    let viewResult: ViewResult | null = $state(null);
    let viewLoading = $state(false);
    let viewError: string | null = $state(null);

    // dbPrefix from daemon config (e.g. "she/db/")
    let dbViewPrefix = $state('she/db/view/');

    // ---- Tabs inside DB panel ----
    const PANEL_KEY = 'she-db-panel';
    let panel: 'docs' | 'views' = $state((localStorage.getItem(PANEL_KEY) as 'docs' | 'views') ?? 'docs');

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

    // ---- Chat panel ----
    const CHAT_WIDTH_KEY = 'she-db-chat-width';
    const CHAT_OPEN_KEY  = 'she-db-chat-open';
    let chatOpen  = $state(localStorage.getItem(CHAT_OPEN_KEY) === 'true');
    let chatWidth = $state(parseInt(localStorage.getItem(CHAT_WIDTH_KEY) ?? '320', 10));
    let chatResizing = false;
    let chatResizeStartX = 0;
    let chatResizeStartW = 0;

    // ---- View editor row resize ----
    const MAP_HEIGHT_KEY = 'she-db-map-height';
    const REDUCE_HEIGHT_KEY = 'she-db-reduce-height';
    let mapHeight = $state(parseInt(localStorage.getItem(MAP_HEIGHT_KEY) ?? '240', 10));
    let reduceHeight = $state(parseInt(localStorage.getItem(REDUCE_HEIGHT_KEY) ?? '160', 10));
    let _mapDragging = false;
    let _mapDragStartY = 0;
    let _mapDragStartH = 0;
    let _reduceDragging = false;
    let _reduceDragStartY = 0;
    let _reduceDragStartH = 0;

    const currentView = $derived(
        selectedViewId
            ? { id: selectedViewId, filter: viewFilter, map: viewMap, reduce: viewReduce }
            : null,
    );

    function onApplyView(parts: { filter?: string; map?: string; reduce?: string }) {
        if (parts.filter !== undefined) viewFilter = parts.filter;
        if (parts.map    !== undefined) viewMap    = parts.map;
        if (parts.reduce !== undefined) viewReduce = parts.reduce;
    }

    $effect(() => { localStorage.setItem(CHAT_OPEN_KEY, String(chatOpen)); });
    $effect(() => { localStorage.setItem(PANEL_KEY, panel); });
    $effect(() => {
        if (selectedViewId) localStorage.setItem(SELECTED_VIEW_KEY, selectedViewId);
        else localStorage.removeItem(SELECTED_VIEW_KEY);
    });

    function onResizeStart(e: MouseEvent) {
        resizing = true;
        resizeStartX = e.clientX;
        resizeStartWidth = sidebarWidth;
        e.preventDefault();
    }

    function onResizeMove(e: MouseEvent) {
        if (resizing) sidebarWidth = Math.max(140, Math.min(500, resizeStartWidth + e.clientX - resizeStartX));
        if (chatResizing) chatWidth = Math.max(240, Math.min(600, chatResizeStartW - (e.clientX - chatResizeStartX)));
        if (_mapDragging) mapHeight = Math.max(60, Math.min(600, _mapDragStartH + e.clientY - _mapDragStartY));
        if (_reduceDragging) reduceHeight = Math.max(40, Math.min(400, _reduceDragStartH + e.clientY - _reduceDragStartY));
    }

    function onResizeEnd() {
        if (resizing) {
            resizing = false;
            localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
        }
        if (chatResizing) {
            chatResizing = false;
            localStorage.setItem(CHAT_WIDTH_KEY, String(chatWidth));
        }
        if (_mapDragging) {
            _mapDragging = false;
            localStorage.setItem(MAP_HEIGHT_KEY, String(mapHeight));
        }
        if (_reduceDragging) {
            _reduceDragging = false;
            localStorage.setItem(REDUCE_HEIGHT_KEY, String(reduceHeight));
        }
    }

    function onChatResizeStart(e: MouseEvent) {
        chatResizing = true;
        chatResizeStartX = e.clientX;
        chatResizeStartW = chatWidth;
        e.preventDefault();
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

    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean; alert?: boolean }): Promise<boolean> };

    async function deleteSelectedDoc() {
        if (!selectedDocId) return;
        if (!(await dialog.show(`Delete document "${selectedDocId}"?`, { confirm: 'Delete', danger: true }))) return;
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
            viewDescription = def.description ?? '';
            viewMqttPub = def.mqttpub ?? false;
            viewRetain  = def.retain  ?? false;
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
            if (viewDescription.trim()) def.description = viewDescription.trim();
            if (viewMqttPub) def.mqttpub = true;
            if (viewRetain)  def.retain  = true;
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
        if (!(await dialog.show(`Delete view "${selectedViewId}"?`, { confirm: 'Delete', danger: true }))) return;
        try {
            await deleteView(selectedViewId);
            selectedViewId = null;
            viewFilter = '';
            viewMap = '// emit(this.someProperty)';
            viewReduce = '';
            viewDescription = '';
            viewMqttPub = false;
            viewRetain  = false;
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
            await loadViews();
            await selectView(id);
        } catch (e: unknown) {
            newViewError = e instanceof Error ? e.message : String(e);
        }
    }

    // ---- Sidebar search ----
    let docSearch = $state('');
    let viewSearch = $state('');

    function hasWildcard(s: string) { return s.includes('#') || s.includes('+'); }

    let filteredDocIds = $derived(
        [...docIds].filter(id => {
            if (!docSearch) return true;
            if (hasWildcard(docSearch)) return mqttWildcard(id, docSearch) !== null;
            return id.toLowerCase().includes(docSearch.toLowerCase());
        }).sort()
    );
    let filteredViewIds = $derived(
        [...viewIds].filter(id => {
            if (!viewSearch) return true;
            if (hasWildcard(viewSearch)) return mqttWildcard(id, viewSearch) !== null;
            return id.toLowerCase().includes(viewSearch.toLowerCase());
        }).sort()
    );

    // ---- MQTT topic clipboard copy ----
    let mqttTopicCopied = $state(false);
    let _mqttCopyTimer: ReturnType<typeof setTimeout> | null = null;
    function copyMqttTopic() {
        try { navigator.clipboard.writeText(`${dbViewPrefix}${selectedViewId}`); } catch { /* ignore */ }
        mqttTopicCopied = true;
        if (_mqttCopyTimer) clearTimeout(_mqttCopyTimer);
        _mqttCopyTimer = setTimeout(() => (mqttTopicCopied = false), 1500);
    }

    onMount(() => {
        loadDocs();
        loadViews().then(() => {
            if (selectedViewId && viewIds.includes(selectedViewId)) selectView(selectedViewId);
            else selectedViewId = null;
        });
        getConfig().then((cfg) => {
            const raw = (cfg.dbPrefix as string | undefined) || 'she/db/';
            const prefix = raw.endsWith('/') ? raw : raw + '/';
            dbViewPrefix = prefix + 'view/';
        }).catch(() => {});

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

{#snippet dbWelcome()}
    <div class="welcome">
        <div class="welcome-inner">
            <div class="welcome-logo">db</div>
            <p class="welcome-sub">sheDB — embedded JSON document store with MapReduce views</p>
            <div class="welcome-hint">
                <strong>In scripts:</strong> use <code>she.db.get(id)</code>, <code>she.db.set(id, doc)</code>,
                <code>she.db.extend(id, partial)</code>, <code>she.db.sub(pattern, cb)</code>.<br>
                <strong>Views:</strong> <code>this</code> = current document &mdash; call <code>emit(value)</code> to add to result.
            </div>
            <div class="welcome-links">
                <a href="https://github.com/hobbyquaker/she/blob/main/doc/db/README.md" target="_blank" rel="noopener">sheDB docs</a>
                <span>·</span>
                <a href="https://github.com/hobbyquaker/she/blob/main/doc/db/view-examples.md" target="_blank" rel="noopener">View examples</a>
                <span>·</span>
                <a href="https://github.com/hobbyquaker/she" target="_blank" rel="noopener">GitHub</a>
            </div>
        </div>
    </div>
{/snippet}

<ConfirmDialog bind:this={dialog} />
<div class="db-root" class:row-dragging={_mapDragging || _reduceDragging} role="presentation" onmousemove={onResizeMove} onmouseup={onResizeEnd} onmouseleave={onResizeEnd}>
    <!-- Panel tabs -->
    <div class="panel-tabs">
        <button class:active={panel === 'docs'} onclick={() => (panel = 'docs')}>Documents</button>
        <button class:active={panel === 'views'} onclick={() => (panel = 'views')}>Views</button>
        {#if panel === 'views'}
        <button
            class="ai-toggle"
            class:ai-open={chatOpen}
            onclick={() => chatOpen = !chatOpen}
            title={chatOpen ? 'Close AI assistant' : 'Open AI assistant'}
        >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
                <line x1="5.5" y1="5" x2="4" y2="2.5"/>
                <line x1="10.5" y1="5" x2="12" y2="2.5"/>
                <path d="M3 11 V7 A5 3.5 0 0 0 13 7 V11 Z" stroke-linejoin="round"/>
                <circle cx="6" cy="8.2" r="0.7" fill="currentColor" stroke="none"/>
                <circle cx="10" cy="8.2" r="0.7" fill="currentColor" stroke="none"/>
            </svg>
            AI
        </button>
        {/if}
    </div>

    {#if panel === 'docs'}
        <div class="panel">
            <!-- Left sidebar: doc list -->
            <aside class="sidebar" style:width="{sidebarWidth}px">
                <div class="toolbar">
                    <button onclick={() => { showNewDocForm = !showNewDocForm; newDocError = null; }}>+ Doc</button>
                </div>
                {#if showNewDocForm}
                    <div class="new-item-form">
                        <input bind:value={newDocId} placeholder="device/lamp1" onkeydown={(e) => e.key === 'Enter' && createDoc()} />
                        <button onclick={createDoc}>Create</button>
                    </div>
                    {#if newDocError}<div class="form-error">{newDocError}</div>{/if}
                {/if}
                <div class="sidebar-search">
                    <input type="search" placeholder="Filter…" bind:value={docSearch} />
                </div>
                <ul class="flat-list">
                    {#each filteredDocIds as id (id)}
                        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
                        <li class="flat-item" class:active-item={selectedDocId === id} onclick={() => selectDoc(id)}>{id}</li>
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
                        <div class="monaco-doc-wrap">
                            <MonacoEditor bind:value={docEditor} language="json" />
                        </div>
                    {/if}
                {:else}
                    {@render dbWelcome()}
                {/if}
            </main>
        </div>
    {:else}
        <div class="panel">
            <!-- Left sidebar: view list -->
            <aside class="sidebar" style:width="{sidebarWidth}px">
                <div class="toolbar">
                    <button onclick={() => { showNewViewForm = !showNewViewForm; newViewError = null; }}>+ View</button>
                </div>
                {#if showNewViewForm}
                    <div class="new-item-form">
                        <input bind:value={newViewId} placeholder="myView" onkeydown={(e) => e.key === 'Enter' && createView()} />
                        <button onclick={createView}>Create</button>
                    </div>
                    {#if newViewError}<div class="form-error">{newViewError}</div>{/if}
                {/if}
                <div class="sidebar-search">
                    <input type="search" placeholder="Filter…" bind:value={viewSearch} />
                </div>
                <ul class="flat-list">
                    {#each filteredViewIds as id (id)}
                        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
                        <li class="flat-item" class:active-item={selectedViewId === id} onclick={() => selectView(id)}>{id}</li>
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
                        <div class="view-sections">
                            <div class="view-top">
                            <div class="view-section">
                                <div class="section-title">Description <span class="section-hint">— optional, shown in sidebar</span></div>
                                <div class="section-body">
                                    <input class="filter-input" bind:value={viewDescription} placeholder="(optional description)" />
                                </div>
                            </div>
                            <div class="view-section">
                                <div class="section-title">Filter <span class="section-hint">— MQTT wildcard, optional</span></div>
                                <div class="section-body">
                                    <input class="filter-input" bind:value={viewFilter} placeholder="#" />
                                </div>
                            </div>
                            <div class="view-section">
                                <div class="section-title">Map <span class="section-hint">— <code>this</code> = document &nbsp;·&nbsp; call <code>emit(this)</code> to include in result</span></div>
                                <div class="monaco-view-wrap" style:height="{mapHeight}px">
                                    <MonacoEditor bind:value={viewMap} language="javascript" onSave={saveView} />
                                </div>
                                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                                <div class="view-row-handle" role="separator" onmousedown={(e) => { _mapDragging = true; _mapDragStartY = e.clientY; _mapDragStartH = mapHeight; e.preventDefault(); }}></div>
                            </div>
                            <div class="view-section">
                                <div class="section-title">Reduce <span class="section-hint">— receives <code>result</code> array, must <code>return</code> new value (optional)</span></div>
                                <div class="monaco-view-wrap" style:height="{reduceHeight}px">
                                    <MonacoEditor bind:value={viewReduce} language="javascript" onSave={saveView} />
                                </div>
                                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                                <div class="view-row-handle" role="separator" onmousedown={(e) => { _reduceDragging = true; _reduceDragStartY = e.clientY; _reduceDragStartH = reduceHeight; e.preventDefault(); }}></div>
                            </div>
                            <div class="view-section view-section--options">
                                <label class="opt-check">
                                    <input type="checkbox" bind:checked={viewMqttPub} />
                                    <span class="checkmark"></span>
                                    Publish to MQTT
                                </label>
                                {#if viewMqttPub}
                                <div class="mqtt-topic-row">
                                    <code class="mqtt-topic">{dbViewPrefix}{selectedViewId}</code>
                                    <button class="btn-copy" title={mqttTopicCopied ? 'Copied!' : 'Copy topic'} onclick={copyMqttTopic}>
                                        {#if mqttTopicCopied}
                                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                            <polyline points="2,8 6,12 14,4"/>
                                        </svg>
                                        {:else}
                                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                                            <rect x="5" y="2" width="9" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>
                                            <rect x="2" y="5" width="9" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>
                                        </svg>
                                        {/if}
                                    </button>
                                    <span class="section-hint">published on every update</span>
                                </div>
                                <label class="opt-check">
                                    <input type="checkbox" bind:checked={viewRetain} />
                                    <span class="checkmark"></span>
                                    Retain
                                    <span class="section-hint">— send as retained MQTT message</span>
                                </label>
                                {/if}
                            </div>
                            </div><!-- /view-top -->
                            {#if viewResult}
                                <div class="view-result-fill">
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
                        </div>
                    {/if}
                {:else}
                    {@render dbWelcome()}
                {/if}
            </main>
            <!-- Chat panel (Views only) -->
            {#if chatOpen}
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <div class="chat-resize-handle" role="separator" onmousedown={onChatResizeStart}></div>
                <div class="chat-pane" style:width="{chatWidth}px">
                    <ViewChat currentView={currentView} {onApplyView} />
                </div>
            {/if}
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
    .db-root.row-dragging { cursor: row-resize; user-select: none; }

    .panel-tabs {
        display: flex;
        align-items: center;
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
        font-size: 13px;
        cursor: pointer;
    }

    .panel-tabs button.active {
        background: var(--bg-active);
        color: var(--fg-text);
    }

    /* AI toggle — same look as Scripts page */
    .ai-toggle {
        margin-left: auto;
        background: var(--bg-widget) !important;
        color: var(--fg-brand) !important;
        border: 1px solid var(--border) !important;
        font-weight: 600 !important;
        display: inline-flex !important;
        align-items: center !important;
        gap: 4px !important;
        padding: 3px 10px !important;
        border-radius: 4px !important;
        cursor: pointer !important;
        font-size: 12px !important;
    }
    .ai-toggle:hover { background: var(--bg-hover) !important; }
    .ai-toggle.ai-open { background: var(--fg-brand) !important; color: #fff !important; border-color: var(--fg-brand) !important; }

    .panel {
        display: flex;
        flex: 1;
        overflow: hidden;
    }

    .sidebar {
        min-width: 140px;
        max-width: 500px;
        flex-shrink: 0;
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
    }
    .resize-handle:hover,
    .resize-handle:active {
        background: var(--accent);
    }

    .chat-resize-handle {
        width: 5px;
        flex-shrink: 0;
        cursor: col-resize;
        background: var(--border-sub);
        transition: background 0.15s;
    }
    .chat-resize-handle:hover,
    .chat-resize-handle:active {
        background: var(--accent);
    }

    .chat-pane {
        flex-shrink: 0;
        min-width: 240px;
        max-width: 600px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    /* ---- Sidebar toolbar ---- */
    .toolbar {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 8px;
        border-bottom: 1px solid var(--border-sub);
    }

    .toolbar button {
        flex: 1;
        background: var(--accent);
        color: #fff;
        border: none;
        padding: 4px 6px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
    }

    .toolbar button:hover { background: var(--accent-hov); }



    /* ---- New-item form ---- */
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

    /* ---- Flat sidebar list ---- */
    .sidebar-search {
        padding: 4px 6px;
        border-bottom: 1px solid var(--border-sub);
        flex-shrink: 0;
    }
    .sidebar-search input {
        width: 100%;
        box-sizing: border-box;
        background: var(--bg-app);
        border: 1px solid var(--border);
        border-radius: 3px;
        color: var(--fg);
        padding: 3px 6px;
        font-size: 12px;
    }

    .flat-list {
        flex: 1;
        overflow-y: auto;
        list-style: none;
        padding: 4px 0;
        margin: 0;
    }
    .flat-item {
        padding: 3px 10px;
        font-size: 12px;
        font-family: monospace;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--fg);
    }
    .flat-item:hover { background: var(--bg-hover); }
    .flat-item.active-item {
        background: var(--bg-active);
        color: var(--fg-text);
    }

    /* ---- Editor area ---- */
    .editor-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .editor-toolbar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border-sub);
        flex-shrink: 0;
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

    .btn-danger { background: var(--accent-del) !important; }

    .error-bar {
        background: var(--bg-err-subtle);
        color: var(--fg-err-subtle);
        padding: 4px 10px;
        font-size: 0.82rem;
        flex-shrink: 0;
    }

    .loading {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--fg-dim);
        font-size: 0.9rem;
    }

    /* ---- Monaco wrappers ---- */
    .monaco-doc-wrap {
        flex: 1;
        overflow: hidden;
        min-height: 0;
    }

    .monaco-view-wrap {
        overflow: hidden;
    }

    /* ---- View section layout ---- */
    .view-sections {
        display: flex;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
        min-height: 0;
    }
    .view-top {
        flex: 0 1 auto;
        overflow-y: auto;
        min-height: 0;
    }
    .view-row-handle {
        height: 5px;
        flex-shrink: 0;
        cursor: row-resize;
        background: var(--border-sub);
        transition: background 0.15s;
    }
    .view-row-handle:hover,
    .view-row-handle:active { background: var(--accent); }

    .view-section {
        border-bottom: 1px solid var(--border-sub);
    }

    .section-title {
        padding: 5px 10px 4px;
        font-size: 0.7rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--fg-muted);
        background: var(--bg-panel);
        border-bottom: 1px solid var(--border-sub);
        user-select: none;
    }

    .section-hint {
        font-weight: normal;
        text-transform: none;
        letter-spacing: 0;
        color: var(--fg-dim);
    }

    .view-section--options {
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .opt-check {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--fg);
        cursor: pointer;
        user-select: none;
    }
    .opt-check input[type='checkbox'] {
        position: absolute;
        opacity: 0;
        width: 0;
        height: 0;
        pointer-events: none;
    }
    .opt-check .checkmark {
        flex-shrink: 0;
        width: 13px;
        height: 13px;
        border: 1.5px solid var(--border);
        border-radius: 2px;
        background: var(--bg-app);
        position: relative;
        transition: background 0.12s, border-color 0.12s;
    }
    .opt-check input:checked + .checkmark {
        background: var(--accent);
        border-color: var(--accent);
    }
    .opt-check input:checked + .checkmark::after {
        content: '';
        position: absolute;
        left: 3px;
        top: 0px;
        width: 4px;
        height: 7px;
        border: 1.5px solid #fff;
        border-top: none;
        border-left: none;
        transform: rotate(45deg);
    }
    .opt-check:hover .checkmark { border-color: var(--accent); }

    .mqtt-topic-row {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 3px 0 3px 19px;
    }
    .mqtt-topic {
        font-size: 11px;
        background: var(--bg-widget);
        border: 1px solid var(--border);
        border-radius: 3px;
        padding: 1px 5px;
        color: var(--fg);
        font-family: monospace;
        word-break: break-all;
    }
    .btn-copy {
        flex-shrink: 0;
        background: none;
        border: 1px solid var(--border);
        border-radius: 3px;
        color: var(--fg-muted);
        cursor: pointer;
        padding: 2px 4px;
        line-height: 0;
        display: inline-flex;
        align-items: center;
    }
    .btn-copy:hover { color: var(--fg); border-color: var(--accent); }

    .section-body { padding: 6px 8px; }

    .filter-input {
        width: 100%;
        box-sizing: border-box;
        background: var(--bg-app);
        border: 1px solid var(--border);
        color: var(--fg);
        padding: 4px 8px;
        border-radius: 3px;
        font-size: 0.82rem;
    }

    /* ---- View result ---- */
    .view-result-fill {
        flex: 1 0 120px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-top: 2px solid var(--border-sub);
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
        flex: 1;
        margin: 0;
        padding: 8px;
        background: var(--bg-app);
        color: var(--fg-text);
        font-family: 'Cascadia Code', 'Fira Mono', monospace;
        font-size: 0.8rem;
        overflow: auto;
        white-space: pre-wrap;
        min-height: 0;
    }

    .result-error { color: var(--fg-err-subtle); }

    /* ---- Welcome page ---- */
    .welcome {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-app);
    }

    .welcome-inner {
        max-width: 480px;
        text-align: center;
        padding: 32px 24px;
    }

    .welcome-logo {
        font-size: 52px;
        font-weight: 700;
        letter-spacing: -2px;
        color: var(--fg-brand);
        line-height: 1;
        margin-bottom: 8px;
        font-family: 'Cascadia Code', 'Fira Code', monospace;
    }

    .welcome-sub {
        color: var(--fg-muted);
        font-size: 13px;
        margin: 0 0 24px;
    }

    .welcome-hint {
        background: var(--bg-panel);
        border: 1px solid var(--border-sub);
        border-radius: 6px;
        padding: 14px 18px;
        font-size: 13px;
        color: var(--fg);
        line-height: 1.6;
        text-align: left;
        margin-bottom: 20px;
    }

    .welcome-hint code { color: var(--fg-brand); font-size: 12px; }

    .welcome-links {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        font-size: 12px;
    }

    .welcome-links a { color: var(--fg-brand); text-decoration: none; }
    .welcome-links a:hover { text-decoration: underline; }
    .welcome-links span { color: var(--fg-dim); }
</style>

