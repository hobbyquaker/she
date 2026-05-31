<script lang="ts">
    import { onMount } from 'svelte';
    import { getConfig, putConfig } from '../lib/api.js';
    import { getTheme, setTheme, type Theme } from '../lib/theme.js';

    let theme = $state<Theme>(getTheme());

    // ── field state ───────────────────────────────────────────────────────
    // MQTT
    let mqttUrl        = $state('');
    let mqttName       = $state('logic');
    let varPrefix      = $state('var');
    let disableVars    = $state(false);

    // Web server
    let port           = $state<number | ''>(8080);
    let apiKey         = $state('');

    // Scripts
    let dir            = $state('');
    let disableWatch   = $state(false);

    // Solar events
    let latitude       = $state<number | ''>(48.7408);
    let longitude      = $state<number | ''>(9.1778);

    // Logging
    let verbosity      = $state('info');

    // sheDB
    let dbPath         = $state('');
    let dbRetain       = $state(false);

    // Redis
    let redisUrl       = $state('');

    // AI Assistant
    let aiProvider     = $state('ollama');
    let aiBaseUrl      = $state('');
    let aiModel        = $state('');
    let aiApiKey       = $state('');

    // Unknown keys from config.json — preserved on save
    let extra          = $state<Record<string, unknown>>({});

    const KNOWN = new Set([
        'url', 'name', 'variablePrefix', 'disableVariables',
        'port', 'apiKey',
        'dir', 'disableWatch',
        'latitude', 'longitude',
        'verbosity',
        'dbPath', 'dbRetain',
        'redis',
        'ai',
    ]);

    // ── status ────────────────────────────────────────────────────────────
    let loading = $state(true);
    let saving  = $state(false);
    let msg     = $state('');
    let errMsg  = $state('');

    // ── left nav / search ─────────────────────────────────────────────────
    let search        = $state('');
    let activeSection = $state('appearance');

    const SECTIONS = [
        { id: 'appearance', label: 'Appearance',  terms: ['theme','color','dark','light'] },
        { id: 'mqtt',       label: 'MQTT',         terms: ['broker','url','client','name','variable','prefix'] },
        { id: 'webserver',  label: 'Web server',   terms: ['port','api key','http','auth','server'] },
        { id: 'scripts',    label: 'Scripts',      terms: ['directory','watch','hot reload','dir'] },
        { id: 'solar',      label: 'Solar events', terms: ['latitude','longitude','sunrise','sunset','geo'] },
        { id: 'logging',    label: 'Logging',      terms: ['verbosity','debug','info','warn','error'] },
        { id: 'shedb',      label: 'sheDB',        terms: ['database','db','path','retain'] },
        { id: 'redis',      label: 'Redis',        terms: ['redis','cache'] },
        { id: 'ai',         label: 'AI Assistant', terms: ['llm','ollama','openai','anthropic','model','provider','base url'] },
    ] as const;

    let visibleSections = $derived(
        SECTIONS.filter(sec => {
            const q = search.trim().toLowerCase();
            return !q || sec.label.toLowerCase().includes(q) || sec.terms.some(t => t.includes(q));
        })
    );

    function scrollTo(id: string) {
        activeSection = id;
        document.getElementById('sec-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    onMount(async () => {
        try {
            const cfg = await getConfig();
            if (typeof cfg.url              === 'string')  mqttUrl      = cfg.url;
            if (typeof cfg.name             === 'string')  mqttName     = cfg.name;
            if (typeof cfg.variablePrefix   === 'string')  varPrefix    = cfg.variablePrefix;
            if (typeof cfg.disableVariables === 'boolean') disableVars  = cfg.disableVariables;
            if (typeof cfg.port             === 'number')  port         = cfg.port;
            if (typeof cfg.apiKey           === 'string')  apiKey       = cfg.apiKey;
            if (typeof cfg.dir              === 'string')  dir          = cfg.dir;
            if (typeof cfg.disableWatch     === 'boolean') disableWatch = cfg.disableWatch;
            if (typeof cfg.latitude         === 'number')  latitude     = cfg.latitude;
            if (typeof cfg.longitude        === 'number')  longitude    = cfg.longitude;
            if (typeof cfg.verbosity        === 'string')  verbosity    = cfg.verbosity;
            if (typeof cfg.dbPath           === 'string')  dbPath       = cfg.dbPath;
            if (typeof cfg.dbRetain         === 'boolean') dbRetain     = cfg.dbRetain;
            const redis = cfg.redis as { url?: string } | undefined;
            if (redis?.url) redisUrl = redis.url;
            const ai = cfg.ai as { provider?: string; baseUrl?: string; model?: string; apiKey?: string } | undefined;
            if (ai?.provider) aiProvider = ai.provider;
            if (ai?.baseUrl)  aiBaseUrl  = ai.baseUrl;
            if (ai?.model)    aiModel    = ai.model;
            if (ai?.apiKey)   aiApiKey   = ai.apiKey;
            extra = Object.fromEntries(Object.entries(cfg).filter(([k]) => !KNOWN.has(k)));
        } catch (e: any) {
            errMsg = e.message;
        } finally {
            loading = false;
        }
    });

    async function save() {
        errMsg = '';
        msg    = '';
        const cfg: Record<string, unknown> = { ...extra };

        if (mqttUrl)    cfg.url             = mqttUrl;
        cfg.name                            = mqttName;
        cfg.variablePrefix                  = varPrefix;
        if (disableVars)    cfg.disableVariables = true;

        if (port !== '')    cfg.port        = Number(port);
        if (apiKey)         cfg.apiKey      = apiKey;

        if (dir)            cfg.dir         = dir;
        if (disableWatch)   cfg.disableWatch = true;

        if (latitude  !== '') cfg.latitude  = Number(latitude);
        if (longitude !== '') cfg.longitude = Number(longitude);

        cfg.verbosity = verbosity;

        if (dbPath) {
            cfg.dbPath = dbPath;
            if (dbRetain) cfg.dbRetain = true;
        }
        if (redisUrl) cfg.redis = { url: redisUrl };
        if (aiProvider && aiModel) {
            cfg.ai = {
                provider: aiProvider,
                ...(aiBaseUrl  ? { baseUrl:  aiBaseUrl }  : {}),
                model:    aiModel,
                ...(aiApiKey   ? { apiKey:   aiApiKey }   : {}),
            };
        }

        saving = true;
        try {
            const res = await putConfig(cfg);
            msg = res.restartRequired ? 'Saved — restart required to apply changes.' : 'Saved.';
        } catch (e: any) {
            errMsg = e.message;
        } finally {
            saving = false;
        }
    }
