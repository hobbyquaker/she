<script lang="ts">
    /* Adapters → Hosts: which hosts she manages adapters on (moved here from Settings). Edits are
       saved explicitly (Save); the setup command / manual form live in a view covering the tab. */
    import { onMount, onDestroy, untrack } from 'svelte';
    import {
        getConfig, patchConfig, getServiceHosts, testServicesSsh, testServiceHost, getServicesSshPubkey, generateServicesSshKey,
        createServicesSetupCommand, getServicesSetupState, getDaemonStatus, deployServiceHelper,
        updateHostNode, restartAllInstances, getNodeReleases,
        type ServiceHost, type SetupCommand, type HelperDeployResult, type NodeUpdateResult, type RestartAllResult,
        type NodeChannel, type NodeReleases,
    } from '../../lib/api.js';
    import RemoveHelper from './RemoveHelper.svelte';
    import ConfirmDialog from '../../lib/ConfirmDialog.svelte';

    let {
        onchanged,
        onupdates,
        onnodeupdates,
        generation = 0,
        origin = null,
    }: {
        onchanged?: () => void;
        onupdates?: (count: number) => void;
        onnodeupdates?: (count: number) => void;
        generation?: number;
        origin?: string | null;
    } = $props();

    type Remote = { host: string; port: number | ''; user: string; identityFile: string; hostname: string };
    let remotes = $state<Remote[]>([]);
    let snapshot = $state('');
    let status = $state<ServiceHost[]>([]);
    let loading = $state(true);
    let saving = $state(false);
    let error = $state('');
    let notice = $state('');
    let daemonUser = $state('');
    let dialog = $state<ConfirmDialog>();

    let view = $state<'list' | 'add'>('list');
    let editing = $state<number | null>(null);
    let removeOpen = $state<number | null>(null);
    let testResult = $state<Record<string, { ok: boolean; msg: string }>>({});
    let testing = $state<string | null>(null);

    // the helper she ships is newer than the one on the host — same action as on the
    // Installations tab, offered where the host and its helper version are shown
    // hosts whose helper is older than the one she ships — drives the yellow dot on the Hosts sub-tab
    let helperUpdateCount = $derived(status.filter(h => h.ok && h.helperOutdated).length);
    $effect(() => { onupdates?.(helperUpdateCount); });
    let helperBusy = $state<string | null>(null);
    let helperResult = $state<Record<string, HelperDeployResult | { error: string }>>({});
    async function updateHelper(hostName: string) {
        helperBusy = hostName;
        try {
            const r = await deployServiceHelper(hostName);
            helperResult = { ...helperResult, [hostName]: r };
            if (r.ok) {
                status = (await getServiceHosts(true)).hosts;
                onchanged?.();
            }
        } catch (e: any) {
            helperResult = { ...helperResult, [hostName]: { error: e.message ?? String(e) } };
        } finally {
            helperBusy = null;
        }
    }

    let helperAllBusy = $state(false);
    let helperAllAt = $state('');
    let outdatedHosts = $derived(status.filter((h) => h.ok && h.helperOutdated).map((h) => h.name));

    async function updateAllHelpers() {
        const todo = outdatedHosts;
        if (todo.length === 0 || helperAllBusy) return;
        helperAllBusy = true;
        try {
            for (const [i, name] of todo.entries()) {
                helperAllAt = `${i + 1} of ${todo.length}: ${name}`;
                try {
                    helperResult = { ...helperResult, [name]: await deployServiceHelper(name) };
                } catch (e: any) {
                    helperResult = { ...helperResult, [name]: { error: e.message ?? String(e) } };
                }
            }
            status = (await getServiceHosts(true)).hosts;
            onchanged?.();
        } finally {
            helperAllBusy = false;
            helperAllAt = '';
        }
    }

    // ── Node.js on the host (tj/n, helper v13) ─────────────────────────────────
    // The adapters run on the host's node, so it is managed where the host is: n installs
    // the requested channel, and the running instances keep the old binary until restarted.
    let nodeBusy = $state<string | null>(null);
    let nodeResult = $state<Record<string, NodeUpdateResult | { error: string }>>({});
    let restartBusy = $state<string | null>(null);
    let restartResult = $state<Record<string, RestartAllResult | { error: string }>>({});

    // what a click would install — asked once for all hosts (n's labels: lts and latest;
    // "stable" is only n's old alias for lts, not a third channel)
    let releases = $state<NodeReleases | null>(null);
    const CHANNELS: { key: NodeChannel; label: string }[] = [
        { key: 'stable', label: 'stable' },
        { key: 'lts', label: 'LTS' },
        { key: 'latest', label: 'latest' },
    ];
    // n resolves both stable and lts to the newest long-term-support release
    const targetOf = (c: NodeChannel) => (c === 'latest' ? releases?.latest : releases?.lts) ?? null;

    /** -1 / 0 / 1 for two "vX.Y.Z" strings; null when either is unknown. */
    function cmpVersion(a: string | null | undefined, b: string | null | undefined): number | null {
        if (!a || !b) return null;
        const parts = (v: string) => v.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
        const [pa, pb] = [parts(a), parts(b)];
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
        }
        return 0;
    }

    /**
     * Hosts with a Node.js worth updating — the yellow dot on the Hosts sub-tab and, through it,
     * on the Adapters entry in the main nav. A host that tracks an LTS line is only compared
     * against LTS: `latest` there is a jump to another major, not an update, and would leave the
     * dot on forever. A host already on the latest line is compared against latest.
     */
    const majorOf = (v: string | null | undefined) => (v ? Number(v.replace(/^v/, '').split('.')[0]) || 0 : 0);
    let nodeUpdateCount = $derived(
        status.filter((h) => {
            if (!h.ok || !h.node || !releases) return false;
            const onLatestLine = !!releases.latest && majorOf(h.node) === majorOf(releases.latest);
            const target = onLatestLine ? releases.latest : releases.lts;
            return !!target && cmpVersion(target, h.node) === 1;
        }).length,
    );
    $effect(() => { onnodeupdates?.(nodeUpdateCount); });

    /** All three labels, each either an update to offer or a "you are on it" state. */
    function channelsFor(st: ServiceHost): { key: NodeChannel; label: string; target: string | null; current: boolean; downgrade: boolean }[] {
        return CHANNELS.map((c) => {
            const target = targetOf(c.key);
            return { ...c, target, current: !!target && target === st.node, downgrade: cmpVersion(target, st.node) === -1 };
        });
    }

    async function updateNode(hostName: string, channel: NodeChannel) {
        const isLocal = statusOf(hostName)?.local === true;
        const ok = await dialog?.show(
            `Install Node.js ${targetOf(channel) ?? `"${channel}"`} on ${hostName} with n install ${channel}? ` +
                'This replaces the host\'s node binary; running adapters keep the current version until they are restarted.' +
                (isLocal ? ' she runs on this host too — it keeps the old binary until the daemon itself is restarted.' : ''),
            { confirm: 'Update Node.js' },
        );
        if (!ok) return;
        nodeBusy = hostName;
        restartResult = { ...restartResult, [hostName]: undefined as any };
        try {
            const r = await updateHostNode(hostName, channel);
            nodeResult = { ...nodeResult, [hostName]: r };
            status = (await getServiceHosts(true)).hosts;
            onchanged?.();
        } catch (e: any) {
            nodeResult = { ...nodeResult, [hostName]: { error: e.message ?? String(e) } };
        } finally {
            nodeBusy = null;
        }
    }

    async function restartAll(hostName: string) {
        restartBusy = hostName;
        try {
            restartResult = { ...restartResult, [hostName]: await restartAllInstances(hostName) };
            onchanged?.();
        } catch (e: any) {
            restartResult = { ...restartResult, [hostName]: { error: e.message ?? String(e) } };
        } finally {
            restartBusy = null;
        }
    }

    // ssh key
    let pubkey = $state<string | null>(null);
    let keyFile = $state('');
    let keyBusy = $state(false);
    let keyCopied = $state(false);

    // manual add form
    let form = $state<Remote>({ host: '', port: '', user: '', identityFile: '', hostname: '' });
    let formTest = $state<{ ok: boolean; msg: string } | null>(null);
    let formTesting = $state(false);

    // setup command (I9)
    let setupOrigin = $state(location.origin);
    let setupCmd = $state<SetupCommand | null>(null);
    let setupState = $state<'pending' | 'fetched' | 'done' | 'expired' | null>(null);
    let setupHost = $state('');
    let setupBusy = $state(false);
    let setupErr = $state('');
    let setupCopied = $state(false);
    let setupPoll: ReturnType<typeof setInterval> | null = null;

    const dirty = $derived(JSON.stringify({ remotes }) !== snapshot);
    const statusOf = (name: string) => status.find((s) => s.name === name) ?? null;
    const localStatus = $derived(status.find((s) => s.local) ?? null);

    /** Cards are indexed by position (edit/remove use the index), so the list itself is kept sorted by label. */
    const byLabel = (a: Remote, b: Remote) =>
        (a.hostname || a.host).localeCompare(b.hostname || b.host, undefined, { numeric: true, sensitivity: 'base' });

    function fromConfig(cfg: Record<string, unknown>) {
        const svc = cfg.services as Record<string, unknown> | undefined;
        const list = Array.isArray(svc?.hosts) ? (svc!.hosts as any[]) : null;
        remotes = (list ?? []).filter((h) => h && h.ssh).map((h) => ({
            host: String(h.ssh.host ?? ''), port: typeof h.ssh.port === 'number' ? h.ssh.port : '',
            user: String(h.ssh.user ?? ''), identityFile: String(h.ssh.identityFile ?? ''), hostname: String(h.hostname ?? ''),
        })).sort(byLabel);
        snapshot = JSON.stringify({ remotes });
    }
    async function load(refresh = false) {
        loading = true;
        error = '';
        try {
            const [cfg, st] = await Promise.all([getConfig(), getServiceHosts(refresh).catch(() => ({ hosts: [] as ServiceHost[] }))]);
            fromConfig(cfg);
            status = st.hosts;
        } catch (e: any) {
            error = e.message ?? String(e);
        } finally {
            loading = false;
        }
        loadKey();
    }
    async function loadKey() {
        try {
            const r = await getServicesSshPubkey();
            pubkey = r.publicKey;
            keyFile = r.identityFile;
        } catch { /* best effort */ }
        try {
            daemonUser = (await getDaemonStatus()).user ?? '';
        } catch { /* best effort */ }
    }
    onMount(() => load());

    // something changed on another tab (an adapter installed, an instance removed): ask the
    // hosts again. Unsaved edits in this form win — only the status half is refreshed then.
    // The generation guard and untrack keep this out of a loop: reading `dirty` and then
    // reloading the form would re-trigger the effect through the very state it writes.
    let seenGeneration = 0;
    $effect(() => {
        const g = generation;
        if (g === seenGeneration) return;
        seenGeneration = g;
        untrack(() => {
            if (origin === 'hostsconf') return;
            void (async () => {
                if (dirty) {
                    try {
                        status = (await getServiceHosts(true)).hosts;
                    } catch { /* keep what is on screen */ }
                } else {
                    await load(true);
                }
            })();
        });
    });
    onMount(async () => {
        try {
            releases = await getNodeReleases();
        } catch { /* the buttons fall back to plain labels */ }
    });
    onDestroy(() => stopPoll());

    function flash(msg: string) {
        notice = msg;
        setTimeout(() => { if (notice === msg) notice = ''; }, 3000);
    }

    async function save() {
        saving = true;
        error = '';
        try {
            // the she host is always in the list — adapters installed next to she are hers to manage
            const hosts: Record<string, unknown>[] = [{ name: 'local' }];
            for (const r of remotes) {
                if (!r.host.trim()) continue;
                const ssh: Record<string, unknown> = { host: r.host.trim() };
                if (r.port !== '' && Number(r.port) > 0) ssh.port = Number(r.port);
                if (r.user.trim()) ssh.user = r.user.trim();
                if (r.identityFile.trim()) ssh.identityFile = r.identityFile.trim();
                hosts.push({ ...(r.hostname.trim() ? { hostname: r.hostname.trim() } : {}), ssh });
            }
            await patchConfig('services.hosts', hosts);
            window.dispatchEvent(new CustomEvent('she:config-changed'));
            snapshot = JSON.stringify({ remotes });
            editing = null;
            flash('saved');
            onchanged?.();
            status = (await getServiceHosts(true)).hosts;
        } catch (e: any) {
            error = e.message ?? String(e);
        } finally {
            saving = false;
        }
    }
    function discard() {
        const s = JSON.parse(snapshot);
        remotes = s.remotes;
        editing = null;
    }

    async function test(r: Remote) {
        const key = r.host;
        testing = key;
        try {
            const res = await testServicesSsh({ host: r.host.trim(), port: r.port, user: r.user.trim(), identityFile: r.identityFile.trim() });
            testResult = { ...testResult, [key]: res.ok ? { ok: true, msg: `helper v${res.helper ?? '?'}` } : { ok: false, msg: `${res.code}: ${res.error}` } };
        } catch (e: any) {
            testResult = { ...testResult, [key]: { ok: false, msg: e.message ?? String(e) } };
        } finally {
            testing = null;
        }
    }
    async function testLocal() {
        testing = 'local';
        try {
            const res = await testServiceHost('local');
            testResult = { ...testResult, local: res.ok ? { ok: true, msg: `helper v${res.helper ?? '?'}` } : { ok: false, msg: `${res.code}: ${res.error}` } };
        } catch (e: any) {
            testResult = { ...testResult, local: { ok: false, msg: e.message ?? String(e) } };
        } finally {
            testing = null;
        }
    }
    async function dropFromList(i: number) {
        const r = remotes[i];
        if (!(await dialog?.show(`Remove ${r.hostname || r.host} from the list? she stops managing it; nothing on the host is changed (use "Remove from host…" for that).`, { confirm: 'Remove', danger: true }))) return;
        remotes = remotes.filter((_, idx) => idx !== i);
        if (editing === i) editing = null;
    }

    // ── add view
    function openAdd() {
        form = { host: '', port: '', user: '', identityFile: '', hostname: '' };
        formTest = null;
        setupErr = '';
        view = 'add';
    }
    async function testForm() {
        if (!form.host.trim()) { formTest = { ok: false, msg: 'enter a host first' }; return; }
        formTesting = true;
        try {
            const res = await testServicesSsh({ host: form.host.trim(), port: form.port, user: form.user.trim(), identityFile: form.identityFile.trim() });
            formTest = res.ok ? { ok: true, msg: `helper v${res.helper ?? '?'}` } : { ok: false, msg: `${res.code}: ${res.error}` };
        } catch (e: any) {
            formTest = { ok: false, msg: e.message ?? String(e) };
        } finally {
            formTesting = false;
        }
    }
    function addManual() {
        if (!form.host.trim()) return;
        remotes = [...remotes, { ...form, host: form.host.trim(), user: form.user.trim(), identityFile: form.identityFile.trim(), hostname: form.hostname.trim() }].sort(byLabel);
        view = 'list';
        flash('host added — Save to keep it');
    }
    function stopPoll() { if (setupPoll) { clearInterval(setupPoll); setupPoll = null; } }
    async function createSetup() {
        setupBusy = true; setupErr = ''; setupCmd = null; setupState = null; setupHost = ''; setupCopied = false; stopPoll();
        try {
            setupCmd = await createServicesSetupCommand(setupOrigin.trim().replace(/\/+$/, ''));
            setupState = 'pending';
            loadKey();
            setupPoll = setInterval(async () => {
                if (!setupCmd) return stopPoll();
                try {
                    const st = await getServicesSetupState(setupCmd.token);
                    setupState = st.status;
                    if (st.status === 'done') {
                        setupHost = st.host ?? '';
                        stopPoll();
                        // the daemon wrote the host entry itself — re-read, nothing to save
                        fromConfig(await getConfig());
                        status = (await getServiceHosts(true)).hosts;
                        onchanged?.();
                    } else if (st.status === 'expired') stopPoll();
                } catch { /* keep polling */ }
            }, 3000);
        } catch (e: any) {
            setupErr = e.message ?? String(e);
        } finally {
            setupBusy = false;
        }
    }
    async function copy(text: string, mark: (v: boolean) => void) {
        try { await navigator.clipboard.writeText(text); mark(true); setTimeout(() => mark(false), 2000); } catch { /* clipboard blocked */ }
    }
    async function generateKey() {
        if (pubkey && !(await dialog?.show('Regenerate the services SSH key? Every remote host then needs the new public key (re-run the setup command, or replace it in authorized_keys).', { confirm: 'Regenerate', danger: true }))) return;
        keyBusy = true;
        try {
            const r = await generateServicesSshKey();
            pubkey = r.publicKey;
            keyFile = r.identityFile;
            flash('key generated');
        } catch (e: any) {
            error = e.message ?? String(e);
        } finally {
            keyBusy = false;
        }
    }
