<script lang="ts">
    import { onMount, onDestroy, tick } from 'svelte';
    import { subscribeWs, getBrokerLogBuffer } from '../../lib/ws.js';
    import { getBrokerConf, getBrokerLogs } from '../../lib/api.js';
    import { fmtLogTs as fmt } from '../../lib/format.js';

    type Level = 'D' | 'I' | 'N' | 'W' | 'E';

    interface LogEntry {
        ts: number;
        level: Level;
        msg: string;
    }

    const LEVEL_LABEL: Record<Level, string> = { D: 'DBG', I: 'INF', N: 'NTC', W: 'WRN', E: 'ERR' };
    const LEVEL_CLASS: Record<Level, string> = { D: 'lvl-d', I: 'lvl-i', N: 'lvl-n', W: 'lvl-w', E: 'lvl-e' };
    const VALID_LEVELS = new Set<string>(['D', 'I', 'N', 'W', 'E']);

    let entries = $state<LogEntry[]>([]);
    let autoScroll = $state(true);
    let filterLevels = $state<Set<Level>>(new Set(['D', 'I', 'N', 'W', 'E']));
    let logContainer = $state<HTMLElement | undefined>(undefined);
    let hasReceived = $state(false);
    let topicEnabled = $state<boolean | null>(null); // null = unknown (still loading)

    const MAX = 500;

    let unsub: (() => void) | null = null;

    onMount(async () => {
        // Fetch server-side ring buffer (history from daemon start, survives page refresh)
        const httpEntries = await getBrokerLogs().catch(() => []);
        // Merge with client-side buffer (entries received since page loaded)
        const wsEntries = getBrokerLogBuffer();
        // Combine, sort by ts, deduplicate by ts+msg
        const seen = new Set<string>();
        const combined = [...httpEntries, ...wsEntries]
            .filter(e => VALID_LEVELS.has(e.level))
            .map(e => ({ ts: e.ts, level: e.level as Level, msg: e.msg }));
        combined.sort((a, b) => a.ts - b.ts);
        entries = combined.filter(e => {
            const k = `${e.ts}\x00${e.msg}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        }).slice(-MAX);
        if (entries.length > 0) { hasReceived = true; tick().then(scrollToBottom); }

        unsub = subscribeWs('brokerLog', (msg: { level: string; msg: string; ts: number }) => {
            if (!VALID_LEVELS.has(msg.level)) return;
            hasReceived = true;
            entries = [...entries.slice(-(MAX - 1)), { ts: msg.ts, level: msg.level as Level, msg: msg.msg }];
            if (autoScroll) tick().then(scrollToBottom);
        });
        // Check if log_dest includes 'topic'
        getBrokerConf().then(conf => {
            const v = conf.managed['log_dest'];
            const dests = Array.isArray(v) ? v : (v ? [v] : []);
            topicEnabled = dests.includes('topic');
        }).catch(() => { topicEnabled = null; });
    });

    onDestroy(() => { unsub?.(); });

    function scrollToBottom() {
        if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
    }

    function toggleLevel(l: Level) {
        const s = new Set(filterLevels);
        if (s.has(l)) s.delete(l); else s.add(l);
        filterLevels = s;
    }

    function clear() { entries = []; hasReceived = false; }

    let filtered = $derived(entries.filter(e => filterLevels.has(e.level)));

</script>

<div class="logs-page">
    <div class="toolbar">
        <div class="level-filters">
            {#each (['D', 'I', 'N', 'W', 'E'] as Level[]) as l}
            <button
                class="lvl-btn {LEVEL_CLASS[l]}"
                class:active={filterLevels.has(l)}
                onclick={() => toggleLevel(l)}
                title="Toggle {l} messages"
            >{LEVEL_LABEL[l]}</button>
            {/each}
        </div>
        <div class="spacer"></div>
        <label class="autoscroll-label">
            <input type="checkbox" bind:checked={autoScroll} />
            <span class="checkmark"></span>
            Auto-scroll
        </label>
        <button class="btn-clear" onclick={clear}>Clear</button>
    </div>

    <div class="log-container" bind:this={logContainer}>
        {#if filtered.length === 0}
            <div class="empty">
                {#if !hasReceived}
                    {#if topicEnabled === false}
                        <code>log_dest topic</code> is not enabled in mosquitto.conf.<br />
                        <span class="hint">Enable it in the <strong>Config</strong> tab, then click <em>Apply &amp; Reload</em>.</span>
                    {:else if topicEnabled === true}
                        <code>log_dest topic</code> is configured — waiting for messages&hellip;<br />
                        <span class="hint">If nothing appears, mosquitto may need a full restart for the change to take effect.</span>
                    {:else}
                        Waiting for log messages&hellip;<br />
                        <span class="hint">Make sure <code>log_dest topic</code> is set in mosquitto.conf.</span>
                    {/if}
                {:else}
                    No messages match the current filter.
                {/if}
            </div>
        {:else}
            <!-- Unkeyed on purpose: duplicate entries are legal in a log stream -->
            {#each filtered as e}
            <div class="entry">
                <span class="ts">{fmt(e.ts)}</span>
                <span class="badge {LEVEL_CLASS[e.level]}">{LEVEL_LABEL[e.level]}</span>
                <span class="msg">{e.msg}</span>
            </div>
            {/each}
        {/if}
    </div>
</div>

<style>
    .logs-page {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .toolbar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border-bottom: 1px solid var(--border, #333);
        flex-shrink: 0;
    }

    .level-filters { display: flex; gap: 4px; }
    .lvl-btn {
        background: none;
        border: 1px solid var(--border, #444);
        border-radius: 3px;
        color: var(--text-muted, #888);
        cursor: pointer;
        font-family: monospace;
        font-size: 11px;
        padding: 2px 7px;
        opacity: 0.45;
        transition: opacity 0.1s;
    }
    .lvl-btn.active { opacity: 1; }

    .lvl-d { border-color: #555; color: #999; }
    .lvl-i { border-color: rgba(86,156,214,0.5); color: #569cd6; }
    .lvl-n { border-color: rgba(100,180,100,0.5); color: #6dbf6d; }
    .lvl-w { border-color: rgba(220,170,60,0.5); color: #d7a83c; }
    .lvl-e { border-color: rgba(220,60,60,0.5); color: #e06c6c; }

    .spacer { flex: 1; }

    .autoscroll-label { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-muted, #aaa); cursor: pointer; user-select: none; }
    .autoscroll-label input[type='checkbox'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .checkmark { flex-shrink: 0; width: 14px; height: 14px; border: 1.5px solid var(--border, #444); border-radius: 3px; background: var(--input-bg, #2a2a2a); position: relative; transition: background 0.12s, border-color 0.12s; }
    .autoscroll-label input:checked + .checkmark { background: var(--accent, #569cd6); border-color: var(--accent, #569cd6); }
    .autoscroll-label input:checked + .checkmark::after { content: ''; position: absolute; left: 3px; top: 0px; width: 4px; height: 8px; border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg); }
    .autoscroll-label:hover .checkmark { border-color: var(--accent, #569cd6); }
    .btn-clear { background: none; border: 1px solid var(--border, #444); border-radius: 3px; color: var(--text-muted, #888); cursor: pointer; font-size: 11px; padding: 2px 8px; }

    .log-container {
        flex: 1;
        overflow-y: auto;
        font-family: monospace;
        font-size: 12px;
        line-height: 1.5;
        padding: 6px 12px;
    }

    .entry {
        display: flex;
        align-items: baseline;
        gap: 8px;
        padding: 1px 0;
    }
    .entry:hover { background: rgba(255,255,255,0.03); }

    .ts { color: var(--text-muted, #666); font-size: 11px; flex-shrink: 0; }

    .badge {
        border-radius: 3px;
        font-size: 10px;
        padding: 0 4px;
        flex-shrink: 0;
        border: 1px solid currentColor;
    }
    .badge.lvl-d { color: #888; }
    .badge.lvl-i { color: #569cd6; }
    .badge.lvl-n { color: #6dbf6d; }
    .badge.lvl-w { color: #d7a83c; }
    .badge.lvl-e { color: #e06c6c; }

    .msg { color: var(--text, #ddd); white-space: pre-wrap; word-break: break-all; }

    .empty {
        color: var(--text-muted, #777);
        font-size: 13px;
        padding: 24px;
        text-align: center;
        line-height: 1.8;
    }
    .hint { font-size: 12px; }
    .hint code { background: rgba(255,255,255,0.06); border-radius: 2px; padding: 0 3px; }
</style>
