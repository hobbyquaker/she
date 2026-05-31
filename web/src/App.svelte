<script lang="ts">
    import { onMount } from 'svelte';
    import Scripts from './pages/Scripts.svelte';
    import Config from './pages/Config.svelte';
    import Logs from './pages/Logs.svelte';
    import DB from './pages/DB.svelte';
    import Matter from './pages/Matter.svelte';
    import MQTT from './pages/MQTT.svelte';
    import Packages from './pages/Packages.svelte';

    type Page = 'scripts' | 'mqtt' | 'matter' | 'db' | 'logs' | 'config' | 'packages';
    const validPages: Page[] = ['scripts', 'mqtt', 'matter', 'db', 'logs', 'config', 'packages'];

    function pageFromHash(): Page {
        const hash = location.hash.slice(1) as Page;
        return validPages.includes(hash) ? hash : 'scripts';
    }

    let page = $state<Page>(pageFromHash());

    function navigate(p: Page) {
        page = p;
        location.hash = p;
    }

    onMount(() => {
        // Set hash on initial load if missing
        if (!location.hash) location.hash = page;
        const onHashChange = () => {
            page = pageFromHash();
        };
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
    });
</script>

<div class="shell">
    <nav>
        <span class="brand">she</span>
        <button class:active={page === 'scripts'} onclick={() => navigate('scripts')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="5,3 1,8 5,13"/>
                <polyline points="11,3 15,8 11,13"/>
            </svg>
            Scripts
        </button>
        <button class:active={page === 'mqtt'} onclick={() => navigate('mqtt')}>
            <!-- MQTT logo: square badge with three arc-band cutouts from bottom-left corner (mqtt.org geometry) -->
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="none" style="vertical-align: middle">
                <path fill-rule="evenodd" d="M2,0 H14 A2,2 0 0,1 16,2 V14 A2,2 0 0,1 14,16 H0 V2 A2,2 0 0,1 2,0 Z M0,16 L0,12 A4,4 0 0,1 4,16 Z M0,10.5 A5.5,5.5 0 0,1 5.5,16 L9,16 A9,9 0 0,0 0,7 Z M0,5.5 A10.5,10.5 0 0,1 10.5,16 L13.5,16 A13.5,13.5 0 0,0 0,2.5 Z"/>
            </svg>
            MQTT
        </button>
        <button class:active={page === 'matter'} onclick={() => navigate('matter')}>
            <!-- Matter logo: three arrows converging to a central point -->
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M8,2 L8,7"/>
                <path d="M6,5 L8,7.5 L10,5"/>
                <path d="M2.5,14 L6,10"/>
                <path d="M6.2,12.8 L6,10 L3.2,10.2"/>
                <path d="M13.5,14 L10,10"/>
                <path d="M9.8,12.8 L10,10 L12.8,10.2"/>
            </svg>
            Matter
        </button>
        <button class:active={page === 'db'} onclick={() => navigate('db')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <ellipse cx="8" cy="4.5" rx="5" ry="1.8"/>
                <path d="M3,4.5 v7 a5,1.8 0,0,0 10,0 v-7"/>
                <path d="M3,8 a5,1.8 0,0,0 10,0"/>
            </svg>
            DB
        </button>
        <button class:active={page === 'logs'} onclick={() => navigate('logs')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <line x1="2" y1="5" x2="14" y2="5"/>
                <line x1="2" y1="8" x2="14" y2="8"/>
                <line x1="2" y1="11" x2="9" y2="11"/>
            </svg>
            Logs
        </button>
        <button class:active={page === 'config'} onclick={() => navigate('config')}>
            <!-- Gear / settings icon (Lucide settings path, 24x24 viewBox) -->
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                <circle cx="12" cy="12" r="3"/>
            </svg>
            Config
        </button>
        <button class:active={page === 'packages'} onclick={() => navigate('packages')}>
            <!-- Box / package icon -->
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="0.5,4 8,8 15.5,4"/>
                <polyline points="8,8 8,15.5"/>
                <polygon points="8,0.5 15.5,4 8,7.5 0.5,4"/>
            </svg>
            Packages
        </button>
    </nav>

    <main>
        {#if page === 'scripts'}
            <Scripts />
        {:else if page === 'mqtt'}
            <MQTT />
        {:else if page === 'matter'}
            <Matter />
        {:else if page === 'db'}
            <DB />
        {:else if page === 'config'}
            <Config />
        {:else if page === 'packages'}
            <Packages />
        {:else}
            <Logs />
        {/if}
    </main>
</div>

<style>
    .shell {
        display: flex;
        flex-direction: column;
        height: 100vh;
    }
    nav {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 0 12px;
        height: 40px;
        background: #252526;
        border-bottom: 1px solid #333;
        flex-shrink: 0;
    }
    .brand {
        font-weight: 700;
        font-size: 14px;
        letter-spacing: 2px;
        margin-right: 12px;
        color: #569cd6;
    }
    button {
        background: none;
        border: none;
        color: #cccccc;
        cursor: pointer;
        padding: 6px 12px;
        border-radius: 3px;
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 5px;
    }
    button:hover { background: #2a2d2e; }
    button.active { background: #37373d; color: #fff; }
    main { flex: 1; min-height: 0; }
</style>
