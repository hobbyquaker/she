<script lang="ts">
    /* Secrets tab (roadmap A5): groups of named string values for scripts (she.secrets.get('group/field')).
       Write-only by design — the daemon never returns a value, so inputs are empty until you type. */
    import { listSecrets, putSecret, deleteSecret, markSecret, type SecretsOverview, type SecretGroup } from '../lib/api.js';
    import ConfirmDialog from '../lib/ConfirmDialog.svelte';

    let { active = true }: { active?: boolean } = $props();

    let overview = $state<SecretsOverview | null>(null);
    let selected = $state<string | null>(null);
    let error = $state('');
    let notice = $state('');
    let busy = $state(false);
    let newGroup = $state('');
    let newField = $state('');
    let newValue = $state('');
    let newSecret = $state(true);
    let drafts = $state<Record<string, string>>({});
    let reveal = $state(false);
    let dialog = $state<ConfirmDialog>();
    let loadedOnce = false;

    const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
    const group = $derived<SecretGroup | null>(overview?.groups.find((g) => g.name === selected) ?? null);
    const locked = $derived(overview?.status === 'locked' || overview?.status === 'error');

    async function load() {
        try {
            overview = await listSecrets();
            error = '';
            if (selected && !overview.groups.some((g) => g.name === selected)) selected = null;
            if (!selected && overview.groups.length > 0) selected = overview.groups[0].name;
        } catch (e: any) {
            error = e.message ?? String(e);
        }
    }
    $effect(() => {
        if (active && !loadedOnce) {
            loadedOnce = true;
            load();
        }
    });

    function flash(msg: string) {
        notice = msg;
        setTimeout(() => { if (notice === msg) notice = ''; }, 2500);
    }

    async function save(g: string, f: string, value: string, secret = true) {
        if (!value) return;
        busy = true;
        try {
            await putSecret(g, f, value, secret);
            drafts = { ...drafts, [`${g}/${f}`]: '' };
            newField = ''; newValue = ''; newSecret = true;
            flash(`saved ${g}/${f}`);
            await load();
            selected = g;
        } catch (e: any) {
            error = e.message ?? String(e);
        } finally {
            busy = false;
        }
    }
    async function addGroup() {
        const g = newGroup.trim();
        if (!NAME_RE.test(g)) { error = 'group name: letters, digits, _ . - (max 64)'; return; }
        // a group exists through its first field — select it and let the field form create it
        if (!overview?.groups.some((x) => x.name === g)) {
            overview = overview ? { ...overview, groups: [...overview.groups, { name: g, changed: 0, fields: [] }].sort((a, b) => a.name.localeCompare(b.name)) } : overview;
        }
        selected = g;
        newGroup = '';
        error = '';
    }
    async function lock(g: string, f: string) {
        if (!(await dialog?.show(`Mark ${g}/${f} as secret? Its value will never be shown again — not here, not through the API. Scripts keep reading it. This cannot be undone (delete and re-create to change your mind).`, { confirm: 'Mark secret', danger: true }))) return;
        busy = true;
        try {
            await markSecret(g, f);
            drafts = { ...drafts, [`${g}/${f}`]: '' };
            flash(`${g}/${f} is secret now`);
            await load();
        } catch (e: any) {
            error = e.message ?? String(e);
        } finally {
            busy = false;
        }
    }
    async function removeField(g: string, f: string) {
        if (!(await dialog?.show(`Delete secret ${g}/${f}? Scripts reading it get undefined from now on.`, { confirm: 'Delete', danger: true }))) return;
        busy = true;
        try {
            await deleteSecret(g, f);
            flash(`deleted ${g}/${f}`);
            await load();
        } catch (e: any) {
            error = e.message ?? String(e);
        } finally {
            busy = false;
        }
    }
    async function removeGroup(g: string) {
        const fields = group?.fields.length ?? 0;
        if (fields === 0) {
            overview = overview ? { ...overview, groups: overview.groups.filter((x) => x.name !== g) } : overview;
            selected = overview?.groups[0]?.name ?? null;
            return;
        }
        if (!(await dialog?.show(`Delete the group ${g} with its ${fields} secret${fields === 1 ? '' : 's'}?`, { confirm: 'Delete group', danger: true }))) return;
        busy = true;
        try {
            await deleteSecret(g);
            flash(`deleted ${g}`);
            selected = null;
            await load();
        } catch (e: any) {
            error = e.message ?? String(e);
        } finally {
            busy = false;
        }
    }
    function fmt(ts: number) {
        return ts ? new Date(ts).toLocaleString() : '—';
    }
