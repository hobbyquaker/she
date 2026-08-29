<script lang="ts">
    /**
     * Device discovery in the Add-instance flow (roadmap I13).
     *
     * The scan itself runs on the target host — the adapter's own `--discover`, because broadcast,
     * multicast, ARP and /dev only reach the network and the usb bus of the machine running it.
     * This component only asks for it, shows what answered, and hands the picked device back.
     *
     * Explicit trigger on purpose: no probing of the user's network unless they press the button.
     */
    import { discoverDevices, type DiscoveredDevice } from '../../lib/api.js';

    let {
        host,
        adapter,
        kinds,
        property,
        selected = null,
        onpick,
    }: {
        host: string;
        adapter: string;
        kinds: Array<'network' | 'serial'>;
        property: string;
        selected?: string | null;
        onpick?: (device: DiscoveredDevice, value: string) => void;
    } = $props();

    type Form = 'address' | 'hostname' | 'fqdn';
    /** Which form of a device's identity is configured, per device. */
    let forms = $state<Record<string, Form>>({});

    /**
     * The FQDN by default: it outlives a dhcp lease where an address does not. Never the short
     * hostname on its own — it resolves through the search list of whoever asks, which the host
     * that ran the scan has and another machine may not.
     */
    function defaultForm(d: DiscoveredDevice): Form {
        return d.fqdn ? 'fqdn' : 'address';
    }
    function formOf(d: DiscoveredDevice): Form {
        return forms[d.value] ?? defaultForm(d);
    }
    function valueOf(d: DiscoveredDevice, form: Form = formOf(d)): string {
        return (form === 'fqdn' ? d.fqdn : form === 'hostname' ? d.hostname : d.address) ?? d.value;
    }
    /** The forms this device actually answers to — the core only reports names that round-trip. */
    function formsOf(d: DiscoveredDevice): Array<{ form: Form; label: string; title: string }> {
        const out: Array<{ form: Form; label: string; title: string }> = [];
        if (d.address) out.push({ form: 'address', label: 'IP', title: d.address + ' — changes when the dhcp lease does' });
        if (d.hostname) {
            out.push({
                form: 'hostname',
                label: 'host',
                title: d.hostname + ' — resolves through the search list of whoever asks, so it may not work on every host',
            });
        }
        if (d.fqdn) out.push({ form: 'fqdn', label: 'FQDN', title: d.fqdn + ' — qualified and verified, outlives a dhcp lease' });
        return out.length > 1 ? out : [];
    }
    function pick(d: DiscoveredDevice, form?: Form) {
        if (form) forms = { ...forms, [d.value]: form };
        onpick?.(d, valueOf(d, form ?? formOf(d)));
    }

    let scanning = $state(false);
    let scanned  = $state(false);
    let error    = $state('');
    let devices  = $state<DiscoveredDevice[]>([]);
    let advanced = $state(false);
    let address  = $state('');
    let timeout  = $state<number | ''>(5);

    // a serial scan is a directory listing: no timeout to speak of, nothing a router could hide
    let network = $derived(kinds.includes('network'));

    export async function scan() {
        if (scanning) return;
        scanning = true; error = '';
        try {
            const extra = address.trim();
            const r = await discoverDevices(host, adapter, {
                ...(network && timeout !== '' ? { timeout: Number(timeout) } : {}),
                ...(extra ? { address: extra.split(/[\s,]+/).filter(Boolean) } : {}),
            });
            devices = r.devices;
            scanned = true;
            forms = {};
            // one device and nothing chosen yet: preselect it, the user only has to confirm
            if (devices.length === 1 && !selected && !devices[0].usedBy) pick(devices[0]);
        } catch (e: any) {
            error = e?.message ?? String(e);
        } finally {
            scanning = false;
        }
    }

    function label(d: DiscoveredDevice): string {
        return d.name ?? d.model ?? d.type ?? d.id ?? d.value;
    }
    function openServices(d: DiscoveredDevice): string[] {
        return Object.entries(d.services ?? {}).filter(([, open]) => open).map(([name]) => name);
    }
</script>

