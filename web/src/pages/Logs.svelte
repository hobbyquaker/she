<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { subscribeLog, type LogEntry } from '../lib/ws.js';

    const MAX_LINES = 500;
    let entries = $state<LogEntry[]>([]);
    let logEl: HTMLDivElement;
    let autoscroll = $state(true);
    let filterLevel = $state<'all' | 'debug' | 'info' | 'warn' | 'error'>('all');

    const levels = ['all', 'debug', 'info', 'warn', 'error'] as const;
    const levelOrder = { debug: 0, info: 1, warn: 2, error: 3 };

    const unsubscribe = subscribeLog((entry) => {
        entries = [...entries.slice(-(MAX_LINES - 1)), entry];
    });

    $effect(() => {
        if (autoscroll && logEl) {
            logEl.scrollTop = logEl.scrollHeight;
        }
    });

    onDestroy(unsubscribe);

    function clear() { entries = []; }

    function visible(e: LogEntry) {
        if (filterLevel === 'all') return true;
        return levelOrder[e.level] >= levelOrder[filterLevel];
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
        padding: 6px 12px; background: #252526;
        border-bottom: 1px solid #333; flex-shrink: 0;
    }
    h2 { font-size: 13px; font-weight: 600; flex: 1; }
    select {
        background: #3c3c3c; color: #ccc; border: 1px solid #555;
        padding: 2px 6px; border-radius: 3px; font-size: 12px;
    }
    .cb { font-size: 12px; color: #aaa; display: flex; align-items: center; gap: 4px; }
    button {
        background: #3c3c3c; color: #ccc; border: 1px solid #555;
        padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 12px;
    }
    button:hover { background: #444; }
    .log {
        flex: 1; overflow-y: auto; padding: 4px 0;
        font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 12px;
    }
    .line { display: flex; gap: 8px; padding: 1px 12px; }
    .line:hover { background: #2a2d2e; }
    .ts { color: #666; flex-shrink: 0; }
    .lvl { width: 48px; flex-shrink: 0; font-weight: bold; }
    .debug .lvl { color: #888; }
    .info .lvl { color: #4fc1ff; }
    .warn .lvl { color: #cca700; }
    .error .lvl { color: #f48771; }
    .msg { color: #d4d4d4; word-break: break-all; }
</style>