</script>

<!-- ── tooltip helper ─────────────────────────────────────────────────── -->
{#snippet tip(text: string)}
    <span class="tip">
        <span class="tip-icon">ℹ</span>
        <span class="tip-box">{text}</span>
    </span>
{/snippet}

<div class="config-root">
    <!-- ── Left sidebar ─────────────────────────────────────────────── -->
    <aside class="config-sidebar">
        <div class="sidebar-search">
            <svg class="search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <circle cx="6.5" cy="6.5" r="4.5"/>
                <line x1="10" y1="10" x2="14" y2="14"/>
            </svg>
            <input
                class="search-input"
                type="search"
                bind:value={search}
                placeholder="Filter settings…"
                autocomplete="off"
                spellcheck="false"
            />
        </div>
        <nav class="section-nav">
            {#each SECTIONS as sec (sec.id)}
                {#if visibleSections.some(s => s.id === sec.id)}
                    <button
                        class="section-link"
                        class:active={activeSection === sec.id}
                        onclick={() => scrollTo(sec.id)}
                    >
                        {sec.label}
                    </button>
                {/if}
            {/each}
        </nav>
    </aside>

    <!-- ── Main content ─────────────────────────────────────────────── -->
    <div class="config-main">
        <div class="config-topbar">
            <span class="topbar-title">Settings</span>
            {#if errMsg}<span class="err">{errMsg}</span>{/if}
            {#if msg}<span class="ok">{msg}</span>{/if}
            <button class="save-btn" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>

        {#if loading}
            <div class="loading">Loading…</div>
        {:else}
            <div class="config-form">

                <!-- ── Appearance ─────────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'appearance')}
                <section id="sec-appearance">
                    <h3>Appearance</h3>
                    <div class="field">
                        <label for="theme-select">Color theme</label>
                        <select id="theme-select" bind:value={theme} onchange={() => setTheme(theme)}>
                            <option value="dark">Dark</option>
                            <option value="light">Light</option>
                            <option value="system">System (OS preference)</option>
                        </select>
                    </div>
                </section>
                {/if}

                <!-- ── MQTT ──────────────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'mqtt')}
                <section id="sec-mqtt">
                    <h3>MQTT</h3>
                    <div class="field">
                        <label>
                            Broker URL
                            {@render tip('mqtt:// or mqtts:// URL of the broker. Leave empty to run without MQTT.')}
                        </label>
                        <input type="text" bind:value={mqttUrl} placeholder="mqtt://localhost:1883" />
                    </div>
                    <div class="field">
                        <label>
                            Client name
                            {@render tip('MQTT client ID and topic prefix used for the "connected" status message. Default: logic')}
                        </label>
                        <input type="text" bind:value={mqttName} placeholder="logic" />
                    </div>
                    <div class="field">
                        <label>
                            Variable prefix
                            {@render tip('Topic prefix for the variable system (var/set/name → var/status/name). Default: var')}
                        </label>
                        <input type="text" bind:value={varPrefix} placeholder="var" />
                    </div>
                    <div class="field field--check">
                        <input type="checkbox" id="disableVars" bind:checked={disableVars} />
                        <label for="disableVars">
                            Disable variable system
                            {@render tip('When enabled, var/set/… messages are not processed and no var/status/… retained messages are published.')}
                        </label>
                    </div>
                </section>
                {/if}

                <!-- ── Web server ────────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'webserver')}
                <section id="sec-webserver">
                    <h3>Web server</h3>
                    <div class="field">
                        <label>
                            Port
                            {@render tip('HTTP server port. Use 0 to let the OS pick a free port. Default: 8080')}
                        </label>
                        <input type="number" bind:value={port} min="0" max="65535" placeholder="8080" />
                    </div>
                    <div class="field">
                        <label>
                            API key
                            {@render tip('Bearer token required on all HTTP and WebSocket requests. Leave empty to disable authentication.')}
                        </label>
                        <input type="text" bind:value={apiKey} placeholder="leave empty to disable auth" autocomplete="off" />
                    </div>
                </section>
                {/if}

                <!-- ── Scripts ───────────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'scripts')}
                <section id="sec-scripts">
                    <h3>Scripts</h3>
                    <div class="field">
                        <label>
                            Scripts directory
                            {@render tip('Directory that is watched for .js script files. Defaults to ~/.she/scripts')}
                        </label>
                        <input type="text" bind:value={dir} placeholder="~/.she/scripts (default)" />
                    </div>
                    <div class="field field--check">
                        <input type="checkbox" id="disableWatch" bind:checked={disableWatch} />
                        <label for="disableWatch">
                            Disable file watching
                            {@render tip('When enabled the daemon will not watch for file changes and will not hot-reload scripts.')}
                        </label>
                    </div>
                </section>
                {/if}

                <!-- ── Solar events ──────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'solar')}
                <section id="sec-solar">
                    <h3>Solar events</h3>
                    <div class="field">
                        <label>
                            Latitude
                            {@render tip('Geographic latitude used for sunrise/sunset calculations. Default: 48.7408 (Stuttgart)')}
                        </label>
                        <input type="number" bind:value={latitude} step="0.0001" placeholder="48.7408" />
                    </div>
                    <div class="field">
                        <label>
                            Longitude
                            {@render tip('Geographic longitude used for sunrise/sunset calculations. Default: 9.1778 (Stuttgart)')}
                        </label>
                        <input type="number" bind:value={longitude} step="0.0001" placeholder="9.1778" />
                    </div>
                </section>
                {/if}

                <!-- ── Logging ───────────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'logging')}
                <section id="sec-logging">
                    <h3>Logging</h3>
                    <div class="field">
                        <label>
                            Verbosity
                            {@render tip('Minimum log level. debug shows all messages including MQTT traffic details.')}
                        </label>
                        <select bind:value={verbosity}>
                            <option value="debug">debug</option>
                            <option value="info">info</option>
                            <option value="warn">warn</option>
                            <option value="error">error</option>
                        </select>
                    </div>
                </section>
                {/if}

                <!-- ── sheDB ─────────────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'shedb')}
                <section id="sec-shedb">
                    <h3>sheDB</h3>
                    <div class="field">
                        <label>
                            Database path
                            {@render tip('Path to the sheDB data directory. Defaults to ~/.she/db. Leave empty to disable sheDB.')}
                        </label>
                        <input type="text" bind:value={dbPath} placeholder="defaults to ~/.she/db" />
                    </div>
                    <div class="field field--check">
                        <input type="checkbox" id="dbRetain" bind:checked={dbRetain} disabled={!dbPath} />
                        <label for="dbRetain" class:muted={!dbPath}>
                            Retain sheDB MQTT messages
                            {@render tip('Publish sheDB documents as retained MQTT messages so other clients see the current value on subscribe.')}
                        </label>
                    </div>
                </section>
                {/if}

                <!-- ── Redis ─────────────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'redis')}
                <section id="sec-redis">
                    <h3>Redis</h3>
                    <div class="field">
                        <label>
                            Redis URL
                            {@render tip('redis:// URL for the optional Redis write-through cache. All state store changes are written to the she:state hash. Leave empty to disable.')}
                        </label>
                        <input type="text" bind:value={redisUrl} placeholder="leave empty to disable" />
                    </div>
                </section>
                {/if}

                <!-- ── AI Assistant ──────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'ai')}
                <section id="sec-ai">
                    <h3>AI Assistant</h3>
                    <div class="field">
                        <label>
                            Provider
                            {@render tip('LLM provider. Ollama and LM Studio use the OpenAI-compatible /v1/chat/completions API at the Base URL below.')}
                        </label>
                        <select bind:value={aiProvider}>
                            <option value="ollama">Ollama (local)</option>
                            <option value="lmstudio">LM Studio (local)</option>
                            <option value="openai">OpenAI</option>
                            <option value="anthropic">Anthropic</option>
                        </select>
                    </div>
                    {#if aiProvider !== 'anthropic'}
                        <div class="field">
                            <label>
                                Base URL
                                {@render tip('Base URL of the LLM API. For Ollama: http://localhost:11434. For LM Studio: http://localhost:1234. OpenAI uses api.openai.com automatically.')}
                            </label>
                            <input type="text" bind:value={aiBaseUrl} placeholder={
                                aiProvider === 'ollama' ? 'http://localhost:11434' :
                                aiProvider === 'lmstudio' ? 'http://localhost:1234' :
                                'https://api.openai.com'
                            } />
                        </div>
                    {/if}
                    <div class="field">
                        <label>
                            Model
                            {@render tip('Model identifier. Examples: llama3.2, qwen2.5-coder:7b, gpt-4o, claude-3-5-sonnet-20241022')}
                        </label>
                        <input type="text" bind:value={aiModel} placeholder="e.g. llama3.2 or gpt-4o" />
                    </div>
                    {#if aiProvider === 'openai' || aiProvider === 'anthropic'}
                        <div class="field">
                            <label>
                                API key
                                {@render tip('API key for the provider. Stored in config.json. For local providers (Ollama, LM Studio) this is usually not needed.')}
                            </label>
                            <input type="password" bind:value={aiApiKey} placeholder="sk-…" autocomplete="off" />
                        </div>
                    {/if}
                </section>
                {/if}

            </div>
        {/if}
    </div>
</div>

<style>
    /* ── root layout ─────────────────────────────────────────────────── */
    .config-root {
        display: flex;
        flex-direction: row;
        height: 100%;
        overflow: hidden;
        background: var(--bg-app);
    }

    /* ── left sidebar ────────────────────────────────────────────────── */
    .config-sidebar {
        width: 180px;
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        background: var(--bg-panel);
        border-right: 1px solid var(--border-sub);
        overflow: hidden;
    }

    .sidebar-search {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 10px 10px 8px;
        border-bottom: 1px solid var(--border-sub);
    }

    .search-icon { color: var(--fg-dim); flex-shrink: 0; }

    .search-input {
        flex: 1;
        background: transparent;
        border: none;
        outline: none;
        color: var(--fg);
        font-size: 12px;
        padding: 0;
        font-family: inherit;
    }

    .search-input::placeholder { color: var(--fg-dim); }
    .search-input::-webkit-search-cancel-button { display: none; }

    .section-nav {
        flex: 1;
        overflow-y: auto;
        padding: 6px 0;
        display: flex;
        flex-direction: column;
    }

    .section-link {
        display: block;
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        border-left: 2px solid transparent;
        color: var(--fg-muted);
        font-size: 12.5px;
        padding: 6px 12px;
        cursor: pointer;
        border-radius: 0;
        transition: color 0.1s;
        line-height: 1.3;
    }

    .section-link:hover { color: var(--fg); background: var(--bg-hover); }

    .section-link.active {
        color: var(--fg-brand);
        border-left-color: var(--fg-brand);
        background: color-mix(in srgb, var(--fg-brand) 8%, transparent);
    }

    /* ── main content ────────────────────────────────────────────────── */
    .config-main {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-width: 0;
    }

    .config-topbar {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 0 20px;
        height: 40px;
        border-bottom: 1px solid var(--border-sub);
        flex-shrink: 0;
        background: var(--bg-panel);
    }

    .topbar-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--fg);
        flex: 1;
    }

    .save-btn {
        background: var(--accent);
        color: #fff;
        border: none;
        padding: 4px 16px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 13px;
        flex-shrink: 0;
    }
    .save-btn:disabled { opacity: 0.4; cursor: default; }
    .save-btn:not(:disabled):hover { background: var(--accent-hov); }

    .loading {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--fg-dim);
        font-size: 13px;
    }

    /* ── form ────────────────────────────────────────────────────────── */
    .config-form {
        flex: 1;
        overflow-y: auto;
        padding: 0 24px 32px;
        display: flex;
        flex-direction: column;
    }

    section {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 20px 0 24px;
        border-bottom: 1px solid var(--border-sub);
        max-width: 640px;
    }

    section:last-child { border-bottom: none; }

    h3 {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--fg-muted);
        margin: 0 0 4px;
    }

    /* ── fields ──────────────────────────────────────────────────────── */
    .field {
        display: grid;
        grid-template-columns: 200px 1fr;
        align-items: center;
        gap: 12px;
    }

    .field--check { grid-template-columns: auto 1fr; }

    .field label {
        font-size: 13px;
        color: var(--fg);
        display: flex;
        align-items: center;
        gap: 5px;
        white-space: nowrap;
    }

    .field--check label { white-space: normal; }

    .muted { opacity: 0.4; }

    input[type='text'],
    input[type='number'],
    input[type='password'],
    select {
        background: var(--bg-input);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: 3px;
        padding: 5px 8px;
        font-size: 13px;
        font-family: inherit;
        width: 100%;
        box-sizing: border-box;
        outline: none;
    }

    input[type='text']:focus,
    input[type='number']:focus,
    input[type='password']:focus,
    select:focus { border-color: var(--fg-brand); }

    input[type='checkbox'] {
        width: 14px;
        height: 14px;
        accent-color: var(--accent);
        cursor: pointer;
        flex-shrink: 0;
    }

    input::placeholder { color: var(--fg-dim); }

    /* ── tooltip ─────────────────────────────────────────────────────── */
    .tip {
        position: relative;
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
    }

    .tip-icon {
        font-size: 11px;
        color: var(--fg-brand);
        cursor: default;
        line-height: 1;
        opacity: 0.7;
    }

    .tip:hover .tip-icon { opacity: 1; }

    .tip-box {
        display: none;
        position: absolute;
        left: 20px;
        top: 50%;
        transform: translateY(-50%);
        background: var(--bg-panel);
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 7px 10px;
        font-size: 12px;
        color: var(--fg);
        width: 260px;
        line-height: 1.5;
        z-index: 100;
        white-space: normal;
        pointer-events: none;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    }

    .tip:hover .tip-box { display: block; }

    /* ── status messages ─────────────────────────────────────────────── */
    .err  { color: var(--fg-err); font-size: 13px; }
    .ok   { color: var(--fg-ok);  font-size: 13px; }
</style>
