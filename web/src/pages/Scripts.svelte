<script lang="ts">
    import { onMount } from 'svelte';
    import * as monaco from 'monaco-editor';
    import { listScripts, readScript, writeScript, deleteScript, type ScriptEntry } from '../lib/api.js';

    let files = $state<ScriptEntry[]>([]);
    let selected = $state<string | null>(null);
    let dirty = $state(false);
    let error = $state('');
    let saving = $state(false);

    let editorContainer: HTMLDivElement;
    let editor: monaco.editor.IStandaloneCodeEditor;

    // Monaco sandbox type stubs for she API autocomplete
    const she_dts = `
declare const she: {
    log(...args: any[]): void;
    info(...args: any[]): void;
    debug(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
    now(): number;
    schedule(pattern: string | Date | object | (string | Date | object)[], opts?: { random?: number }, cb?: () => void): void;
    sunSchedule(pattern: string | string[], opts?: { shift?: number; random?: number }, cb?: () => void): void;
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
};
`;

    onMount(async () => {
        // Configure Monaco language service
        monaco.languages.typescript.javascriptDefaults.addExtraLib(she_dts, 'she-api.d.ts');
        monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
            target: monaco.languages.typescript.ScriptTarget.ES2022,
            allowNonTsExtensions: true,
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
            dirty = true;
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
            if (!confirm('Discard unsaved changes?')) return;
        }
        selected = path;
        dirty = false;
        try {
            const { content } = await readScript(path);
            editor.setValue(content);
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
        const name = prompt('New script name (without .js):');
        if (!name) return;
        const path = name.endsWith('.js') ? name : `${name}.js`;
        await writeScript(path, `/* global she */\n'use strict';\n\n`);
        await loadFiles();
        await selectFile(path);
    }

    async function del() {
        if (!selected) return;
        if (!confirm(`Delete ${selected}?`)) return;
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
                <li class:active={f.path === selected}>
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
        padding: 4px 12px;
        background: #252526;
        border-bottom: 1px solid #333;
        height: 36px;
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
        padding: 3px 10px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 12px;
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
