<script lang="ts">
    /**
     * Files tab of the instance drawer (I10): the files an adapter instance maintains —
     * options declared with `x-file` (or guessed from `…-file` names) plus everything under
     * /etc/<adapter>/ and /var/lib/<adapter>/<instance>/. Editing in Monaco: JSON validated
     * against the adapter's schema when it ships one, YAML linted with js-yaml.
     */
    import { onMount } from 'svelte';
    import yaml from 'js-yaml';
    import type * as monaco from 'monaco-editor';
    import MonacoEditor from '../../lib/MonacoEditor.svelte';
    import {
        getServiceFiles, getServiceFile, putServiceFile, createServiceFile, getAdapterAsset,
        type ServiceFileOption, type ServiceFileEntry,
    } from '../../lib/api.js';

    let { host, adapter, instance, onchanged }: { host: string; adapter: string; instance: string; onchanged?: () => void } = $props();

    let options = $state<ServiceFileOption[]>([]);
    let files   = $state<ServiceFileEntry[]>([]);
    let dirs    = $state<string[]>([]);
    let loading = $state(true);
    let error   = $state('');

    // editor
    let openPath  = $state<string | null>(null);
    let content   = $state('');
    let original  = $state('');
    let format    = $state<string | null>(null);
    let schema    = $state<object | null>(null);
    let schemaName = $state<string | null>(null);
    let yamlMarkers = $state<monaco.editor.IMarkerData[]>([]);
    let problems  = $state<monaco.editor.IMarker[]>([]);
    let saving    = $state(false);
    let msg       = $state('');
    let dirty     = $derived(content !== original);
    let language  = $derived(format === 'json' ? 'json' : format === 'yaml' ? 'yaml' : 'plaintext');
    let errorCount = $derived(problems.filter(p => p.severity === 8).length + yamlMarkers.length);

    async function load() {
        loading = true; error = '';
        try {
            const r = await getServiceFiles(host, adapter, instance);
            options = r.options; files = r.files; dirs = r.dirs;
        } catch (e: any) {
            error = e.message ?? String(e);
        } finally {
            loading = false;
        }
    }
    onMount(load);

    /** the option a path belongs to (for its schema) */
    function optionFor(path: string): ServiceFileOption | undefined {
        return options.find(o => o.path === path);
    }

    async function open(path: string, fmt: string | null) {
        if (dirty && !confirm('Discard unsaved changes?')) return;
        msg = ''; error = '';
        try {
            const r = await getServiceFile(host, adapter, instance, path);
            openPath = r.path; content = r.content; original = r.content; format = fmt ?? r.format;
            schema = null; schemaName = null; yamlMarkers = []; problems = [];
            const opt = optionFor(path);
            if (opt?.schema && format === 'json') {
                try {
                    const a = await getAdapterAsset(host, adapter, opt.schema);
                    schema = JSON.parse(a.content); schemaName = opt.schema;
                } catch { /* no schema — plain JSON validation */ }
            }
        } catch (e: any) {
            error = e.message ?? String(e);
        }
    }

    // YAML lint: js-yaml errors carry a mark with line/column
    $effect(() => {
        if (format !== 'yaml') { yamlMarkers = []; return; }
        try {
            yaml.load(content);
            yamlMarkers = [];
        } catch (e: any) {
            const line = (e?.mark?.line ?? 0) + 1;
            const col = (e?.mark?.column ?? 0) + 1;
            yamlMarkers = [{ severity: 8, message: e?.reason ?? String(e), startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col + 1 }];
        }
    });

    async function save(restart: boolean) {
        if (!openPath) return;
        saving = true; msg = ''; error = '';
        try {
            const r = await putServiceFile(host, adapter, instance, openPath, content, restart);
            original = content;
            msg = r.restarted ? 'Saved and restarted.' : 'Saved.';
            onchanged?.();
            load();
        } catch (e: any) {
            error = e.message ?? String(e);
        } finally {
            saving = false;
        }
    }

    async function create(o: ServiceFileOption) {
        msg = ''; error = '';
        try {
            const r = await createServiceFile(host, adapter, instance, o.key);
            msg = `Created ${r.path} and set ${r.envName} — restart the instance to use it.`;
            await load();
            const created = files.find(f => f.path === r.path);
            await open(r.path, created?.format ?? o.format);
        } catch (e: any) {
            error = e.message ?? String(e);
        }
    }

    function fmtSize(n: number): string {
        return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
    }
    function fmtTime(t: number): string {
        return t ? new Date(t * 1000).toLocaleString() : '';
    }
</script>