<div class="scan">
    <div class="bar">
        <button class="ghost" onclick={scan} disabled={scanning || !host || !adapter}>
            {#if scanning}<span class="spinner"></span> Scanning…{:else}{scanned ? 'Scan again' : network ? 'Scan network' : 'Scan for devices'}{/if}
        </button>
        <span class="muted">
            {#if scanning}
                {network ? `${adapter} --discover on ${host}` : `looking for devices on ${host}`}
            {:else if scanned}
                {devices.length === 0 ? 'nothing answered' : `${devices.length} device${devices.length === 1 ? '' : 's'} found`}
            {:else}
                asks <span class="mono">{adapter} --discover</span> on {host} and fills in <span class="mono">{property}</span>
            {/if}
        </span>
        {#if network}
            <button class="link" onclick={() => (advanced = !advanced)}>{advanced ? '− ' : '+ '}device on another network?</button>
        {/if}
    </div>

    {#if advanced && network}
        <div class="adv">
            <label>
                Address or range
                <input type="text" bind:value={address} spellcheck="false" placeholder="172.16.24.145 or 172.16.20.0/24" />
            </label>
            <label>
                Timeout (s)
                <input type="number" bind:value={timeout} min="1" max="120" />
            </label>
            <span class="muted">Broadcast and multicast stop at the router — name the device, or a range to sweep for it.</span>
        </div>
    {/if}

    {#if error}<div class="err-box">{error}</div>{/if}

    {#if scanned && devices.length === 0 && !scanning}
        <div class="muted empty">
            Nothing answered on {host}.
            {#if network}Devices behind a router need their address given above.{:else}Is the stick plugged into that host?{/if}
            Filling in <span class="mono">{property}</span> by hand works as before.
        </div>
    {/if}

    {#if devices.length > 0}
        <ul class="results">
            {#each devices as d (d.value)}
                {@const chosen = valueOf(d)}
                <li>
                    <button class="row" class:active={selected === chosen} class:used={!!d.usedBy} onclick={() => pick(d)}>
                        <span class="head">
                            <span class="name">{label(d)}</span>
                            {#if d.usedBy}<span class="badge">already configured as {d.usedBy}</span>{/if}
                            {#if selected === chosen}<span class="badge sel">selected</span>{/if}
                        </span>
                        <span class="sub mono">{chosen}</span>
                        <span class="meta">
                            {#if d.device && d.device !== d.value}<span title="the device node the stable name points at right now">{d.device}</span>{/if}
                            {#if d.model && d.model !== label(d)}<span>{d.model}</span>{/if}
                            {#if d.type && d.type !== label(d)}<span>{d.type}</span>{/if}
                            {#if d.serial}<span>serial {d.serial}</span>{/if}
                            {#each openServices(d) as s}<span class="svc">{s}</span>{/each}
                            {#if d.sources.length}<span class="src">({d.sources.join('+')})</span>{/if}
                        </span>
                    </button>
                    {#if formsOf(d).length}
                        <div class="forms" role="group" aria-label="what to configure">
                            {#each formsOf(d) as f (f.form)}
                                <button class="form" class:on={formOf(d) === f.form && selected === chosen} title={f.title} onclick={() => pick(d, f.form)}>{f.label}</button>
                            {/each}
                            {#if formOf(d) === 'hostname' && selected === chosen}
                                <span class="warn-hint">the short name only resolves where the search domain matches</span>
                            {/if}
                        </div>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
    .scan { display: flex; flex-direction: column; gap: 6px; }
    .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .muted { color: var(--fg-muted); font-size: 11px; }
    .mono { font-family: var(--font-mono, monospace); }
    .empty { line-height: 1.5; }

    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    button.ghost:disabled { opacity: 0.5; cursor: default; }
    button.link { background: none; border: none; color: var(--accent); font-size: 11px; cursor: pointer; padding: 0; margin-left: auto; }

    .adv { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; padding: 6px 8px; border: 1px solid var(--border); border-radius: 3px; }
    .adv label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--fg-muted); }
    .adv input { background: var(--bg-input, var(--bg-app)); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; padding: 3px 6px; font-size: 12px; }
    .adv input[type='text'] { width: 240px; }
    .adv input[type='number'] { width: 70px; }

    .results { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-width: 640px; }
    button.row {
        width: 100%; text-align: left; display: flex; flex-direction: column; gap: 2px;
        background: var(--bg-app); border: 1px solid var(--border); border-radius: 3px;
        padding: 5px 8px; cursor: pointer; color: var(--fg); font-size: 12px;
    }
    button.row:hover { border-color: var(--fg-muted); }
    button.row.active { border-color: var(--accent); background: rgba(86,156,214,0.08); }
    button.row.used { opacity: 0.65; }
    .head { display: flex; align-items: center; gap: 6px; }
    .name { font-weight: 600; }
    .sub { font-size: 11px; color: var(--accent); }
    .meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: var(--fg-muted); }
    .svc { background: rgba(39,174,96,0.15); color: #27ae60; border-radius: 8px; padding: 0 6px; }
    .src { font-style: italic; }
    .badge { background: rgba(127,140,141,0.2); color: var(--fg-muted); border-radius: 8px; padding: 0 6px; font-size: 10px; font-weight: 600; }
    .badge.sel { background: rgba(86,156,214,0.15); color: var(--accent); }

    /* what to configure: the address, the short name or the fqdn — all three verified by the
       host that ran the scan, and only the ones that round-trip are offered at all */
    .forms { display: flex; align-items: center; gap: 4px; padding: 3px 0 0 8px; }
    button.form {
        background: none; border: 1px solid var(--border); color: var(--fg-muted);
        border-radius: 3px; font-size: 10px; padding: 0 6px; cursor: pointer; line-height: 16px;
    }
    button.form:hover { color: var(--fg); border-color: var(--fg-muted); }
    button.form.on { background: rgba(86,156,214,0.15); border-color: var(--accent); color: var(--accent); }
    .warn-hint { font-size: 10px; color: #d4ac0d; }
    .err-box { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.35); border-radius: 3px; color: #e88; padding: 6px 10px; font-size: 11px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner { display: inline-block; width: 11px; height: 11px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
</style>
