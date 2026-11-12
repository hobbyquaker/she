<script lang="ts">
    /**
     * The commit dialog: a pre-filled message the user commits as it is, edits, or replaces with one the AI
     * writes from the staged diff. Used after a save, rename or delete in "ask" mode and for manual commits.
     * A click on one of the files shows what the commit will change in it: HEAD against the working tree.
     */
    import { onDestroy, tick } from 'svelte';
    import * as monaco from 'monaco-editor';
    import { getGitDiff, type GitFileDiff } from './api.js';
    import { resolveMonacoTheme } from './theme.js';
    import { resetMonacoHoverServices } from './monaco-services.js';

    let open = $state(false);
    let title = $state('Commit');
    let files = $state<string[]>([]);
    let value = $state('');
    let confirmLabel = $state('Commit');
    let aiAvailable = $state(false);
    let aiHint = $state('');
    let generate: (() => Promise<string>) | null = null;
    let generating = $state(false);
    let genError = $state('');
    let resolve: ((v: string | null) => void) | null = null;
    let textarea: HTMLTextAreaElement | undefined = $state();

    // ── the diff of one file ──
    let languageOf: (path: string) => string = () => 'plaintext';
    /** the file whose diff is shown, null when none */
    let diffFile = $state<string | null>(null);
    let diffInfo = $state<GitFileDiff | null>(null);
    let diffLoading = $state(false);
    let diffError = $state('');
    let diffContainer: HTMLDivElement | undefined = $state();
    let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
    let diffOriginal: monaco.editor.ITextModel | null = null;
    let diffModified: monaco.editor.ITextModel | null = null;
    /** counts the requests, so a slow answer for a file the user has left is dropped */
    let diffRequest = 0;

    /** there is text to compare: not binary, not too large */
    let diffHasText = $derived(!!diffInfo && !diffInfo.binary && !diffInfo.tooLarge);
    let diffNote = $derived.by(() => {
        if (!diffInfo) return '';
        if (diffInfo.binary) return 'Binary file — no diff to show';
        if (diffInfo.tooLarge) return 'File too large for the diff view';
        if (diffInfo.added) return 'new file';
        if (diffInfo.deleted) return 'deleted';
        if (diffInfo.head === diffInfo.work) return 'no changes';
        return '';
    });

    export function show(opts: {
        title?: string;
        files?: string[];
        initial: string;
        confirm?: string;
        /** the AI is configured: the Generate button is enabled */
        aiAvailable: boolean;
        /** shown as the disabled button's title when the AI is not available */
        aiHint?: string;
        /** asks the daemon for the AI message; rejects with the reason */
        generate?: () => Promise<string>;
        /** the Monaco language of a file, for the diff's syntax highlighting */
        languageOf?: (path: string) => string;
    }): Promise<string | null> {
        closeDiff();
        languageOf = opts.languageOf ?? (() => 'plaintext');
        title = opts.title ?? 'Commit';
        files = opts.files ?? [];
        value = opts.initial;
        confirmLabel = opts.confirm ?? 'Commit';
        aiAvailable = opts.aiAvailable;
        aiHint = opts.aiHint ?? 'No AI provider configured';
        generate = opts.generate ?? null;
        generating = false;
        genError = '';
        open = true;
        setTimeout(() => {
            if (textarea) {
                textarea.focus();
                const len = textarea.value.length;
                textarea.setSelectionRange(len, len);
            }
        }, 0);
        return new Promise((r) => (resolve = r));
    }

    /** A click on a file: show its diff, or hide it when it is the one shown. */
    async function toggleDiff(file: string) {
        if (diffFile === file) { closeDiff(); return; }
        closeDiff();
        const request = ++diffRequest;
        diffFile = file;
        diffLoading = true;
        try {
            const info = await getGitDiff(file);
            if (request !== diffRequest) return;
            diffInfo = info;
            diffLoading = false;
            if (info.binary || info.tooLarge) return;
            await tick();
            if (request !== diffRequest || !diffContainer) return;
            const lang = languageOf(file);
            // a new file is compared against nothing, a deleted one against nothing on the other side
            diffOriginal = monaco.editor.createModel(info.head ?? '', lang);
            diffModified = monaco.editor.createModel(info.work ?? '', lang);
            diffEditor = monaco.editor.createDiffEditor(diffContainer, {
                theme: resolveMonacoTheme(),
                readOnly: true,
                // side by side when the dialog is wide enough for it, inline below that
                renderSideBySide: true,
                useInlineViewWhenSpaceIsLimited: true,
                renderSideBySideInlineBreakpoint: 720,
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
                renderOverviewRuler: false,
            });
            diffEditor.setModel({ original: diffOriginal, modified: diffModified });
            resetMonacoHoverServices();
        } catch (e: any) {
            if (request !== diffRequest) return;
            diffLoading = false;
            diffError = (e as Error).message || 'Could not load the diff';
        }
    }

    /** Hide the diff and give back what Monaco holds for it. */
    function closeDiff() {
        diffRequest++;
        diffFile = null;
        diffInfo = null;
        diffLoading = false;
        diffError = '';
        // only after a diff editor really existed: the reset builds an editor
        if (diffEditor) {
            diffEditor.dispose();
            diffEditor = null;
            resetMonacoHoverServices();
        }
        diffOriginal?.dispose();
        diffOriginal = null;
        diffModified?.dispose();
        diffModified = null;
    }

    onDestroy(closeDiff);

    async function generateWithAi() {
        if (!generate || generating) return;
        generating = true;
        genError = '';
        try {
            const msg = await generate();
            if (msg.trim()) value = msg.trim();
        } catch (e: any) {
            genError = (e as Error).message || 'AI did not answer';
        } finally {
            generating = false;
        }
    }

    function submit() {
        const v = value.trim();
        if (!v || generating) return;
        closeDiff();
        open = false;
        resolve?.(v);
        resolve = null;
        value = '';
    }

    function cancel() {
        closeDiff();
        open = false;
        resolve?.(null);
        resolve = null;
        value = '';
    }

    function onKeydown(e: KeyboardEvent) {
        if (!open) return;
        if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
    }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
    <div class="backdrop" role="presentation" onclick={cancel}></div>
    <div class="dialog" class:wide={diffFile !== null} role="dialog" aria-modal="true" aria-labelledby="commit-dialog-title">
        <p id="commit-dialog-title" class="title">{title}</p>
        {#if files.length}
            <ul class="files">
                {#each files as f}
                    <li>
                        <button
                            class="file"
                            class:shown={diffFile === f}
                            aria-expanded={diffFile === f}
                            title={diffFile === f ? 'Hide the diff' : 'Show what the commit changes in this file'}
                            onclick={() => toggleDiff(f)}
                        ><span class="chevron" aria-hidden="true">{diffFile === f ? '▾' : '▸'}</span><span class="name">{f}</span></button>
                    </li>
                {/each}
            </ul>
        {/if}
        {#if diffFile !== null}
            <div class="diff">
                <div class="diff-head">
                    <span class="diff-path">{diffFile}</span>
                    {#if diffLoading}<span class="diff-note">loading…</span>
                    {:else if diffError}<span class="diff-note err-note">{diffError}</span>
                    {:else if diffNote}<span class="diff-note">{diffNote}</span>{/if}
                    <span class="spacer"></span>
                    <button class="diff-close" onclick={closeDiff}>Hide diff</button>
                </div>
                {#if diffHasText}
                    <div class="diff-editor" bind:this={diffContainer}></div>
                {/if}
            </div>
        {/if}
        <textarea
            bind:this={textarea}
            bind:value
            rows="4"
            placeholder="Commit message…"
            disabled={generating}
            onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
        ></textarea>
        {#if genError}<div class="err">{genError}</div>{/if}
        <div class="actions">
            <button
                class="ai"
                onclick={generateWithAi}
                disabled={!aiAvailable || !generate || generating}
                title={aiAvailable ? 'Let the configured AI write the message from the staged diff' : aiHint}
            >{generating ? 'Generating…' : 'Generate with AI'}</button>
            <span class="spacer"></span>
            <button class="cancel" onclick={cancel}>Cancel</button>
            <button onclick={submit} disabled={!value.trim() || generating}>{confirmLabel}</button>
        </div>
        <div class="hint">Ctrl+Enter commits · Cancel leaves the change uncommitted</div>
    </div>
{/if}

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 100;
    }
    .dialog {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 101;
        background: var(--bg-widget);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 20px 24px 12px;
        width: min(520px, calc(100vw - 32px));
        max-height: calc(100vh - 32px);
        overflow-y: auto;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
        box-sizing: border-box;
    }
    /* with a diff shown the dialog takes the room a side-by-side view needs */
    .dialog.wide {
        width: min(1100px, calc(100vw - 32px));
    }
    .title {
        margin: 0 0 10px;
        font-size: 13px;
        font-weight: 600;
        color: var(--fg);
    }
    .files {
        list-style: none;
        margin: 0 0 10px;
        padding: 0;
        max-height: 90px;
        overflow-y: auto;
        font-size: 11px;
        color: var(--fg-muted);
        font-family: var(--font-mono, monospace);
    }
    .files li {
        display: flex;
    }
    .files .file {
        display: flex;
        align-items: baseline;
        gap: 4px;
        min-width: 0;
        max-width: 100%;
        padding: 1px 4px 1px 0;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        border-radius: 2px;
    }
    .files .file:hover,
    .files .file.shown {
        background: none;
        color: var(--fg);
    }
    .files .file .name {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .files .file:hover .name {
        text-decoration: underline;
    }
    .chevron {
        flex: none;
        width: 10px;
    }
    .diff {
        margin: 0 0 10px;
        border: 1px solid var(--border);
        border-radius: 3px;
        overflow: hidden;
    }
    .diff-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 3px 4px 3px 8px;
        font-size: 11px;
        background: var(--bg-app);
        color: var(--fg-muted);
    }
    .diff-path {
        font-family: var(--font-mono, monospace);
        color: var(--fg);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .diff-note {
        flex: none;
    }
    .err-note {
        color: var(--fg-err);
    }
    .diff-head .diff-close {
        flex: none;
        padding: 2px 8px;
        font-size: 11px;
        background: none;
        color: var(--fg-muted);
    }
    .diff-head .diff-close:hover {
        background: var(--bg-input);
        color: var(--fg);
    }
    .diff-editor {
        height: min(420px, 46vh);
        border-top: 1px solid var(--border);
    }
    textarea {
        width: 100%;
        box-sizing: border-box;
        resize: vertical;
        background: var(--bg-app);
        border: 1px solid var(--border);
        border-radius: 3px;
        color: var(--fg);
        font-size: 13px;
        font-family: inherit;
        line-height: 1.4;
        padding: 6px 8px;
        margin-bottom: 10px;
        outline: none;
    }
    textarea:focus {
        border-color: var(--accent);
    }
    textarea:disabled {
        opacity: 0.6;
    }
    .err {
        font-size: 11px;
        color: var(--fg-err);
        margin: -4px 0 8px;
    }
    .actions {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .spacer {
        flex: 1;
    }
    button {
        border: none;
        border-radius: 3px;
        padding: 5px 14px;
        font-size: 12px;
        cursor: pointer;
    }
    .cancel,
    .ai {
        background: var(--bg-input);
        color: var(--fg);
    }
    .cancel:hover:not(:disabled),
    .ai:hover:not(:disabled) {
        background: #484848;
    }
    .ai {
        border: 1px solid var(--border);
    }
    .actions button:not(.cancel):not(.ai) {
        background: #0e639c;
        color: #fff;
    }
    .actions button:not(.cancel):not(.ai):hover:not(:disabled) {
        background: #1177bb;
    }
    button:disabled {
        opacity: 0.4;
        cursor: default;
    }
    .hint {
        margin-top: 8px;
        font-size: 10px;
        color: var(--fg-muted);
        text-align: right;
    }
</style>
