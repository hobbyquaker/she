<script lang="ts">
    import { onMount } from 'svelte';
    import * as monaco from 'monaco-editor';
    import { listScripts, readScript, writeScript, deleteScript, type ScriptEntry } from '../lib/api.js';
    import ConfirmDialog from '../lib/ConfirmDialog.svelte';
    import InputDialog from '../lib/InputDialog.svelte';

    let files = $state<ScriptEntry[]>([]);
    let selected = $state<string | null>(null);
    let dirty = $state(false);
    let error = $state('');
    let saving = $state(false);

    let editorContainer: HTMLDivElement;
    let editor: monaco.editor.IStandaloneCodeEditor;
    let suppressChange = false;
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
            language: 'javascript',
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
        });

        editor.onDidChangeModelContent(() => {
            if (!suppressChange) dirty = true;
        });

        await loadFiles();
    });

    async function loadFiles() {
        try {
            files = await listScripts();
            error = '';
        } catch (e: any) {
            error = e.message;
        }
    }

    async function selectFile(path: string) {
        if (dirty && selected) {
            if (!(await dialog.show('Discard unsaved changes?', { confirm: 'Discard' }))) return;
        }
        selected = path;
        dirty = false;
        try {
            const { content } = await readScript(path);
            suppressChange = true;
            editor.setValue(content);
            suppressChange = false;
            editor.setScrollPosition({ scrollTop: 0 });
        } catch (e: any) {
            error = e.message;
        }
    }

    async function save() {
        if (!selected) return;
        saving = true;
        try {
            await writeScript(selected, editor.getValue());
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
            placeholder: 'myscript.js',
            confirm: 'Create',
        });
        if (!name) return;
        const path = name.endsWith('.js') ? name : `${name}.js`;
        await writeScript(path, `/* global she */\n'use strict';\n\n`);
        await loadFiles();
        await selectFile(path);
    }

    async function saveAs() {
        if (!selected) return;
        const name = await inputDialog.show('Save as:', {
            placeholder: 'copy.js',
            initial: selected,
            confirm: 'Save',
        });
        if (!name) return;
        const path = name.endsWith('.js') ? name : `${name}.js`;
        await writeScript(path, editor.getValue());
        await loadFiles();
        await selectFile(path);
    }

    async function del() {
        if (!selected) return;
        if (!(await dialog.show(`Delete ${selected}?`, { confirm: 'Delete', danger: true }))) return;
        await deleteScript(selected);
        selected = null;
        editor.setValue('');
        await loadFiles();
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
            <button onclick={newFile} title="New script">+ New</button>
            <button onclick={loadFiles} title="Refresh">↻</button>
        </div>
        {#if error}
            <div class="err">{error}</div>
        {/if}
        <ul>
            {#each files as f (f.path)}
                <li class:active={f.path === selected} class:dirty={f.path === selected && dirty}>
                    <button onclick={() => selectFile(f.path)}>{f.path}</button>
                </li>
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
        padding: 4px 8px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
    }
    .toolbar button:hover { background: #1177bb; }
    ul {
        flex: 1;
        overflow-y: auto;
        list-style: none;
        padding: 4px 0;
    }
    li button {
        display: block;
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        color: #cccccc;
        padding: 5px 12px;
        cursor: pointer;
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    li button:hover { background: #2a2d2e; }
    li.active button { background: #37373d; color: #fff; }
    li.dirty button { font-style: italic; }
    li.dirty button::after { content: ' \25CF'; font-size: 7px; vertical-align: middle; color: #e5c07b; }
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
