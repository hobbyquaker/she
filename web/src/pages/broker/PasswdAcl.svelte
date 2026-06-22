<script lang="ts">
    import { onMount } from 'svelte';
    import {
        getBrokerConf,
        listPasswdUsers,
        addPasswdUser,
        deletePasswdUser,
        readAclFile,
        writeAclFile,
        brokerReload,
    } from '../../lib/api.js';
    import MonacoEditor from '../../lib/MonacoEditor.svelte';
    import ConfirmDialog from '../../lib/ConfirmDialog.svelte';

    // ── Passwd state ──────────────────────────────────────────────────────────
    let passwdFile = $state('/etc/mosquitto/passwd');
    let passwdUsers = $state<string[]>([]);
    let passwdLoading = $state(false);
    let passwdError = $state('');
    let passwdOk = $state('');

    let addUsername = $state('');
    let addPassword = $state('');
    let addConfirm = $state('');
    let adding = $state(false);
    let addError = $state('');

    // Change-password form per user
    let changingUser = $state<string | null>(null);
    let changePassword = $state('');
    let changeConfirm = $state('');
    let changeSaving = $state(false);
    let changeError = $state('');

    let deletingUser = $state<string | null>(null);

    // ── ACL state ─────────────────────────────────────────────────────────────
    let aclFile = $state('/etc/mosquitto/acl');
    let aclContent = $state('');
    let aclLoading = $state(false);
    let aclError = $state('');
    let aclOk = $state('');
    let aclSaving = $state(false);

    let reloading = $state(false);
    let reloadMsg = $state('');

    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean }): Promise<boolean> };

    onMount(async () => {
        // Pre-populate file paths from broker config (first listener with password_file/acl_file)
        try {
            const conf = await getBrokerConf();
            const pwListener = conf.listeners.find((l) => l.password_file);
            if (pwListener?.password_file) passwdFile = pwListener.password_file;
            const aclListener = conf.listeners.find((l) => l.acl_file);
            if (aclListener?.acl_file) aclFile = aclListener.acl_file;
            // Also check managed keys for global password_file / acl_file
            if (!pwListener?.password_file && conf.managed['password_file']) {
                passwdFile = String(conf.managed['password_file']);
            }
            if (!aclListener?.acl_file && conf.managed['acl_file']) {
                aclFile = String(conf.managed['acl_file']);
            }
        } catch {
            // ignore — user can set paths manually
        }

        await loadPasswd();
        await loadAcl();
    });

    async function loadPasswd() {
        if (!passwdFile) return;
        passwdLoading = true;
        passwdError = '';
        passwdOk = '';
        try {
            const r = await listPasswdUsers(passwdFile);
            passwdUsers = r.users;
        } catch (e: any) {
            passwdError = e.message ?? 'Failed to load password file';
        } finally {
            passwdLoading = false;
        }
    }

    async function addUser() {
        if (!addUsername.trim()) { addError = 'Username required'; return; }
        if (!addPassword) { addError = 'Password required'; return; }
        if (addPassword !== addConfirm) { addError = 'Passwords do not match'; return; }
        adding = true;
        addError = '';
        passwdOk = '';
        try {
            await addPasswdUser(passwdFile, addUsername.trim(), addPassword);
            addUsername = '';
            addPassword = '';
            addConfirm = '';
            passwdOk = 'User added.';
            await loadPasswd();
        } catch (e: any) {
            addError = e.message ?? 'Failed to add user';
        } finally {
            adding = false;
        }
    }

    async function startChange(user: string) {
        changingUser = user;
        changePassword = '';
        changeConfirm = '';
        changeError = '';
    }

    async function saveChange() {
        if (!changePassword) { changeError = 'Password required'; return; }
        if (changePassword !== changeConfirm) { changeError = 'Passwords do not match'; return; }
        changeSaving = true;
        changeError = '';
        passwdOk = '';
        try {
            await addPasswdUser(passwdFile, changingUser!, changePassword);
            changingUser = null;
            passwdOk = 'Password updated.';
        } catch (e: any) {
            changeError = e.message ?? 'Failed to change password';
        } finally {
            changeSaving = false;
        }
    }

    async function removeUser(user: string) {
        if (!await dialog.show(`Delete user "${user}" from ${passwdFile}?`, { confirm: 'Delete', danger: true })) return;
        deletingUser = user;
        passwdError = '';
        passwdOk = '';
        try {
            await deletePasswdUser(passwdFile, user);
            passwdOk = `User "${user}" deleted.`;
            await loadPasswd();
        } catch (e: any) {
            passwdError = e.message ?? 'Delete failed';
        } finally {
            deletingUser = null;
        }
    }

    async function loadAcl() {
        if (!aclFile) return;
        aclLoading = true;
        aclError = '';
        aclOk = '';
        try {
            const r = await readAclFile(aclFile);
            aclContent = r.content;
        } catch (e: any) {
            aclError = e.message ?? 'Failed to load ACL file';
        } finally {
            aclLoading = false;
        }
    }

    async function saveAcl() {
        aclSaving = true;
        aclError = '';
        aclOk = '';
        try {
            await writeAclFile(aclFile, aclContent);
            aclOk = 'ACL file saved.';
        } catch (e: any) {
            aclError = e.message ?? 'Save failed';
        } finally {
            aclSaving = false;
        }
    }

    async function reload() {
        reloading = true;
        reloadMsg = '';
        try {
            const r = await brokerReload();
            reloadMsg = r.stderr || r.stdout || 'Reloaded';
        } catch (e: any) {
            reloadMsg = 'Error: ' + (e.message ?? 'reload failed');
        } finally {
            reloading = false;
        }
    }
