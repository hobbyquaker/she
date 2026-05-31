<script lang="ts">
    import { onMount } from 'svelte';
    import Scripts from './pages/Scripts.svelte';
    import Config from './pages/Config.svelte';
    import Logs from './pages/Logs.svelte';
    import DB from './pages/DB.svelte';
    import Matter from './pages/Matter.svelte';

    type Page = 'scripts' | 'config' | 'logs' | 'db' | 'matter';
    const validPages: Page[] = ['scripts', 'config', 'logs', 'db', 'matter'];

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
        <button class:active={page === 'matter'} onclick={() => navigate('matter')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="4" y="4" width="8" height="8" rx="1"/>
                <line x1="7" y1="4" x2="7" y2="2"/><line x1="9" y1="4" x2="9" y2="2"/>
                <line x1="7" y1="12" x2="7" y2="14"/><line x1="9" y1="12" x2="9" y2="14"/>
                <line x1="4" y1="7" x2="2" y2="7"/><line x1="4" y1="9" x2="2" y2="9"/>
                <line x1="12" y1="7" x2="14" y2="7"/><line x1="12" y1="9" x2="14" y2="9"/>
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
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="8" cy="8" r="2.5"/>
                <line x1="8" y1="1" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="15"/>
                <line x1="1" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="15" y2="8"/>
                <line x1="3.1" y1="3.1" x2="4.5" y2="4.5"/><line x1="11.5" y1="11.5" x2="12.9" y2="12.9"/>
                <line x1="12.9" y1="3.1" x2="11.5" y2="4.5"/><line x1="4.5" y1="11.5" x2="3.1" y2="12.9"/>
            </svg>
            Config
        </button>
    </nav>

    <main>
        {#if page === 'scripts'}
            <Scripts />
        {:else if page === 'config'}
            <Config />
        {:else if page === 'db'}
            <DB />
        {:else if page === 'matter'}
            <Matter />
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
