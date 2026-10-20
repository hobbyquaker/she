<script lang="ts">
    /**
     * The MQTT tab of the Matter page (roadmap M19, D-25/D-26): the Matter ↔ MQTT bridge — on/off,
     * the topic templates and the payload format, the devices with their MQTT names.
     */
    import { onDestroy, untrack } from 'svelte';
    import { subscribeWs } from '../../lib/ws.js';
    import { getMatterBridge, updateMatterBridge, setMatterBridgeDevice, type MatterBridgeSettings, type MatterBridgeTemplates } from '../../lib/api.js';

    let { active = false }: { active?: boolean } = $props();

    let data = $state<MatterBridgeSettings | null>(null);
    let loaded = $state(false);
    let error = $state<string | null>(null);
    let busy = $state(false);
    let result = $state<string | null>(null);
    /** the template inputs as edited (saved as a set) */
    let edit = $state<MatterBridgeTemplates | null>(null);
    let format = $state<string>('basic');
    let dirty = $derived(!!data && !!edit && (JSON.stringify(edit) !== JSON.stringify(data.templates) || format !== data.format));

    const LABELS: Record<keyof MatterBridgeTemplates, { label: string; dir: 'out' | 'in'; hint: string }> = {
        connected: { label: 'Connected', dir: 'out', hint: '2 while she runs, 0 on shutdown — retained' },
        attribute: { label: 'Attribute', dir: 'out', hint: 'every application attribute of endpoints ≥ 1 — retained' },
        event: { label: 'Event', dir: 'out', hint: 'cluster events (button presses …) — not retained' },
        online: { label: 'Online', dir: 'out', hint: 'true / false from the node\'s connection — retained' },
        set: { label: 'Set', dir: 'in', hint: 'a command or an attribute write; ${device} accepts the MQTT name or the node ID' },
        get: { label: 'Get', dir: 'in', hint: 'reads the attribute from the device and publishes it on the Attribute topic' },
    };
    const FORMAT_HINTS: Record<string, string> = {
        plain: 'the value as is (structs and lists as JSON)',
        basic: '{ "val", "ts", "lc" } — mqtt-smarthome (default)',
        extended: '{ "val", "ts", "lc", "matter": { nodeId, device, endpoint, cluster, attribute } }',
    };

    async function load() {
        error = null;
        try {
            data = await getMatterBridge();
            if (!dirty || !edit) {
                edit = { ...data.templates };
                format = data.format;
            }
            loaded = true;
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
    }
    $effect(() => {
        if (active && !loaded) untrack(load);
    });
    const unsub = subscribeWs('matter:bridge', () => { if (loaded) load(); });
    const unsubDevices = subscribeWs('matter:deviceList', () => { if (loaded) load(); });
    onDestroy(() => { unsub(); unsubDevices(); });

    async function apply(patch: Parameters<typeof updateMatterBridge>[0], what: string) {
        busy = true;
        error = null;
        result = null;
        try {
            data = await updateMatterBridge(patch);
            edit = { ...data.templates };
            format = data.format;
            result = what;
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            busy = false;
        }
    }
    function toggle() {
        if (!data) return;
        apply({ enabled: !data.enabled }, data.enabled ? 'Bridge switched off — its retained topics were cleared.' : 'Bridge switched on.');
    }
    function save() {
        if (!edit) return;
        apply({ templates: edit, format }, 'Saved — the old topics were cleared and the state republished.');
    }
    function resetDefaults() {
        if (!data) return;
        edit = { ...data.defaults };
        format = 'basic';
    }
    function revert() {
        if (!data) return;
        edit = { ...data.templates };
        format = data.format;
    }

    // devices
    let editing = $state<string | null>(null);
    let editName = $state('');
    async function saveName(nodeId: string) {
        busy = true;
        error = null;
        try {
            data = await setMatterBridgeDevice(nodeId, { name: editName.trim() });
            editing = null;
            result = 'Renamed — the topics moved, the old ones were cleared.';
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            busy = false;
        }
    }
    async function togglePublish(nodeId: string, publish: boolean) {
        busy = true;
        error = null;
        try {
            data = await setMatterBridgeDevice(nodeId, { publish });
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            busy = false;
        }
    }
    function example(tpl: string, dev: string): string {
        return tpl.replace('${device}', dev).replace('${nodeId}', '4').replace('${endpoint}', '1').replace('${cluster}', 'on_off').replace('${attribute}', 'on_off').replace('${event}', 'initial_press').replace('${attributeOrCommand}', 'on_off');
    }
</script>

<div class="bridge">
    <div class="bar">
        <span class="title">Matter ↔ MQTT bridge</span>
        {#if data}
            <span class="badge" class:on={data.enabled}>{data.enabled ? 'on' : 'off'}</span>
            <span class="count">{data.enabled ? `${data.status.published} topic${data.status.published === 1 ? '' : 's'} published` : 'devices stay off MQTT until switched on'}{data.enabled && !data.status.connected ? ' · MQTT not connected' : ''}</span>
        {/if}
        <span class="spacer"></span>
        {#if result}<span class="result">{result}</span>{/if}
        {#if data}<button onclick={toggle} disabled={busy} class:ghost={data.enabled}>{data.enabled ? 'Switch off' : 'Switch on'}</button>{/if}
    </div>
    {#if error}<p class="err">{error}</p>{/if}
    {#if !loaded}
        <div class="info">Loading…</div>
    {:else if data && edit}
        <div class="body">
            <section>
                <h3>Topics and payload</h3>
                <p class="hint">Templates with <code>$&#123;placeholders&#125;</code>: {data.placeholders.map((p) => `\${${p}}`).join(' · ')}. Outbound ones are filled, inbound ones become subscriptions (a placeholder is <code>+</code>, the last one <code>#</code>). An empty template disables that topic. Cluster, attribute, event and command names are snake_case (<code>level_control/current_level</code>), values in Matter's units. Defaults are mqtt-smarthome.</p>
                <table class="tpl">
                    <tbody>
                        {#each Object.keys(LABELS) as key (key)}
                            {@const k = key as keyof MatterBridgeTemplates}
                            <tr>
                                <th><span class="dir" class:in={LABELS[k].dir === 'in'}>{LABELS[k].dir}</span> {LABELS[k].label}</th>
                                <td><input type="text" bind:value={edit[k]} spellcheck="false" placeholder="(off)" /></td>
                                <td class="hint-cell">{LABELS[k].hint}{#if edit[k]} · e.g. <code>{example(edit[k], data.devices[0]?.name ?? 'bad_licht')}</code>{/if}</td>
                            </tr>
                        {/each}
                        <tr>
                            <th>Payload</th>
                            <td>
                                <select bind:value={format}>
                                    {#each data.formats as f (f)}<option value={f}>{f === 'basic' ? 'mqtt-smarthome basic' : f === 'extended' ? 'mqtt-smarthome extended' : 'plain'}</option>{/each}
                                </select>
                            </td>
                            <td class="hint-cell">{FORMAT_HINTS[format]}. Inbound payloads are accepted plain or as <code>&#123;"val": …&#125;</code> in every format.</td>
                        </tr>
                    </tbody>
                </table>
                <div class="actions">
                    <button onclick={save} disabled={busy || !dirty}>Save</button>
                    <button class="ghost" onclick={revert} disabled={busy || !dirty}>Revert</button>
                    <button class="ghost" onclick={resetDefaults} disabled={busy}>Reset to defaults</button>
                    {#if dirty && data.enabled}<span class="hint">Saving clears the bridge's retained topics and republishes under the new ones.</span>{/if}
                </div>
                <p class="hint">On <code>set</code>: <code>on_off/on_off</code> true/false → on/off, "toggle" → toggle; <code>level_control/current_level</code> → moveToLevel; <code>window_covering/current_position_lift_percent100ths</code> → goToLiftPercentage; <code>color_control/color_temperature_mireds</code> → moveToColorTemperature; a command name runs that command with the payload object as its fields; anything else is an attribute write. The bridge does not echo a set — the status follows from the device's report.</p>
            </section>
            <section>
                <h3>Devices</h3>
                <p class="hint">The MQTT name is taken from the device name when a node first appears and kept — renaming the device in Apple Home or she does not move its topics; edit it here to move them.</p>
                <table class="devs">
                    <thead><tr><th>Device</th><th>Node</th><th>MQTT name</th><th>Bridged</th><th></th></tr></thead>
                    <tbody>
                        {#each data.devices as d (d.nodeId)}
                            <tr class:off={!d.publish} class:gone={d.gone}>
                                <td><span class="status-dot" class:online={d.online}></span>{d.deviceName ?? `Node ${d.nodeId}`}{#if d.gone}<span class="dim"> (unpaired)</span>{/if}</td>
                                <td class="mono">{d.nodeId}</td>
                                <td>
                                    {#if editing === d.nodeId}
                                        <input class="name-in" type="text" bind:value={editName} spellcheck="false" onkeydown={(e) => { if (e.key === 'Enter') saveName(d.nodeId); if (e.key === 'Escape') editing = null; }} />
                                    {:else}
                                        <code>{d.name}</code>
                                    {/if}
                                </td>
                                <td><label class="chk"><input type="checkbox" checked={d.publish} disabled={busy || d.gone} onchange={(e) => togglePublish(d.nodeId, (e.currentTarget as HTMLInputElement).checked)} /><span class="checkmark"></span> {d.publish ? 'yes' : 'no'}</label></td>
                                <td class="c-act">
                                    {#if editing === d.nodeId}
                                        <button class="sm" onclick={() => saveName(d.nodeId)} disabled={busy || !editName.trim()}>Save</button>
                                        <button class="ghost sm" onclick={() => (editing = null)}>Cancel</button>
                                    {:else}
                                        <button class="ghost sm" disabled={busy || d.gone} onclick={() => { editing = d.nodeId; editName = d.name; }}>Rename</button>
                                    {/if}
                                </td>
                            </tr>
                        {/each}
                        {#if data.devices.length === 0}<tr><td colspan="5" class="dim">No paired devices.</td></tr>{/if}
                    </tbody>
                </table>
            </section>
        </div>
    {/if}
</div>

<style>
    .bridge { flex: 1; display: flex; flex-direction: column; overflow: hidden; color: var(--fg); font-size: 12px; }
    .bar { display: flex; align-items: center; gap: 8px; padding: 5px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .title { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg-muted); }
    .count, .hint, .dim { color: var(--fg-muted); font-size: 11px; }
    .spacer { flex: 1; }
    .result { color: var(--fg-muted); font-size: 11px; }
    .badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600; line-height: 16px; background: rgba(128,128,128,0.18); color: var(--fg-muted); }
    .badge.on { background: rgba(152,195,121,0.18); color: #98c379; }
    .body { flex: 1; overflow: auto; padding: 8px 12px 16px; display: flex; flex-direction: column; gap: 18px; }
    h3 { margin: 0 0 4px; font-size: 12px; font-weight: 600; color: var(--fg-text); }
    .hint { margin: 2px 0 8px; line-height: 1.5; }
    code { color: var(--accent, #569cd6); font-size: 11px; }
    .err { margin: 6px 12px; color: #e74c3c; }
    .info { padding: 16px; color: var(--fg-muted); }
    table { border-collapse: collapse; width: 100%; }
    .tpl th { text-align: left; font-weight: 500; color: var(--fg); padding: 4px 8px 4px 0; white-space: nowrap; width: 120px; vertical-align: middle; }
    .tpl td { padding: 3px 6px 3px 0; vertical-align: middle; }
    .tpl input, select { background: var(--bg-app); border: 1px solid var(--border); color: var(--fg-text); padding: 3px 6px; border-radius: 3px; font-size: 12px; font-family: var(--font-mono, monospace); width: 100%; box-sizing: border-box; min-width: 300px; }
    select { font-family: inherit; }
    .hint-cell { color: var(--fg-muted); font-size: 11px; }
    .dir { display: inline-block; width: 26px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #98c379; }
    .dir.in { color: #e5a86b; }
    .actions { display: flex; align-items: center; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
    button { background: var(--accent); border: none; color: #fff; padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    button.sm { padding: 1px 7px; font-size: 11px; }
    .devs th { text-align: left; font-weight: 600; font-size: 11px; color: var(--fg-muted); padding: 4px 8px; border-bottom: 1px solid var(--border); }
    .devs td { padding: 4px 8px; border-bottom: 1px solid var(--border-sub, var(--border)); vertical-align: middle; }
    tr.off td { color: var(--fg-muted); }
    tr.gone td { color: var(--fg-dim); }
    .mono { font-family: var(--font-mono, monospace); font-size: 11px; }
    .name-in { background: var(--bg-app); border: 1px solid var(--border); color: var(--fg-text); padding: 2px 6px; border-radius: 3px; font-size: 12px; font-family: var(--font-mono, monospace); width: 200px; }
    .c-act { text-align: right; white-space: nowrap; }
    .status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--fg-dim); margin-right: 6px; }
    .status-dot.online { background: #98c379; }
    /* the checkbox look of the other pages (DB, Secrets, chat): the native box hidden, a themed one drawn */
    .chk { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
    .chk input[type='checkbox'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .chk .checkmark { flex-shrink: 0; width: 13px; height: 13px; border: 1.5px solid var(--border); border-radius: 2px; background: var(--bg-app); position: relative; transition: background 0.12s, border-color 0.12s; }
    .chk input:checked + .checkmark { background: var(--accent); border-color: var(--accent); }
    .chk input:checked + .checkmark::after { content: ''; position: absolute; left: 3px; top: 0; width: 4px; height: 7px; border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg); }
    .chk:hover .checkmark { border-color: var(--accent); }
    .chk input:focus-visible + .checkmark { outline: 1px solid var(--accent); outline-offset: 1px; }
    .chk:has(input:disabled) { cursor: default; opacity: 0.5; }
    .chk:has(input:disabled):hover .checkmark { border-color: var(--border); }
</style>
