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
    let latestVersion = $state<string | null>(null);

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

        // Check for newer version on npm (best-effort, silent on failure)
        fetch('https://registry.npmjs.org/smart-home-engine/latest')
            .then(r => r.json())
            .then((d: { version?: string }) => { if (d.version && d.version !== __APP_VERSION__) latestVersion = d.version; })
            .catch(() => {});

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
        <button class:active={page === 'packages'} onclick={() => navigate('packages')}>
            <!-- npm logo reproduced in line-art: outer box + n, p, m letter strokes -->
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
                <rect x="0.75" y="0.75" width="14.5" height="14.5" rx="1"/>
                <!-- n -->
                <path d="M2,11 V5 H5 V11"/>
                <!-- p (with descender) -->
                <path d="M6,12 V5 H9 V8 H6"/>
                <!-- m (wide, two arches via center divider) -->
                <path d="M10,11 V5 H15 V11"/>
                <line x1="12.5" y1="5" x2="12.5" y2="11"/>
            </svg>
            Packages
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

        <!-- right side: version · github · settings -->
        <div class="nav-spacer"></div>
        <div class="nav-right">
            <span class="version">
                v{__APP_VERSION__}
                {#if latestVersion}
                    <a class="update-badge" href="https://www.npmjs.com/package/smart-home-engine" target="_blank" rel="noopener" title="Update available: v{latestVersion}">↑ {latestVersion}</a>
                {/if}
            </span>
            <a class="nav-icon" href="https://github.com/hobbyquaker/she" target="_blank" rel="noopener" title="GitHub">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                </svg>
            </a>
            <button class="nav-settings" class:active={page === 'config'} onclick={() => navigate('config')} title="Settings">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                    <circle cx="12" cy="12" r="3"/>
                </svg>
            </button>
        </div>
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
        background: var(--bg-panel);
        border-bottom: 1px solid var(--border-sub);
        flex-shrink: 0;
    }
    .brand {
        font-weight: 700;
        font-size: 14px;
        letter-spacing: 2px;
        margin-right: 12px;
        color: var(--fg-brand);
    }
    button {
        background: none;
        border: none;
        color: var(--fg);
        cursor: pointer;
        padding: 6px 12px;
        border-radius: 3px;
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 5px;
    }
    button:hover { background: var(--bg-hover); }
    button.active { background: var(--bg-active); color: var(--fg-text); }

    .nav-spacer { flex: 1; }

    .nav-right {
        display: flex;
        align-items: center;
        gap: 2px;
    }

    .version {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 11px;
        color: var(--fg-dim);
        padding: 0 6px;
        white-space: nowrap;
    }

    .update-badge {
        background: var(--accent);
        color: #fff;
        font-size: 10px;
        padding: 1px 5px;
        border-radius: 3px;
        text-decoration: none;
        line-height: 1.6;
    }
    .update-badge:hover { background: var(--accent-hov); }

    .nav-icon {
        display: flex;
        align-items: center;
        padding: 6px 8px;
        color: var(--fg-muted);
        border-radius: 3px;
        text-decoration: none;
        line-height: 0;
    }
    .nav-icon:hover { background: var(--bg-hover); color: var(--fg); }

    .nav-settings {
        background: none;
        border: none;
        color: var(--fg);
        cursor: pointer;
        padding: 6px 8px;
        border-radius: 3px;
        display: flex;
        align-items: center;
    }
    .nav-settings:hover { background: var(--bg-hover); }
    .nav-settings.active { background: var(--bg-active); color: var(--fg-text); }

    main { flex: 1; min-height: 0; }
</style>
