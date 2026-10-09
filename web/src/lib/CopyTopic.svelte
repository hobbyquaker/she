<script lang="ts">
    /**
     * A topic with a copy button that shows only while the pointer is over it (or it has keyboard focus).
     * Copies exactly the topic; the click never reaches the row behind it. Without a secure context
     * (plain http on a LAN host) navigator.clipboard is missing: a hidden textarea and execCommand do it then.
     */
    let { topic, class: cls = '' }: { topic: string; class?: string } = $props();
    let done = $state(false);
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function copy(e: MouseEvent) {
        e.stopPropagation();
        e.preventDefault();
        let ok = false;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(topic);
                ok = true;
            }
        } catch {
            ok = false;
        }
        if (!ok) {
            const ta = document.createElement('textarea');
            ta.value = topic;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { ok = document.execCommand('copy'); } catch { ok = false; }
            ta.remove();
        }
        if (ok) {
            done = true;
            clearTimeout(timer);
            timer = setTimeout(() => (done = false), 1000);
        }
    }
</script>

<span class="ct {cls}">{topic}<button class="cp" class:done onclick={copy} title={done ? 'Copied' : 'Copy topic'} aria-label="Copy topic">{done ? '✓' : '⧉'}</button></span>

<style>
    .ct { position: relative; padding-right: 18px; display: inline-block; max-width: 100%; }
    .cp {
        position: absolute; right: 0; top: 50%; transform: translateY(-50%);
        width: 16px; height: 16px; padding: 0; line-height: 14px; font-size: 11px;
        background: var(--bg-app); border: 1px solid var(--border); border-radius: 3px; color: var(--fg-muted);
        cursor: pointer; opacity: 0; transition: opacity 0.1s;
    }
    .ct:hover .cp, .ct:focus-within .cp, .cp.done { opacity: 1; }
    .cp:hover { color: var(--fg); border-color: var(--fg-muted); }
    .cp.done { color: var(--fg-ok, #4ec9b0); border-color: var(--fg-ok, #4ec9b0); }
</style>