</script>

{#snippet lockIcon(closed: boolean)}
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        {#if closed}<path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />{:else}<path d="M5.5 7V5a2.5 2.5 0 0 1 5 0" />{/if}
    </svg>
{/snippet}

<ConfirmDialog bind:this={dialog} />

<div class="sec-shell">
    <div class="bar">
        <span class="muted">Values are stored encrypted and never sent back to the browser — scripts read them with <code>she.secrets.get('group/field')</code>.</span>
        <span class="spacer"></span>
        {#if notice}<span class="ok">{notice}</span>{/if}
        {#if overview}<span class="muted" title={overview.file}>key: {overview.keySource === 'env' ? 'SHE_SECRETS_KEY' : overview.keySource === 'file' ? overview.keyFile : 'none yet — generated on first save'}</span>{/if}
        <button class="ghost" onclick={load} title="Reload">↺</button>
    </div>

    {#if error}<div class="err-box">{error} <button class="ghost sm" onclick={() => (error = '')}>×</button></div>{/if}
    {#if locked && overview}
        <div class="err-box">
            <b>Secrets store locked:</b> {overview.error}. Values cannot be read or changed until the key is back — set <code>SHE_SECRETS_KEY</code> in the daemon's environment or restore <code>{overview.keyFile}</code>, then restart she. Starting over means deleting <code>{overview.file}</code>.
        </div>
    {/if}

    <div class="body">
        <div class="groups">
            <div class="groups-head">Groups</div>
            {#if overview}
                {#each overview.groups as g (g.name)}
                    <button class="group" class:active={selected === g.name} onclick={() => (selected = g.name)}>
                        <span class="name">{g.name}</span>
                        <span class="count">{g.fields.length}</span>
                    </button>
                {/each}
                {#if overview.groups.length === 0}<div class="muted empty">No secrets yet.</div>{/if}
            {/if}
            <form class="add-group" onsubmit={(e) => { e.preventDefault(); addGroup(); }}>
                <input type="text" placeholder="new group" bind:value={newGroup} spellcheck="false" disabled={locked} />
                <button type="submit" class="ghost sm" disabled={locked || !newGroup.trim()}>+</button>
            </form>
        </div>

        <div class="fields">
            {#if group}
                <div class="fields-head">
                    <span class="title">{group.name}</span>
                    <span class="muted">changed {fmt(group.changed)}</span>
                    <span class="spacer"></span>
                    <label class="reveal check-label"><input type="checkbox" bind:checked={reveal} /><span class="checkmark"></span> show while typing</label>
                    <button class="ghost sm danger" onclick={() => removeGroup(group!.name)} disabled={busy || locked}>Delete group</button>
                </div>
                <table>
                    <colgroup><col class="c-name" /><col class="c-value" /><col class="c-changed" /><col class="c-act" /></colgroup>
                    <thead><tr><th>field</th><th>value</th><th>changed</th><th></th></tr></thead>
                    <tbody>
                        {#each group.fields as f (f.name)}
                            {@const key = `${group.name}/${f.name}`}
                            {@const draft = drafts[key] ?? (f.secret ? '' : (f.value ?? ''))}
                            {@const dirty = f.secret ? draft !== '' : draft !== (f.value ?? '')}
                            <tr>
                                <td class="mono" title="she.secrets.get('{key}')">{f.name}</td>
                                <td>
                                    <form class="val" onsubmit={(e) => { e.preventDefault(); if (dirty) save(group!.name, f.name, draft, f.secret); }}>
                                        {#if f.secret}
                                            <button type="button" class="lock is-secret" disabled title="secret — write-only, never shown again">{@render lockIcon(true)}</button>
                                            <input type={reveal ? 'text' : 'password'} placeholder="•••••• (type to replace)" value={draft} oninput={(e) => (drafts = { ...drafts, [key]: (e.target as HTMLInputElement).value })} autocomplete="off" spellcheck="false" disabled={locked} />
                                        {:else}
                                            <button type="button" class="lock" onclick={() => lock(group!.name, f.name)} disabled={busy || locked} title="plain — shown in clear; click to mark it secret (never shown again)">{@render lockIcon(false)}</button>
                                            {#if draft.includes('\n')}
                                                <textarea value={draft} rows={4} oninput={(e) => (drafts = { ...drafts, [key]: (e.target as HTMLTextAreaElement).value })} spellcheck="false" disabled={locked}></textarea>
                                            {:else}
                                                <input type="text" value={draft} oninput={(e) => (drafts = { ...drafts, [key]: (e.target as HTMLInputElement).value })} autocomplete="off" spellcheck="false" disabled={locked} />
                                            {/if}
                                        {/if}
                                        <button type="submit" class="sm" disabled={busy || locked || !dirty || !draft}>Save</button>
                                    </form>
                                </td>
                                <td class="muted">{fmt(f.changed)}</td>
                                <td class="c-act"><button class="ghost sm" onclick={() => removeField(group!.name, f.name)} disabled={busy || locked} title="Delete">×</button></td>
                            </tr>
                        {/each}
                        <tr class="new">
                            <td><input type="text" placeholder="new field" bind:value={newField} spellcheck="false" disabled={locked} /></td>
                            <td>
                                <form class="val" onsubmit={(e) => { e.preventDefault(); if (NAME_RE.test(newField.trim())) save(group!.name, newField.trim(), newValue, newSecret); else error = 'field name: letters, digits, _ . - (max 64)'; }}>
                                    <button type="button" class="lock" class:is-secret={newSecret} onclick={() => (newSecret = !newSecret)} disabled={locked} title={newSecret ? 'secret — write-only once saved (click for a plain field, e.g. a user name)' : 'plain — shown in clear (click for a secret)'}>{@render lockIcon(newSecret)}</button>
                                    {#if newValue.includes('\n') || reveal || !newSecret}
                                        <textarea placeholder="value" bind:value={newValue} rows={newValue.includes('\n') ? 4 : 1} spellcheck="false" disabled={locked}></textarea>
                                    {:else}
                                        <input type="password" placeholder="value" bind:value={newValue} autocomplete="off" disabled={locked} />
                                    {/if}
                                    <button type="submit" class="sm" disabled={busy || locked || !newField.trim() || !newValue}>Add</button>
                                </form>
                            </td>
                            <td class="muted" colspan="2">the lock decides the kind: secret fields are write-only forever, plain fields (user names, hosts) stay readable here. Multi-line values: tick <i>show while typing</i> and paste.</td>
                        </tr>
                    </tbody>
                </table>
                <div class="hint">
                    <code>she.secrets.get('{group.name}/&lt;field&gt;')</code> returns the string, <code>she.secrets.get('{group.name}')</code> the whole group as a frozen object, <code>she.secrets.has(…)</code> checks without a warning. Scripts that read a secret at load time keep the old value until they are reloaded.
                </div>
            {:else if overview && !locked}
                <div class="muted empty">
                    {#if overview.groups.length === 0}Create a group on the left, then add fields to it — e.g. group <code>smtp</code> with <code>host</code>, <code>user</code>, <code>password</code>.{:else}Select a group.{/if}
                </div>
            {/if}
        </div>
    </div>
</div>

<style>
    .sec-shell { display: flex; flex-direction: column; height: 100%; overflow: hidden; font-size: 13px; color: var(--fg); }
    .bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .spacer { flex: 1; }
    .muted { color: var(--fg-muted); font-size: 12px; }
    .ok { color: #27ae60; font-size: 12px; }
    .mono { font-family: var(--font-mono, monospace); font-size: 12px; }
    code { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--accent); }
    .err-box { margin: 8px 12px 0; background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.35); border-radius: 3px; color: #e88; padding: 6px 10px; font-size: 12px; }
    .body { flex: 1; display: flex; min-height: 0; }
    .groups { width: 220px; flex-shrink: 0; border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: auto; }
    .groups-head, .fields-head { padding: 8px 12px; font-weight: 600; font-size: 11px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .fields-head { display: flex; align-items: center; gap: 10px; text-transform: none; letter-spacing: 0; border-bottom: 1px solid var(--border); }
    .fields-head .title { font-size: 14px; font-weight: 600; color: var(--fg); }
    .group { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none; border: none; color: var(--fg); padding: 6px 12px; cursor: pointer; font-size: 13px; }
    .group:hover { background: var(--bg-hover, rgba(255,255,255,0.04)); }
    .group.active { background: var(--bg-panel); color: var(--accent); }
    .group .name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
    .group .count { font-size: 11px; color: var(--fg-muted); }
    .add-group { display: flex; gap: 4px; padding: 8px 12px; margin-top: auto; border-top: 1px solid var(--border); }
    .add-group input { flex: 1; min-width: 0; font-size: 12px; padding: 3px 6px; background: var(--bg-input, var(--bg)); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; }
    .add-group input::placeholder, .val input::placeholder, .val textarea::placeholder, td > input::placeholder { color: var(--fg-muted); opacity: 0.8; }
    .empty { padding: 12px; }
    .fields { flex: 1; min-width: 0; overflow: auto; display: flex; flex-direction: column; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    col.c-name { width: 22%; } col.c-changed { width: 22%; } col.c-act { width: 40px; }
    th { text-align: left; font-weight: 600; font-size: 11px; color: var(--fg-muted); padding: 6px 12px; border-bottom: 1px solid var(--border); }
    td { padding: 5px 12px; border-bottom: 1px solid var(--border-sub, var(--border)); vertical-align: top; overflow: hidden; text-overflow: ellipsis; }
    td.c-act { text-align: right; }
    tr.new td { background: rgba(255,255,255,0.02); }
    .val { display: flex; gap: 6px; align-items: flex-start; }
    .val input, .val textarea, td > input { flex: 1; min-width: 0; width: 100%; box-sizing: border-box; font-size: 12px; padding: 3px 6px; background: var(--bg-input, var(--bg)); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; font-family: var(--font-mono, monospace); }
    .val textarea { resize: vertical; }
    .lock { flex-shrink: 0; width: 22px; height: 22px; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--border); color: var(--fg-muted); border-radius: 3px; }
    .lock:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    .lock.is-secret { color: #d4ac0d; border-color: rgba(241,196,15,0.5); opacity: 1; }
    .reveal { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fg-muted); cursor: pointer; user-select: none; white-space: nowrap; }
    .check-label input[type='checkbox'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .checkmark { flex-shrink: 0; width: 13px; height: 13px; border: 1.5px solid var(--border); border-radius: 3px; background: var(--bg-input); position: relative; transition: background 0.12s, border-color 0.12s; }
    .check-label input:checked + .checkmark { background: var(--accent); border-color: var(--accent); }
    .check-label input:checked + .checkmark::after { content: ''; position: absolute; left: 3px; top: 0px; width: 4px; height: 7px; border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg); }
    .check-label:hover .checkmark { border-color: var(--accent); }
    .hint { padding: 10px 12px; color: var(--fg-muted); font-size: 12px; line-height: 1.5; }
    button { background: var(--accent); border: none; color: #fff; padding: 3px 10px; font-size: 12px; border-radius: 3px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    button.ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-muted); }
    button.sm { padding: 1px 7px; font-size: 11px; }
    button.danger:hover:not(:disabled) { color: #e74c3c; border-color: #e74c3c; }
</style>
