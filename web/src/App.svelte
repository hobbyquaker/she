<script lang="ts">
    import { onMount } from 'svelte';
    import Scripts from './pages/Scripts.svelte';
    import Config from './pages/Config.svelte';
    import Logs from './pages/Logs.svelte';
    import DB from './pages/DB.svelte';
    import Matter from './pages/Matter.svelte';
    import MQTT from './pages/MQTT.svelte';
    import Packages from './pages/Packages.svelte';
    import { getAuthMode, login, logout, onUnauthorized, type AuthMode } from './lib/api.js';

    type Page = 'scripts' | 'mqtt' | 'matter' | 'db' | 'logs' | 'config' | 'packages';
    const validPages: Page[] = ['scripts', 'mqtt', 'matter', 'db', 'logs', 'config', 'packages'];

    function pageFromHash(): Page {
        const hash = location.hash.slice(1) as Page;
        return validPages.includes(hash) ? hash : 'scripts';
    }

    let page = $state<Page>(pageFromHash());
    let latestVersion = $state<string | null>(null);

    // ── Auth ────────────────────────────────────────────────────────────────
    let authMode = $state<AuthMode>('none');
    let showLogin = $state(false);
    let loginPassword = $state('');
    let loginError = $state('');
    let loginLoading = $state(false);

    onUnauthorized(() => { showLogin = true; });

    async function handleLogin() {
        loginError = '';
        loginLoading = true;
        try {
            await login(loginPassword);
            loginPassword = '';
            showLogin = false;
        } catch (e: any) {
            loginError = e.message ?? 'Login failed';
        } finally {
            loginLoading = false;
        }
    }

    async function handleLogout() {
        await logout();
        showLogin = true;
    }

    function navigate(p: Page) {
        page = p;
        location.hash = p;
    }

    onMount(async () => {
        // Set hash on initial load if missing
        if (!location.hash) location.hash = page;
        const onHashChange = () => {
            page = pageFromHash();
        };
        window.addEventListener('hashchange', onHashChange);

        // Detect auth mode — show login overlay immediately if in password mode
        try {
            authMode = await getAuthMode();
            if (authMode === 'password') {
                // Probe a protected endpoint to check if we already have a valid session
                const probe = await fetch('/she/scripts');
                if (probe.status === 401) showLogin = true;
            }
        } catch {
            // best-effort
        }

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
            {#if authMode === 'password'}
            <button class="nav-logout" onclick={handleLogout} title="Logout">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                    <polyline points="16 17 21 12 16 7"/>
                    <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
            </button>
            {/if}
        </div>
    </nav>

    <main>
        <div class="page-wrap" class:hidden={page !== 'scripts'}><Scripts active={page === 'scripts'} /></div>
        <div class="page-wrap" class:hidden={page !== 'packages'}><Packages /></div>
        <div class="page-wrap" class:hidden={page !== 'mqtt'}><MQTT /></div>
        <div class="page-wrap" class:hidden={page !== 'matter'}><Matter /></div>
        <div class="page-wrap" class:hidden={page !== 'db'}><DB /></div>
        <div class="page-wrap" class:hidden={page !== 'config'}><Config /></div>
        <div class="page-wrap" class:hidden={page !== 'logs'}><Logs /></div>
    </main>

    {#if showLogin}
    <div class="login-overlay">
        <form class="login-box" onsubmit={(e) => { e.preventDefault(); handleLogin(); }}>
            <div class="login-brand">she</div>
            <h2>Sign in</h2>
            <div class="login-field">
                <label for="she-password">Password</label>
                <input
                    id="she-password"
                    type="password"
                    bind:value={loginPassword}
                    placeholder="Enter password"
                    autocomplete="current-password"
                    disabled={loginLoading}
                />
            </div>
            {#if loginError}
            <div class="login-error">{loginError}</div>
            {/if}
            <button type="submit" class="login-btn" disabled={loginLoading || !loginPassword}>
                {loginLoading ? 'Signing in…' : 'Sign in'}
            </button>
        </form>
    </div>
    {/if}
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

    .nav-logout {
        background: none;
        border: none;
        color: var(--fg-muted);
        cursor: pointer;
        padding: 6px 8px;
        border-radius: 3px;
        display: flex;
        align-items: center;
    }
    .nav-logout:hover { background: var(--bg-hover); color: var(--fg); }

    main { flex: 1; min-height: 0; position: relative; }

    .page-wrap { position: absolute; inset: 0; overflow: hidden; }
    .page-wrap.hidden { display: none; }

    /* ── Login overlay ─────────────────────────────────────────────── */
    .login-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
    }
    .login-box {
        background: var(--bg-panel);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 32px 36px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-width: 280px;
    }
    .login-brand {
        font-weight: 700;
        font-size: 22px;
        letter-spacing: 3px;
        color: var(--fg-brand);
        text-align: center;
    }
    .login-box h2 {
        margin: 0;
        font-size: 15px;
        font-weight: 500;
        text-align: center;
        color: var(--fg);
    }
    .login-field {
        display: flex;
        flex-direction: column;
        gap: 5px;
    }
    .login-field label {
        font-size: 12px;
        color: var(--fg-dim);
    }
    .login-field input {
        padding: 7px 10px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 4px;
        color: var(--fg);
        font-size: 13px;
    }
    .login-field input:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
    .login-error {
        font-size: 12px;
        color: var(--fg-error, #e06c75);
        text-align: center;
    }
    .login-btn {
        padding: 8px;
        background: var(--accent);
        color: #fff;
        border: none;
        border-radius: 4px;
        font-size: 13px;
        cursor: pointer;
        justify-content: center;
    }
    .login-btn:hover:not(:disabled) { background: var(--accent-hov); }
    .login-btn:disabled { opacity: 0.5; cursor: default; }
</style>
