<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { subscribeWs } from '../lib/ws.js';
    import { fetchMqttState, publishMqtt, type MqttEntry } from '../lib/api.js';

    let entries = $state<MqttEntry[]>([]);
    let filter = $state('');
    let loading = $state(true);
    let loadError: string | null = $state(null);

    // Publish form
    let pubTopic = $state('');
    let pubPayload = $state('');
    let pubRetain = $state(false);
    let pubQos = $state<0 | 1 | 2>(0);
    let pubBusy = $state(false);
    let pubError: string | null = $state(null);
    let pubOk = $state(false);

    async function load() {
        loading = true;
        loadError = null;
        try {
            entries = await fetchMqttState();
        } catch (e: unknown) {
            loadError = e instanceof Error ? e.message : String(e);
        } finally {
            loading = false;
        }
    }

    // Live updates from the broker via WebSocket
    const unsubscribe = subscribeWs('mqtt', (msg) => {
        const { topic, val, ts } = msg as { topic: string; val: unknown; ts: number };
        const idx = entries.findIndex((e) => e.topic === topic);
        if (idx >= 0) {
            entries[idx] = { topic, val, ts };
        } else {
            entries = [...entries, { topic, val, ts }].sort((a, b) => a.topic.localeCompare(b.topic));
        }
    });

    onMount(load);
    onDestroy(unsubscribe);

    function fmtVal(val: unknown): string {
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
    }

    function fmtAge(ts: number): string {
        const diff = Math.floor((Date.now() - ts) / 1000);
        if (diff < 60) return `${diff}s`;
        if (diff < 3600) return `${Math.floor(diff / 60)}m`;
        return `${Math.floor(diff / 3600)}h`;
    }

    let filtered = $derived(
        filter ? entries.filter((e) => e.topic.toLowerCase().includes(filter.toLowerCase())) : entries,
    );

    async function publish() {
        if (!pubTopic) return;
        pubBusy = true;
        pubError = null;
        pubOk = false;
        try {
            await publishMqtt(pubTopic, pubPayload, pubRetain, pubQos);
            pubOk = true;
            setTimeout(() => {
                pubOk = false;
            }, 2000);
        } catch (e: unknown) {
            pubError = e instanceof Error ? e.message : String(e);
        } finally {
            pubBusy = false;
        }
    }
</script>

<div class="page">
    <div class="toolbar">
        <h2>MQTT</h2>
        <input class="filter" type="search" placeholder="Filter topics…" bind:value={filter} />
        <span class="count">{filtered.length} / {entries.length}</span>
    </div>

    <div class="publish-bar">
        <input class="pub-topic" type="text" placeholder="topic" bind:value={pubTopic} />
        <input class="pub-payload" type="text" placeholder="payload" bind:value={pubPayload} />
        <label class="retain-label">
            <input type="checkbox" bind:checked={pubRetain} /> retain
        </label>
        <select bind:value={pubQos}>
            <option value={0}>QoS 0</option>
            <option value={1}>QoS 1</option>
            <option value={2}>QoS 2</option>
        </select>
        <button onclick={publish} disabled={pubBusy || !pubTopic}>Publish</button>
        {#if pubOk}<span class="pub-ok">✓</span>{/if}
        {#if pubError}<span class="pub-err">{pubError}</span>{/if}
    </div>

    {#if loading}
        <div class="info">Loading…</div>
    {:else if loadError}
        <div class="info error">{loadError}</div>
    {:else if filtered.length === 0}
        <div class="info">No topics{filter ? ' matching filter' : ''}.</div>
    {:else}
        <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th>Topic</th>
                        <th>Value</th>
                        <th>Age</th>
                    </tr>
                </thead>
                <tbody>
                    {#each filtered as entry (entry.topic)}
                        <tr>
                            <td class="topic">{entry.topic}</td>
                            <td class="val">{fmtVal(entry.val)}</td>
                            <td class="age">{fmtAge(entry.ts)}</td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {/if}
</div>

<style>
    .page {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-bottom: 1px solid #3c3c3c;
        flex-shrink: 0;
    }
    .toolbar h2 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: #ccc;
    }
    .filter {
        flex: 1;
        max-width: 360px;
        background: #1e1e1e;
        border: 1px solid #3c3c3c;
        border-radius: 3px;
        color: #ccc;
        padding: 3px 8px;
        font-size: 13px;
    }
    .count {
        font-size: 12px;
        color: #666;
        margin-left: auto;
    }

    .publish-bar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border-bottom: 1px solid #3c3c3c;
        flex-shrink: 0;
    }
    .pub-topic {
        width: 240px;
    }
    .pub-payload {
        flex: 1;
    }
    .pub-topic,
    .pub-payload {
        background: #1e1e1e;
        border: 1px solid #3c3c3c;
        border-radius: 3px;
        color: #ccc;
        padding: 3px 8px;
        font-size: 13px;
    }
    .retain-label {
        font-size: 12px;
        color: #888;
        display: flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
    }
    select {
        background: #2d2d2d;
        border: 1px solid #3c3c3c;
        color: #ccc;
        padding: 3px 6px;
        font-size: 12px;
        border-radius: 3px;
    }
    button {
        background: #0e639c;
        border: none;
        color: #fff;
        padding: 4px 12px;
        border-radius: 3px;
        font-size: 12px;
        cursor: pointer;
    }
    button:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .pub-ok {
        color: #4ec9b0;
        font-size: 13px;
    }
    .pub-err {
        color: #f48771;
        font-size: 12px;
    }

    .info {
        padding: 24px 16px;
        color: #666;
        font-size: 13px;
    }
    .info.error {
        color: #f48771;
    }

    .table-wrap {
        flex: 1;
        overflow: auto;
    }
    table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
    }
    thead {
        position: sticky;
        top: 0;
        background: #252526;
    }
    th {
        text-align: left;
        padding: 6px 12px;
        color: #888;
        font-weight: 500;
        border-bottom: 1px solid #3c3c3c;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }
    td {
        padding: 4px 12px;
        border-bottom: 1px solid #2d2d2d;
        color: #ccc;
    }
    tr:hover td {
        background: #2a2d2e;
    }
    .topic {
        font-family: monospace;
        font-size: 12px;
        color: #9cdcfe;
    }
    .val {
        font-family: monospace;
        font-size: 12px;
        max-width: 400px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .age {
        color: #666;
        font-size: 11px;
        white-space: nowrap;
    }
</style>
