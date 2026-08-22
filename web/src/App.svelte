<script lang="ts">
    import { onMount } from 'svelte';
    import Scripts from './pages/Scripts.svelte';
    import Config from './pages/Config.svelte';
    import Logs from './pages/Logs.svelte';
    import DB from './pages/DB.svelte';
    import Matter from './pages/Matter.svelte';
    import MQTT from './pages/MQTT.svelte';
    import Packages from './pages/Packages.svelte';
    import Security from './pages/Security.svelte';
    import Services from './pages/Services.svelte';
    import { getAuthMode, login, logout, onUnauthorized, getDaemonStatus, restartDaemon, updateDaemon, checkForUpdate, getConfig, getOutdatedDeps, type AuthMode, type AuthModeResponse, type DaemonStatus } from './lib/api.js';
    import ConfirmDialog from './lib/ConfirmDialog.svelte';
    import { subscribeWs, subscribeLog, getLogBuffer } from './lib/ws.js';

    type Page = 'scripts' | 'mqtt' | 'matter' | 'security' | 'services' | 'db' | 'logs' | 'config' | 'packages';
    const validPages: Page[] = ['scripts', 'mqtt', 'matter', 'security', 'services', 'db', 'logs', 'config', 'packages'];

    function pageFromHash(): Page {
        const hash = location.hash.slice(1) as Page;
        return validPages.includes(hash) ? hash : 'scripts';
    }

    let page = $state<Page>(pageFromHash());
    let stats = $state<DaemonStatus | null>(null);
    let statsOpen = $state(false);
    let versionOpen = $state(false);
    let checkingUpdate = $state(false);
    let updating = $state(false);

    // ── Auth ────────────────────────────────────────────────────────────────
    let authMode = $state<AuthMode>('none');    let proxyLogoutUrl = $state('');    let showLogin = $state(false);
    let loginPassword = $state('');
    let loginError = $state('');
    let loginLoading = $state(false);
    let authReady = $state(false); // true once initial auth probe is done

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
        if (authMode === 'proxy' && proxyLogoutUrl) {
            window.location.href = proxyLogoutUrl;
            return;
        }
        await logout();
        showLogin = true;
    }

    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean; alert?: boolean }): Promise<boolean> } = $state(null as any);

    let restarting = $state(false);
    let mqttConnecting = $state(false); // true while waiting for retained-state sentinel
    let mqttConnected  = $state(false); // true once broker is fully ready
    let mqttError      = $state(false); // true when broker configured but not connected

    // packages dot
    let pinnedPackages = $state<string[]>([]);
    let outdatedDepsCount = $state(0);
    let brokerEnabled = $state(false);
    let servicesEnabled = $state(false);

    // services dot — worst case over all adapter instances (updated by the Services page)
    let servicesStatus = $state<'none' | 'ok' | 'warn' | 'err'>('none');
    let servicesTitle = $state('');

    // matter dot
    let matterDevices = $state<{ nodeId: string; online?: boolean }[]>([]);
    const matterOnlineCount = $derived(matterDevices.filter(d => d.online).length);
    const matterStatus = $derived<'none' | 'all' | 'some' | 'offline'>(
        matterDevices.length === 0 ? 'none' :
        matterOnlineCount === matterDevices.length ? 'all' :
        matterOnlineCount > 0 ? 'some' : 'offline'
    );

    // logs dot
    let logHasError = $state(false);
    let logHasWarn  = $state(false);

    async function restart() {
        if (!(await dialog.show('Restart the she daemon? The page will reload after a moment.', { confirm: 'Restart' }))) return;
        restarting = true;
        let prevStartedAt: number | undefined;
        try {
            const s = await getDaemonStatus();
            prevStartedAt = s.startedAt;
        } catch { /* best-effort */ }
        try { await restartDaemon(); } catch { /* ignore — daemon is restarting */ }
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 250));
            try {
                const s = await getDaemonStatus();
                // Reload as soon as we see a new startedAt (or any response if we had no baseline)
                if (prevStartedAt === undefined || s.startedAt !== prevStartedAt) {
                    location.reload();
                    return;
                }
            } catch { /* daemon is down — keep polling */ }
        }
        location.reload();
    }

    async function handleCheckUpdate() {
        checkingUpdate = true;
        try {
            const res = await checkForUpdate();
            if (stats) stats = { ...stats, latestVersion: res.latestVersion ?? undefined };
        } catch { /* best-effort */ } finally {
            checkingUpdate = false;
        }
    }

    async function update() {
        if (!(await dialog.show(`Update to v${stats?.latestVersion}? The daemon will restart after the update completes.`, { confirm: 'Update' }))) return;
        versionOpen = false;
        updating = true;
        const prevStartedAt: number | undefined = stats?.startedAt;
        try { await updateDaemon(); } catch { /* ok — daemon will restart */ }
        // Poll until startedAt changes (new daemon instance) — mirrors restart() logic.
        // When the daemon goes down, switch the overlay to 'Restarting…'.
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            try {
                const s = await getDaemonStatus();
                if (prevStartedAt === undefined || s.startedAt !== prevStartedAt) {
                    location.reload(); return;
                }
            } catch {
                // Daemon is down — npm has finished and systemd is restarting the service.
                updating = false;
                restarting = true;
            }
        }
        location.reload(); // deadline hit — reload anyway
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
            const authResult = await getAuthMode();
            authMode = authResult.mode;
            proxyLogoutUrl = authResult.proxyLogoutUrl ?? '';
            if (authMode === 'password') {
                // Probe a protected endpoint to check if we already have a valid session
                const probe = await fetch('/she/scripts');
                if (probe.status === 401) showLogin = true;
            }
        } catch {
            // best-effort
        }
        authReady = true;

        // Poll daemon status every 5s and fetch cached outdated deps count
        async function pollStatus() {
            try { stats = await getDaemonStatus(); } catch { /* daemon may be restarting */ }
            try {
                const [o, cfg] = await Promise.all([getOutdatedDeps(), getConfig()]);
                pinnedPackages = Array.isArray(cfg.pinnedPackages) ? (cfg.pinnedPackages as string[]) : [];
                outdatedDepsCount = Object.keys(o).filter(n => !pinnedPackages.includes(n)).length;
                const wasBrokerEnabled = brokerEnabled;
                brokerEnabled = (cfg.broker as any)?.enabled === true;
                if (wasBrokerEnabled && !brokerEnabled && page === 'security') navigate('scripts');
                const wasServicesEnabled = servicesEnabled;
                servicesEnabled = (cfg.services as any)?.enabled === true;
                if (wasServicesEnabled && !servicesEnabled && page === 'services') navigate('scripts');
            } catch { /* best effort */ }
            // Redirect away from Matter page if Matter is not enabled at runtime
            if (!stats?.matterEnabled && page === 'matter') navigate('scripts');
            // Redirect away from DB page if sheDB is not enabled at runtime
            if (!stats?.dbEnabled && page === 'db') navigate('scripts');
        }
        pollStatus();
        const statusInterval = setInterval(pollStatus, 5000);

        // Subscribe to mqtt:status events — drives the MQTT tab dots
        const unsubMqttStatus = subscribeWs('mqtt:status', (msg) => {
            if (msg.connected === false) {
                mqttError = true; mqttConnecting = false; mqttConnected = false;
            } else {
                mqttError      = false;
                mqttConnecting = msg.ready === false;
                mqttConnected  = msg.ready === true;
            }
        });

        // Matter device list and status — drives the Matter tab dot
        const unsubMatterList = subscribeWs('matter:deviceList', (msg) => {
            if (!Array.isArray(msg.devices)) return;
            matterDevices = (msg.devices as any[]).map(d => ({ nodeId: String(d.nodeId), online: Boolean(d.online) }));
        });
        const unsubMatterStatus = subscribeWs('matter:deviceStatus', (msg) => {
            if (msg.nodeId === undefined) return;
            const nodeId = String(msg.nodeId);
            const online = Boolean(msg.online);
            matterDevices = matterDevices.map(d => d.nodeId === nodeId ? { ...d, online } : d);
        });

        // Log level indicator — drives the Logs tab dot
        const buf = getLogBuffer();
        logHasError = buf.some(e => e.level === 'error');
        logHasWarn  = !logHasError && buf.some(e => e.level === 'warn');
        const unsubLog = subscribeLog((entry) => {
            if (entry.level === 'error') { logHasError = true; logHasWarn = false; }
            else if (entry.level === 'warn' && !logHasError) logHasWarn = true;
        });

        return () => {
            window.removeEventListener('hashchange', onHashChange);
            clearInterval(statusInterval);
            unsubMqttStatus();
            unsubMatterList();
            unsubMatterStatus();
            unsubLog();
        };
    });
