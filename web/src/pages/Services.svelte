<script lang="ts">
    import { untrack } from 'svelte';
    import Instances from './services/Instances.svelte';
    import Hosts from './services/Hosts.svelte';
    import HostsConfig from './services/HostsConfig.svelte';

    type Status = 'none' | 'ok' | 'warn' | 'err';
    let {
        onstatus,
        active = false,
        sub = null,
        onsub,
    }: { onstatus?: (status: Status, title: string) => void; active?: boolean; sub?: string | null; onsub?: (s: string) => void } = $props();

    type SubTab = 'instances' | 'hosts' | 'hostsconf';
    const TAB_KEY = 'she-services-tab';
    const stored = localStorage.getItem(TAB_KEY); // may still hold the retired 'catalog' tab
    let tab = $state<SubTab>(stored === 'hosts' || stored === 'catalog' ? 'hosts' : stored === 'hostsconf' ? 'hostsconf' : 'instances');
    $effect(() => { localStorage.setItem(TAB_KEY, tab); });

    // ── URL: #/adapters/<slug> ─────────────────────────────────────────────────
    // the slugs are what the tabs are called on screen, not their internal names
    const SLUGS: Record<SubTab, string> = { instances: 'instances', hosts: 'installations', hostsconf: 'hosts' };
    const fromSlug = (slug: string | null) => (Object.keys(SLUGS) as SubTab[]).find((t) => SLUGS[t] === slug) ?? null;
    // Writing `tab` from an effect makes that effect re-run whenever the tab changes — untrack
    // does not help, it tracks writes too. Without the guard a click would re-enter here with
    // the hash still on the old slug and put the tab straight back, which is exactly what
    // happened. seenSub is a plain variable: it only remembers what the url last said, so the
    // effect steers the tab when the url changed and stays out of the way when the user clicked.
    let seenSub: string | null | undefined = undefined;
    $effect(() => {
        if (sub === seenSub) return;
        seenSub = sub;
        const t = fromSlug(sub);
        if (t) untrack(() => { if (t !== tab) tab = t; });
    });
    // reported whenever this page is the one on screen, so the hash always names the open tab
    $effect(() => { if (active) onsub?.(SLUGS[tab]); });

    // bump to make the Instances tab reload after host-side changes (update, install)
    let generation = $state(0);

    // pending updates, reported by the tabs that know about them: adapter packages on
    // Installations, the she-servicectl helper on Hosts. Each puts a yellow dot on its own
    // sub-tab, and together they light the Adapters dot in the main nav.
    let adapterUpdates = $state(0);
    let helperUpdates = $state(0);
    let nodeUpdates = $state(0);
    let instStatus = $state<Status>('none');
    let instTitle = $state('');
    let updateTitle = $derived(
        [
            adapterUpdates > 0 ? `${adapterUpdates} adapter update${adapterUpdates === 1 ? '' : 's'} available` : '',
            helperUpdates > 0 ? `${helperUpdates} host${helperUpdates === 1 ? '' : 's'} with an outdated helper` : '',
            nodeUpdates > 0 ? `${nodeUpdates} host${nodeUpdates === 1 ? '' : 's'} with a newer Node.js` : '',
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
            {#if helperUpdates + nodeUpdates > 0}
                <span class="tab-dot" title={[
                    helperUpdates > 0 ? `${helperUpdates} host${helperUpdates === 1 ? '' : 's'} running an outdated she-servicectl` : '',
                    nodeUpdates > 0 ? `${nodeUpdates} host${nodeUpdates === 1 ? '' : 's'} with a newer Node.js available` : '',
                ].filter(Boolean).join(' · ')}></span>
            {/if}
        </button>
    </div>

    <!-- tabs stay mounted: switching must not re-run the host listing -->
    <div class="tab-wrap" class:hidden={tab !== 'instances'}><Instances onstatus={(s, t) => { instStatus = s; instTitle = t; }} {generation} /></div>
    <div class="tab-wrap" class:hidden={tab !== 'hosts'}><Hosts onchanged={() => generation++} onupdates={(n) => (adapterUpdates = n)} /></div>
    <div class="tab-wrap" class:hidden={tab !== 'hostsconf'}><HostsConfig onchanged={() => generation++} onupdates={(n) => (helperUpdates = n)} onnodeupdates={(n) => (nodeUpdates = n)} /></div>
</div>

<style>
    .services-page {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    /* menubar tabs — the sub-navigation look shared by the Broker, MQTT, Adapters and DB pages */
    .sub-nav {
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 6px 10px 0;
        border-bottom: 1px solid var(--border-sub);
        flex-shrink: 0;
    }

    .sub-nav button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        color: var(--fg-muted);
        cursor: pointer;
        font-size: 13px;
        padding: 5px 12px 6px;
        margin-bottom: -1px;
    }

    .sub-nav button:hover { color: var(--fg); }

    .sub-nav button.active {
        color: var(--fg-text);
        border-bottom-color: var(--fg-brand);
    }

    /* same yellow as the main nav's update dots */
    .tab-dot { width: 7px; height: 7px; border-radius: 50%; background: #f90; flex-shrink: 0; }

    .tab-wrap { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
    .tab-wrap.hidden { display: none; }
</style>
