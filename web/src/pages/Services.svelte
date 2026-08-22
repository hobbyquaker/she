<script lang="ts">
    import Instances from './services/Instances.svelte';
    import Hosts from './services/Hosts.svelte';
    import AddInstance from './services/AddInstance.svelte';

    type Status = 'none' | 'ok' | 'warn' | 'err';
    let { onstatus }: { onstatus?: (status: Status, title: string) => void } = $props();

    type SubTab = 'instances' | 'hosts' | 'add';
    const TAB_KEY = 'she-services-tab';
    const stored = localStorage.getItem(TAB_KEY) as SubTab | null;
    let tab = $state<SubTab>(stored === 'hosts' || stored === 'add' ? stored : 'instances');
    $effect(() => { localStorage.setItem(TAB_KEY, tab); });

    // bump to make the Instances tab reload after host-side changes (update, install)
    let generation = $state(0);
</script>

<div class="services-page">
    <div class="sub-nav">
        <button class:active={tab === 'instances'} onclick={() => (tab = 'instances')}>Instances</button>
        <button class:active={tab === 'hosts'} onclick={() => (tab = 'hosts')}>Hosts</button>
        <button class:active={tab === 'add'} onclick={() => (tab = 'add')}>Add instance</button>
    </div>

    {#if tab === 'instances'}
        <Instances {onstatus} {generation} />
    {:else if tab === 'hosts'}
        <Hosts onchanged={() => generation++} />
    {:else}
        <AddInstance oninstalled={() => { generation++; }} />
    {/if}
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
</style>