</script>

<svelte:document onclick={() => { if (statsOpen) statsOpen = false; if (versionOpen) versionOpen = false; }} />

{#if authReady && !showLogin}
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
            {#if outdatedDepsCount > 0}<span class="nav-dot nav-dot--warn" title="{outdatedDepsCount} package update{outdatedDepsCount === 1 ? '' : 's'} available"></span>{/if}
        </button>
        <button class:active={page === 'mqtt'} onclick={() => navigate('mqtt')}>
            <!-- MQTT logo: square badge with three arc-band cutouts from bottom-left corner (mqtt.org geometry) -->
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="none" style="vertical-align: middle">
                <path fill-rule="evenodd" d="M2,0 H14 A2,2 0 0,1 16,2 V14 A2,2 0 0,1 14,16 H0 V2 A2,2 0 0,1 2,0 Z M0,16 L0,12 A4,4 0 0,1 4,16 Z M0,10.5 A5.5,5.5 0 0,1 5.5,16 L9,16 A9,9 0 0,0 0,7 Z M0,5.5 A10.5,10.5 0 0,1 10.5,16 L13.5,16 A13.5,13.5 0 0,0 0,2.5 Z"/>
            </svg>
            MQTT
            {#if mqttError}<span class="nav-dot nav-dot--err" title="MQTT broker not connected"></span>
            {:else if mqttConnecting}<span class="nav-dot nav-dot--warn nav-dot--blink" title="Waiting for retained MQTT state"></span>
            {:else if mqttConnected}<span class="nav-dot nav-dot--ok" title="MQTT connected"></span>
            {/if}
        </button>
        {#if brokerEnabled}
        <button class:active={page === 'security'} onclick={() => navigate('security')}>
            <!-- Broker icon: antenna / broadcast -->
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="8" cy="10" r="2"/>
                <path d="M5,7 A4,4 0,0,1 11,7"/>
                <path d="M3,5 A6.5,6.5 0,0,1 13,5"/>
                <line x1="8" y1="12" x2="8" y2="15"/>
            </svg>
            Broker
        </button>
        {/if}
        {#if servicesEnabled}
        <button class:active={page === 'services'} onclick={() => navigate('services')}>
            <!-- Services icon: stacked boxes -->
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="2" width="12" height="4" rx="1"/>
                <rect x="2" y="10" width="12" height="4" rx="1"/>
                <circle cx="4.5" cy="4" r="0.6" fill="currentColor"/>
                <circle cx="4.5" cy="12" r="0.6" fill="currentColor"/>
            </svg>
            Services
            <!-- the dot box is always there so the button keeps its width when the status is unknown -->
            {#if servicesStatus === 'ok'}<span class="nav-dot nav-dot--ok" title={servicesTitle}></span>
            {:else if servicesStatus === 'warn'}<span class="nav-dot nav-dot--warn" title={servicesTitle}></span>
            {:else if servicesStatus === 'err'}<span class="nav-dot nav-dot--err" title={servicesTitle}></span>
            {:else}<span class="nav-dot nav-dot--none"></span>
            {/if}
        </button>
        {/if}
        {#if stats?.matterEnabled}
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
            {#if matterStatus === 'all'}<span class="nav-dot nav-dot--ok" title="All Matter devices online"></span>
            {:else if matterStatus === 'some'}<span class="nav-dot nav-dot--warn" title="Some Matter devices offline"></span>
            {:else if matterStatus === 'offline'}<span class="nav-dot nav-dot--err" title="No Matter devices online"></span>
            {/if}
        </button>
        {/if}
        {#if stats?.dbEnabled}
        <button class:active={page === 'db'} onclick={() => navigate('db')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <ellipse cx="8" cy="4.5" rx="5" ry="1.8"/>
                <path d="M3,4.5 v7 a5,1.8 0,0,0 10,0 v-7"/>
                <path d="M3,8 a5,1.8 0,0,0 10,0"/>
            </svg>
            DB
        </button>
        {/if}
        <button class:active={page === 'logs'} onclick={() => { navigate('logs'); logHasError = false; logHasWarn = false; }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <line x1="2" y1="5" x2="14" y2="5"/>
                <line x1="2" y1="8" x2="14" y2="8"/>
                <line x1="2" y1="11" x2="9" y2="11"/>
            </svg>
            Logs
            {#if logHasError}<span class="nav-dot nav-dot--err" title="Errors in recent logs"></span>
            {:else if logHasWarn}<span class="nav-dot nav-dot--warn" title="Warnings in recent logs"></span>
            {/if}
        </button>

        <!-- right side: github · version · stats · config -->
        <div class="nav-spacer"></div>

        <div class="nav-right">
            <a class="nav-icon" href="https://github.com/hobbyquaker/she" target="_blank" rel="noopener" title="GitHub">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                </svg>
            </a>

            <!-- Version button + popup -->
            <div class="version-wrap">
                <button class="version" onclick={(e) => { e.stopPropagation(); versionOpen = !versionOpen; statsOpen = false; }}>
                    v{__APP_VERSION__}
                    {#if stats?.latestVersion && !stats?.docker}<span class="update-dot" title="Update available"></span>{/if}
                </button>
                {#if versionOpen && !stats?.docker}
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <div class="version-popup" onclick={(e) => e.stopPropagation()}>
                    <dl>
                        <dt>Installed</dt><dd>v{__APP_VERSION__}</dd>
                        {#if stats?.latestVersion}
                        <dt>Latest</dt><dd style="color: #f90">v{stats.latestVersion}</dd>
                        {:else}
                        <dt>Latest</dt><dd>up to date</dd>
                        {/if}
                    </dl>
                    <div class="version-actions">
                        {#if stats?.latestVersion}
                        <button onclick={update}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 4 4 10 10 10"/><path d="M4 10A9 9 0 1 0 6.5 5"/></svg>
                            Update to v{stats.latestVersion}
                        </button>
                        {/if}
                        <button class="check-btn" onclick={handleCheckUpdate} disabled={checkingUpdate} title="Check for updates now">
                            <svg class:spinning={checkingUpdate} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 4 4 10 10 10"/><path d="M4 10A9 9 0 1 0 6.5 5"/></svg>
                            {checkingUpdate ? 'Checking…' : 'Check for updates'}
                        </button>
                    </div>
                </div>
                {/if}
            </div>

            <!-- Stats popup trigger -->
            <div class="stats-wrap">
                <button class="nav-icon" onclick={(e) => { e.stopPropagation(); statsOpen = !statsOpen; versionOpen = false; }} title="Daemon status">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="20" x2="18" y2="10"/>
                        <line x1="12" y1="20" x2="12" y2="4"/>
                        <line x1="6" y1="20" x2="6" y2="14"/>
                    </svg>
                </button>
                {#if statsOpen}
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <div class="stats-popup" onclick={(e) => e.stopPropagation()}>
                    {#if stats}
                    <dl>
                        {#if stats.startedAt}
                        {@const uptimeSec = Math.floor((Date.now() - stats.startedAt) / 1000)}
                        {@const d = Math.floor(uptimeSec / 86400)}
                        {@const h = Math.floor((uptimeSec % 86400) / 3600)}
                        {@const m = Math.floor((uptimeSec % 3600) / 60)}
                        <dt>Uptime</dt><dd>{d > 0 ? d + 'd ' : ''}{h > 0 || d > 0 ? h + 'h ' : ''}{m}m</dd>
                        {/if}
                        <dt>Scripts</dt><dd>{stats.scripts}</dd>
                        <dt>MQTT topics</dt><dd>{stats.topics}</dd>
                        <dt>MQTT msg/s</dt><dd>{stats.mqttMsgPerSec ?? '—'}</dd>
                        {#if stats.matterEnabled}
                        <dt>Matter nodes</dt><dd>{stats.matterNodes ?? 0}</dd>
                        <dt>Matter endpoints</dt><dd>{stats.matterEndpoints ?? 0}</dd>
                        {/if}
                        {#if stats.dbEnabled}
                        <dt>DB docs</dt><dd>{stats.dbDocs ?? '—'}</dd>
                        <dt>DB views</dt><dd>{stats.dbViews ?? '—'}</dd>
                        {/if}
                        <dt>Handlers</dt><dd>{stats.handlers ?? '—'}</dd>
                        <dt>Memory</dt><dd>{stats.memMb != null ? stats.memMb + ' MB' : '—'}</dd>
                        <dt>CPU</dt><dd>{stats.cpuPercent != null ? stats.cpuPercent + ' %' : '—'}</dd>
                        <dt>EL util</dt><dd>{stats.eluPercent != null ? stats.eluPercent + ' %' : '—'}</dd>
                        <dt>EL lag mean</dt><dd>{stats.elMeanMs != null ? stats.elMeanMs + ' ms' : '—'}</dd>
                        <dt>EL lag max</dt><dd>{stats.elMaxMs != null ? stats.elMaxMs + ' ms' : '—'}</dd>
                    </dl>
                    {:else}
                    <span class="stats-empty">Loading…</span>
                    {/if}
                    <div class="stats-actions">
                        {#if !stats?.docker}
                        <button onclick={() => { statsOpen = false; restart(); }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>
                                <line x1="12" y1="2" x2="12" y2="12"/>
                            </svg>
                            Restart daemon
                        </button>
                        {/if}
                    </div>
                </div>
                {/if}
            </div>

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
        <ConfirmDialog bind:this={dialog} />
        <div class="page-wrap" class:hidden={page !== 'scripts'}><Scripts active={page === 'scripts'} /></div>
        <div class="page-wrap" class:hidden={page !== 'packages'}><Packages /></div>
        <div class="page-wrap" class:hidden={page !== 'mqtt'}><MQTT /></div>
        <div class="page-wrap" class:hidden={page !== 'matter'}><Matter /></div>
        <div class="page-wrap" class:hidden={page !== 'security'}><Security /></div>
        {#if servicesEnabled}<div class="page-wrap" class:hidden={page !== 'services'}><Services onstatus={(s, t) => { servicesStatus = s; servicesTitle = t; }} /></div>{/if}
        <div class="page-wrap" class:hidden={page !== 'db'}><DB /></div>
        <div class="page-wrap" class:hidden={page !== 'config'}><Config /></div>
        <div class="page-wrap" class:hidden={page !== 'logs'}><Logs /></div>
    </main>
</div>
{/if}

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

{#if restarting}
<div class="updating-overlay">
    <div class="updating-box">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 4 4 10 10 10"/><path d="M4 10A9 9 0 1 0 6.5 5"/></svg>
        Restarting smart-home-engine…
    </div>
</div>
{/if}

{#if updating}
<div class="updating-overlay">
    <div class="updating-box">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 4 4 10 10 10"/><path d="M4 10A9 9 0 1 0 6.5 5"/></svg>
        Updating smart-home-engine…
    </div>
</div>
{/if}

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

    .stats-wrap {
        position: relative;
    }
    .stats-popup {
        position: absolute;
        right: 0;
        top: calc(100% + 4px);
        background: var(--bg-panel);
        border: 1px solid var(--border);
        border-radius: 5px;
        padding: 10px 14px 6px;
        min-width: 190px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
        z-index: 200;
    }
    .stats-popup dl {
        margin: 0 0 8px;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 3px 12px;
        font-size: 12px;
    }
    .stats-popup dt {
        color: var(--fg-dim);
        font-weight: normal;
    }
    .stats-popup dd {
        margin: 0;
        text-align: right;
        color: var(--fg);
        font-variant-numeric: tabular-nums;
    }
    .stats-empty {
        font-size: 12px;
        color: var(--fg-dim);
        display: block;
        margin-bottom: 8px;
    }
    .stats-actions {
        border-top: 1px solid var(--border-sub);
        padding-top: 6px;
    }
    .stats-actions button {
        width: 100%;
        justify-content: center;
        gap: 6px;
        font-size: 12px;
        color: var(--fg-dim);
        padding: 4px 8px;
    }
    .stats-actions button:hover { color: var(--fg); }

    .nav-right {
        display: flex;
        align-items: center;
        gap: 2px;
    }

    .version-wrap {
        position: relative;
    }

    .version {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: var(--fg-dim);
        padding: 4px 8px;
        background: none;
        border: none;
        cursor: pointer;
        border-radius: 3px;
        white-space: nowrap;
    }
    .version:hover { background: var(--bg-hover); color: var(--fg); }

    .update-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #f90;
        display: inline-block;
        flex-shrink: 0;
    }

    /* Unified nav status dot — used on MQTT, Packages, Matter, Logs tab buttons */
    .nav-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        display: inline-block;
        flex-shrink: 0;
    }
    .nav-dot--ok   { background: var(--fg-ok); }
    .nav-dot--none { visibility: hidden; }
    .nav-dot--warn { background: #f90; }
    .nav-dot--err  { background: var(--fg-err); }
    .nav-dot--blink { animation: navDotBlink 0.9s ease-in-out infinite; }
    @keyframes navDotBlink {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.1; }
    }

    .version-popup {
        position: absolute;
        right: 0;
        top: calc(100% + 4px);
        background: var(--bg-panel);
        border: 1px solid var(--border);
        border-radius: 5px;
        padding: 10px 14px 6px;
        min-width: 180px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
        z-index: 200;
    }
    .version-popup dl {
        margin: 0 0 6px;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 3px 12px;
        font-size: 12px;
    }
    .version-popup dt { color: var(--fg-dim); font-weight: normal; }
    .version-popup dd { margin: 0; text-align: right; }
    .version-actions {
        border-top: 1px solid var(--border-sub);
        padding-top: 6px;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .version-actions button {
        width: 100%;
        justify-content: center;
        gap: 6px;
        font-size: 12px;
        color: #f90;
        padding: 4px 8px;
    }
    .version-actions button:hover { color: var(--fg); }
    .version-actions .check-btn { color: var(--fg-dim); }
    .version-actions .check-btn:hover { color: var(--fg); }
    .version-actions .check-btn:disabled { opacity: 0.5; cursor: default; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinning { animation: spin 0.8s linear infinite; display: inline-block; }

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
        background: var(--bg);
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

    /* ── Updating overlay ──────────────────────────────────────────── */
    .updating-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2000;
    }
    .updating-box {
        display: flex;
        align-items: center;
        gap: 12px;
        background: var(--bg-panel);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 20px 28px;
        font-size: 14px;
        color: var(--fg);
    }
    .updating-box svg { animation: spin 1s linear infinite; color: #f90; }
    @keyframes spin { to { transform: rotate(360deg); } }
</style>