<div class="files">
    <div class="list">
        {#if loading}
            <div class="muted pad">Loading…</div>
        {:else}
            {#if options.length}
                <div class="group-title">Adapter files</div>
                {#each options as o (o.key)}
                    <div class="opt">
                        <div class="opt-head">
                            <span class="mono key">--{o.key}</span>
                            <span class="badge">{o.format}</span>
                            {#if !o.declared}<span class="muted" title="Guessed from the option name — the adapter does not declare this file">guessed</span>{/if}
                        </div>
                        {#if o.describe}<div class="muted desc">{o.describe}</div>{/if}
                        {#if o.path}
                            {#if o.managed && o.exists && o.editable}
                                <button class="path-link mono" class:active={openPath === o.path} onclick={() => open(o.path!, o.format)}>{o.path}</button>
                            {:else if o.managed && !o.exists}
                                <div class="mono muted">{o.path} <span class="warn">— missing</span></div>
                                <button class="ghost sm" onclick={() => create(o)}>Create{o.example ? ' from example' : ''}</button>
                            {:else if !o.editable}
                                <div class="mono muted">{o.path} <span title="binary — not edited here">(binary)</span></div>
                            {:else}
                                <div class="mono muted">{o.path}</div>
                                <div class="muted warn">outside {dirs.join(' and ')} — she only edits files there. <button class="link" onclick={() => create(o)}>Create{o.example ? ' from example' : ''} in /etc/{adapter}/</button> and move the content over.</div>
                            {/if}
                        {:else}
                            <div class="muted">not set</div>
                            <button class="ghost sm" onclick={() => create(o)}>Create{o.example ? ' from example' : ''}</button>
                        {/if}
                    </div>
                {/each}
            {/if}
            <div class="group-title" style="margin-top:8px">{dirs.join(' · ')}</div>
            {#if files.length === 0}
                <div class="muted pad">No files.</div>
            {/if}
            {#each files as f (f.path)}
                {#if f.kind === 'file'}
                    <div class="file">
                        {#if f.editable}
                            <button class="path-link mono" class:active={openPath === f.path} onclick={() => open(f.path, f.format)} title={fmtTime(f.mtime)}>{f.path}</button>
                        {:else}
                            <span class="mono muted" title={/\.env$/.test(f.path) ? 'edited through the Config tab' : 'not a text format she edits'}>{f.path}</span>
                        {/if}
                        <span class="muted size">{fmtSize(f.size)}</span>
                    </div>
                {/if}
            {/each}
        {/if}
        {#if error}<div class="err pad">{error}</div>{/if}
    </div>

    <div class="editor">
        {#if openPath}
            <div class="edbar">
                <span class="mono path">{openPath}</span>
                {#if schemaName}<span class="muted" title="JSON schema shipped by the adapter">schema: {schemaName}</span>{/if}
                <span class="spacer"></span>
                {#if errorCount > 0}<span class="err">{errorCount} problem{errorCount === 1 ? '' : 's'}</span>{:else if format === 'json' || format === 'yaml'}<span class="ok">valid {format}</span>{/if}
                <button onclick={() => save(false)} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</button>
                <button onclick={() => save(true)} disabled={saving || (!dirty && errorCount > 0)} title="Save and restart the instance">Save &amp; restart</button>
                {#if msg}<span class="muted">{msg}</span>{/if}
            </div>
            <div class="monaco">
                {#key openPath}
                    <MonacoEditor bind:value={content} {language} jsonSchema={schema} markers={yamlMarkers} onMarkers={(m) => (problems = m)} onSave={() => save(false)} />
                {/key}
            </div>
        {:else}
            <div class="muted pad">Pick a file on the left.</div>
        {/if}
    </div>
</div>

<style>
    .files { flex: 1; display: flex; overflow: hidden; min-height: 0; }
    .list { width: 300px; flex-shrink: 0; overflow: auto; border-right: 1px solid var(--border); padding: 8px 0; font-size: 12px; }
    .editor { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .pad { padding: 8px 12px; }
    .muted { color: var(--fg-muted); font-size: 11px; }
    .warn { color: #d4ac0d; }
    .err { color: #e74c3c; font-size: 11px; }
    .ok { color: #27ae60; font-size: 11px; }
    .mono { font-family: var(--font-mono, monospace); font-size: 11px; }
    .group-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-muted); padding: 4px 12px; word-break: break-all; }
    .opt { padding: 4px 12px 8px; border-bottom: 1px solid var(--border-sub, var(--border)); }
    .opt-head { display: flex; align-items: center; gap: 6px; }
    .key { font-weight: 600; }
    .desc { margin: 2px 0 4px; }
    .badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600; line-height: 16px; background: rgba(86,156,214,0.15); color: var(--accent); }
    .file { display: flex; align-items: center; gap: 8px; padding: 2px 12px; }
    .file .size { margin-left: auto; white-space: nowrap; }
    .path-link { background: none; border: none; padding: 1px 0; color: var(--fg); cursor: pointer; text-align: left; word-break: break-all; }
    .path-link:hover, .path-link.active { color: var(--accent); }
    .path-link.active { font-weight: 600; }
    button { background: var(--accent); border: none; color: #fff; padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    button.sm { padding: 1px 7px; font-size: 11px; margin-top: 3px; }
    button.link { background: none; border: none; color: var(--accent); padding: 0; font-size: 11px; }
    .edbar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
    .edbar .path { word-break: break-all; }
    .spacer { flex: 1; }
    .monaco { flex: 1; min-height: 0; }
</style>
