<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import { subscribeLog, getLogBuffer, getHistoryEntries, type LogEntry } from '../lib/ws.js';

    const MAX_LINES = 2000;
    let entries = $state<LogEntry[]>(getLogBuffer());
    let historyLoading = $state(true);
    let logEl: HTMLDivElement;
    let autoscroll = $state(true);
    let filterLevel = $state<'all' | 'debug' | 'info' | 'warn' | 'error'>('all');
    let filterText  = $state('');
    let filterRegex = $state(false);

    const levels = ['all', 'debug', 'info', 'warn', 'error'] as const;
    const levelOrder = { debug: 0, info: 1, warn: 2, error: 3 };

    const unsubLog = subscribeLog((entry) => {
        entries = [...entries.slice(-(MAX_LINES - 1)), entry];
    });
    onDestroy(unsubLog);

    onMount(async () => {
        try {
            const history = await getHistoryEntries();
            // Merge history with any live entries already received during the fetch.
            // History entries are older so prepend them; deduplicate by ts+msg.
            const liveSet = new Set(entries.map((e) => e.ts + e.msg));
            const newHistory = history.filter((e) => !liveSet.has(e.ts + e.msg));
            entries = [...newHistory, ...entries].slice(-MAX_LINES);
        } catch { /* best-effort — live log still works without history */ }
        historyLoading = false;
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
        {#if historyLoading}<span class="history-loading" title="Loading log history…">↺</span>{/if}
        <select bind:value={filterLevel}>
            {#each levels as l}<option value={l}>{l}</option>{/each}
        </select>
        <input class="filter-in" type="search" placeholder="Filter messages…" bind:value={filterText} />
        <label class="check-label" title="Interpret filter as a regular expression">
            <input type="checkbox" bind:checked={filterRegex} />
            <span class="checkmark"></span> Regex
        </label>
        <label class="check-label">
            <input type="checkbox" bind:checked={autoscroll} />
            <span class="checkmark"></span> Auto-scroll
        </label>
        <button onclick={clear}>Clear</button>
    </div>
    <div class="log" bind:this={logEl}>
        <!-- Unkeyed on purpose: identical entries (same ms, same msg) are legal
             in a log stream, and duplicate keys make Svelte throw, killing the
             whole list. -->
        {#each entries.filter(visible) as e}
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
    .history-loading { font-size: 13px; color: var(--fg-muted); animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    select {
        background: var(--bg-input); color: var(--fg); border: 1px solid var(--border);
        padding: 2px 6px; border-radius: 3px; font-size: 12px;
    }
    .filter-in {
        flex: 1; max-width: 320px;
        background: var(--bg-input); color: var(--fg); border: 1px solid var(--border);
        padding: 2px 6px; border-radius: 3px; font-size: 12px;
    }
    .check-label {
        display: flex; align-items: center; gap: 6px;
        cursor: pointer; font-size: 12px; color: var(--fg-muted);
        user-select: none; white-space: nowrap;
    }
    .check-label input[type='checkbox'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .checkmark {
        flex-shrink: 0; width: 13px; height: 13px;
        border: 1.5px solid var(--border); border-radius: 3px;
        background: var(--bg-input); position: relative;
        transition: background 0.12s, border-color 0.12s;
    }
    .check-label input:checked + .checkmark { background: var(--accent); border-color: var(--accent); }
    .check-label input:checked + .checkmark::after {
        content: ''; position: absolute; left: 3px; top: 0px; width: 4px; height: 7px;
        border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg);
    }
    .check-label:hover .checkmark { border-color: var(--accent); }
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
