<script lang="ts">
    import { onMount, onDestroy, tick } from 'svelte';
    import * as monaco from 'monaco-editor';
    import {
        listScriptsTree,
        readScript,
        writeScript,
        deleteScript,
        createScriptDir,
        commitFile,
        type TreeEntry,
    } from '../lib/api.js';
    import { subscribeLog, type LogEntry } from '../lib/ws.js';
    import ConfirmDialog from '../lib/ConfirmDialog.svelte';
    import InputDialog from '../lib/InputDialog.svelte';

    interface Tab {
        path: string;
        dirty: boolean;
        savedContent: string;
        model: monaco.editor.ITextModel | null;
        logEntries: LogEntry[];
    }

    let tree = $state<TreeEntry[]>([]);
    /** key = entry.path → true if expanded */
    let expandedDirs = $state<Record<string, boolean>>({});
    let tabs = $state<Tab[]>([]);
    let activeTab = $state<string | null>(null);
    let saving = $state(false);
    let error = $state('');
    let dropdownOpen = $state(false);
    let logPanelOpen = $state(true);
    let logEl = $state<HTMLDivElement | undefined>(undefined);

    let scriptErrors = $state<Set<string>>(new Set());
    const scriptHadError = new Set<string>();

    let editorContainer: HTMLDivElement;
    let editor: monaco.editor.IStandaloneCodeEditor;
    let emptyModel: monaco.editor.ITextModel;
    let suppressChange = false;
    let unsubLog: (() => void) | null = null;
    let _treeLoaded = false;
    let _mounted = false;

    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean }): Promise<boolean> };
    let inputDialog: { show(msg: string, opts?: { placeholder?: string; confirm?: string; initial?: string }): Promise<string | null> };

    let currentTab = $derived(tabs.find(t => t.path === activeTab) ?? null);

    const TABS_KEY   = 'she-tabs';
    const ACTIVE_KEY = 'she-active-tab';
    const LOG_KEY    = 'she-log-open';

    $effect(() => {
        if (!_mounted) return;
        localStorage.setItem(TABS_KEY, JSON.stringify(tabs.map(t => t.path)));
        if (activeTab) localStorage.setItem(ACTIVE_KEY, activeTab);
        else           localStorage.removeItem(ACTIVE_KEY);
    });

    // Monaco sandbox type stubs for she API autocomplete
    const she_dts = `
declare const she: {
    log(...args: any[]): void;
    info(...args: any[]): void;
    debug(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
    now(): number;
    /** Schedule with a cron string, Date, node-schedule literal, array of any of those,
     *  or a suncalc event name ('sunrise', 'sunset', 'dawn', 'dusk', …) for solar scheduling.
     *  opts.shift (seconds) offsets solar events; opts.random adds a random delay. */
    schedule(pattern: string | Date | object | (string | Date | object)[], opts?: { shift?: number; random?: number }, cb?: () => void): void;
    combineBool(srcs: string[], target: string): void;
    combineMax(srcs: string[], target: string): void;
    timer(src: string | string[], target: string, time: number): void;
    mqtt: {
        sub(topic: string | string[], opts?: any, cb?: (topic: string, val: any, obj: any, prev: any, msg: any) => void): void;
        pub(topic: string | string[], payload: any, opts?: { qos?: number; retain?: boolean }): void;
        get(topic: string): any;
        set(topic: string | string[], val: any): void;
        getProp(topic: string, ...prop: string[]): any;
        link(source: string | string[], target: string | string[], value?: any): void;
        age(topic: string): number;
    };
    api: {
        get(path: string, handler: (req: any) => any): void;
        post(path: string, handler: (req: any, body: any) => any): void;
        put(path: string, handler: (req: any, body: any) => any): void;
        delete(path: string, handler: (req: any) => any): void;
    };
    db: {
        get(id: string): any;
        set(id: string, doc: object): void;
        extend(id: string, partial: object): void;
        delete(id: string): void;
        prop(id: string, method: 'set' | 'create' | 'del', prop: string, val?: any): void;
        sub(pattern: string, callback: (id: string, doc: any) => void): void;
        query(filter: string | null, mapFn: Function, reduceFn?: Function): any[];
    };
    matter: {
        sub(nodeId: string, endpointId: number, cluster: string, attr: string, cb: (val: any, old: any) => void): number;
        unsub(listenerId: number): void;
        get(nodeId: string, endpointId: number, cluster: string, attr: string): Promise<any>;
        send(nodeId: string, endpointId: number, cluster: string, command: string, args?: object): Promise<any>;
        on(nodeId: string, endpointId: number, cluster: string, event: string, cb: (val: any) => void): number;
    };
    influx: {
        query(fluxQuery: string): Promise<any[]>;
        write(measurement: string, fields: object, tags?: object, timestamp?: number | Date): Promise<void>;
        getLast(topic: string, n: number): Promise<Array<{ ts: number; val: any }>>;
        getRange(topic: string, from: number | string | Date, to: number | string | Date): Promise<Array<{ ts: number; val: any }>>;
    };
    elastic: {
        search(index: string, query: object): Promise<{ hits: any[]; total: number }>;
        get(index: string, id: string): Promise<object | null>;
        index(index: string, doc: object, id?: string): Promise<{ id: string }>;
        find(index: string, field: string, text: string, size?: number): Promise<any[]>;
    };
};
`;

    onMount(async () => {
        logPanelOpen = localStorage.getItem(LOG_KEY) !== 'false';

        monaco.languages.typescript.javascriptDefaults.addExtraLib(she_dts, 'she-api.d.ts');
        monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
            target: monaco.languages.typescript.ScriptTarget.ES2022,
            allowNonTsExtensions: true,
            checkJs: true,
        });
        monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
            noSyntaxValidation: false,
            noSemanticValidation: true, // semantic checks are noisy for plain JS scripts
        });

        emptyModel = monaco.editor.createModel('', 'javascript');
        editor = monaco.editor.create(editorContainer, {
            model: emptyModel,
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
        });

        editor.onDidChangeModelContent(() => {
            if (suppressChange) return;
            const tab = tabs.find(t => t.path === activeTab);
            if (tab) tab.dirty = editor.getValue() !== tab.savedContent;
        });

        unsubLog = subscribeLog((entry) => {
            const match = entry.msg.match(/^user::([^:]+):/);
            if (!match) return;
            const basename = match[1];
            if (entry.level === 'error') {
                scriptHadError.add(basename);
                if (!scriptErrors.has(basename)) {
                    scriptErrors = new Set([...scriptErrors, basename]);
                }
            } else if (scriptHadError.has(basename)) {
                scriptHadError.delete(basename);
                const next = new Set(scriptErrors);
                next.delete(basename);
                scriptErrors = next;
            }
            const tab = tabs.find(t => t.path.split('/').pop() === basename);
            if (tab) {
                tab.logEntries = [...tab.logEntries.slice(-199), entry];
                if (tab.path === activeTab && logPanelOpen && logEl) {
                    tick().then(() => { if (logEl) logEl.scrollTop = logEl.scrollHeight; });
                }
            }
        });

        await loadTree();

        const savedPaths = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]') as string[];
        const savedActive = localStorage.getItem(ACTIVE_KEY);
        for (const p of savedPaths) {
            await openTabInternal(p, false);
        }
        const restoreActive = savedActive && tabs.some(t => t.path === savedActive)
            ? savedActive : (tabs[0]?.path ?? null);
        if (restoreActive) await switchTab(restoreActive);
        _mounted = true;
    });

    onDestroy(() => {
        unsubLog?.();
        for (const tab of tabs) tab.model?.dispose();
        emptyModel?.dispose();
        editor?.dispose();
    });

    async function loadTree() {
        try {
            tree = await listScriptsTree();
            if (!_treeLoaded) {
                _treeLoaded = true;
                // Auto-expand all directories on first load
                const dirs: Record<string, boolean> = {};
                function collectDirs(entries: TreeEntry[]) {
                    for (const e of entries) {
                        if (e.type === 'dir') { dirs[e.path] = true; if (e.children) collectDirs(e.children); }
                    }
                }
                collectDirs(tree);
                expandedDirs = dirs;
            }
            error = '';
        } catch (e: any) { error = e.message; }
    }

    function toggleDir(path: string) { expandedDirs[path] = !expandedDirs[path]; }

    async function toggleLib(dirPath: string, makeLib: boolean) {
        try {
            if (makeLib) await writeScript(`${dirPath}/.shelib`, '');
            else await deleteScript(`${dirPath}/.shelib`);
            await loadTree();
        } catch (e: any) { error = e.message; }
    }

    async function openTabInternal(path: string, andSwitch = true) {
        if (tabs.some(t => t.path === path)) {
            if (andSwitch) await switchTab(path);
            return;
        }
        try {
            const { content } = await readScript(path);
            const uri = monaco.Uri.parse(`file:///she-scripts/${encodeURIComponent(path)}`);
            monaco.editor.getModel(uri)?.dispose();
            const model = monaco.editor.createModel(content, 'javascript', uri);
            tabs = [...tabs, { path, dirty: false, savedContent: content, model, logEntries: [] }];
            if (andSwitch) await switchTab(path);
        } catch (e: any) { error = (e as Error).message; }
    }

    async function openTab(path: string) { await openTabInternal(path, true); }

    async function switchTab(path: string) {
        const tab = tabs.find(t => t.path === path);
        if (!tab?.model) return;
        activeTab = path;
        suppressChange = true;
        editor.setModel(tab.model);
        suppressChange = false;
    }

    async function closeTab(path: string) {
        const tab = tabs.find(t => t.path === path);
        if (!tab) return;
        if (tab.dirty) {
            if (!(await dialog.show(`Discard unsaved changes to ${path}?`, { confirm: 'Discard' }))) return;
        }
        const idx = tabs.findIndex(t => t.path === path);
        tab.model?.dispose();
        tabs = tabs.filter(t => t.path !== path);
        if (activeTab === path) {
            const next = tabs[idx] ?? tabs[idx - 1] ?? null;
            if (next) await switchTab(next.path);
            else { activeTab = null; editor.setModel(emptyModel); }
        }
    }

    async function save() {
        if (!activeTab) return;
        const tab = tabs.find(t => t.path === activeTab);
        if (!tab) return;
        saving = true;
        try {
            const value = editor.getValue();
            await writeScript(activeTab, value);
            tab.savedContent = value;
            tab.dirty = false;
            error = '';
        } catch (e: any) { error = (e as Error).message; }
        finally { saving = false; }
    }

    async function saveAndCommit() {
        if (!activeTab) return;
        await save();
        if (error) return;
        const msg = await inputDialog.show('Commit message:', { placeholder: 'Update script', confirm: 'Commit' });
        if (!msg) return;
        try { await commitFile(activeTab, msg); }
        catch (e: any) { error = 'Git: ' + (e as Error).message; }
    }

    async function newFile() {
        const name = await inputDialog.show('New script name:', {
            placeholder: 'myscript.js or folder/myscript.js',
            confirm: 'Create',
        });
        if (!name) return;
        const p = name.endsWith('.js') ? name : `${name}.js`;
        await writeScript(p, `/* global she */\n'use strict';\n\n`);
        await loadTree();
        await openTabInternal(p, true);
    }

    async function newFolder() {
        const name = await inputDialog.show('New folder name:', {
            placeholder: 'myfolder',
            confirm: 'Create',
        });
        if (!name) return;
        await createScriptDir(name);
        expandedDirs[name] = true;
        await loadTree();
    }

    async function saveAs() {
        if (!activeTab) return;
        const name = await inputDialog.show('Save as:', {
            placeholder: 'copy.js',
            initial: activeTab,
            confirm: 'Save',
        });
        if (!name) return;
        const p = name.endsWith('.js') ? name : `${name}.js`;
        await writeScript(p, editor.getValue());
        await loadTree();
        await openTabInternal(p, true);
    }

    async function del() {
        if (!activeTab) return;
        if (!(await dialog.show(`Delete ${activeTab}?`, { confirm: 'Delete', danger: true }))) return;
        const toDelete = activeTab;
        await closeTab(toDelete);
        await deleteScript(toDelete);
        await loadTree();
    }

    function clearLog() { if (currentTab) currentTab.logEntries = []; }

    function toggleLogPanel() {
        logPanelOpen = !logPanelOpen;
        localStorage.setItem(LOG_KEY, String(logPanelOpen));
    }

    function fmt(ts: number) {
        return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    function handleKeydown(e: KeyboardEvent) {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
        if (e.key === 'Escape') dropdownOpen = false;
    }
</script>

<svelte:window onkeydown={handleKeydown} />
<ConfirmDialog bind:this={dialog} />
<InputDialog bind:this={inputDialog} />

<div class="layout">
    <aside>
        <div class="toolbar">
            <button onclick={newFile} title="New script">+ File</button>
            <button onclick={newFolder} title="New folder">+ Folder</button>
            <button onclick={loadTree} title="Refresh" class="refresh">↻</button>
        </div>
        {#if error}<div class="err">{error}</div>{/if}

        {#snippet treeEntry(entry: TreeEntry)}
            {#if entry.type === 'dir'}
                <li class="tree-dir">
                    <div class="dir-row" style="--depth: {entry.path.split('/').length - 1}">
                        <button class="chevron" onclick={() => toggleDir(entry.path)}>
                            {expandedDirs[entry.path] ? '▾' : '▸'}
                        </button>
                        <span class="dir-name" class:lib={entry.lib}>{entry.name}</span>
                        <label class="lib-label" title="Library directory — .js files won't be loaded as scripts automatically">
                            <input type="checkbox" checked={entry.lib} onchange={() => toggleLib(entry.path, !entry.lib)} />
                            lib
                        </label>
                    </div>
                    {#if expandedDirs[entry.path] && entry.children}
                        <ul class="tree-children">
                            {#each entry.children as child (child.path)}
                                {@render treeEntry(child)}
                            {/each}
                        </ul>
                    {/if}
                </li>
            {:else}
                {@const basename = entry.name}
                {@const hasErr = scriptErrors.has(basename)}
                <li
                    class="tree-file"
                    class:active={tabs.some(t => t.path === entry.path)}
                    class:active-tab={entry.path === activeTab}
                    style="--depth: {entry.path.split('/').length - 1}"
                >
                    <button class:lib={entry.lib} onclick={() => openTab(entry.path)}>
                        <span class="badge" class:badge-shelib={entry.lib}>JS</span>
                        <span class="fname">{entry.name}</span>
                        {#if tabs.find(t => t.path === entry.path)?.dirty}<span class="dirty-dot">●</span>{/if}
                        {#if hasErr}<span class="err-dot">●</span>{/if}
                    </button>
                </li>
            {/if}
        {/snippet}

        <ul class="tree">
            {#each tree as entry (entry.path)}
                {@render treeEntry(entry)}
            {/each}
        </ul>
    </aside>

    <div class="editor-area">
        {#if tabs.length > 0}
            <div class="tab-bar">
                {#each tabs as tab (tab.path)}
                    <div
                        class="tab"
                        class:active={tab.path === activeTab}
                        onclick={() => switchTab(tab.path)}
                        role="button"
                        tabindex="0"
                        onkeydown={(e) => e.key === 'Enter' && switchTab(tab.path)}
                    >
                        <span class="tab-label">{tab.path.split('/').pop()}</span>
                        {#if tab.dirty}<span class="tab-dirty">●</span>{/if}
                        <button class="tab-close" title="Close" onclick={(e) => { e.stopPropagation(); closeTab(tab.path); }}>×</button>
                    </div>
                {/each}
            </div>
        {/if}

        <div class="editor-toolbar">
            <span class="filename">{activeTab ?? 'No file selected'}</span>
            <div class="split-wrap">
                <div class="split-btn">
                    <button class="split-main" onclick={save} disabled={!currentTab?.dirty || saving}>
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button class="split-arrow" onclick={() => dropdownOpen = !dropdownOpen} disabled={!activeTab} aria-label="Save options">▾</button>
                </div>
                {#if dropdownOpen}
                    <div class="split-backdrop" role="presentation" onclick={() => dropdownOpen = false}></div>
                    <div class="split-menu">
                        <button onclick={() => { dropdownOpen = false; save(); }}>Save</button>
                        <button onclick={() => { dropdownOpen = false; saveAndCommit(); }}>Save & Commit</button>
                    </div>
                {/if}
            </div>
            {#if activeTab}
                <button onclick={saveAs}>Save As</button>
                <button onclick={del} class="danger">Delete</button>
            {/if}
        </div>

        <div class="editor-container" bind:this={editorContainer}></div>

        <div class="log-panel" class:collapsed={!logPanelOpen}>
            <div class="log-header">
                <button class="log-toggle" onclick={toggleLogPanel}>
                    {logPanelOpen ? '▾' : '▸'} Script Log
                    {#if activeTab}<span class="log-file"> — {activeTab.split('/').pop()}</span>{/if}
                </button>
                {#if logPanelOpen}
                    <button class="log-clear" onclick={clearLog}>Clear</button>
                {/if}
            </div>
            {#if logPanelOpen}
                <div class="log-body" bind:this={logEl}>
                    {#each currentTab?.logEntries ?? [] as e (e.ts + e.msg)}
                        <div class="log-line {e.level}">
                            <span class="ts">{fmt(e.ts)}</span>
                            <span class="lvl">{e.level.toUpperCase()}</span>
                            <span class="msg">{e.msg}</span>
                        </div>
                    {/each}
                    {#if (currentTab?.logEntries.length ?? 0) === 0}
                        <span class="log-empty">No log output for this script.</span>
                    {/if}
                </div>
            {/if}
        </div>
    </div>
</div>

<style>
    .layout { display: flex; height: 100%; }

    aside {
        width: 220px; flex-shrink: 0;
        background: var(--bg-panel);
        border-right: 1px solid var(--border-sub);
        display: flex; flex-direction: column; overflow: hidden;
    }
    .toolbar {
        display: flex; align-items: center; gap: 4px; padding: 8px;
        border-bottom: 1px solid var(--border-sub);
    }
    .toolbar button {
        flex: 1; background: var(--accent); color: #fff; border: none;
        padding: 4px 6px; border-radius: 3px; cursor: pointer; font-size: 12px; line-height: 1;
    }
    .toolbar button.refresh { flex: 0 0 auto; padding: 4px 8px; }
    .toolbar button:hover { background: var(--accent-hov); }

    .tree { flex: 1; overflow-y: auto; list-style: none; padding: 4px 0; margin: 0; }
    .tree-dir, .tree-file { list-style: none; }
    .tree-children { list-style: none; padding: 0; margin: 0; }
    .dir-row {
        display: flex; align-items: center; gap: 4px;
        padding: 3px 12px 3px calc(8px + var(--depth, 0) * 12px); cursor: default;
    }
    .chevron {
        background: none; border: none; color: var(--fg-muted); cursor: pointer;
        padding: 0; font-size: 9px; line-height: 1; width: 12px; flex-shrink: 0; text-align: center;
    }
    .dir-name { color: var(--fg); font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dir-name.lib { color: var(--fg-muted); font-style: italic; }
    .lib-label {
        display: flex; align-items: center; gap: 3px; color: var(--fg-muted);
        font-size: 10px; cursor: pointer; flex-shrink: 0; user-select: none;
    }
    .lib-label input[type='checkbox'] { accent-color: var(--fg-brand); width: 10px; height: 10px; cursor: pointer; }

    .tree-file button {
        display: flex; align-items: center; gap: 5px; width: 100%; text-align: left;
        background: none; border: none; color: var(--fg);
        padding: 3px 8px 3px calc(20px + var(--depth, 0) * 12px);
        cursor: pointer; font-size: 12px;
    }
    .tree-file button.lib .fname { color: var(--fg-muted); font-style: italic; }
    .tree-file button:hover { background: var(--bg-hover); }
    .tree-file.active-tab button { background: var(--bg-active); color: var(--fg-text); }
    .tree-file.active:not(.active-tab) button { background: var(--bg-hover); }

    .badge { font-size: 9px; font-weight: 700; padding: 0 3px; border-radius: 2px; background: #f0c040; color: #1e1e1e; flex-shrink: 0; }
    .badge.badge-shelib { background: var(--bg-widget); color: var(--fg-muted); }
    .fname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dirty-dot { color: #e5c07b; font-size: 8px; flex-shrink: 0; }
    .err-dot { color: var(--fg-err); font-size: 8px; flex-shrink: 0; }
    .err { color: var(--fg-err); padding: 8px; font-size: 12px; }

    .editor-area { flex: 1; display: flex; flex-direction: column; min-width: 0; }

    .tab-bar {
        display: flex; overflow-x: auto; background: var(--bg-app);
        border-bottom: 1px solid var(--border-sub); flex-shrink: 0; height: 35px; scrollbar-width: none;
    }
    .tab-bar::-webkit-scrollbar { display: none; }
    .tab {
        display: flex; align-items: center; gap: 5px; padding: 0 10px; height: 35px;
        min-width: 0; max-width: 180px; cursor: pointer; font-size: 12px;
        color: var(--fg-muted); background: var(--bg-app);
        border-right: 1px solid var(--border-sub); flex-shrink: 0; user-select: none;
    }
    .tab:hover { background: var(--bg-hover); color: var(--fg); }
    .tab.active { background: var(--bg-panel); color: var(--fg); border-top: 2px solid var(--fg-brand); }
    .tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .tab-dirty { color: #e5c07b; font-size: 8px; flex-shrink: 0; }
    .tab-close {
        background: none; border: none; color: var(--fg-muted); cursor: pointer;
        font-size: 14px; padding: 0; width: 16px; height: 16px;
        display: flex; align-items: center; justify-content: center; border-radius: 2px; flex-shrink: 0;
    }
    .tab-close:hover { background: var(--bg-hover); color: var(--fg); }

    .editor-toolbar {
        display: flex; align-items: center; gap: 6px; padding: 6px 10px;
        background: var(--bg-panel); border-bottom: 1px solid var(--border-sub); flex-shrink: 0;
    }
    .filename { flex: 1; font-size: 12px; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .split-wrap { position: relative; flex-shrink: 0; }
    .split-btn { display: flex; }
    .split-main {
        background: var(--accent); color: #fff; border: none;
        padding: 4px 10px; border-radius: 3px 0 0 3px; cursor: pointer; font-size: 12px; line-height: 1;
    }
    .split-main:disabled { opacity: 0.4; cursor: default; }
    .split-main:not(:disabled):hover { background: var(--accent-hov); }
    .split-arrow {
        background: var(--accent); color: #fff; border: none;
        border-left: 1px solid rgba(255,255,255,0.2);
        padding: 4px 6px; border-radius: 0 3px 3px 0; cursor: pointer; font-size: 10px; line-height: 1;
    }
    .split-arrow:disabled { opacity: 0.4; cursor: default; }
    .split-arrow:not(:disabled):hover { background: var(--accent-hov); }
    .split-backdrop { position: fixed; inset: 0; z-index: 9; }
    .split-menu {
        position: absolute; top: calc(100% + 2px); right: 0; z-index: 10;
        background: var(--bg-widget); border: 1px solid var(--border); border-radius: 3px;
        display: flex; flex-direction: column; min-width: 140px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    }
    .split-menu button {
        background: none; border: none; color: var(--fg); text-align: left;
        padding: 7px 12px; cursor: pointer; font-size: 12px;
    }
    .split-menu button:hover { background: var(--bg-hover); }

    .editor-toolbar > button {
        background: var(--accent); color: #fff; border: none;
        padding: 4px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; line-height: 1;
    }
    .editor-toolbar > button:disabled { opacity: 0.4; cursor: default; }
    .editor-toolbar > button:not(:disabled):hover { background: var(--accent-hov); }
    .editor-toolbar > button.danger { background: var(--accent-del); }
    .editor-toolbar > button.danger:hover { background: var(--accent-del-hov); }

    .editor-container { flex: 1; min-height: 0; }

    .log-panel {
        flex-shrink: 0; display: flex; flex-direction: column;
        border-top: 1px solid var(--border-sub); height: 130px;
    }
    .log-panel.collapsed { height: 26px; }
    .log-header {
        display: flex; align-items: center; gap: 6px; padding: 4px 8px;
        background: var(--bg-panel); border-bottom: 1px solid var(--border-sub); flex-shrink: 0;
    }
    .log-toggle {
        background: none; border: none; color: var(--fg-muted); cursor: pointer;
        font-size: 11px; padding: 0; flex: 1; text-align: left;
    }
    .log-toggle:hover { color: var(--fg); }
    .log-file { font-style: italic; }
    .log-clear {
        background: none; border: none; color: var(--fg-muted); cursor: pointer;
        font-size: 11px; padding: 0 4px; border-radius: 2px;
    }
    .log-clear:hover { background: var(--bg-hover); color: var(--fg); }
    .log-body { flex: 1; overflow-y: auto; font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 11px; padding: 2px 0; }
    .log-line { display: flex; gap: 8px; padding: 0 8px; line-height: 1.6; }
    .log-line:hover { background: var(--bg-hover); }
    .log-line .ts { color: var(--fg-dim); flex-shrink: 0; }
    .log-line .lvl { width: 44px; flex-shrink: 0; font-weight: bold; }
    .log-line.debug .lvl { color: var(--fg-muted); }
    .log-line.info  .lvl { color: #4fc1ff; }
    .log-line.warn  .lvl { color: var(--fg-warn); }
    .log-line.error .lvl { color: var(--fg-err); }
    .log-line .msg { color: var(--fg-text); word-break: break-all; }
    .log-empty { color: var(--fg-dim); font-size: 11px; padding: 4px 8px; font-style: italic; }
</style>
