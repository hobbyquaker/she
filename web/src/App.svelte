<script lang="ts">
    import Scripts from './pages/Scripts.svelte';
    import Config from './pages/Config.svelte';
    import Logs from './pages/Logs.svelte';
    import DB from './pages/DB.svelte';

    type Page = 'scripts' | 'config' | 'logs' | 'db';
    let page = $state<Page>('scripts');
</script>

<div class="shell">
    <nav>
        <span class="brand">she</span>
        <button class:active={page === 'scripts'} onclick={() => (page = 'scripts')}>Scripts</button>
        <button class:active={page === 'config'} onclick={() => (page = 'config')}>Config</button>
        <button class:active={page === 'logs'} onclick={() => (page = 'logs')}>Logs</button>
        <button class:active={page === 'db'} onclick={() => (page = 'db')}>DB</button>
    </nav>

    <main>
        {#if page === 'scripts'}
            <Scripts />
        {:else if page === 'config'}
            <Config />
        {:else if page === 'db'}
            <DB />
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
    }
    button:hover { background: #2a2d2e; }
    button.active { background: #37373d; color: #fff; }
    main { flex: 1; min-height: 0; }
</style>
