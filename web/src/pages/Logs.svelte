<script lang="ts">
    import { onMount } from 'svelte';
    import { subscribeLog, getLogBuffer, type LogEntry } from '../lib/ws.js';

    const MAX_LINES = 2000;
    let entries = $state<LogEntry[]>(getLogBuffer());
    let logEl: HTMLDivElement;
    let autoscroll = $state(true);
    let filterLevel = $state<'all' | 'debug' | 'info' | 'warn' | 'error'>('all');
    let filterText  = $state('');
    let filterRegex = $state(false);

    const levels = ['all', 'debug', 'info', 'warn', 'error'] as const;
    const levelOrder = { debug: 0, info: 1, warn: 2, error: 3 };

    subscribeLog((entry) => {
        entries = [...entries.slice(-(MAX_LINES - 1)), entry];
    });

    onMount(() => {
        // Scroll to bottom on first show
        if (logEl) logEl.scrollTop = logEl.scrollHeight;
    });

    $effect(() => {
        // Re-run whenever entries change; autoscroll to bottom.
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        entries.length;
        if (autoscroll && logEl) logEl.scrollTop = logEl.scrollHeight;
    });

    function clear() { entries = []; }

    function visible(e: LogEntry): boolean {
        if (filterLevel !== 'all' && levelOrder[e.level] < levelOrder[filterLevel]) return false;
        if (!filterText) return true;
        if (filterRegex) {
            try { return new RegExp(filterText, 'i').test(e.msg); } catch { /* invalid regex — fall through */ }
        }
        return e.msg.toLowerCase().includes(filterText.toLowerCase());
    }

    function fmt(ts: number) {
        return new Date(ts).toLocaleTimeString();
    }
</script>

<div class="page">
    <div class="toolbar">
        <h2>Logs</h2>
        <select bind:value={filterLevel}>
            {#each levels as l}<option value={l}>{l}</option>{/each}
        </select>
        <input class="filter-in" type="search" placeholder="Filter messages…" bind:value={filterText} />
        <label class="cb" title="Interpret filter as a regular expression">
            <input type="checkbox" bind:checked={filterRegex} /> Regex
        </label>
        <label class="cb"><input type="checkbox" bind:checked={autoscroll} /> Auto-scroll</label>
        <button onclick={clear}>Clear</button>
    </div>
    <div class="log" bind:this={logEl}>
        {#each entries.filter(visible) as e (e.ts + e.msg)}
            <div class="line {e.level}">
                <span class="ts">{fmt(e.ts)}</span>
                <span class="lvl">{e.level.toUpperCase()}</span>
                <span class="msg">{e.msg}</span>
            </div>
        {/each}
    </div>
</div>

<style>
    .page { display: flex; flex-direction: column; height: 100%; }
    .toolbar {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 12px; background: var(--bg-panel);
        border-bottom: 1px solid var(--border-sub); flex-shrink: 0;
    }
    h2 { font-size: 13px; font-weight: 600; flex: 1; }
    select {
        background: var(--bg-input); color: var(--fg); border: 1px solid var(--border);
        padding: 2px 6px; border-radius: 3px; font-size: 12px;
    }
    .filter-in {
        flex: 1; max-width: 320px;
        background: var(--bg-input); color: var(--fg); border: 1px solid var(--border);
        padding: 2px 6px; border-radius: 3px; font-size: 12px;
    }
    .cb { font-size: 12px; color: var(--fg-muted); display: flex; align-items: center; gap: 4px; }
    button {
        background: var(--bg-input); color: var(--fg); border: 1px solid var(--border);
        padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 12px;
    }
    button:hover { background: var(--bg-active); }
    .log {
        flex: 1; overflow-y: auto; padding: 4px 0;
        font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 12px;
    }
    .line { display: flex; gap: 8px; padding: 1px 12px; }
    .line:hover { background: var(--bg-hover); }
    .ts { color: var(--fg-dim); flex-shrink: 0; }
    .lvl { width: 48px; flex-shrink: 0; font-weight: bold; }
    .debug .lvl { color: var(--fg-muted); }
    .info .lvl { color: #4fc1ff; }
    .warn .lvl { color: var(--fg-warn); }
    .error .lvl { color: var(--fg-err); }
    .msg { color: var(--fg-text); word-break: break-all; }
</style>
