<script lang="ts">
    import { onMount } from 'svelte';
    import * as monaco from 'monaco-editor';
    import {
        listScriptsTree,
        readScript,
        writeScript,
        deleteScript,
        createScriptDir,
        type TreeEntry,
    } from '../lib/api.js';
    import ConfirmDialog from '../lib/ConfirmDialog.svelte';
    import InputDialog from '../lib/InputDialog.svelte';

    let tree = $state<TreeEntry[]>([]);
    /** key = entry.path → true if expanded */
    let expandedDirs = $state<Record<string, boolean>>({});
    let selected = $state<string | null>(null);
    let dirty = $state(false);
    let error = $state('');
    let saving = $state(false);

    let editorContainer: HTMLDivElement;
    let editor: monaco.editor.IStandaloneCodeEditor;
    let suppressChange = false;
    let savedContent = '';
    let dialog: { show: (msg: string, opts?: { confirm?: string; danger?: boolean }) => Promise<boolean> };
    let inputDialog: { show: (msg: string, opts?: { placeholder?: string; confirm?: string; initial?: string }) => Promise<string | null> };

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
        // Configure Monaco language service
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

        editor = monaco.editor.create(editorContainer, {
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
        });

        editor.onDidChangeModelContent(() => {
            if (!suppressChange) dirty = editor.getValue() !== savedContent;
        });

        await loadTree();
    });

    let _treeLoaded = false;

    async function loadTree() {
        try {
            tree = await listScriptsTree();
            if (!_treeLoaded) {
                _treeLoaded = true;
                // Auto-expand all directories on first load
                const dirs: Record<string, boolean> = {};
                function collectDirs(entries: TreeEntry[]) {
                    for (const e of entries) {
                        if (e.type === 'dir') {
                            dirs[e.path] = true;
                            if (e.children) collectDirs(e.children);
                        }
                    }
                }
                collectDirs(tree);
                expandedDirs = dirs;
            }
            error = '';
        } catch (e: any) {
            error = e.message;
        }
    }

    function toggleDir(path: string) {
        expandedDirs[path] = !expandedDirs[path];
    }

    async function toggleLib(dirPath: string, makeLib: boolean) {
        try {
            if (makeLib) {
                await writeScript(`${dirPath}/.shelib`, '');
            } else {
                await deleteScript(`${dirPath}/.shelib`);
            }
            await loadTree();
        } catch (e: any) {
            error = e.message;
        }
    }

    async function selectFile(path: string) {
        if (dirty && selected) {
            if (!(await dialog.show('Discard unsaved changes?', { confirm: 'Discard' }))) return;
        }
        selected = path;
        try {
            const { content } = await readScript(path);
            savedContent = content;
            // Create a per-file model with a .js URI so Monaco's JS language service
            // runs syntax diagnostics (red underlines) on the correct file.
            const oldModel = editor.getModel();
            const uri = monaco.Uri.parse(`file:///she-scripts/${encodeURIComponent(path)}`);
            const newModel = monaco.editor.createModel(content, 'javascript', uri);
            suppressChange = true;
            editor.setModel(newModel);
            suppressChange = false;
            oldModel?.dispose();
            dirty = false;
            editor.setScrollPosition({ scrollTop: 0 });
        } catch (e: any) {
            error = e.message;
        }
    }

    async function save() {
        if (!selected) return;
        saving = true;
        try {
            const value = editor.getValue();
            await writeScript(selected, value);
            savedContent = value;
            dirty = false;
            error = '';
        } catch (e: any) {
            error = e.message;
        } finally {
            saving = false;
        }
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
        await selectFile(p);
    }

    async function newFolder() {
        const name = await inputDialog.show('New folder name:', {
            placeholder: 'myfolder or parent/myfolder',
            confirm: 'Create',
        });
        if (!name) return;
        await createScriptDir(name);
        expandedDirs[name] = true;
        await loadTree();
    }

    async function saveAs() {
        if (!selected) return;
        const name = await inputDialog.show('Save as:', {
            placeholder: 'copy.js',
            initial: selected,
            confirm: 'Save',
        });
        if (!name) return;
        const p = name.endsWith('.js') ? name : `${name}.js`;
        await writeScript(p, editor.getValue());
        await loadTree();
        await selectFile(p);
    }

    async function del() {
        if (!selected) return;
        if (!(await dialog.show(`Delete ${selected}?`, { confirm: 'Delete', danger: true }))) return;
        await deleteScript(selected);
        selected = null;
        editor.setValue('');
        await loadTree();
    }

    function handleKeydown(e: KeyboardEvent) {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            save();
        }
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
        {#if error}
            <div class="err">{error}</div>
        {/if}

        {#snippet treeEntry(entry: TreeEntry)}
            {#if entry.type === 'dir'}
                <li class="tree-dir">
                    <div class="dir-row" style="--depth: {entry.path.split('/').length - 1}">
                        <button class="chevron" onclick={() => toggleDir(entry.path)}>
                            {expandedDirs[entry.path] ? '▾' : '▸'}
                        </button>
                        <span class="dir-name" class:lib={entry.lib}>{entry.name}</span>
                        <label class="lib-label" title="Library directory — .js files won't be loaded as scripts automatically">
                            <input
                                type="checkbox"
                                checked={entry.lib}
                                onchange={() => toggleLib(entry.path, !entry.lib)}
                            />
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
                <li
                    class="tree-file"
                    class:active={entry.path === selected}
                    class:dirty={entry.path === selected && dirty}
                    style="--depth: {entry.path.split('/').length - 1}"
                >
                    <button class:lib={entry.lib} onclick={() => selectFile(entry.path)}>
                        {entry.name}
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
        <div class="editor-toolbar">
            <span class="filename">{selected ?? 'No file selected'}{dirty ? ' •' : ''}</span>
            <button onclick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save'}</button>
            {#if selected}
                <button onclick={saveAs}>Save As</button>
                <button onclick={del} class="danger">Delete</button>
            {/if}
        </div>
        <div class="editor-container" bind:this={editorContainer}></div>
    </div>
</div>

<style>
    .layout {
        display: flex;
        height: 100%;
    }
    aside {
        width: 220px;
        flex-shrink: 0;
        background: #252526;
        border-right: 1px solid #333;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .toolbar {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 8px;
        border-bottom: 1px solid #333;
    }
    .toolbar button {
        flex: 1;
        background: #0e639c;
        color: #fff;
        border: none;
        padding: 4px 6px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
    }
    .toolbar button.refresh { flex: 0 0 auto; padding: 4px 8px; }
    .toolbar button:hover { background: #1177bb; }
    /* ---- Tree view ---- */
    .tree {
        flex: 1;
        overflow-y: auto;
        list-style: none;
        padding: 4px 0;
        margin: 0;
    }
    .tree-dir, .tree-file { list-style: none; }
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
        color: #858585;
        cursor: pointer;
        padding: 0;
        font-size: 9px;
        line-height: 1;
        width: 12px;
        flex-shrink: 0;
        text-align: center;
    }
    .dir-name {
        color: #cccccc;
        font-size: 12px;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .dir-name.lib { color: #858585; font-style: italic; }
    .lib-label {
        display: flex;
        align-items: center;
        gap: 3px;
        color: #858585;
        font-size: 10px;
        cursor: pointer;
        flex-shrink: 0;
        user-select: none;
    }
    .lib-label input[type='checkbox'] {
        accent-color: #569cd6;
        width: 10px;
        height: 10px;
        cursor: pointer;
    }
    .tree-file button {
        display: block;
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        color: #cccccc;
        padding: 4px 12px 4px calc(20px + var(--depth, 0) * 12px);
        cursor: pointer;
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .tree-file button.lib { color: #858585; font-style: italic; }
    .tree-file button:hover { background: #2a2d2e; }
    .tree-file.active button { background: #37373d; color: #fff; }
    .tree-file.dirty button { font-style: italic; }
    .tree-file.dirty button::after {
        content: ' \25CF';
        font-size: 7px;
        vertical-align: middle;
        color: #e5c07b;
    }
    .err {
        color: #f48771;
        padding: 8px;
        font-size: 12px;
    }
    .editor-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
    }
    .editor-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: #252526;
        border-bottom: 1px solid #333;
    }
    .filename {
        flex: 1;
        font-size: 12px;
        color: #aaaaa;
    }
    .editor-toolbar button {
        background: #0e639c;
        color: #fff;
        border: none;
        padding: 4px 10px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
    }
    .editor-toolbar button:disabled { opacity: 0.4; cursor: default; }
    .editor-toolbar button:not(:disabled):hover { background: #1177bb; }
    .editor-toolbar button.danger { background: #6c1717; }
    .editor-toolbar button.danger:hover { background: #8b1e1e; }
    .editor-container {
        flex: 1;
        min-height: 0;
    }
</style>