</script>

<div class="passwd-page">
    <!-- ── Password File ────────────────────────────────────────────────── -->
    <section class="card">
        <div class="card-header">
            <h4>Password File</h4>
            <div class="header-actions">
                <button onclick={reload} disabled={reloading}>{reloading ? 'Reloading…' : 'Apply & Reload'}</button>
            </div>
        </div>

        <div class="file-row">
            <label class="file-label">
                <span>File path</span>
                <input bind:value={passwdFile} placeholder="/etc/mosquitto/passwd" onchange={loadPasswd} />
            </label>
            <button onclick={loadPasswd} disabled={passwdLoading}>↻</button>
        </div>

        {#if reloadMsg}<div class="reload-msg">{reloadMsg}</div>{/if}
        {#if passwdError}<div class="err">{passwdError}</div>{/if}
        {#if passwdOk}<div class="ok">{passwdOk}</div>{/if}

        {#if passwdLoading}
        <div class="loading">Loading…</div>
        {:else}
        <!-- User list -->
        {#if passwdUsers.length > 0}
        <table class="user-table">
            <thead><tr><th>Username</th><th></th></tr></thead>
            <tbody>
            {#each passwdUsers as user}
            <tr>
                <td class="user-name">{user}</td>
                <td class="user-actions">
                    {#if changingUser === user}
                    <div class="change-form">
                        <input type="password" bind:value={changePassword} placeholder="New password" autocomplete="new-password" />
                        <input type="password" bind:value={changeConfirm} placeholder="Confirm password" autocomplete="new-password" />
                        {#if changeError}<span class="inline-err">{changeError}</span>{/if}
                        <button onclick={saveChange} disabled={changeSaving}>{changeSaving ? '…' : 'Save'}</button>
                        <button onclick={() => (changingUser = null)}>Cancel</button>
                    </div>
                    {:else}
                    <button onclick={() => startChange(user)}>Change password</button>
                    <button class="btn-danger" onclick={() => removeUser(user)} disabled={deletingUser === user}>{deletingUser === user ? '…' : 'Delete'}</button>
                    {/if}
                </td>
            </tr>
            {/each}
            </tbody>
        </table>
        {:else if !passwdError}
        <p class="empty">No users found — file may not exist yet.</p>
        {/if}

        <!-- Add user form -->
        <div class="add-form">
            <span class="add-title">Add user</span>
            <div class="add-fields">
                <input bind:value={addUsername} placeholder="Username" autocomplete="off" />
                <input type="password" bind:value={addPassword} placeholder="Password" autocomplete="new-password" />
                <input type="password" bind:value={addConfirm} placeholder="Confirm password" autocomplete="new-password" />
                <button class="btn-add" onclick={addUser} disabled={adding}>{adding ? 'Adding…' : 'Add'}</button>
            </div>
            {#if addError}<div class="err">{addError}</div>{/if}
        </div>
        {/if}
    </section>

    <!-- ── ACL File ──────────────────────────────────────────────────────── -->
    <section class="card acl-card">
        <div class="card-header">
            <h4>ACL File</h4>
            <div class="header-actions">
                <button class="btn-save" onclick={saveAcl} disabled={aclSaving}>{aclSaving ? 'Saving…' : 'Save'}</button>
            </div>
        </div>

        <div class="file-row">
            <label class="file-label">
                <span>File path</span>
                <input bind:value={aclFile} placeholder="/etc/mosquitto/acl" onchange={loadAcl} />
            </label>
            <button onclick={loadAcl} disabled={aclLoading}>↻</button>
        </div>

        {#if aclError}<div class="err">{aclError}</div>{/if}
        {#if aclOk}<div class="ok">{aclOk}</div>{/if}

        <div class="acl-editor-wrap">
            {#if aclLoading}
            <div class="loading">Loading…</div>
            {:else}
            <MonacoEditor bind:value={aclContent} language="plaintext" onSave={saveAcl} />
            {/if}
        </div>

        <p class="hint">
            Static ACL file format: <code>user &lt;username&gt;</code> followed by <code>topic [read|write|readwrite] &lt;pattern&gt;</code>.
            Requires <code>acl_file</code> set in mosquitto.conf and no dynsec plugin.
            After saving, click <strong>Apply &amp; Reload</strong> above to activate changes.
        </p>
    </section>
</div>

<ConfirmDialog bind:this={dialog} />

<style>
    .passwd-page {
        padding: 14px 16px;
        height: 100%;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 14px;
        overflow-y: auto;
    }

    .card {
        background: var(--surface, #1e1e1e);
        border: 1px solid var(--border, #333);
        border-radius: 6px;
        padding: 12px 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        flex-shrink: 0;
    }

    .acl-card {
        flex: 1;
        min-height: 260px;
        overflow: hidden;
    }

    .card-header {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .card-header h4 {
        margin: 0;
        font-size: 11px;
        font-weight: 600;
        color: var(--text-muted, #aaa);
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .header-actions { display: flex; gap: 6px; margin-left: auto; }
    .header-actions button {
        background: none;
        border: 1px solid var(--border, #444);
        border-radius: 4px;
        color: var(--text-muted, #aaa);
        cursor: pointer;
        font-size: 12px;
        padding: 4px 10px;
    }
    .btn-save { background: var(--accent-dim, rgba(86,156,214,0.15)) !important; border-color: rgba(86,156,214,0.35) !important; color: var(--accent, #569cd6) !important; }

    .file-row {
        display: flex;
        align-items: flex-end;
        gap: 6px;
    }
    .file-label {
        display: flex;
        flex-direction: column;
        gap: 3px;
        flex: 1;
    }
    .file-label span {
        font-size: 11px;
        color: var(--text-muted, #999);
        font-family: monospace;
    }
    .file-row input {
        background: var(--input-bg, #2a2a2a);
        border: 1px solid var(--border, #444);
        border-radius: 4px;
        color: var(--text, #eee);
        font-size: 12px;
        padding: 4px 8px;
        width: 100%;
        box-sizing: border-box;
        font-family: monospace;
    }
    .file-row > button {
        background: none;
        border: 1px solid var(--border, #444);
        border-radius: 4px;
        color: var(--text-muted, #aaa);
        cursor: pointer;
        font-size: 14px;
        padding: 4px 8px;
        flex-shrink: 0;
    }
    .file-row > button:hover { color: var(--text, #eee); }

    .err  { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.3); border-radius: 4px; color: #e88; font-size: 12px; padding: 6px 10px; }
    .ok   { background: rgba(70,180,70,0.1); border: 1px solid rgba(70,180,70,0.25); border-radius: 4px; color: #8c8; font-size: 12px; padding: 6px 10px; }
    .inline-err { font-size: 11px; color: #e88; }
    .reload-msg { font-size: 12px; color: var(--text-muted, #aaa); white-space: pre-wrap; }
    .loading { font-size: 13px; color: var(--text-muted, #aaa); padding: 8px 0; }
    .empty { font-size: 12px; color: var(--text-muted, #777); margin: 0; }

    .user-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
    }
    .user-table th {
        text-align: left;
        font-size: 10px;
        font-weight: 600;
        color: var(--text-muted, #777);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 0 6px 4px;
        border-bottom: 1px solid var(--border, #333);
    }
    .user-table td {
        padding: 5px 6px;
        border-bottom: 1px solid var(--border, #2a2a2a);
        vertical-align: middle;
    }
    .user-name { font-family: monospace; color: var(--text, #ddd); }
    .user-actions { text-align: right; }
    .user-actions button {
        background: none;
        border: 1px solid var(--border, #444);
        border-radius: 3px;
        color: var(--text-muted, #aaa);
        cursor: pointer;
        font-size: 11px;
        padding: 2px 7px;
        margin-left: 4px;
    }
    .user-actions button:hover { border-color: var(--accent, #569cd6); color: var(--accent, #569cd6); }
    .btn-danger:hover { border-color: #c04040 !important; color: #e66 !important; }

    .change-form {
        display: flex;
        align-items: center;
        gap: 6px;
        justify-content: flex-end;
        flex-wrap: wrap;
    }
    .change-form input {
        background: var(--input-bg, #2a2a2a);
        border: 1px solid var(--border, #444);
        border-radius: 4px;
        color: var(--text, #eee);
        font-size: 12px;
        padding: 3px 7px;
        width: 140px;
    }

    .add-form {
        border-top: 1px solid var(--border, #333);
        padding-top: 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .add-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-muted, #aaa);
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .add-fields {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
    }
    .add-fields input {
        background: var(--input-bg, #2a2a2a);
        border: 1px solid var(--border, #444);
        border-radius: 4px;
        color: var(--text, #eee);
        font-size: 12px;
        padding: 4px 8px;
        flex: 1;
        min-width: 120px;
    }
    .btn-add {
        background: var(--accent-dim, rgba(86,156,214,0.15));
        border: 1px solid rgba(86,156,214,0.35);
        border-radius: 4px;
        color: var(--accent, #569cd6);
        cursor: pointer;
        font-size: 12px;
        padding: 4px 14px;
        white-space: nowrap;
    }
    .btn-add:disabled { opacity: 0.5; cursor: default; }

    .acl-editor-wrap {
        flex: 1;
        min-height: 0;
        border: 1px solid var(--border, #333);
        border-radius: 4px;
        overflow: hidden;
    }

    .hint {
        margin: 0;
        font-size: 10.5px;
        color: var(--text-muted, #666);
        line-height: 1.45;
        flex-shrink: 0;
    }
    .hint code {
        font-size: 10px;
        background: rgba(255,255,255,0.06);
        border-radius: 2px;
        padding: 0 3px;
    }
</style>
