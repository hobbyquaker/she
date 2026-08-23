<script lang="ts">
    import { onMount } from 'svelte';
    import { getConfig, putConfig, setupAuth, getDaemonStatus, getBrokerStatus, listMatterDevices, type AuthMode } from '../lib/api.js';
    import ConfirmDialog from '../lib/ConfirmDialog.svelte';
    import { getTheme, setTheme, type Theme } from '../lib/theme.js';
    import L from 'leaflet';
    import 'leaflet/dist/leaflet.css';
    import markerIconUrl from 'leaflet/dist/images/marker-icon.png?url';
    import markerRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png?url';
    import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png?url';

    // Fix Leaflet default icon paths when bundled with Vite
    delete (L.Icon.Default.prototype as any)._getIconUrl;
    L.Icon.Default.mergeOptions({ iconUrl: markerIconUrl, iconRetinaUrl: markerRetinaUrl, shadowUrl: markerShadowUrl });

    let theme = $state<Theme>(getTheme());
    let dataDir = $state('~/.she');

    // ── field state ───────────────────────────────────────────────────────
    // MQTT
    let mqttProtocol   = $state('mqtt');
    let mqttHost       = $state('');
    let mqttUsername   = $state('');
    let mqttPassword   = $state('');
    let mqttCa         = $state('');
    let mqttCert       = $state('');
    let mqttKey        = $state('');
    let mqttName       = $state('logic');
    let varPrefix      = $state('var');
    let mqttVersion    = $state('');
    let disableVars    = $state(false);

    // Mosquitto management
    let brokerEnabled  = $state(false);
    let brokerChecking = $state(false);

    // Services (xyz2mqtt adapter instances)
    let servicesEnabled = $state(false);
    let servicesPublishers = $state('hobbyquaker');   // comma-separated npm user names whose packages the catalog lists
    // Matter controller
    let matterEnabled  = $state(false);
    let matterStorage  = $state('');   // path; empty = use daemon default (<data-dir>/matter)
    let matterChecking = $state(false);

    // Web server
    let port           = $state<number | ''>(8080);
    let bindAddress    = $state('');

    // Authentication
    let authMode       = $state<AuthMode>('none');
    let authPassword   = $state('');
    let authProxyHeader = $state('X-Remote-User');
    let authProxyLogoutUrl = $state('');
    let authSaving     = $state(false);
    let authMsg        = $state('');
    let authErr        = $state('');

    // Scripts
    let dir            = $state('');
    let disableWatch   = $state(false);
    let gitAutoCommit  = $state(false);
    let gitAutoPush    = $state(false);
    let timezone       = $state('');

    // Solar events
    let latitude       = $state<number | ''>(48.7408);
    let longitude      = $state<number | ''>(9.1778);

    // Solar map / geolocation
    let showMap        = $state(false);
    let mapEl          = $state<HTMLDivElement | undefined>(undefined);
    let geoLoading     = $state(false);
    let leafletMarker  = $state<L.Marker | null>(null);

    // Logging
    let verbosity      = $state('info');

    // Script engine
    let heartbeatEnabled   = $state(false);
    let heartbeatInterval  = $state<number | ''>(50);
    let heartbeatThreshold = $state<number | ''>(300);
    let safeModeAutoDetect = $state(true);
    let scriptTimeout      = $state<number | ''>(5000);

    // sheDB
    let dbEnabled      = $state(true);  // default enabled
    let dbPath         = $state('');
    let dbPrefix       = $state('');
    let dbPublish      = $state(false);
    let dbRetain       = $state(false);

    // Redis
    let redisUrl       = $state('');

    // InfluxDB
    let influxVersion  = $state<'1' | '2'>('2');
    let influxUrl      = $state('');
    let influxToken    = $state('');
    let influxOrg      = $state('');
    let influxBucket   = $state('');
    let influxDatabase = $state('');
    let influxUsername = $state('');
    let influxPassword = $state('');

    // AI Assistant
    interface AiPreset {
        id: string; label: string; provider: string;
        baseUrl: string; defaultModel: string;
        freeNote: string; apiKeyUrl: string;
    }
    const AI_PRESETS: AiPreset[] = [
        { id: 'ollama',    label: 'Ollama (local)',                       provider: 'ollama',    baseUrl: '',                                                         defaultModel: '',                           freeNote: '',                                              apiKeyUrl: '' },
        { id: 'lmstudio',  label: 'LM Studio (local)',                    provider: 'openai',    baseUrl: 'http://localhost:1234',                                     defaultModel: '',                           freeNote: '',                                              apiKeyUrl: '' },
        { id: 'groq',      label: 'Groq — Qwen 2.5 Coder 32B (free)',     provider: 'openai',    baseUrl: 'https://api.groq.com/openai/v1',                           defaultModel: 'qwen-2.5-coder-32b',         freeNote: '14 400 req/day · no credit card needed',        apiKeyUrl: 'https://console.groq.com/keys' },
        { id: 'gemini',    label: 'Google Gemini 2.0 Flash (free)',        provider: 'openai',    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',  defaultModel: 'gemini-2.0-flash',           freeNote: '15 RPM · 1 000 000 tokens/day · no credit card', apiKeyUrl: 'https://aistudio.google.com/apikey' },
        { id: 'openai',    label: 'OpenAI (paid)',                         provider: 'openai',    baseUrl: '',                                                         defaultModel: 'gpt-4o-mini',                freeNote: '',                                              apiKeyUrl: 'https://platform.openai.com/api-keys' },
        { id: 'anthropic', label: 'Anthropic (paid)',                      provider: 'anthropic', baseUrl: '',                                                         defaultModel: 'claude-3-5-haiku-20241022',  freeNote: '',                                              apiKeyUrl: 'https://console.anthropic.com/settings/keys' },
    ];

    let aiPreset   = $state('ollama');
    let aiProvider = $state('ollama');
    let aiBaseUrl  = $state('');
    let aiModel    = $state('');
    let aiApiKey   = $state('');

    // Per-preset settings cache — remembers customised values when switching presets
    const presetCache: Record<string, { baseUrl: string; model: string; apiKey: string }> = {};
    let previousPreset = 'ollama';

    function detectAiPreset(provider: string, baseUrl: string): string {
        if (provider === 'anthropic') return 'anthropic';
        if (provider === 'ollama')    return 'ollama';
        if (!baseUrl) return 'openai';
        if (baseUrl.includes('localhost:1234'))  return 'lmstudio';
        if (baseUrl.includes('groq.com'))        return 'groq';
        if (baseUrl.includes('googleapis.com'))  return 'gemini';
        return 'openai';
    }

    function onPresetChange() {
        // Save current values for the preset we're leaving
        presetCache[previousPreset] = { baseUrl: aiBaseUrl, model: aiModel, apiKey: aiApiKey };

        const p = AI_PRESETS.find(x => x.id === aiPreset);
        if (!p) return;
        aiProvider = p.provider;

        // Restore previously cached values, or fall back to preset defaults
        const cached = presetCache[aiPreset];
        aiBaseUrl = cached?.baseUrl ?? p.baseUrl;
        aiModel   = cached?.model   ?? p.defaultModel;
        aiApiKey  = cached?.apiKey  ?? '';

        previousPreset = aiPreset;
    }

    const activePreset = $derived(AI_PRESETS.find(p => p.id === aiPreset));

    // Unknown keys from config.json — preserved on save
    let extra          = $state<Record<string, unknown>>({});

    const KNOWN = new Set([
        'url', 'name', 'variablePrefix', 'disableVariables',
        'mqttUsername', 'mqttPassword', 'mqttCa', 'mqttCert', 'mqttKey', 'mqttVersion',
        'port', 'bindAddress', 'auth', 'password', 'proxyHeader', 'proxyLogoutUrl',
        'dir', 'disableWatch', 'gitAutoCommit', 'gitAutoPush',
        'latitude', 'longitude', 'timezone',
        'verbosity',
        'dbPath', 'dbPrefix', 'dbPublish', 'dbRetain',
        'redis',
        'influx',
        'ai',
        'broker', // handled explicitly in load/save for broker.enabled
        'services', // handled explicitly in load/save for services.enabled
        'matter-storage', // handled explicitly
    ]);

    // ── Leaflet map ────────────────────────────────────────────────────────
    $effect(() => {
        if (!mapEl) return;
        const lat = typeof latitude  === 'number' ? latitude  : 48.7408;
        const lng = typeof longitude === 'number' ? longitude : 9.1778;

        const map = L.map(mapEl).setView([lat, lng], 10);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(map);

        const marker = L.marker([lat, lng], { draggable: true }).addTo(map);
        leafletMarker = marker;

        const onPos = (pos: L.LatLng) => {
            latitude  = +pos.lat.toFixed(6);
            longitude = +pos.lng.toFixed(6);
        };
        marker.on('dragend', () => onPos(marker.getLatLng()));
        map.on('click', (e) => { marker.setLatLng(e.latlng); onPos(e.latlng); });

        return () => {
            leafletMarker = null;
            map.remove();
        };
    });

    // Keep marker in sync when lat/lon text inputs change
    $effect(() => {
        if (!leafletMarker || latitude === '' || longitude === '') return;
        leafletMarker.setLatLng([Number(latitude), Number(longitude)]);
    });

    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean; alert?: boolean }): Promise<boolean> };

    function geolocate() {
        if (!navigator.geolocation) { dialog.show('Geolocation is not supported by this browser.', { alert: true }); return; }
        geoLoading = true;
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                latitude  = +pos.coords.latitude.toFixed(6);
                longitude = +pos.coords.longitude.toFixed(6);
                geoLoading = false;
            },
            () => { geoLoading = false; }
        );
    }

    // ── status ────────────────────────────────────────────────────────────
    let loading = $state(true);
    let saving  = $state(false);
    let msg     = $state('');
    let errMsg  = $state('');

    // ── left nav / search ─────────────────────────────────────────────────
    let search        = $state('');
    let activeSection = $state('appearance');

    const SECTIONS = [
        { id: 'appearance', label: 'Appearance',    terms: ['theme','color','dark','light'] },
        { id: 'auth',       label: 'Authentication', terms: ['auth','password','login','proxy','header','nginx','authentik','secure'] },
        { id: 'mqtt',       label: 'MQTT',         terms: ['broker','url','client','name','variable','prefix','protocol','version','mqtt5'] },
        { id: 'broker',  label: 'Mosquitto',        terms: ['mosquitto','broker','mqtt broker','management','dynsec'] },
        { id: 'services', label: 'Services',        terms: ['services','adapter','xyz2mqtt','2mqtt','interfaces','instances','systemd','fleet'] },
        { id: 'matter',  label: 'Matter controller', terms: ['matter','thread','zigbee','iot','devices','smart home controller'] },
        { id: 'webserver',  label: 'Web server',   terms: ['port','http','server','bind','address'] },
        { id: 'scripts',    label: 'Scripts',      terms: ['directory','watch','hot reload','dir'] },
        { id: 'git',        label: 'Git',           terms: ['git','auto commit','auto push','commit','push','repository'] },
        { id: 'solar',      label: 'Location',      terms: ['latitude','longitude','sunrise','sunset','geo','timezone','time zone','iana','schedule'] },
        { id: 'shedb',      label: 'sheDB',        terms: ['database','db','shedb','path','retain','enable'] },
        { id: 'redis',      label: 'Redis',        terms: ['redis','cache'] },
        { id: 'influx',     label: 'InfluxDB',     terms: ['influx','influxdb','time series','history','token','org','bucket','database','flux','influxql'] },
        { id: 'logging',    label: 'Logging',      terms: ['verbosity','debug','info','warn','error'] },
        { id: 'engine',     label: 'Script engine', terms: ['heartbeat','event loop','lag','blocking','performance','safe mode','recovery','timeout'] },
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
            const st = await getDaemonStatus();
            if (st.dataDir) dataDir = st.dataDir;
        } catch { /* best-effort */ }
        try {
            const cfg = await getConfig();
            if (typeof cfg.url === 'string' && cfg.url) {
                try {
                    const u = new URL(cfg.url);
                    mqttProtocol = u.protocol.replace(':', '');
                    mqttHost     = u.host;
                } catch {
                    mqttHost = cfg.url;
                }
            }
            if (typeof cfg.mqttUsername === 'string') mqttUsername = cfg.mqttUsername;
            if (typeof cfg.mqttPassword === 'string') mqttPassword = cfg.mqttPassword;
            if (typeof cfg.mqttCa   === 'string') mqttCa   = cfg.mqttCa;
            if (typeof cfg.mqttCert === 'string') mqttCert = cfg.mqttCert;
            if (typeof cfg.mqttKey  === 'string') mqttKey  = cfg.mqttKey;
            if (typeof cfg.mqttVersion === 'string') mqttVersion = cfg.mqttVersion;
            if (typeof cfg.name             === 'string')  mqttName     = cfg.name;
            if (typeof cfg.variablePrefix   === 'string')  varPrefix    = cfg.variablePrefix;
            if (typeof cfg.disableVariables === 'boolean') disableVars  = cfg.disableVariables;
            if (typeof cfg.port             === 'number')  port         = cfg.port;
            if (typeof cfg.bindAddress      === 'string')  bindAddress  = cfg.bindAddress;
            if (typeof cfg.auth             === 'string')  authMode     = cfg.auth as AuthMode;
            if (typeof cfg.proxyHeader      === 'string')  authProxyHeader = cfg.proxyHeader;
            if (typeof cfg.proxyLogoutUrl   === 'string')  authProxyLogoutUrl = cfg.proxyLogoutUrl;
            if (typeof cfg.dir              === 'string')  dir          = cfg.dir;
            if (typeof cfg.disableWatch     === 'boolean') disableWatch = cfg.disableWatch;
            if (typeof cfg.gitAutoCommit    === 'boolean') gitAutoCommit = cfg.gitAutoCommit;
            if (typeof cfg.gitAutoPush      === 'boolean') gitAutoPush   = cfg.gitAutoPush;
            if (typeof cfg.latitude         === 'number')  latitude     = cfg.latitude;
            if (typeof cfg.longitude        === 'number')  longitude    = cfg.longitude;
            if (typeof cfg.timezone         === 'string')  timezone     = cfg.timezone;
            if (typeof cfg.verbosity        === 'string')  verbosity    = cfg.verbosity;
            if (typeof cfg.heartbeat === 'object' && cfg.heartbeat !== null) {
                const hb = cfg.heartbeat as Record<string, unknown>;
                if (typeof hb.enabled   === 'boolean') heartbeatEnabled   = hb.enabled;
                if (typeof hb.interval  === 'number')  heartbeatInterval  = hb.interval;
                if (typeof hb.threshold === 'number')  heartbeatThreshold = hb.threshold;
            }
            if (typeof cfg.safeModeAutoDetect === 'boolean') safeModeAutoDetect = cfg.safeModeAutoDetect;
            if (typeof cfg.scriptTimeout      === 'number')  scriptTimeout      = cfg.scriptTimeout;
            if (typeof cfg.dbPath === 'string') {
                dbEnabled = cfg.dbPath !== ''; // empty string = explicitly disabled
                dbPath    = cfg.dbPath;
            } else {
                dbEnabled = true; // key absent = daemon uses default = enabled
                dbPath    = '';
            }
            if (typeof cfg.dbPrefix         === 'string')  dbPrefix     = cfg.dbPrefix;
            if (typeof cfg.dbPublish        === 'boolean') dbPublish    = cfg.dbPublish;
            if (typeof cfg.dbRetain         === 'boolean') dbRetain     = cfg.dbRetain;
            const redis = cfg.redis as { url?: string } | undefined;
            if (redis?.url) redisUrl = redis.url;
            const inf = cfg.influx as Record<string, unknown> | undefined;
            if (inf) {
                influxVersion = (Number(inf.version) === 1 || (!!inf.database && !inf.token)) ? '1' : '2';
                if (typeof inf.url      === 'string') influxUrl      = inf.url;
                if (typeof inf.token    === 'string') influxToken    = inf.token;
                if (typeof inf.org      === 'string') influxOrg      = inf.org;
                if (typeof inf.bucket   === 'string') influxBucket   = inf.bucket;
                if (typeof inf.database === 'string') influxDatabase = inf.database;
                if (typeof inf.username === 'string') influxUsername = inf.username;
                if (typeof inf.password === 'string') influxPassword = inf.password;
            }
            const brokerCfg = cfg.broker as Record<string, unknown> | undefined;
            brokerEnabled = brokerCfg?.enabled === true;
            const ms = cfg['matter-storage'] as string | undefined;
            matterEnabled = !!ms;
            matterStorage = (ms && typeof ms === 'string' && ms !== 'true') ? ms : '';
            const ai = cfg.ai as { provider?: string; baseUrl?: string; model?: string; apiKey?: string } | undefined;
            if (ai?.provider) aiProvider = ai.provider;
            if (ai?.baseUrl)  aiBaseUrl  = ai.baseUrl;
            if (ai?.model)    aiModel    = ai.model;
            if (ai?.apiKey)   aiApiKey   = ai.apiKey;
            aiPreset = detectAiPreset(aiProvider, aiBaseUrl);
            previousPreset = aiPreset;
            extra = Object.fromEntries(Object.entries(cfg).filter(([k]) => !KNOWN.has(k)));
            // Keep the full broker object in extra so non-enabled fields survive a save
            if (brokerCfg) extra = { ...extra, broker: brokerCfg };
            const servicesCfg = cfg.services as Record<string, unknown> | undefined;
            servicesEnabled = servicesCfg?.enabled === true;
            if (servicesCfg) extra = { ...extra, services: servicesCfg };
            const tp = servicesCfg?.trustedPublishers;
            servicesPublishers = Array.isArray(tp) ? tp.join(', ') : 'hobbyquaker';
        } catch (e: any) {
            errMsg = e.message;
        } finally {
            loading = false;
        }
    });

    async function saveAuth() {
        authErr = '';
        authMsg = '';
        if (authMode === 'password' && !authPassword) {
            authErr = 'A password is required to enable password authentication.';
            return;
        }
        authSaving = true;
        try {
            await setupAuth(
                authMode,
                authMode === 'password' ? authPassword : undefined,
                authMode === 'proxy' ? authProxyHeader : undefined,
                authMode === 'proxy' ? authProxyLogoutUrl : undefined,
            );
            authPassword = '';
            authMsg = 'Authentication settings saved.';
        } catch (e: any) {
            authErr = e.message;
        } finally {
            authSaving = false;
        }
    }

    async function onDbEnabledChange(val: boolean) {
        if (val) { dbEnabled = true; return; }
        let docCount = 0;
        try {
            const st = await getDaemonStatus();
            docCount = st.dbDocs ?? 0;
        } catch { /* best-effort */ }
        if (docCount > 0) {
            const ok = await dialog.show(
                `sheDB contains ${docCount} document${docCount === 1 ? '' : 's'}. Disabling it will hide the DB page but data on disk is preserved and can be re-enabled later. Continue?`,
                { confirm: 'Disable anyway', danger: true },
            );
            if (!ok) return;
        }
        dbEnabled = false;
    }

    async function onMatterEnabledChange(val: boolean) {
        if (val) { matterEnabled = true; return; }
        matterChecking = true;
        try {
            const devices = await listMatterDevices();
            if (devices.length > 0) {
                await dialog.show(
                    `Cannot disable the Matter controller: ${devices.length} device${devices.length === 1 ? ' is' : 's are'} still paired. Unpair all devices first via the Matter page.`,
                    { alert: true } as any,
                );
                return;
            }
        } catch {
            // listMatterDevices may fail if Matter is already stopped — proceed
        } finally {
            matterChecking = false;
        }
        matterEnabled = false;
    }

    async function onBrokerEnabledChange(val: boolean) {
        if (val) { brokerEnabled = true; return; }
        // Turning OFF — guard against active dynsec or SSH config
        brokerChecking = true;
        try {
            const st = await getBrokerStatus();
            if (st.dynsec?.configured) {
                await dialog.show(
                    'Cannot disable mosquitto management: the dynamic security plugin is still configured. Remove it first via Broker → Status.',
                    { alert: true } as any,
                );
                return;
            }
            if (st.sshConfigured) {
                const ok = await dialog.show(
                    'An SSH broker connection is configured. Disabling mosquitto management will hide the Broker page but your configuration will be preserved.',
                    { confirm: 'Disable anyway', danger: true },
                );
                if (!ok) return;
            }
        } catch {
            // getBrokerStatus may fail if broker was never configured — proceed
        } finally {
            brokerChecking = false;
        }
        brokerEnabled = false;
    }

    async function save() {
        errMsg = '';
        msg    = '';
        const cfg: Record<string, unknown> = { ...extra };

        if (mqttHost)     cfg.url             = `${mqttProtocol}://${mqttHost}`;
        cfg.name                              = mqttName;
        cfg.variablePrefix                    = varPrefix;
        if (mqttVersion)    cfg.mqttVersion    = mqttVersion;
        if (disableVars)    cfg.disableVariables = true;
        if (mqttUsername)   cfg.mqttUsername   = mqttUsername;
        if (mqttPassword)   cfg.mqttPassword   = mqttPassword;
        if (mqttCa)         cfg.mqttCa         = mqttCa;
        if (mqttCert)       cfg.mqttCert       = mqttCert;
        if (mqttKey)        cfg.mqttKey        = mqttKey;

        if (port !== '')    cfg.port        = Number(port);
        if (bindAddress)    cfg.bindAddress = bindAddress;

        if (dir)            cfg.dir         = dir;
        if (disableWatch)   cfg.disableWatch = true;
        if (gitAutoCommit)  cfg.gitAutoCommit = true;
        if (gitAutoPush)    cfg.gitAutoPush   = true;

        if (latitude  !== '') cfg.latitude  = Number(latitude);
        if (longitude !== '') cfg.longitude = Number(longitude);
        if (timezone)         cfg.timezone  = timezone;

        cfg.verbosity = verbosity;
        cfg.heartbeat = {
            enabled: heartbeatEnabled,
            ...(heartbeatInterval  !== '' ? { interval:  Number(heartbeatInterval)  } : {}),
            ...(heartbeatThreshold !== '' ? { threshold: Number(heartbeatThreshold) } : {}),
        };
        cfg.safeModeAutoDetect = safeModeAutoDetect;
        if (scriptTimeout !== '') cfg.scriptTimeout = Number(scriptTimeout);

        if (dbEnabled) {
            if (dbPath) {
                cfg.dbPath = dbPath;
                if (dbPrefix) cfg.dbPrefix = dbPrefix;
                if (dbPublish) {
                    cfg.dbPublish = true;
                    if (dbRetain) cfg.dbRetain = true;
                }
            }
            // else: key absent → daemon uses default path, DB enabled
        } else {
            cfg.dbPath = ''; // explicitly disable sheDB
        }
        if (redisUrl) cfg.redis = { url: redisUrl };
        if (influxUrl) {
            cfg.influx = influxVersion === '1'
                ? {
                    version: 1,
                    url: influxUrl,
                    ...(influxDatabase ? { database: influxDatabase } : {}),
                    ...(influxUsername ? { username: influxUsername } : {}),
                    ...(influxPassword ? { password: influxPassword } : {}),
                }
                : {
                    url: influxUrl,
                    ...(influxToken  ? { token:  influxToken }  : {}),
                    ...(influxOrg    ? { org:    influxOrg }    : {}),
                    ...(influxBucket ? { bucket: influxBucket } : {}),
                };
        }
        // broker.enabled — merge into the existing broker config block (preserves dynsec, ssh, etc.)
        const brokerExtra = (extra.broker as Record<string, unknown> | undefined) ?? {};
        const { enabled: _bIgnored, ...brokerRest } = brokerExtra;
        if (brokerEnabled) {
            cfg.broker = { ...brokerRest, enabled: true };
        } else if (Object.keys(brokerRest).length > 0) {
            cfg.broker = brokerRest;
        }
        // services.enabled — merge into the existing services block (preserves hosts etc.)
        const servicesExtra = (extra.services as Record<string, unknown> | undefined) ?? {};
        const { enabled: _sIgnored, hosts: _hIgnored, trustedPublishers: _tpIgnored, ...servicesRest } = servicesExtra;
        const publishers = servicesPublishers.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        if (publishers.join(',') !== 'hobbyquaker') servicesRest.trustedPublishers = publishers; // default stays implicit
        // the host list is edited on the Adapters page → kept as it is
        const servicesOut: Record<string, unknown> = { ...servicesRest, ...(Array.isArray(servicesExtra.hosts) ? { hosts: servicesExtra.hosts } : {}) };
        if (servicesEnabled) {
            cfg.services = { ...servicesOut, enabled: true };
        } else if (Object.keys(servicesOut).length > 0) {
            cfg.services = servicesOut;
        }
        // matter-storage
        if (matterEnabled) {
            cfg['matter-storage'] = matterStorage || true;
        }
        if (aiProvider) {
            cfg.ai = {
                provider: aiProvider,
                ...(aiBaseUrl  ? { baseUrl:  aiBaseUrl }  : {}),
                ...(aiModel    ? { model:    aiModel }    : {}),
                ...(aiApiKey   ? { apiKey:   aiApiKey }   : {}),
            };
        }

        saving = true;
        try {
            const res = await putConfig(cfg);
            window.dispatchEvent(new CustomEvent('she:config-changed'));
            msg = res.restartRequired ? 'Saved — restart required to apply changes.' : 'Saved.';
        } catch (e: any) {
            errMsg = e.message;
        } finally {
            saving = false;
        }
    }
