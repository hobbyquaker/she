<script lang="ts">
    let open = $state(false);
    let message = $state('');
    let confirmLabel = $state('Confirm');
    let danger = $state(false);
    let resolve: ((v: boolean) => void) | null = null;

    export function show(
        msg: string,
        opts?: { confirm?: string; danger?: boolean },
    ): Promise<boolean> {
        message = msg;
        confirmLabel = opts?.confirm ?? 'Confirm';
        danger = opts?.danger ?? false;
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
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="backdrop" onclick={() => choose(false)}></div>
    <div class="dialog" role="dialog" aria-modal="true">
        <p>{message}</p>
        <div class="actions">
            <button class="cancel" onclick={() => choose(false)}>Cancel</button>
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
        background: #2d2d30;
        border: 1px solid #454545;
        border-radius: 6px;
        padding: 20px 24px 16px;
        min-width: 280px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    }
    p {
        margin: 0 0 20px;
        font-size: 13px;
        color: #cccccc;
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
        background: #3c3c3c;
        color: #cccccc;
    }
    .cancel:hover {
        background: #484848;
    }
    button:not(.cancel) {
        background: #0e639c;
        color: #fff;
    }
    button:not(.cancel):hover {
        background: #1177bb;
    }
    button.danger {
        background: #6c1717;
    }
    button.danger:hover {
        background: #8b1e1e;
    }
</style>
