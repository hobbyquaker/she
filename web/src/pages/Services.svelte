<script lang="ts">
    import Instances from './services/Instances.svelte';
    import Hosts from './services/Hosts.svelte';
    import type { AddPreset } from './services/AddInstance.svelte';
    import Catalog from './services/Catalog.svelte';

    type Status = 'none' | 'ok' | 'warn' | 'err';
    let { onstatus }: { onstatus?: (status: Status, title: string) => void } = $props();

    type SubTab = 'instances' | 'hosts' | 'catalog';
    const TAB_KEY = 'she-services-tab';
    const stored = localStorage.getItem(TAB_KEY) as SubTab | null;
    let tab = $state<SubTab>(stored === 'hosts' || stored === 'catalog' ? stored : 'instances');
    // Hosts tab "+ add instance" / Catalog install → open the add panel in the Instances tab with host + adapter preselected
    let addRequest = $state<AddPreset | null>(null);
    let addN = 0;
    function requestAdd(host: string, adapter: string) {
        addRequest = { host, adapter, n: ++addN };
        tab = 'instances';
    }
    $effect(() => { localStorage.setItem(TAB_KEY, tab); });

    // bump to make the Instances tab reload after host-side changes (update, install)
    let generation = $state(0);
</script>

<div class="services-page">
    <div class="sub-nav">
        <button class:active={tab === 'instances'} onclick={() => (tab = 'instances')}>Instances</button>
        <button class:active={tab === 'hosts'} onclick={() => (tab = 'hosts')}>Hosts</button>
        <button class:active={tab === 'catalog'} onclick={() => (tab = 'catalog')}>Catalog</button>
    </div>

    <!-- tabs stay mounted: switching must not re-run the host listing -->
    <div class="tab-wrap" class:hidden={tab !== 'instances'}><Instances {onstatus} {generation} {addRequest} /></div>
    <div class="tab-wrap" class:hidden={tab !== 'hosts'}><Hosts onchanged={() => generation++} onaddinstance={requestAdd} /></div>
    <div class="tab-wrap" class:hidden={tab !== 'catalog'}><Catalog oninstalled={(host, adapter) => { generation++; requestAdd(host, adapter); }} /></div>
</div>

<style>
    .services-page {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    /* same look as the Broker page's sub-tabs */
    .sub-nav {
        display: flex;
        gap: 2px;
        padding: 6px 10px 0;
        border-bottom: 1px solid var(--border, #333);
        flex-shrink: 0;
    }

    .sub-nav button {
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        color: var(--text-muted, #888);
        cursor: pointer;
        font-size: 13px;
        padding: 5px 12px 6px;
        margin-bottom: -1px;
    }

    .sub-nav button.active {
        color: var(--text, #eee);
        border-bottom-color: var(--accent, #569cd6);
    }

    .tab-wrap { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
    .tab-wrap.hidden { display: none; }
</style>