</script>

<!-- ── tooltip helper ─────────────────────────────────────────────────── -->
<ConfirmDialog bind:this={dialog} />
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

                <!-- ── Authentication ────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'auth')}
                <section id="sec-auth">
                    <h3>Authentication</h3>
                    <div class="field">
                        <label>
                            Mode
                            {@render tip('none: no authentication required. password: single-user password login. proxy: trust a header set by nginx/authentik.')}
                        </label>
                        <select bind:value={authMode}>
                            <option value="none">None (open)</option>
                            <option value="password">Password</option>
                            <option value="proxy">Proxy header (nginx / authentik)</option>
                        </select>
                    </div>
                    {#if authMode === 'password'}
                    <div class="field">
                        <label>
                            {authPassword ? 'New password' : 'Password'}
                            {@render tip('Set a new password. Leave empty to keep the current password (if already set).')}
                        </label>
                        <input type="password" bind:value={authPassword} placeholder="Enter new password" autocomplete="new-password" />
                    </div>
                    {/if}
                    {#if authMode === 'proxy'}
                    <div class="field">
                        <label>
                            Proxy user header
                            {@render tip('The HTTP header that nginx/authentik sets after successful authentication. Default: X-Remote-User')}
                        </label>
                        <input type="text" bind:value={authProxyHeader} placeholder="X-Remote-User" />
                    </div>
                    <div class="field">
                        <label>
                            Logout URL
                            {@render tip('URL to redirect to when the user clicks Logout (e.g. https://auth.example.com/application/o/she/end-session/ for Authentik). Leave empty to do nothing on logout.')}
                        </label>
                        <input type="text" bind:value={authProxyLogoutUrl} placeholder="https://auth.example.com/…/end-session/" />
                    </div>
                    {/if}
                    {#if authErr}<div class="field-error">{authErr}</div>{/if}
                    {#if authMsg}<div class="field-ok">{authMsg}</div>{/if}
                    <div class="field">
                        <span></span>
                        <button
                            class="save-auth-btn"
                            onclick={saveAuth}
                            disabled={authSaving || (authMode === 'password' && !authPassword)}
                        >
                            {authSaving ? 'Saving…' : 'Apply authentication settings'}
                        </button>
                    </div>
                </section>
                {/if}

                <!-- ── MQTT ──────────────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'mqtt')}
                <section id="sec-mqtt">
                    <h3>MQTT</h3>
                    <div class="field">
                        <label>
                            Protocol
                            {@render tip('Transport protocol. Use mqtts or wss for TLS encryption.')}
                        </label>
                        <select bind:value={mqttProtocol}>
                            <option value="mqtt">mqtt (plain TCP)</option>
                            <option value="mqtts">mqtts (TLS)</option>
                            <option value="ws">ws (WebSocket)</option>
                            <option value="wss">wss (WebSocket + TLS)</option>
                        </select>
                    </div>
                    <div class="field">
                        <label>
                            Broker address
                            {@render tip('Hostname and optional port of the MQTT broker. Example: 192.168.1.1:1883. Leave empty to run without MQTT.')}
                        </label>
                        <input type="text" bind:value={mqttHost} placeholder="localhost:1883" />
                    </div>
                    <div class="field">
                        <label>
                            Username
                            {@render tip('MQTT broker username. Leave empty if the broker does not require authentication.')}
                        </label>
                        <input type="text" bind:value={mqttUsername} placeholder="(optional)" autocomplete="off" />
                    </div>
                    <div class="field">
                        <label>
                            Password
                            {@render tip('MQTT broker password. Stored in plain text in config.json.')}
                        </label>
                        <input type="password" bind:value={mqttPassword} placeholder="(optional)" autocomplete="new-password" />
                    </div>
                    {#if mqttProtocol === 'mqtts' || mqttProtocol === 'wss'}
                    <div class="field">
                        <label>
                            CA certificate
                            {@render tip("PEM-encoded CA certificate to verify the broker's TLS certificate. Leave empty to use the system's default CA store.")}
                        </label>
                        <textarea bind:value={mqttCa} rows="4" placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----" spellcheck="false"></textarea>
                    </div>
                    <div class="field">
                        <label>
                            Client certificate
                            {@render tip('PEM-encoded client certificate for mutual TLS authentication.')}
                        </label>
                        <textarea bind:value={mqttCert} rows="4" placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----" spellcheck="false"></textarea>
                    </div>
                    <div class="field">
                        <label>
                            Client private key
                            {@render tip('PEM-encoded private key matching the client certificate.')}
                        </label>
                        <textarea bind:value={mqttKey} rows="4" placeholder="-----BEGIN PRIVATE KEY-----&#10;…&#10;-----END PRIVATE KEY-----" spellcheck="false"></textarea>
                    </div>
                    {/if}
                    <div class="field">
                        <label>
                            MQTT protocol version
                            {@render tip('MQTT protocol version used when connecting to the broker. Choose 5 only if your broker supports MQTT 5.0. Default: 3.1.1 (mqtt.js default).')}
                        </label>
                        <select bind:value={mqttVersion}>
                            <option value="">3.1.1 (default)</option>
                            <option value="5">5.0</option>
                        </select>
                    </div>
                    <div class="field">
                        <label>
                            Client name
                            {@render tip('MQTT client ID and topic prefix used for the "connected" status message. Default: she')}
                        </label>
                        <input type="text" bind:value={mqttName} placeholder="she" />
                    </div>
                    <div class="field">
                        <label>
                            Variable prefix
                            {@render tip('Topic prefix for the variable system (var/set/name → var/status/name). Default: var')}
                        </label>
                        <input type="text" bind:value={varPrefix} placeholder="var" />
                    </div>
                    <div class="field field--check">
                        <span></span>
                        <label class="check-label">
                            <input type="checkbox" bind:checked={disableVars} />
                            <span class="checkmark"></span>
                            Disable variable system
                            {@render tip('When enabled, var/set/… messages are not processed and no var/status/… retained messages are published.')}
                        </label>
                    </div>
                </section>
                {/if}

                <!-- ── Mosquitto Management ──────────────────────── -->
                {#if visibleSections.some(s => s.id === 'broker')}
                <section id="sec-broker">
                    <h3>Mosquitto management</h3>
                    <div class="field field--check">
                        <label>
                            Enable
                            {@render tip('Shows the Broker page in the navigation, giving access to listener config, dynamic security, TLS certificates and more. Disable if you are not using Mosquitto or prefer to manage it externally.')}
                        </label>
                        <label class="check-label" class:muted={brokerChecking}>
                            <input type="checkbox" checked={brokerEnabled} disabled={brokerChecking}
                                onchange={(e) => onBrokerEnabledChange((e.target as HTMLInputElement).checked)} />
                            <span class="checkmark"></span>
                            Mosquitto management{#if brokerChecking} — checking…{/if}
                        </label>
                    </div>
                </section>
                {/if}

                <!-- ── Services ──────────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'services')}
                <section id="sec-services">
                    <h3>Services</h3>
                    <div class="field field--check">
                        <label>
                            Enable
                            {@render tip('Shows the Adapters page (main menu): inventory of the xyz2mqtt adapter instances seen on the broker (mqtt-interfaces-core convention), restart and log level over their maintenance topics, update check, and management of the instances installed on this host via systemd.')}
                        </label>
                        <label class="check-label">
                            <input type="checkbox" bind:checked={servicesEnabled} />
                            <span class="checkmark"></span>
                            Service management
                        </label>
                    </div>
                    {#if servicesEnabled}
                    <div class="field">
                        <label for="svc-hosts-link">Hosts</label>
                        <div class="feature-desc" style="padding-left:0">Which hosts she manages adapters on — this host, remote hosts over SSH, the setup command and the SSH key — lives on the Adapters page: <button id="svc-hosts-link" type="button" class="link-btn" onclick={() => { location.hash = 'adapters'; localStorage.setItem('she-services-tab', 'hostsconf'); }}>open Adapters → Hosts</button></div>
                    </div>
                    <div class="field">
                        <label>
                            Trusted publishers
                            {@render tip('npm user names. The Catalog tab lists their packages whose latest version depends on mqtt-interfaces-core, and only those can be installed from she. Comma-separated.')}
                        </label>
                        <input type="text" bind:value={servicesPublishers} spellcheck="false" placeholder="hobbyquaker" style="max-width:420px" />
                    </div>
                    {/if}
                </section>
                {/if}

                <!-- ── Matter controller ──────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'matter')}
                <section id="sec-matter">
                    <h3>Matter controller</h3>
                    <div class="field field--check">
                        <label>
                            Enable
                            {@render tip('Shows the Matter page and starts the built-in Matter controller on next restart. Requires a restart to take effect. Disable only after unpairing all devices.')}
                        </label>
                        <label class="check-label" class:muted={matterChecking}>
                            <input type="checkbox" checked={matterEnabled} disabled={matterChecking}
                                onchange={(e) => onMatterEnabledChange((e.target as HTMLInputElement).checked)} />
                            <span class="checkmark"></span>
                            Matter controller{#if matterChecking} — checking…{/if}
                        </label>
                    </div>
                    {#if matterEnabled}
                    <div class="field">
                        <label>
                            Storage path
                            {@render tip('Path to the Matter controller storage directory. Leave empty to use the default ({dataDir}/matter).')}
                        </label>
                        <input id="matter-storage-input" type="text" bind:value={matterStorage}
                            placeholder="{dataDir}/matter (default)" />
                    </div>
                    {/if}
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
                            Bind address
                            {@render tip('Interface she listens on. Use 127.0.0.1 when running behind nginx (recommended with proxy auth). Default: 0.0.0.0')}
                        </label>
                        <input type="text" bind:value={bindAddress} placeholder="0.0.0.0 (default)" />
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
                            {@render tip('Directory that is watched for .js script files. Defaults to {dataDir}/scripts')}
                        </label>
                        <input type="text" bind:value={dir} placeholder="{dataDir}/scripts (default)" />
                    </div>
                    <div class="field field--check">
                        <span></span>
                        <label class="check-label">
                            <input type="checkbox" bind:checked={disableWatch} />
                            <span class="checkmark"></span>
                            Disable file watching
                            {@render tip('When enabled the daemon will not watch for file changes and will not hot-reload scripts.')}
                        </label>
                    </div>
                </section>
                {/if}

                <!-- ── Git ─────────────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'git')}
                <section id="sec-git">
                    <h3>Git</h3>
                    <div class="field field--check">
                        <span></span>
                        <label class="check-label">
                            <input type="checkbox" bind:checked={gitAutoCommit} />
                            <span class="checkmark"></span>
                            Auto-commit on save
                            {@render tip('When enabled, saving or renaming/deleting a script automatically creates a git commit. Only effective when the scripts directory is inside a git repository.')}
                        </label>
                    </div>
                    <div class="field field--check">
                        <span></span>
                        <label class="check-label">
                            <input type="checkbox" bind:checked={gitAutoPush} />
                            <span class="checkmark"></span>
                            Auto-push after commit
                            {@render tip('When enabled, every commit (manual or automatic) is immediately pushed to the remote.')}
                        </label>
                    </div>
                </section>
                {/if}

                <!-- ── Location ────────────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'solar')}
                <section id="sec-solar">
                    <h3>Location</h3>
                    <div class="field">
                        <label>
                            Timezone
                            {@render tip('IANA timezone for cron scheduling (e.g. Europe/Berlin). Leave empty to use the system timezone. Requires daemon restart.')}
                        </label>
                        <input
                            type="text"
                            list="tz-list"
                            bind:value={timezone}
                            placeholder="(system default)"
                            autocomplete="off"
                            spellcheck="false"
                        />
                        <datalist id="tz-list">
                            {#each (Intl.supportedValuesOf?.('timeZone') ?? []) as tz}
                                <option value={tz}>{tz}</option>
                            {/each}
                        </datalist>
                    </div>
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
                    <div class="field geo-actions">
                        <span></span>
                        <div class="geo-btns">
                            <button class="geo-btn" onclick={geolocate} disabled={geoLoading}>
                                {#if geoLoading}…{:else}📍 Use my location{/if}
                            </button>
                            <button class="geo-btn" onclick={() => showMap = !showMap}>
                                {showMap ? 'Hide map' : 'Pick on map'}
                            </button>
                        </div>
                    </div>
                    {#if showMap}
                    <div class="field">
                        <div class="map-label">Map <span class="map-note">(click or drag marker to set location — requires internet for tiles)</span></div>
                        <div class="map-container" bind:this={mapEl}></div>
                    </div>
                    {/if}
                </section>
                {/if}

                <!-- ── sheDB ─────────────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'shedb')}
                <section id="sec-shedb">
                    <h3>sheDB</h3>
                    <div class="field field--check">
                        <label>
                            Enable
                            {@render tip('Built-in JSON document store used by scripts and the DB page. Disable only if you don\'t use it — data on disk is preserved.')}
                        </label>
                        <label class="check-label">
                            <input type="checkbox" checked={dbEnabled}
                                onchange={(e) => onDbEnabledChange((e.target as HTMLInputElement).checked)} />
                            <span class="checkmark"></span>
                            sheDB
                        </label>
                    </div>
                    {#if dbEnabled}
                    <div class="field">
                        <label>
                            Database path
                            {@render tip('Path to the sheDB data directory. Defaults to {dataDir}/db. Leave empty to use the default.')}
                        </label>
                        <input type="text" bind:value={dbPath} placeholder="defaults to {dataDir}/db" />
                    </div>
                    <div class="field">
                        <label>
                            MQTT topic prefix
                            {@render tip('Prefix for all sheDB MQTT topics. Defaults to she/db/ — documents publish to {prefix}doc/{id}, views to {prefix}view/{id}, commands use {prefix}set/{id} etc.')}
                        </label>
                        <input type="text" bind:value={dbPrefix} placeholder="she/db/ (default)" />
                    </div>
                    <div class="field field--check">
                        <span></span>
                        <label class="check-label">
                            <input type="checkbox" bind:checked={dbPublish} />
                            <span class="checkmark"></span>
                            Publish documents to MQTT
                            {@render tip('When enabled, every document change is published to {dbPrefix}doc/{id}. Individual views can publish independently via their own "mqttpub" setting.')}
                        </label>
                    </div>
                    {#if dbPublish}
                    <div class="field field--check">
                        <span></span>
                        <label class="check-label">
                            <input type="checkbox" bind:checked={dbRetain} />
                            <span class="checkmark"></span>
                            Retain document messages
                            {@render tip('When enabled, MQTT messages for document changes are published as retained messages.')}
                        </label>
                    </div>
                    {/if}
                    {/if}
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

                <!-- ── InfluxDB ──────────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'influx')}
                <section id="sec-influx">
                    <h3>InfluxDB</h3>
                    <div class="field">
                        <label>
                            URL
                            {@render tip('Base URL of the InfluxDB server, e.g. http://localhost:8086. Leave empty to disable the InfluxDB integration. Requires daemon restart.')}
                        </label>
                        <input type="text" bind:value={influxUrl} placeholder="leave empty to disable" spellcheck="false" />
                    </div>
                    <div class="field">
                        <label>
                            API version
                            {@render tip('InfluxDB 2.x uses token/org/bucket and Flux queries. InfluxDB 1.x uses database/username/password and InfluxQL queries (she.influx.query).')}
                        </label>
                        <select bind:value={influxVersion}>
                            <option value="2">2.x (token / org / bucket)</option>
                            <option value="1">1.x (database / username / password)</option>
                        </select>
                    </div>
                    {#if influxVersion === '2'}
                    <div class="field">
                        <label>
                            Token
                            {@render tip('InfluxDB API token. Stored in plain text in config.json.')}
                        </label>
                        <input type="password" bind:value={influxToken} placeholder="API token" autocomplete="off" />
                    </div>
                    <div class="field">
                        <label>
                            Organization
                            {@render tip('InfluxDB organization name.')}
                        </label>
                        <input type="text" bind:value={influxOrg} placeholder="my-org" spellcheck="false" />
                    </div>
                    <div class="field">
                        <label>
                            Bucket
                            {@render tip('Bucket that she.influx.write() writes to and getLast()/getRange() read from.')}
                        </label>
                        <input type="text" bind:value={influxBucket} placeholder="mqtt" spellcheck="false" />
                    </div>
                    {:else}
                    <div class="field">
                        <label>
                            Database
                            {@render tip('InfluxDB 1.x database name that she.influx writes to and reads from.')}
                        </label>
                        <input type="text" bind:value={influxDatabase} placeholder="she" spellcheck="false" />
                    </div>
                    <div class="field">
                        <label>
                            Username
                            {@render tip('InfluxDB 1.x username. Leave empty if authentication is disabled on the server.')}
                        </label>
                        <input type="text" bind:value={influxUsername} placeholder="(optional)" autocomplete="off" />
                    </div>
                    <div class="field">
                        <label>
                            Password
                            {@render tip('InfluxDB 1.x password. Stored in plain text in config.json.')}
                        </label>
                        <input type="password" bind:value={influxPassword} placeholder="(optional)" autocomplete="new-password" />
                    </div>
                    {/if}
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

                <!-- ── Script engine ─────────────────────────────── -->
                {#if visibleSections.some(s => s.id === 'engine')}
                <section id="sec-engine">
                    <h3>Script engine</h3>
                    <div class="field field--check">
                        <span></span>
                        <label class="check-label">
                            <input type="checkbox" bind:checked={heartbeatEnabled} />
                            <span class="checkmark"></span>
                            Enable event-loop heartbeat
                            {@render tip('When enabled, periodically measures event-loop lag and logs a warning when a user script callback blocks the loop longer than the threshold. Requires daemon restart.')}
                        </label>
                    </div>
                    <div class="field">
                        <label>
                            Heartbeat interval (ms)
                            {@render tip('How often the heartbeat fires, in milliseconds. Lower = finer resolution, slightly more overhead. Default: 50 ms.')}
                        </label>
                        <input type="number" bind:value={heartbeatInterval} min="10" max="5000" step="10" disabled={!heartbeatEnabled} placeholder="50" />
                    </div>
                    <div class="field">
                        <label>
                            Lag threshold (ms)
                            {@render tip('Minimum excess delay (beyond the interval) before a warning is logged. Default: 300 ms.')}
                        </label>
                        <input type="number" bind:value={heartbeatThreshold} min="50" max="60000" step="50" disabled={!heartbeatEnabled} placeholder="300" />
                    </div>
                    <div class="field field--check">
                        <span></span>
                        <label class="check-label">
                            <input type="checkbox" bind:checked={safeModeAutoDetect} />
                            <span class="checkmark"></span>
                            Safe mode after an unclean shutdown
                            {@render tip('She writes a .she-running marker into the data directory and removes it when it stops. If the marker is still there at startup, the previous run was killed rather than stopped — usually a script blocking the event loop — and she starts in safe mode: the web UI comes up but no script is loaded, so the offending script can be fixed. Turn this off if you routinely kill -9 the daemon or force-remove its container. Requires daemon restart.')}
                        </label>
                    </div>
                    <div class="field">
                        <label>
                            Script start timeout (ms)
                            {@render tip('How long a script\'s synchronous top-level code may run before it is terminated and the remaining scripts are loaded anyway. Only covers the initial run, not callbacks. 0 = no limit. Default: 5000 ms.')}
                        </label>
                        <input type="number" bind:value={scriptTimeout} min="0" max="120000" step="500" placeholder="5000" />
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
                            {@render tip('Choose a provider. Free options need a free API key from the provider\'s website — no credit card required.')}
                        </label>
                        <select bind:value={aiPreset} onchange={onPresetChange}>
                            {#each AI_PRESETS as preset}
                                <option value={preset.id}>{preset.label}</option>
                            {/each}
                        </select>
                    </div>
                    {#if activePreset?.freeNote || activePreset?.apiKeyUrl}
                        <div class="preset-note" class:free={!!activePreset.freeNote}>
                            {#if activePreset.freeNote}
                                <span class="free-badge">FREE</span> {activePreset.freeNote}
                            {/if}
                            {#if activePreset.apiKeyUrl}
                                &nbsp;— <a href={activePreset.apiKeyUrl} target="_blank" rel="noreferrer">Get API key ↗</a>
                            {/if}
                        </div>
                    {/if}
                    {#if aiPreset !== 'anthropic'}
                        <div class="field">
                            <label>
                                Base URL
                                {@render tip('Base URL of the LLM API. Auto-filled for cloud presets. For Ollama: http://localhost:11434.')} 
                            </label>
                            <input type="text" bind:value={aiBaseUrl} placeholder={
                                aiPreset === 'ollama'   ? 'http://localhost:11434' :
                                aiPreset === 'lmstudio' ? 'http://localhost:1234'  :
                                activePreset?.baseUrl ?? ''
                            } />
                        </div>
                    {/if}
                    <div class="field">
                        <label>
                            Model
                            {@render tip('Model identifier. Suggested default is filled in when you choose a preset.')} 
                        </label>
                        <input type="text" bind:value={aiModel} placeholder={activePreset?.defaultModel || 'e.g. llama3.2'} />
                    </div>
                    {#if aiPreset !== 'ollama' && aiPreset !== 'lmstudio'}
                        <div class="field">
                            <label>
                                API key
                                {@render tip('Stored in config.json. Not needed for local providers.')}
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

    .field label {
        font-size: 13px;
        color: var(--fg);
        display: flex;
        align-items: center;
        gap: 5px;
        white-space: nowrap;
    }

    /* ── custom checkbox ─────────────────────────────────────────── */
    .check-label {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        font-size: 13px;
        color: var(--fg);
        white-space: normal;
        user-select: none;
    }
    .check-label input[type='checkbox'] {
        position: absolute;
        opacity: 0;
        width: 0;
        height: 0;
        pointer-events: none;
    }
    .checkmark {
        flex-shrink: 0;
        width: 15px;
        height: 15px;
        border: 1.5px solid var(--border);
        border-radius: 3px;
        background: var(--bg-input);
        position: relative;
        transition: background 0.12s, border-color 0.12s;
    }
    .check-label input:checked + .checkmark {
        background: var(--accent);
        border-color: var(--accent);
    }
    .check-label input:checked + .checkmark::after {
        content: '';
        position: absolute;
        left: 4px;
        top: 1px;
        width: 4px;
        height: 8px;
        border: 1.5px solid #fff;
        border-top: none;
        border-left: none;
        transform: rotate(45deg);
    }
    .check-label:hover .checkmark { border-color: var(--accent); }
    .check-label.muted { opacity: 0.4; cursor: default; }
    .check-label.muted:hover .checkmark { border-color: var(--border); }

    .muted { opacity: 0.4; }

    /* ── feature toggle (enable/disable sections) ─────────────────── */
    .feature-toggle {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .feature-desc {
        margin: 0;
        font-size: 11px;
        color: var(--fg-muted);
        line-height: 1.5;
        padding-left: 23px; /* align under label text: 15px checkmark + 8px gap */
    }

    /* ── Services: remote host list + key ───────────────────────────── */

    /* ── feature toggle (enable/disable sections) ─────────────────── */
    .feature-toggle {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .feature-desc {
        margin: 0;
        font-size: 11px;
        color: var(--fg-muted);
        line-height: 1.5;
        padding-left: 23px; /* align with label text after the 15px checkmark + 8px gap */
    }

    input[type='text'],
    input[type='number'],
    input[type='password'],
    select,
    textarea {
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

    textarea {
        resize: vertical;
        font-family: monospace;
        font-size: 11px;
        line-height: 1.5;
    }

    input[type='text']:focus,
    input[type='number']:focus,
    input[type='password']:focus,
    select:focus,
    textarea:focus { border-color: var(--fg-brand); }

    input[type='checkbox'] {
        width: 14px;
        height: 14px;
        accent-color: var(--accent);
        cursor: pointer;
        flex-shrink: 0;
    }

    input::placeholder,
    textarea::placeholder { color: var(--fg-dim); }

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

    .field-error { font-size: 12px; color: var(--fg-err); padding: 2px 0; }
    .field-ok    { font-size: 12px; color: var(--fg-ok);  padding: 2px 0; }

    .preset-note {
        grid-column: 1 / -1;
        font-size: 11px;
        color: var(--fg-muted);
        padding: 4px 0 4px 212px;
        line-height: 1.4;
    }
    .preset-note.free { color: var(--fg-ok, #4caf50); }
    .preset-note a { color: inherit; text-decoration: underline; }
    .free-badge {
        display: inline-block;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.06em;
        padding: 1px 4px;
        border-radius: 3px;
        background: rgba(76, 175, 80, 0.18);
        border: 1px solid rgba(76, 175, 80, 0.4);
        color: var(--fg-ok, #4caf50);
        vertical-align: middle;
        margin-right: 2px;
    }

    .save-auth-btn {
        background: var(--accent);
        color: #fff;
        border: none;
        border-radius: 4px;
        padding: 6px 14px;
        font-size: 13px;
        cursor: pointer;
    }
    .save-auth-btn:disabled { opacity: 0.4; cursor: default; }
    .save-auth-btn:not(:disabled):hover { background: var(--accent-hov); }

    /* ── geo / map ───────────────────────────────────────────────────── */
    .geo-actions { align-items: flex-start; }
    .geo-btns { display: flex; gap: 6px; flex-wrap: wrap; }

    .geo-btn {
        background: var(--bg-input);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: 3px;
        padding: 4px 10px;
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
    }
    .geo-btn:hover:not(:disabled) { background: var(--bg-hover); }
    .geo-btn:disabled { opacity: 0.4; cursor: default; }

    .map-label { font-size: 13px; color: var(--fg); padding-top: 4px; }
    .map-note  { font-size: 11px; color: var(--fg-dim); font-weight: 400; }

    .map-container {
        width: 100%;
        height: 280px;
        border: 1px solid var(--border);
        border-radius: 3px;
        overflow: hidden;
    }
    .link-btn { background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font-size: inherit; text-decoration: underline; }
</style>
