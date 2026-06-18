<script lang="ts">
    import { onMount } from 'svelte';
    import {
        listBrokerUsers, createBrokerUser, deleteBrokerUser, setBrokerUserPassword,
        assignBrokerUserRole, removeBrokerUserRole,
        listBrokerRoles, createBrokerRole, deleteBrokerRole,
        addBrokerRoleAcl, removeBrokerRoleAcl,
        listBrokerGroups, createBrokerGroup, deleteBrokerGroup,
        addBrokerGroupClient, removeBrokerGroupClient, addBrokerGroupRole, removeBrokerGroupRole,
        type DynsecUser, type DynsecRole, type DynsecGroup,
    } from '../../lib/api.js';

    // ── State ──────────────────────────────────────────────────────────────────
    let users = $state<DynsecUser[]>([]);
    let roles = $state<DynsecRole[]>([]);
    let groups = $state<DynsecGroup[]>([]);

    let usersError = $state('');
    let rolesError = $state('');
    let groupsError = $state('');

    let panel = $state<'users' | 'roles' | 'groups'>('users');

    // ── Add user modal ─────────────────────────────────────────────────────────
    let showAddUser = $state(false);
    let newUsername = $state('');
    let newPassword = $state('');
    let showPassword = $state(false);
    let addUserError = $state('');
    let addUserLoading = $state(false);

    // ── Set password modal ─────────────────────────────────────────────────────
    let showSetPassword = $state(false);
    let setPasswordFor = $state('');
    let setPasswordValue = $state('');
    let setPasswordError = $state('');
    let setPasswordLoading = $state(false);

    // ── Add role modal ─────────────────────────────────────────────────────────
    let showAddRole = $state(false);
    let newRolename = $state('');
    let addRoleError = $state('');
    let addRoleLoading = $state(false);

    // ── ACL editor ────────────────────────────────────────────────────────────
    let aclRole = $state<DynsecRole | null>(null);
    let showAclEditor = $state(false);
    let newAclType = $state('publishClientSend');
    let newAclTopic = $state('');
    let newAclAllow = $state(true);
    let aclError = $state('');

    // ── Add group modal ────────────────────────────────────────────────────────
    let showAddGroup = $state(false);
    let newGroupname = $state('');
    let addGroupError = $state('');
    let addGroupLoading = $state(false);

    const ACL_TYPES = [
        'publishClientSend',
        'publishClientReceive',
        'subscribeLiteral',
        'subscribePattern',
        'unsubscribeLiteral',
        'unsubscribePattern',
    ];

    // ── Load ───────────────────────────────────────────────────────────────────
    async function load() {
        try {
            const [u, r, g] = await Promise.allSettled([
                listBrokerUsers(),
                listBrokerRoles(),
                listBrokerGroups(),
            ]);
            if (u.status === 'fulfilled') { users = u.value.users; usersError = ''; }
            else usersError = u.reason?.message ?? 'Failed to load users';
            if (r.status === 'fulfilled') { roles = r.value.roles; rolesError = ''; }
            else rolesError = r.reason?.message ?? 'Failed to load roles';
            if (g.status === 'fulfilled') { groups = g.value.groups; groupsError = ''; }
            else groupsError = g.reason?.message ?? 'Failed to load groups';
        } catch { /* handled above */ }
    }

    onMount(() => { load(); });

    // ── User actions ───────────────────────────────────────────────────────────
    async function submitAddUser() {
        addUserError = '';
        addUserLoading = true;
        try {
            await createBrokerUser(newUsername, newPassword);
            newUsername = '';
            newPassword = '';
            showAddUser = false;
            await load();
        } catch (e: any) {
            addUserError = e.message ?? 'Failed to create user';
        } finally {
            addUserLoading = false;
        }
    }

    async function doDeleteUser(username: string) {
        if (!confirm(`Delete user "${username}"?`)) return;
        try {
            await deleteBrokerUser(username);
            await load();
        } catch (e: any) {
            usersError = e.message;
        }
    }

    async function openSetPassword(username: string) {
        setPasswordFor = username;
        setPasswordValue = '';
        setPasswordError = '';
        showSetPassword = true;
    }

    async function submitSetPassword() {
        setPasswordError = '';
        setPasswordLoading = true;
        try {
            await setBrokerUserPassword(setPasswordFor, setPasswordValue);
            showSetPassword = false;
        } catch (e: any) {
            setPasswordError = e.message;
        } finally {
            setPasswordLoading = false;
        }
    }

    // ── Role actions ───────────────────────────────────────────────────────────
    async function submitAddRole() {
        addRoleError = '';
        addRoleLoading = true;
        try {
            await createBrokerRole(newRolename);
            newRolename = '';
            showAddRole = false;
            await load();
        } catch (e: any) {
            addRoleError = e.message ?? 'Failed to create role';
        } finally {
            addRoleLoading = false;
        }
    }

    async function doDeleteRole(rolename: string) {
        if (!confirm(`Delete role "${rolename}"?`)) return;
        try {
            await deleteBrokerRole(rolename);
            if (aclRole?.rolename === rolename) { aclRole = null; showAclEditor = false; }
            await load();
        } catch (e: any) {
            rolesError = e.message;
        }
    }

    function openAclEditor(role: DynsecRole) {
        aclRole = role;
        showAclEditor = true;
        newAclType = 'publishClientSend';
        newAclTopic = '';
        newAclAllow = true;
        aclError = '';
    }

    async function submitAddAcl() {
        if (!aclRole) return;
        aclError = '';
        try {
            await addBrokerRoleAcl(aclRole.rolename, { acltype: newAclType, topic: newAclTopic, allow: newAclAllow });
            newAclTopic = '';
            await load();
            aclRole = roles.find((r) => r.rolename === aclRole!.rolename) ?? aclRole;
        } catch (e: any) {
            aclError = e.message;
        }
    }

    async function doRemoveAcl(rolename: string, acltype: string, topic: string) {
        try {
            await removeBrokerRoleAcl(rolename, acltype, topic);
            await load();
            aclRole = roles.find((r) => r.rolename === rolename) ?? aclRole;
        } catch (e: any) {
            aclError = e.message;
        }
    }

    // ── Group actions ──────────────────────────────────────────────────────────
    async function submitAddGroup() {
        addGroupError = '';
        addGroupLoading = true;
        try {
            await createBrokerGroup(newGroupname);
            newGroupname = '';
            showAddGroup = false;
            await load();
        } catch (e: any) {
            addGroupError = e.message ?? 'Failed to create group';
        } finally {
            addGroupLoading = false;
        }
    }

    async function doDeleteGroup(groupname: string) {
        if (!confirm(`Delete group "${groupname}"?`)) return;
        try {
            await deleteBrokerGroup(groupname);
            await load();
        } catch (e: any) {
            groupsError = e.message;
        }
    }
