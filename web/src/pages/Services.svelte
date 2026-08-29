<script lang="ts">
    import Instances from './services/Instances.svelte';
    import Hosts from './services/Hosts.svelte';
    import HostsConfig from './services/HostsConfig.svelte';

    type Status = 'none' | 'ok' | 'warn' | 'err';
    let { onstatus }: { onstatus?: (status: Status, title: string) => void } = $props();

    type SubTab = 'instances' | 'hosts' | 'hostsconf';
    const TAB_KEY = 'she-services-tab';
    const stored = localStorage.getItem(TAB_KEY); // may still hold the retired 'catalog' tab
    let tab = $state<SubTab>(stored === 'hosts' || stored === 'catalog' ? 'hosts' : stored === 'hostsconf' ? 'hostsconf' : 'instances');
    $effect(() => { localStorage.setItem(TAB_KEY, tab); });

    // bump to make the Instances tab reload after host-side changes (update, install)
    let generation = $state(0);

    // pending updates, reported by the tabs that know about them: adapter packages on
    // Installations, the she-servicectl helper on Hosts. Each puts a yellow dot on its own
    // sub-tab, and together they light the Adapters dot in the main nav.
    let adapterUpdates = $state(0);
    let helperUpdates = $state(0);
    let instStatus = $state<Status>('none');
    let instTitle = $state('');
    let updateTitle = $derived(
        [
            adapterUpdates > 0 ? `${adapterUpdates} adapter update${adapterUpdates === 1 ? '' : 's'} available` : '',
            helperUpdates > 0 ? `${helperUpdates} host${helperUpdates === 1 ? '' : 's'} with an outdated helper` : '',
        ].filter(Boolean).join(' · '),
    );
    $effect(() => {
        if (updateTitle) onstatus?.('warn', updateTitle);
        else onstatus?.(instStatus, instTitle);
    });
</script>

<div class="services-page">
    <div class="sub-nav">
        <button class:active={tab === 'instances'} onclick={() => (tab = 'instances')}>Instances</button>
        <button class:active={tab === 'hosts'} onclick={() => (tab = 'hosts')}>
            Installations
            {#if adapterUpdates > 0}<span class="tab-dot" title="{adapterUpdates} adapter update{adapterUpdates === 1 ? '' : 's'} available"></span>{/if}
        </button>
        <button class:active={tab === 'hostsconf'} onclick={() => (tab = 'hostsconf')}>
            Hosts
            {#if helperUpdates > 0}<span class="tab-dot" title="{helperUpdates} host{helperUpdates === 1 ? '' : 's'} running an outdated she-servicectl"></span>{/if}
        </button>
    </div>

    <!-- tabs stay mounted: switching must not re-run the host listing -->
    <div class="tab-wrap" class:hidden={tab !== 'instances'}><Instances onstatus={(s, t) => { instStatus = s; instTitle = t; }} {generation} /></div>
    <div class="tab-wrap" class:hidden={tab !== 'hosts'}><Hosts onchanged={() => generation++} onupdates={(n) => (adapterUpdates = n)} /></div>
    <div class="tab-wrap" class:hidden={tab !== 'hostsconf'}><HostsConfig onchanged={() => generation++} onupdates={(n) => (helperUpdates = n)} /></div>
</div>

<style>
    .services-page {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    /* same look as the DB page's Documents / Views panel tabs */
    .sub-nav {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--border-sub, var(--border));
        flex-shrink: 0;
    }

    .sub-nav button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: none;
        border: 1px solid var(--border);
        color: var(--fg);
        padding: 3px 12px;
        border-radius: 4px;
        font-size: 13px;
        cursor: pointer;
    }

    .sub-nav button.active {
        background: var(--bg-active);
        color: var(--fg-text);
    }

    /* same yellow as the main nav's update dots */
    .tab-dot { width: 7px; height: 7px; border-radius: 50%; background: #f90; flex-shrink: 0; }

    .tab-wrap { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
    .tab-wrap.hidden { display: none; }
</style>