</script>

<ConfirmDialog bind:this={dialog} />

{#snippet mark(key: string)}
    {#if testResult[key]}
        {@const t = testResult[key]}
        <span class="test-mark" class:ok={t.ok} class:err={!t.ok} title={t.msg}>{t.ok ? '✓' : `✗ ${t.msg}`}</span>
    {/if}
{/snippet}

<!-- helper version, and the update when she ships a newer one (same action as the Installations tab) -->
{#snippet helper(name: string, st: ServiceHost)}
    <span class="muted">helper v{st.helper}{#if st.helperOutdated} <span class="warn">— outdated</span>{/if}</span>
    {#if st.helperOutdated}
        <button
            class="ghost sm"
            onclick={() => updateHelper(name)}
            disabled={helperBusy !== null}
            title="she ships a newer she-servicectl — replace it (the helper updates itself through the sudo rule it already has)"
        >{helperBusy === name ? 'Updating…' : 'Update helper'}</button>
    {/if}
{/snippet}

<!-- result boxes stay until they are read, so every one of them can be closed -->
{#snippet dismiss(close: () => void)}
    <button class="box-x" onclick={close} title="Dismiss" aria-label="Dismiss">×</button>
{/snippet}

<!-- node version of the host, and updating it through tj/n (helper v13) -->
{#snippet nodeRow(name: string, st: ServiceHost)}
    {@const offers = channelsFor(st)}
    <div class="node-row">
        <span class="muted">Node.js</span>
        <span class="mono">{st.node ?? 'unknown'}</span>
        {#each offers as c (c.key)}
            {#if c.current}
                <span class="ok-pill" title="This host runs the {c.key === 'latest' ? 'newest Node.js release' : `newest long-term-support release${releases?.ltsName ? ` (${releases.ltsName})` : ''}`} — nothing to install">
                    {c.label} <span class="mono">{c.target}</span> ✓
                </span>
            {:else}
                <button
                    class="ghost sm"
                    onclick={() => updateNode(name, c.key)}
                    disabled={nodeBusy !== null || restartBusy !== null}
                    title="{c.downgrade ? 'Switch' : 'Update'} this host to what n installs for {c.key}: the {c.key === 'latest' ? 'newest' : 'newest long-term-support'} Node.js release{releases?.ltsName && c.key !== 'latest' ? ` (${releases.ltsName})` : ''}"
                >
                    {nodeBusy === name ? 'Updating…' : `${c.downgrade ? 'Switch to' : 'Update'} ${c.label}`}
                    {#if c.target}<span class="ver-pill">{c.target}</span>{/if}
                </button>
            {/if}
        {/each}
        {#if releases?.stale}
            <span class="muted" title="nodejs.org could not be reached — these may not be the current versions">versions may be stale</span>
        {/if}
    </div>
    {#if nodeResult[name]}
        {@const n = nodeResult[name]}
        <div class="deploy-box in-card" class:deploy-ok={'ok' in n && n.ok}>
            {@render dismiss(() => { nodeResult = { ...nodeResult, [name]: undefined as any }; })}
            {#if 'error' in n}
                {n.error}
            {:else if n.mismatch}
                n installed Node.js <span class="mono">{n.installed}</span> to <span class="mono">{n.installedPath}</span>, but
                <span class="mono">{n.activePath ?? 'node'}</span> still wins on PATH with <span class="mono">{n.after ?? 'nothing'}</span> —
                the adapters keep running on that one. Remove the other install (distro package, nvm, an <span class="mono">/opt</span> wrapper)
                or put <span class="mono">{n.installedPath.replace('/node', '')}</span> first in PATH.
            {:else if n.restartRequired}
                Node.js {n.before ?? '—'} → <span class="mono">{n.after}</span> (n {n.n}{#if n.nInstalled}, installed{/if}).
                The running instances still use the old binary — restart them to pick up the new one.
                <div class="node-row">
                    <button class="ghost sm" onclick={() => restartAll(name)} disabled={restartBusy !== null || nodeBusy !== null}>
                        {restartBusy === name ? 'Restarting…' : 'Restart all instances'}
                    </button>
                </div>
            {:else}
                Node.js <span class="mono">{n.after ?? n.before}</span> is already what n installs for <span class="mono">{n.spec}</span> (n {n.n}{#if n.nInstalled}, installed{/if}).
            {/if}
        </div>
    {/if}
    {#if restartResult[name]}
        {@const r = restartResult[name]}
        <div class="deploy-box in-card" class:deploy-ok={'ok' in r && r.ok}>
            {@render dismiss(() => { restartResult = { ...restartResult, [name]: undefined as any }; })}
            {#if 'error' in r}
                {r.error}
            {:else if r.restarted.length === 0 && r.failed.length === 0}
                No running instances on this host.
            {:else}
                Restarted {r.restarted.length} instance{r.restarted.length === 1 ? '' : 's'}{#if r.failed.length > 0}, {r.failed.length} failed: {r.failed.map((f) => `${f.adapter}@${f.instance}`).join(', ')}{/if}.
            {/if}
        </div>
    {/if}
{/snippet}

{#snippet helperBox(name: string)}
    {#if helperResult[name]}
        {@const d = helperResult[name]}
        <div class="deploy-box in-card" class:deploy-ok={'ok' in d && d.ok}>
            {@render dismiss(() => { helperResult = { ...helperResult, [name]: undefined as any }; })}
            {#if 'error' in d && d.error && !('ok' in d)}
                {d.error}
            {:else if 'ok' in d && d.ok}
                Helper v{d.helper} {d.method === 'self-update' ? 'updated' : 'installed'} on {name}.
            {:else if 'ok' in d}
                {#if d.installed}Helper installed, but <span class="mono">sudo</span> does not allow it for <span class="mono">{d.user}</span> yet.{:else}Helper uploaded to the SSH user's home; installing it needs root.{/if}
                Run on the host as an admin:
                <pre class="mono">{(d.instructions ?? []).join('\n')}</pre>
                {#if d.error}<div class="muted">{d.error}</div>{/if}
            {/if}
        </div>
    {/if}
{/snippet}

<div class="hc">
    {#if view === 'add'}
        <div class="sheet-head">
            <button class="ghost sm" onclick={() => (view = 'list')}>← Hosts</button>
            <strong>Add remote host</strong>
            <span class="muted">a host she reaches over SSH to manage the adapters installed there</span>
        </div>
        <div class="content narrow">
            <div class="box">
                <div class="box-title">Recommended: one command on the host</div>
                <div class="muted">Run as root on the target. It creates the user <span class="mono">she-services</span>, installs she's SSH key, the <span class="mono">she-servicectl</span> helper and its single sudoers rule, then registers the host here — nothing to type into a form. Valid for 15 minutes, works once; the sha256 lets you read the script first.</div>
                <div class="row">
                    <span class="lbl">she reachable from the host at</span>
                    <input type="text" bind:value={setupOrigin} spellcheck="false" style="width:280px" />
                    <button onclick={createSetup} disabled={setupBusy}>{setupBusy ? 'Preparing…' : 'Create setup command'}</button>
                </div>
                {#if setupErr}<div class="err">{setupErr}</div>{/if}
                {#if setupCmd}
                    <div class="cmd"><code>{setupCmd.command}</code><button class="ghost sm" onclick={() => copy(setupCmd!.command, (v) => (setupCopied = v))}>{setupCopied ? 'Copied' : 'Copy'}</button></div>
                    <div class="muted">Valid until {new Date(setupCmd.expires).toLocaleTimeString()}, single use. To read it first: <span class="mono">curl -fsSL '{setupCmd.scriptUrl}' -o she-setup.sh</span> — sha256 <span class="mono sha">{setupCmd.sha256}</span></div>
                    <div class="state">
                        {#if setupState === 'pending'}<span class="spinner"></span> waiting for the host to fetch the script…
                        {:else if setupState === 'fetched'}<span class="spinner"></span> script fetched, running on the host…
                        {:else if setupState === 'done'}<span class="ok">✓ {setupHost} registered as <span class="mono">{setupCmd.user}</span> — it is in the list.</span> <button class="ghost sm" onclick={() => (view = 'list')}>← Hosts</button>
                        {:else if setupState === 'expired'}command expired — create a new one.{/if}
                    </div>
                {/if}
            </div>
            <div class="box">
                <div class="box-title">By hand: existing SSH access</div>
                <div class="muted">Put the public key (below on the Hosts tab) into <span class="mono">~/.ssh/authorized_keys</span> of the SSH user on the host — <span class="mono">root</span> needs nothing else, another user needs the helper's sudoers line (<em>Deploy helper</em> above prints it).</div>
                <div class="grid">
                    <label><span>host</span><input type="text" placeholder="zigbee.lan" bind:value={form.host} spellcheck="false" /></label>
                    <label><span>port</span><input type="number" placeholder="22" bind:value={form.port} /></label>
                    <label><span>user</span><input type="text" placeholder={daemonUser ? `${daemonUser} (default)` : 'user she runs as'} bind:value={form.user} spellcheck="false" /></label>
                    <label class="wide"><span>identity file</span><input type="text" placeholder="services key (default)" bind:value={form.identityFile} spellcheck="false" /></label>
                </div>
                <div class="row">
                    <button class="ghost sm" onclick={testForm} disabled={formTesting}>{formTesting ? 'Testing…' : 'Test connection'}</button>
                    {#if formTest}<span class="test-mark" class:ok={formTest.ok} class:err={!formTest.ok}>{formTest.ok ? `✓ ${formTest.msg}` : `✗ ${formTest.msg}`}</span>{/if}
                    <span class="spacer"></span>
                    <button onclick={addManual} disabled={!form.host.trim()}>Add to list</button>
                </div>
            </div>
        </div>
    {:else}
        <div class="bar">
            <button class="ghost" onclick={() => load(true)} disabled={loading} title="Reload"><span class:spinning={loading}>↺</span></button>
            <button class="ghost" onclick={openAdd}>+ Add remote host</button>
            <span class="muted">{remotes.length + 1} host{remotes.length === 0 ? '' : 's'}</span>
            {#if loading}<span class="spinner" title="Asking every host…"></span>{/if}
            {#if outdatedHosts.length > 1}
                <button class="ghost sm" onclick={updateAllHelpers} disabled={helperAllBusy || helperBusy !== null} title="Replace she-servicectl on every host that runs an older one, in turn">
                    {helperAllBusy ? `Updating ${helperAllAt}…` : `Update all helpers (${outdatedHosts.length})`}
                </button>
            {/if}
            <span class="spacer"></span>
            {#if notice}<span class="ok">{notice}</span>{/if}
            {#if dirty}
                <span class="muted">unsaved changes</span>
                <button class="ghost" onclick={discard} disabled={saving}>Discard</button>
                <button onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            {/if}
        </div>
        {#if error}<div class="err-box">{error}</div>{/if}

        <div class="content">
            <div class="card">
                <div class="card-head">
                    <span class="dot" class:ok={localStatus?.ok} class:err={localStatus && !localStatus.ok}></span>
                    <span class="name">{localStatus?.hostname ?? 'this host'}</span>
                    <span class="muted">the she host itself</span>
                    <span class="spacer"></span>
                    {#if localStatus?.ok}{@render helper('local', localStatus)}{/if}
                    <button class="ghost sm" onclick={testLocal} disabled={testing !== null}>Test</button>{@render mark('local')}
                </div>
                {#if localStatus?.ok}{@render nodeRow('local', localStatus)}{/if}
                {@render helperBox('local')}
                {#if localStatus && !localStatus.ok}<div class="err-box in-card">{localStatus.error}{#if localStatus.code === 'HELPER_MISSING'}{' '}— run <span class="mono">sudo she --install</span>{/if}</div>{/if}
            </div>

            {#each remotes as r, i (i)}
                {@const st = statusOf(r.host)}
                <div class="card">
                    <div class="card-head">
                        <span class="dot" class:ok={st?.ok} class:err={st && !st.ok}></span>
                        <span class="name">{r.hostname || st?.hostname || r.host}</span>
                        <span class="muted mono">{r.user || daemonUser || '?'}@{r.host}{r.port ? `:${r.port}` : ''}</span>
                        {#if r.identityFile}<span class="muted" title={r.identityFile}>own key</span>{/if}
                        <span class="spacer"></span>
                        {#if st?.ok}{@render helper(r.host, st)}
                        {:else if st && !st.ok}
                            <!-- the host has no usable helper yet: deploying it lives here too, next to the host entry -->
                            <button
                                class="ghost sm"
                                onclick={() => updateHelper(r.host)}
                                disabled={helperBusy !== null}
                                title="Copy she-servicectl to the host and install it (prints the sudoers line when sudo refuses)"
                            >{helperBusy === r.host ? 'Deploying…' : 'Deploy helper'}</button>
                        {/if}
                        <button class="ghost sm" onclick={() => test(r)} disabled={testing !== null || !r.host.trim()}>Test</button>{@render mark(r.host)}
                        <button class="ghost sm" class:active={editing === i} onclick={() => (editing = editing === i ? null : i)}>Edit</button>
                        <button class="ghost sm" class:active={removeOpen === i} onclick={() => (removeOpen = removeOpen === i ? null : i)} title="Remove she from the host: only its SSH key, or everything the setup command created">Remove from host…</button>
                        <button class="ghost sm" onclick={() => dropFromList(i)} title="Remove from the list (nothing on the host changes)">×</button>
                    </div>
                    {#if st?.ok}{@render nodeRow(r.host, st)}{/if}
                    {@render helperBox(r.host)}
                    {#if st && !st.ok}<div class="err-box in-card">{st.error}</div>{/if}
                    {#if editing === i}
                        <div class="grid edit">
                            <label><span>host</span><input type="text" bind:value={r.host} spellcheck="false" /></label>
                            <label><span>port</span><input type="number" placeholder="22" bind:value={r.port} /></label>
                            <label><span>user</span><input type="text" placeholder={daemonUser ? `${daemonUser} (default)` : 'user she runs as'} bind:value={r.user} spellcheck="false" /></label>
                            <label><span>identity file</span><input type="text" placeholder="services key (default)" bind:value={r.identityFile} spellcheck="false" /></label>
                            <label><span>hostname (as adapters report it in info.host; captured automatically)</span><input type="text" bind:value={r.hostname} spellcheck="false" /></label>
                        </div>
                    {/if}
                    {#if removeOpen === i}
                        <div class="in-card"><RemoveHelper host={r.host} label={r.hostname || r.host} onclose={() => (removeOpen = null)} ondone={() => { removeOpen = null; load(true); onchanged?.(); }} /></div>
                    {/if}
                </div>
            {/each}
            {#if remotes.length === 0 && !loading}
                <div class="muted empty">No remote hosts — <em>+ Add remote host</em> sets one up with a single command.</div>
            {/if}

            <div class="card key">
                <div class="card-head">
                    <span class="name">SSH key</span>
                    <span class="muted">one Ed25519 key for all remote hosts, stored in the data directory</span>
                    <span class="spacer"></span>
                    {#if pubkey}<button class="ghost sm" onclick={() => copy(pubkey!, (v) => (keyCopied = v))}>{keyCopied ? 'Copied' : 'Copy public key'}</button>{/if}
                    <button class="ghost sm" onclick={generateKey} disabled={keyBusy}>{keyBusy ? 'Generating…' : pubkey ? 'Regenerate' : 'Generate key'}</button>
                </div>
                {#if pubkey}
                    <code class="pub">{pubkey}</code>
                    <div class="muted">{keyFile}</div>
                {:else}
                    <div class="muted">No services key yet ({keyFile || 'data-dir/ssh/services_id_ed25519'}) — the setup command creates it.</div>
                {/if}
            </div>
        </div>
    {/if}
</div>

<style>
    .deploy-box { background: rgba(230,126,34,0.10); border: 1px solid rgba(230,126,34,0.35); border-radius: 3px; padding: 6px 10px; font-size: 12px; }
    .deploy-box.deploy-ok { background: rgba(39,174,96,0.12); border-color: rgba(39,174,96,0.35); }
    .deploy-box pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-all; background: var(--bg-app); border: 1px solid var(--border); border-radius: 3px; padding: 6px 8px; font-size: 11px; }
    .hc { flex: 1; display: flex; flex-direction: column; overflow: hidden; font-size: 12px; color: var(--fg); }
    .bar, .sheet-head { display: flex; align-items: center; gap: 8px; padding: 5px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .content { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
    .content.narrow { max-width: 820px; }
    .spacer { flex: 1; }
    .muted { color: var(--fg-muted); font-size: 11px; }
    .mono { font-family: var(--font-mono, monospace); font-size: 11px; }
    .ok { color: #27ae60; font-size: 12px; }
    .warn { color: #d4ac0d; }
    .err { color: #e88; font-size: 11px; }
    .err-box { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.35); border-radius: 3px; color: #e88; padding: 6px 10px; margin: 8px 12px 0; }
    .err-box.in-card { margin: 8px 0 0; }
    .in-card { margin-top: 8px; }
    .card { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; }
    .card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .name { font-weight: 600; font-size: 13px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-muted); flex-shrink: 0; }
    .dot.ok { background: #27ae60; }
    .dot.err { background: #e74c3c; }
    .empty { padding: 4px 2px; }
    .grid { display: grid; grid-template-columns: 3fr 72px 2fr; gap: 6px 10px; }
    .grid.edit { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
    .grid label { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .grid label.wide { grid-column: 1 / -1; }
    .grid label > span { font-size: 10px; color: var(--fg-muted); }
    input[type='text'], input[type='number'] { font-size: 12px; padding: 3px 6px; width: 100%; box-sizing: border-box; background: var(--bg-input, var(--bg)); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .row .lbl { color: var(--fg-muted); }
    .box { border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; display: flex; flex-direction: column; gap: 8px; background: var(--bg-panel); }
    .box-title { font-weight: 600; font-size: 13px; }
    .cmd { display: flex; align-items: center; gap: 8px; }
    .cmd code { flex: 1; font-family: var(--font-mono, monospace); font-size: 11px; background: var(--bg-app, var(--bg)); border: 1px solid var(--border); border-radius: 3px; padding: 4px 6px; word-break: break-all; user-select: all; }
    .sha { word-break: break-all; }
    .state { display: flex; align-items: center; gap: 6px; }
    .pub { display: block; font-family: var(--font-mono, monospace); font-size: 11px; word-break: break-all; user-select: all; margin-top: 8px; background: var(--bg-app, var(--bg)); border: 1px solid var(--border); border-radius: 3px; padding: 4px 6px; }
    .test-mark { font-size: 12px; white-space: nowrap; }
    .test-mark.ok { color: #27ae60; font-weight: 700; }
    .test-mark.err { color: #e74c3c; }
    @keyframes spin { to { transform: rotate(360deg); } }
    /* the reload glyph turns while the listing is being fetched — same as the Catalog tab */
    .spinning { display: inline-block; animation: spin 0.8s linear infinite; }
    .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
    button { background: var(--accent); border: none; color: #fff; padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    button.ghost.active { color: var(--accent); border-color: var(--accent); }
    button.sm { padding: 1px 7px; font-size: 11px; }

    /* version a click would install, in the button itself */
    .ver-pill {
        background: var(--bg-widget);
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--fg-brand);
        font-family: monospace;
        font-size: 10px;
        margin-left: 5px;
        padding: 0 5px;
    }

    /* a channel the host is already on */
    .ok-pill {
        background: rgba(39,174,96,0.12);
        border: 1px solid rgba(39,174,96,0.35);
        border-radius: 9px;
        color: var(--fg-ok);
        font-size: 11px;
        padding: 1px 8px;
        white-space: nowrap;
    }
    .ok-pill .mono { font-size: 10px; }

    /* dismiss × in the corner of a result box */
    .box-x {
        background: none;
        border: none;
        color: var(--fg-muted);
        cursor: pointer;
        float: right;
        font-size: 14px;
        line-height: 1;
        margin: -2px -2px 0 6px;
        padding: 0 2px;
    }
    .box-x:hover { color: var(--fg); }

    .node-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 10px 0;
        font-size: 12px;
    }
</style>