</script>

<div class="users-page">
    <!-- Panel selector -->
    <div class="panel-tabs">
        <button class:active={panel === 'users'}   onclick={() => (panel = 'users')}>Users</button>
        <button class:active={panel === 'roles'}   onclick={() => (panel = 'roles')}>Roles</button>
        <button class:active={panel === 'groups'}  onclick={() => (panel = 'groups')}>Groups</button>
        <button class="reload-btn" onclick={load} title="Refresh">↺</button>
    </div>

    <!-- ── Users panel ─────────────────────────────────────────────────────── -->
    {#if panel === 'users'}
    <div class="panel">
        <div class="panel-header">
            <h3>Users</h3>
            <button class="btn-add" onclick={() => { showAddUser = true; addUserError = ''; }}>+ Add user</button>
        </div>
        {#if usersError}<div class="err">{usersError}</div>{/if}
        {#if users.length === 0}
        <div class="empty">No users found.</div>
        {:else}
        <table>
            <thead><tr><th>Username</th><th>Roles</th><th>Groups</th><th></th></tr></thead>
            <tbody>
            {#each users as user}
            <tr>
                <td class="mono">{user.username}</td>
                <td class="tags">{#each user.roles ?? [] as r}<span class="tag">{r.rolename}</span>{/each}</td>
                <td class="tags">{#each user.groups ?? [] as g}<span class="tag tag--group">{g.groupname}</span>{/each}</td>
                <td class="actions">
                    <button onclick={() => openSetPassword(user.username)} title="Set password">🔑</button>
                    <button class="danger" onclick={() => doDeleteUser(user.username)} title="Delete">✕</button>
                </td>
            </tr>
            {/each}
            </tbody>
        </table>
        {/if}
    </div>
    {/if}

    <!-- ── Roles panel ─────────────────────────────────────────────────────── -->
    {#if panel === 'roles'}
    <div class="panel">
        <div class="panel-header">
            <h3>Roles</h3>
            <button class="btn-add" onclick={() => { showAddRole = true; addRoleError = ''; newRolename = ''; }}>+ Add role</button>
        </div>
        {#if rolesError}<div class="err">{rolesError}</div>{/if}
        {#if roles.length === 0}
        <div class="empty">No roles found.</div>
        {:else}
        <table>
            <thead><tr><th>Role</th><th>ACLs</th><th></th></tr></thead>
            <tbody>
            {#each roles as role}
            <tr>
                <td class="mono">{role.rolename}</td>
                <td>{role.acls?.length ?? 0}</td>
                <td class="actions">
                    <button onclick={() => openAclEditor(role)} title="Edit ACLs">Edit ACLs</button>
                    <button class="danger" onclick={() => doDeleteRole(role.rolename)} title="Delete">✕</button>
                </td>
            </tr>
            {/each}
            </tbody>
        </table>
        {/if}
    </div>
    {/if}

    <!-- ── Groups panel ────────────────────────────────────────────────────── -->
    {#if panel === 'groups'}
    <div class="panel">
        <div class="panel-header">
            <h3>Groups</h3>
            <button class="btn-add" onclick={() => { showAddGroup = true; addGroupError = ''; newGroupname = ''; }}>+ Add group</button>
        </div>
        {#if groupsError}<div class="err">{groupsError}</div>{/if}
        {#if groups.length === 0}
        <div class="empty">No groups found.</div>
        {:else}
        <table>
            <thead><tr><th>Group</th><th>Members</th><th>Roles</th><th></th></tr></thead>
            <tbody>
            {#each groups as group}
            <tr>
                <td class="mono">{group.groupname}</td>
                <td class="tags">{#each group.clients ?? [] as c}<span class="tag">{c.username}</span>{/each}</td>
                <td class="tags">{#each group.roles ?? [] as r}<span class="tag tag--group">{r.rolename}</span>{/each}</td>
                <td class="actions">
                    <button class="danger" onclick={() => doDeleteGroup(group.groupname)} title="Delete">✕</button>
                </td>
            </tr>
            {/each}
            </tbody>
        </table>
        {/if}
    </div>
    {/if}
</div>

<!-- ── Add user modal ─────────────────────────────────────────────────────── -->
{#if showAddUser}
<div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal">
        <h3>Add user</h3>
        <label>Username<input bind:value={newUsername} autocomplete="off" /></label>
        <label>
            Password
            <div class="pw-row">
                <input type={showPassword ? 'text' : 'password'} bind:value={newPassword} autocomplete="new-password" />
                <button class="toggle-pw" onclick={() => (showPassword = !showPassword)}>{showPassword ? 'Hide' : 'Show'}</button>
            </div>
        </label>
        {#if addUserError}<div class="err">{addUserError}</div>{/if}
        <div class="modal-actions">
            <button onclick={() => (showAddUser = false)}>Cancel</button>
            <button class="btn-primary" onclick={submitAddUser} disabled={addUserLoading || !newUsername || !newPassword}>
                {addUserLoading ? 'Creating…' : 'Create'}
            </button>
        </div>
    </div>
</div>
{/if}

<!-- ── Set password modal ─────────────────────────────────────────────────── -->
{#if showSetPassword}
<div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal">
        <h3>Set password for <em>{setPasswordFor}</em></h3>
        <label>
            New password
            <input type="password" bind:value={setPasswordValue} autocomplete="new-password" />
        </label>
        {#if setPasswordError}<div class="err">{setPasswordError}</div>{/if}
        <div class="modal-actions">
            <button onclick={() => (showSetPassword = false)}>Cancel</button>
            <button class="btn-primary" onclick={submitSetPassword} disabled={setPasswordLoading || !setPasswordValue}>
                {setPasswordLoading ? 'Saving…' : 'Set password'}
            </button>
        </div>
    </div>
</div>
{/if}

<!-- ── Add role modal ─────────────────────────────────────────────────────── -->
{#if showAddRole}
<div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal">
        <h3>Add role</h3>
        <label>Role name<input bind:value={newRolename} autocomplete="off" /></label>
        {#if addRoleError}<div class="err">{addRoleError}</div>{/if}
        <div class="modal-actions">
            <button onclick={() => (showAddRole = false)}>Cancel</button>
            <button class="btn-primary" onclick={submitAddRole} disabled={addRoleLoading || !newRolename}>
                {addRoleLoading ? 'Creating…' : 'Create'}
            </button>
        </div>
    </div>
</div>
{/if}

<!-- ── ACL editor modal ────────────────────────────────────────────────────── -->
{#if showAclEditor && aclRole}
<div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal modal--wide">
        <h3>ACLs for role <em>{aclRole.rolename}</em></h3>
        {#if (aclRole.acls?.length ?? 0) > 0}
        <table class="acl-table">
            <thead><tr><th>Type</th><th>Topic</th><th>Allow</th><th></th></tr></thead>
            <tbody>
            {#each aclRole.acls ?? [] as acl}
            <tr>
                <td class="mono small">{acl.acltype}</td>
                <td class="mono">{acl.topic}</td>
                <td>{acl.allow ? '✓' : '✗'}</td>
                <td><button class="danger" onclick={() => doRemoveAcl(aclRole!.rolename, acl.acltype, acl.topic)}>✕</button></td>
            </tr>
            {/each}
            </tbody>
        </table>
        {:else}
        <div class="empty">No ACL rules yet.</div>
        {/if}

        <div class="acl-add-row">
            <select bind:value={newAclType}>{#each ACL_TYPES as t}<option value={t}>{t}</option>{/each}</select>
            <input placeholder="topic or pattern" bind:value={newAclTopic} />
            <label class="allow-toggle">
                <input type="checkbox" bind:checked={newAclAllow} />
                Allow
            </label>
            <button onclick={submitAddAcl} disabled={!newAclTopic}>Add</button>
        </div>
        {#if aclError}<div class="err">{aclError}</div>{/if}
        <div class="modal-actions">
            <button onclick={() => (showAclEditor = false)}>Close</button>
        </div>
    </div>
</div>
{/if}

<!-- ── Add group modal ────────────────────────────────────────────────────── -->
{#if showAddGroup}
<div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal">
        <h3>Add group</h3>
        <label>Group name<input bind:value={newGroupname} autocomplete="off" /></label>
        {#if addGroupError}<div class="err">{addGroupError}</div>{/if}
        <div class="modal-actions">
            <button onclick={() => (showAddGroup = false)}>Cancel</button>
            <button class="btn-primary" onclick={submitAddGroup} disabled={addGroupLoading || !newGroupname}>
                {addGroupLoading ? 'Creating…' : 'Create'}
            </button>
        </div>
    </div>
</div>
{/if}

<style>
    .users-page {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .panel-tabs {
        display: flex;
        gap: 2px;
        padding: 8px 16px 0;
        border-bottom: 1px solid var(--border, #333);
        flex-shrink: 0;
    }

    .panel-tabs button {
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        color: var(--text-muted, #888);
        cursor: pointer;
        font-size: 12px;
        padding: 4px 10px 5px;
        margin-bottom: -1px;
    }

    .panel-tabs button.active { color: var(--text, #eee); border-bottom-color: var(--accent, #569cd6); }

    .reload-btn { margin-left: auto; font-size: 14px; padding: 2px 8px; }

    .panel {
        flex: 1;
        overflow: auto;
        padding: 14px 16px;
    }

    .panel-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 10px;
    }

    .panel-header h3 { margin: 0; font-size: 13px; color: var(--text-muted, #aaa); text-transform: uppercase; letter-spacing: 0.04em; }

    .btn-add { margin-left: auto; background: var(--accent-dim, rgba(86,156,214,0.15)); border: 1px solid var(--accent-border, rgba(86,156,214,0.3)); border-radius: 4px; color: var(--accent, #569cd6); cursor: pointer; font-size: 12px; padding: 3px 10px; }

    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { color: var(--text-muted, #888); font-weight: 500; text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border, #333); }
    td { padding: 5px 8px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: middle; }
    tr:last-child td { border-bottom: none; }

    .mono { font-family: monospace; font-size: 11px; }
    .small { font-size: 10px; }

    .tags { display: flex; flex-wrap: wrap; gap: 3px; }
    .tag { background: rgba(86,156,214,0.12); border: 1px solid rgba(86,156,214,0.25); border-radius: 3px; color: #7ab; font-family: monospace; font-size: 10px; padding: 1px 5px; }
    .tag--group { background: rgba(180,130,40,0.12); border-color: rgba(180,130,40,0.25); color: #ca8; }

    .actions { display: flex; gap: 4px; justify-content: flex-end; white-space: nowrap; }
    .actions button { background: none; border: 1px solid var(--border, #333); border-radius: 3px; color: var(--text-muted, #888); cursor: pointer; font-size: 11px; padding: 2px 6px; }
    .actions button:hover { background: rgba(255,255,255,0.06); color: var(--text, #eee); }
    .actions button.danger:hover { background: rgba(220,60,60,0.15); border-color: rgba(220,60,60,0.4); color: #e66; }

    .empty { color: var(--text-muted, #888); font-size: 12px; padding: 10px 0; }
    .err { background: rgba(220,60,60,0.12); border: 1px solid rgba(220,60,60,0.3); border-radius: 4px; color: #e88; font-size: 12px; padding: 6px 10px; margin-bottom: 8px; }

    /* Modal */
    .modal-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.55);
        display: flex; align-items: center; justify-content: center;
        z-index: 100;
    }
    .modal {
        background: var(--surface, #252526);
        border: 1px solid var(--border, #444);
        border-radius: 6px;
        display: flex; flex-direction: column; gap: 10px;
        min-width: 320px; max-width: 520px; width: 100%;
        padding: 18px 20px;
    }
    .modal--wide { min-width: 500px; max-width: 720px; }
    .modal h3 { font-size: 13px; margin: 0; }
    .modal h3 em { font-style: normal; color: var(--accent, #569cd6); }
    .modal label { display: flex; flex-direction: column; font-size: 12px; color: var(--text-muted, #aaa); gap: 4px; }
    .modal input, .modal select { background: var(--input-bg, #1e1e1e); border: 1px solid var(--border, #555); border-radius: 4px; color: var(--text, #eee); font-size: 12px; padding: 5px 8px; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
    .modal-actions button { background: none; border: 1px solid var(--border, #555); border-radius: 4px; color: var(--text-muted, #aaa); cursor: pointer; font-size: 12px; padding: 5px 12px; }
    .btn-primary { background: var(--accent-dim, rgba(86,156,214,0.18)) !important; border-color: var(--accent-border, rgba(86,156,214,0.4)) !important; color: var(--accent, #569cd6) !important; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

    .pw-row { display: flex; gap: 4px; }
    .pw-row input { flex: 1; }
    .toggle-pw { background: none; border: 1px solid var(--border, #555); border-radius: 4px; color: var(--text-muted, #aaa); cursor: pointer; font-size: 11px; padding: 4px 8px; }

    .acl-table { margin-bottom: 10px; }
    .acl-add-row { display: flex; gap: 6px; align-items: center; }
    .acl-add-row select { background: var(--input-bg, #1e1e1e); border: 1px solid var(--border, #555); border-radius: 4px; color: var(--text, #eee); font-size: 11px; padding: 4px 6px; }
    .acl-add-row input { flex: 1; background: var(--input-bg, #1e1e1e); border: 1px solid var(--border, #555); border-radius: 4px; color: var(--text, #eee); font-size: 11px; padding: 4px 6px; }
    .acl-add-row button { background: var(--accent-dim, rgba(86,156,214,0.12)); border: 1px solid var(--accent-border, rgba(86,156,214,0.3)); border-radius: 4px; color: var(--accent, #569cd6); cursor: pointer; font-size: 11px; padding: 4px 10px; }
    .allow-toggle { flex-direction: row; align-items: center; gap: 4px; color: var(--text, #eee); cursor: pointer; }
</style>
