<script lang="ts">
    let open = $state(false);
    let message = $state('');
    let placeholder = $state('');
    let confirmLabel = $state('OK');
    let value = $state('');
    let resolve: ((v: string | null) => void) | null = null;
    let input: HTMLInputElement | undefined = $state();

    export function show(
        msg: string,
        opts?: { placeholder?: string; confirm?: string; initial?: string },
    ): Promise<string | null> {
        message = msg;
        placeholder = opts?.placeholder ?? '';
        confirmLabel = opts?.confirm ?? 'OK';
        value = opts?.initial ?? '';
        open = true;
        // Focus the input on next tick after the element renders
        setTimeout(() => input?.select(), 0);
        return new Promise((r) => (resolve = r));
    }

    function submit() {
        const v = value.trim();
        if (!v) return;
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
    <div class="dialog" role="dialog" aria-modal="true">
        <p>{message}</p>
        <input
            bind:this={input}
            bind:value
            {placeholder}
            onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        />
        <div class="actions">
            <button class="cancel" onclick={cancel}>Cancel</button>
            <button onclick={submit} disabled={!value.trim()}>{confirmLabel}</button>
        </div>
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
        padding: 20px 24px 16px;
        min-width: 320px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    }
    p {
        margin: 0 0 12px;
        font-size: 13px;
        color: var(--fg);
    }
    input {
        width: 100%;
        box-sizing: border-box;
        background: var(--bg-app);
        border: 1px solid var(--border);
        border-radius: 3px;
        color: var(--fg);
        font-size: 13px;
        padding: 5px 8px;
        margin-bottom: 16px;
        outline: none;
    }
    input:focus {
        border-color: var(--accent);
    }
    .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
    }
    button {
        border: none;
        border-radius: 3px;
        padding: 5px 14px;
        font-size: 12px;
        cursor: pointer;
    }
    .cancel {
        background: var(--bg-input);
        color: var(--fg);
    }
    .cancel:hover {
        background: #484848;
    }
    button:not(.cancel) {
        background: #0e639c;
        color: #fff;
    }
    button:not(.cancel):hover:not(:disabled) {
        background: #1177bb;
    }
    button:disabled {
        opacity: 0.4;
        cursor: default;
    }
</style>
