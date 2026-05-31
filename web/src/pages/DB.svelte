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
    import ViewChat from './ViewChat.svelte';

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
    let viewMqttPub = $state(false);
    let viewRetain  = $state(false);
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

    // ---- Chat panel ----
    const CHAT_WIDTH_KEY = 'she-db-chat-width';
    const CHAT_OPEN_KEY  = 'she-db-chat-open';
    let chatOpen  = $state(localStorage.getItem(CHAT_OPEN_KEY) === 'true');
    let chatWidth = $state(parseInt(localStorage.getItem(CHAT_WIDTH_KEY) ?? '320', 10));
    let chatResizing = false;
    let chatResizeStartX = 0;
    let chatResizeStartW = 0;

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

    function onResizeStart(e: MouseEvent) {
        resizing = true;
        resizeStartX = e.clientX;
        resizeStartWidth = sidebarWidth;
        e.preventDefault();
    }

    function onResizeMove(e: MouseEvent) {
        if (resizing) sidebarWidth = Math.max(140, Math.min(500, resizeStartWidth + e.clientX - resizeStartX));
        if (chatResizing) chatWidth = Math.max(240, Math.min(600, chatResizeStartW - (e.clientX - chatResizeStartX)));
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
        if (!confirm(`Delete view "${selectedViewId}"?`)) return;
        try {
            await deleteView(selectedViewId);
            selectedViewId = null;
            viewFilter = '';
            viewMap = '// emit(this.someProperty)';
            viewReduce = '';
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
            await selectView(id);
        } catch (e: unknown) {
            newViewError = e instanceof Error ? e.message : String(e);
        }
    }

    // ---- Tree (folder grouping by slash-separated ID segments) ----
    type DocTreeNode =
        | { type: 'leaf'; name: string; id: string }
        | { type: 'folder'; name: string; path: string; children: DocTreeNode[] };

    let expandedDocDirs: Record<string, boolean> = $state({});
    let expandedViewDirs: Record<string, boolean> = $state({});

    function buildSubTree(ids: string[], prefix: string): DocTreeNode[] {
        const nodes: DocTreeNode[] = [];
        const folderMap = new Map<string, string[]>();
        const leaves: string[] = [];
        for (const id of ids) {
            const rel = prefix ? id.slice(prefix.length + 1) : id;
            const slash = rel.indexOf('/');
            if (slash === -1) { leaves.push(id); }
            else {
                const seg = rel.slice(0, slash);
                if (!folderMap.has(seg)) folderMap.set(seg, []);
                folderMap.get(seg)!.push(id);
            }
        }
        for (const [seg, children] of folderMap) {
            const fpath = prefix ? `${prefix}/${seg}` : seg;
            nodes.push({ type: 'folder', name: seg, path: fpath, children: buildSubTree(children, fpath) });
        }
        for (const id of leaves) {
            nodes.push({ type: 'leaf', name: prefix ? id.slice(prefix.length + 1) : id, id });
        }
        return nodes;
    }

    let docTree = $derived(buildSubTree([...docIds].sort(), ''));
    let viewTree = $derived(buildSubTree([...viewIds].sort(), ''));

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

