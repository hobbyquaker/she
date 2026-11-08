<script lang="ts">
    /**
     * The commit dialog: a pre-filled message the user commits as it is, edits, or replaces with one the AI
     * writes from the staged diff. Used after a save, rename or delete in "ask" mode and for manual commits.
     */
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
    }): Promise<string | null> {
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
        open = false;
        resolve?.(v);
        resolve = null;
        value = '';
    }

    function cancel() {
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
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="commit-dialog-title">
        <p id="commit-dialog-title" class="title">{title}</p>
        {#if files.length}
            <ul class="files">
                {#each files as f}<li>{f}</li>{/each}
            </ul>
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
            >{generating ? 'Generating…' : '✨ Generate with AI'}</button>
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
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
        box-sizing: border-box;
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
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
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
    button:not(.cancel):not(.ai) {
        background: #0e639c;
        color: #fff;
    }
    button:not(.cancel):not(.ai):hover:not(:disabled) {
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
