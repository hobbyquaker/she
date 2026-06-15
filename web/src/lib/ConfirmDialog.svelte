<script lang="ts">
    let open = $state(false);
    let message = $state('');
    let confirmLabel = $state('Confirm');
    let danger = $state(false);
    let alertMode = $state(false);
    let resolve: ((v: boolean) => void) | null = null;

    export function show(
        msg: string,
        opts?: { confirm?: string; danger?: boolean; alert?: boolean },
    ): Promise<boolean> {
        message = msg;
        confirmLabel = opts?.confirm ?? (opts?.alert ? 'OK' : 'Confirm');
        danger = opts?.danger ?? false;
        alertMode = opts?.alert ?? false;
        open = true;
        return new Promise((r) => (resolve = r));
    }

    function choose(value: boolean) {
        open = false;
        resolve?.(value);
        resolve = null;
    }

    function onKeydown(e: KeyboardEvent) {
        if (!open) return;
        if (e.key === 'Escape') choose(false);
        if (e.key === 'Enter') choose(true);
    }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
    <div class="backdrop" role="presentation" onclick={() => choose(false)}></div>
    <div class="dialog" role="dialog" aria-modal="true">
        <p>{message}</p>
        <div class="actions">
            {#if !alertMode}<button class="cancel" onclick={() => choose(false)}>Cancel</button>{/if}
            <button class:danger onclick={() => choose(true)}>{confirmLabel}</button>
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
        min-width: 280px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    }
    p {
        margin: 0 0 20px;
        font-size: 13px;
        color: var(--fg);
        line-height: 1.4;
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
        background: var(--bg-active);
    }
    button:not(.cancel):not(.danger) {
        background: var(--accent);
        color: #fff;
    }
    button:not(.cancel):not(.danger):hover {
        background: var(--accent-hov);
    }
    button.danger {
        background: var(--accent-del);
        color: #fff;
    }
    button.danger:hover {
        background: var(--accent-del-hov);
    }
</style>