{#snippet docTreeNode(nodes: DocTreeNode[], depth: number)}
    {#each nodes as node (node.type === 'leaf' ? node.id : node.path)}
        {#if node.type === 'folder'}
            <li class="tree-dir">
                <div class="dir-row" style="--depth: {depth}">
                    <button class="chevron" onclick={() => { expandedDocDirs[node.path] = !expandedDocDirs[node.path]; }}>
                        {expandedDocDirs[node.path] ? '▾' : '▸'}
                    </button>
                    <span class="dir-name">{node.name}</span>
                </div>
                {#if expandedDocDirs[node.path]}
                    <ul class="tree-children">
                        {@render docTreeNode(node.children, depth + 1)}
                    </ul>
                {/if}
            </li>
        {:else}
            <li class="tree-file" class:active-item={selectedDocId === node.id} style="--depth: {depth}">
                <button onclick={() => selectDoc(node.id)}>
                    <span class="fname">{node.name}</span>
                </button>
            </li>
        {/if}
    {/each}
{/snippet}

{#snippet viewTreeNode(nodes: DocTreeNode[], depth: number)}
    {#each nodes as node (node.type === 'leaf' ? node.id : node.path)}
        {#if node.type === 'folder'}
            <li class="tree-dir">
                <div class="dir-row" style="--depth: {depth}">
                    <button class="chevron" onclick={() => { expandedViewDirs[node.path] = !expandedViewDirs[node.path]; }}>
                        {expandedViewDirs[node.path] ? '▾' : '▸'}
                    </button>
                    <span class="dir-name">{node.name}</span>
                </div>
                {#if expandedViewDirs[node.path]}
                    <ul class="tree-children">
                        {@render viewTreeNode(node.children, depth + 1)}
                    </ul>
                {/if}
            </li>
        {:else}
            <li class="tree-file" class:active-item={selectedViewId === node.id} style="--depth: {depth}">
                <button onclick={() => selectView(node.id)}>
                    <span class="fname">{node.name}</span>
                </button>
            </li>
        {/if}
    {/each}
{/snippet}

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
                <ul class="tree">
                    {@render docTreeNode(docTree, 0)}
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
                    <button class="chat-toggle" class:active={chatOpen} onclick={() => chatOpen = !chatOpen} title="AI assistant">AI</button>
                </div>
                {#if showNewViewForm}
                    <div class="new-item-form">
                        <input bind:value={newViewId} placeholder="myView" onkeydown={(e) => e.key === 'Enter' && createView()} />
                        <button onclick={createView}>Create</button>
                    </div>
                    {#if newViewError}<div class="form-error">{newViewError}</div>{/if}
                {/if}
                <ul class="tree">
                    {@render viewTreeNode(viewTree, 0)}
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
                            <div class="view-section">
                                <div class="section-title">Filter <span class="section-hint">— MQTT wildcard, optional</span></div>
                                <div class="section-body">
                                    <input class="filter-input" bind:value={viewFilter} placeholder="devices/#" />
                                </div>
                            </div>
                            <div class="view-section">
                                <div class="section-title">Map <span class="section-hint">— <code>this</code> = document &nbsp;·&nbsp; call <code>emit(value)</code> to include in result</span></div>
                                <textarea class="code-editor" bind:value={viewMap} spellcheck="false" rows="8"></textarea>
                            </div>
                            <div class="view-section">
                                <div class="section-title">Reduce <span class="section-hint">— receives <code>result</code> array, must <code>return</code> new value (optional)</span></div>
                                <textarea class="code-editor" bind:value={viewReduce} spellcheck="false" rows="5"></textarea>
                            </div>
                            <div class="view-section view-section--options">
                                <label class="opt-check">
                                    <input type="checkbox" bind:checked={viewMqttPub} />
                                    Publish to MQTT
                                    <span class="section-hint">— result published to <code>{selectedViewId}</code> topic under <code>/db/view/</code> on every update</span>
                                </label>
                                {#if viewMqttPub}
                                <label class="opt-check">
                                    <input type="checkbox" bind:checked={viewRetain} />
                                    Retain
                                    <span class="section-hint">— send as retained MQTT message</span>
                                </label>
                                {/if}
                            </div>
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

    .toolbar .chat-toggle {
        flex: 0 0 auto;
        background: var(--bg-app);
        color: var(--fg-dim);
        border: 1px solid var(--border);
    }
    .toolbar .chat-toggle:hover { background: var(--bg-active); color: var(--fg); }
    .toolbar .chat-toggle.active { background: var(--accent); color: #fff; border-color: var(--accent); }

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

    /* ---- Folder tree ---- */
    .tree {
        flex: 1;
        overflow-y: auto;
        list-style: none;
        padding: 4px 0;
        margin: 0;
    }

    .tree-dir,
    .tree-file { list-style: none; }

    .tree-children { list-style: none; padding: 0; margin: 0; }

    .dir-row {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 3px 12px 3px calc(8px + var(--depth, 0) * 12px);
        cursor: default;
    }

    .chevron {
        background: none;
        border: none;
        color: var(--fg-muted);
        cursor: pointer;
        padding: 0;
        font-size: 9px;
        line-height: 1;
        width: 12px;
        flex-shrink: 0;
        text-align: center;
    }

    .dir-name {
        color: var(--fg);
        font-size: 12px;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .tree-file button {
        display: flex;
        align-items: center;
        gap: 5px;
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        color: var(--fg);
        padding: 3px 8px 3px calc(20px + var(--depth, 0) * 12px);
        cursor: pointer;
        font-size: 12px;
    }

    .tree-file button:hover { background: var(--bg-hover); }

    .tree-file.active-item button {
        background: var(--bg-active);
        color: var(--fg-text);
    }

    .fname {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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

    /* ---- JSON document editor ---- */
    .json-editor {
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

    /* ---- View section layout ---- */
    .view-sections {
        overflow-y: auto;
        flex: 1;
    }

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

    .opt-check input[type="checkbox"] { cursor: pointer; }

    .section-body {
        padding: 6px 8px;
    }

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

    .code-editor {
        display: block;
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

    /* ---- View result ---- */
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

