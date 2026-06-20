<script lang="ts">
    import { onMount } from 'svelte';
    import ConfirmDialog from '../../lib/ConfirmDialog.svelte';
    import {
        listBrokerUsers, createBrokerUser, deleteBrokerUser, setBrokerUserPassword,
        assignBrokerUserRole, removeBrokerUserRole,
        listBrokerRoles, createBrokerRole, deleteBrokerRole,
        addBrokerRoleAcl, removeBrokerRoleAcl,
        listBrokerGroups, createBrokerGroup, deleteBrokerGroup,
        addBrokerGroupClient, removeBrokerGroupClient, addBrokerGroupRole, removeBrokerGroupRole,
        getDefaultAclAccess, setDefaultAclAccess, getAnonymousGroup, setAnonymousGroup,
        type DynsecUser, type DynsecRole, type DynsecGroup, type DefaultAclEntry,
    } from '../../lib/api.js';

    // ── State ──────────────────────────────────────────────────────────────────
    let { dynsecReady = false }: { dynsecReady?: boolean } = $props();

    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean }): Promise<boolean> };

    let users = $state<DynsecUser[]>([]);
    let roles = $state<DynsecRole[]>([]);
    let groups = $state<DynsecGroup[]>([]);

    let usersError = $state('');
    let rolesError = $state('');
    let groupsError = $state('');

    let panel = $state<'users' | 'roles' | 'groups' | 'settings'>('users');

    // ── Inline badge editor ─────────────────────────────────────────────────────
    type InlineAdd = { kind: 'user-roles' | 'user-groups' | 'group-members' | 'group-roles'; target: string };
    let inlineAdd = $state<InlineAdd | null>(null);
    let inlineAddVal = $state('');
    let inlineAddErr = $state('');
    let inlineAddLoading = $state(false);

    const inlineOptions = $derived(
        !inlineAdd ? [] :
        inlineAdd.kind === 'user-roles'
            ? roles.map(r => r.rolename).filter(r => !users.find(u => u.username === inlineAdd!.target)?.roles?.some(ur => ur.rolename === r))
        : inlineAdd.kind === 'user-groups'
            ? groups.map(g => g.groupname).filter(g => !users.find(u => u.username === inlineAdd!.target)?.groups?.some(ug => ug.groupname === g))
        : inlineAdd.kind === 'group-members'
            ? users.map(u => u.username).filter(u => !groups.find(g => g.groupname === inlineAdd!.target)?.clients?.some(c => c.username === u))
            : roles.map(r => r.rolename).filter(r => !groups.find(g => g.groupname === inlineAdd!.target)?.roles?.some(gr => gr.rolename === r))
    );

    function openInline(kind: InlineAdd['kind'], target: string) {
        inlineAdd = { kind, target };
        inlineAddVal = '';
        inlineAddErr = '';
    }

    async function doInlineAdd() {
        if (!inlineAdd || !inlineAddVal) return;
        inlineAddLoading = true;
        inlineAddErr = '';
        try {
            const { kind, target } = inlineAdd;
            if (kind === 'user-roles')    await assignBrokerUserRole(target, inlineAddVal);
            else if (kind === 'user-groups')   await addBrokerGroupClient(inlineAddVal, target);
            else if (kind === 'group-members') await addBrokerGroupClient(target, inlineAddVal);
            else                               await addBrokerGroupRole(target, inlineAddVal);
            inlineAdd = null;
            inlineAddVal = '';
            await load();
        } catch (e: any) {
            inlineAddErr = e.message;
        } finally {
            inlineAddLoading = false;
        }
    }

    async function doRemoveUserRole(username: string, rolename: string) {
        try { await removeBrokerUserRole(username, rolename); await load(); }
        catch (e: any) { usersError = e.message; }
    }
    async function doRemoveUserGroup(username: string, groupname: string) {
        try { await removeBrokerGroupClient(groupname, username); await load(); }
        catch (e: any) { usersError = e.message; }
    }
    async function doRemoveGroupMember(groupname: string, username: string) {
        try { await removeBrokerGroupClient(groupname, username); await load(); }
        catch (e: any) { groupsError = e.message; }
    }
    async function doRemoveGroupRole(groupname: string, rolename: string) {
        try { await removeBrokerGroupRole(groupname, rolename); await load(); }
        catch (e: any) { groupsError = e.message; }
    }

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

    // ── Settings state ───────────────────────────────────────────────────────────────
    let defaultAcls = $state<DefaultAclEntry[]>([]);
    let defaultAclsError = $state('');
    let defaultAclsSaving = $state(false);
    let anonymousGroup = $state<string | null>(null);
    let anonymousGroupPending = $state<string>('');
    let anonymousGroupError = $state('');
    let anonymousGroupSaving = $state(false);
    let settingsLoaded = $state(false);

    const DEFAULT_ACL_TYPES = [
        { acltype: 'publishClientSend',    label: 'Publish (send)' },
        { acltype: 'publishClientReceive', label: 'Publish (receive)' },
        { acltype: 'subscribe',            label: 'Subscribe' },
        { acltype: 'unsubscribe',          label: 'Unsubscribe' },
    ];

    async function loadSettings() {
        settingsLoaded = false;
        defaultAclsError = '';
        anonymousGroupError = '';
        try {
            const [aclRes, anonRes] = await Promise.allSettled([
                getDefaultAclAccess(),
                getAnonymousGroup(),
            ]);
            if (aclRes.status === 'fulfilled') {
                // Ensure all 4 types are present, filling in broker defaults when missing
                const map = Object.fromEntries(aclRes.value.acls.map(a => [a.acltype, a.allow]));
                defaultAcls = DEFAULT_ACL_TYPES.map(({ acltype }) => ({
                    acltype,
                    allow: map[acltype] ?? (acltype === 'publishClientReceive' || acltype === 'unsubscribe'),
                }));
            } else {
                defaultAclsError = aclRes.reason?.message ?? 'Failed to load default ACLs';
            }
            if (anonRes.status === 'fulfilled') {
                anonymousGroup = anonRes.value.group;
                anonymousGroupPending = anonRes.value.group ?? '';
            } else {
                anonymousGroupError = anonRes.reason?.message ?? 'Failed to load anonymous group';
            }
        } finally {
            settingsLoaded = true;
        }
    }

    async function saveDefaultAcl(acltype: string, allow: boolean) {
        defaultAcls = defaultAcls.map(a => a.acltype === acltype ? { ...a, allow } : a);
        defaultAclsSaving = true;
        defaultAclsError = '';
        try {
            await setDefaultAclAccess(defaultAcls);
        } catch (e: any) {
            defaultAclsError = e.message;
        } finally {
            defaultAclsSaving = false;
        }
    }

    async function saveAnonymousGroup() {
        anonymousGroupSaving = true;
        anonymousGroupError = '';
        try {
            await setAnonymousGroup(anonymousGroupPending || null);
            anonymousGroup = anonymousGroupPending || null;
        } catch (e: any) {
            anonymousGroupError = e.message;
        } finally {
            anonymousGroupSaving = false;
        }
    }
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
        if (!await dialog.show(`Delete user “${username}”?`, { confirm: 'Delete', danger: true })) return;
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
        if (!await dialog.show(`Delete role “${rolename}”?`, { confirm: 'Delete', danger: true })) return;
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
        if (!await dialog.show(`Delete group “${groupname}”?`, { confirm: 'Delete', danger: true })) return;
        try {
            await deleteBrokerGroup(groupname);
            await load();
        } catch (e: any) {
            groupsError = e.message;
        }
    }

    async function doMemberEditorRemove(_item: string) { /* superseded by inline remove */ }
</script>

<div class="users-page">
    {#if !dynsecReady}
    <div class="plugin-warning">
        ⚠ The dynamic-security plugin is not responding. Add <code>plugin …/mosquitto_dynamic_security.so</code> and <code>plugin_opt_config_file …/dynamic-security.json</code> to your mosquitto.conf and restart mosquitto. Operations below will time out until the plugin is active.
    </div>
    {/if}
    <!-- Panel selector -->
    <div class="panel-tabs">
        <button class:active={panel === 'users'}   onclick={() => (panel = 'users')}>Users</button>
        <button class:active={panel === 'roles'}   onclick={() => (panel = 'roles')}>Roles</button>
        <button class:active={panel === 'groups'}  onclick={() => (panel = 'groups')}>Groups</button>
        <button class:active={panel === 'settings'} onclick={() => { panel = 'settings'; if (!settingsLoaded) loadSettings(); }}>Settings</button>
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
                <td>
                    <div class="tags-cell">
                        <div class="tags">
                            {#each user.roles ?? [] as r}
                            <span class="tag">{r.rolename}<button class="tag-x" onclick={() => doRemoveUserRole(user.username, r.rolename)} title="Remove role">×</button></span>
                            {/each}
                            <button class="tag-plus" onclick={() => openInline('user-roles', user.username)} title="Add role">+</button>
                        </div>
                        {#if inlineAdd?.kind === 'user-roles' && inlineAdd.target === user.username}
                        <div class="inline-add">
                            <select bind:value={inlineAddVal}>
                                <option value="">— role —</option>
                                {#each inlineOptions as opt}<option value={opt}>{opt}</option>{/each}
                            </select>
                            <button class="inline-confirm" onclick={doInlineAdd} disabled={!inlineAddVal || inlineAddLoading}>Add</button>
                            <button class="inline-cancel" onclick={() => (inlineAdd = null)}>×</button>
                        </div>
                        {#if inlineAddErr}<div class="inline-err">{inlineAddErr}</div>{/if}
                        {/if}
                    </div>
                </td>
                <td>
                    <div class="tags-cell">
                        <div class="tags">
                            {#each user.groups ?? [] as g}
                            <span class="tag tag--group">{g.groupname}<button class="tag-x" onclick={() => doRemoveUserGroup(user.username, g.groupname)} title="Remove from group">×</button></span>
                            {/each}
                            <button class="tag-plus tag-plus--group" onclick={() => openInline('user-groups', user.username)} title="Add to group">+</button>
                        </div>
                        {#if inlineAdd?.kind === 'user-groups' && inlineAdd.target === user.username}
                        <div class="inline-add">
                            <select bind:value={inlineAddVal}>
                                <option value="">— group —</option>
                                {#each inlineOptions as opt}<option value={opt}>{opt}</option>{/each}
                            </select>
                            <button class="inline-confirm" onclick={doInlineAdd} disabled={!inlineAddVal || inlineAddLoading}>Add</button>
                            <button class="inline-cancel" onclick={() => (inlineAdd = null)}>×</button>
                        </div>
                        {#if inlineAddErr}<div class="inline-err">{inlineAddErr}</div>{/if}
                        {/if}
                    </div>
                </td>
                <td class="cell-actions"><div class="actions">
                    <button onclick={() => openSetPassword(user.username)} title="Set password">🔑</button>
                    <button class="danger" onclick={() => doDeleteUser(user.username)} title="Delete">✕</button>
                </div></td>
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
                <td class="cell-actions"><div class="actions">
                    <button onclick={() => openAclEditor(role)} title="Edit ACLs">Edit ACLs</button>
                    <button class="danger" onclick={() => doDeleteRole(role.rolename)} title="Delete">✕</button>
                </div></td>
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
                <td>
                    <div class="tags-cell">
                        <div class="tags">
                            {#each group.clients ?? [] as c}
                            <span class="tag">{c.username}<button class="tag-x" onclick={() => doRemoveGroupMember(group.groupname, c.username)} title="Remove member">×</button></span>
                            {/each}
                            <button class="tag-plus" onclick={() => openInline('group-members', group.groupname)} title="Add member">+</button>
                        </div>
                        {#if inlineAdd?.kind === 'group-members' && inlineAdd.target === group.groupname}
                        <div class="inline-add">
                            <select bind:value={inlineAddVal}>
                                <option value="">— user —</option>
                                {#each inlineOptions as opt}<option value={opt}>{opt}</option>{/each}
                            </select>
                            <button class="inline-confirm" onclick={doInlineAdd} disabled={!inlineAddVal || inlineAddLoading}>Add</button>
                            <button class="inline-cancel" onclick={() => (inlineAdd = null)}>×</button>
                        </div>
                        {#if inlineAddErr}<div class="inline-err">{inlineAddErr}</div>{/if}
                        {/if}
                    </div>
                </td>
                <td>
                    <div class="tags-cell">
                        <div class="tags">
                            {#each group.roles ?? [] as r}
                            <span class="tag tag--group">{r.rolename}<button class="tag-x" onclick={() => doRemoveGroupRole(group.groupname, r.rolename)} title="Remove role">×</button></span>
                            {/each}
                            <button class="tag-plus tag-plus--group" onclick={() => openInline('group-roles', group.groupname)} title="Add role">+</button>
                        </div>
                        {#if inlineAdd?.kind === 'group-roles' && inlineAdd.target === group.groupname}
                        <div class="inline-add">
                            <select bind:value={inlineAddVal}>
                                <option value="">— role —</option>
                                {#each inlineOptions as opt}<option value={opt}>{opt}</option>{/each}
                            </select>
                            <button class="inline-confirm" onclick={doInlineAdd} disabled={!inlineAddVal || inlineAddLoading}>Add</button>
                            <button class="inline-cancel" onclick={() => (inlineAdd = null)}>×</button>
                        </div>
                        {#if inlineAddErr}<div class="inline-err">{inlineAddErr}</div>{/if}
                        {/if}
                    </div>
                </td>
                <td class="cell-actions"><div class="actions">
                    <button class="danger" onclick={() => doDeleteGroup(group.groupname)} title="Delete">✕</button>
                </div></td>
            </tr>
            {/each}
            </tbody>
        </table>
        {/if}
    </div>
    {/if}

    <!-- ── Settings panel ─────────────────────────────────────────────────── -->
    {#if panel === 'settings'}
    <div class="panel">
        <div class="settings-section">
            <h3 class="settings-heading">Default ACL Access</h3>
            <p class="settings-hint">Broker-wide defaults applied when no role ACL matches. Role ACLs always take precedence over these defaults.</p>
            {#if defaultAclsError}<div class="err">{defaultAclsError}</div>{/if}
            {#if !settingsLoaded}
            <div class="empty">Loading…</div>
            {:else}
            <table class="acl-defaults-table">
                <thead><tr><th>Operation</th><th>Allow</th><th>Deny</th></tr></thead>
                <tbody>
                {#each DEFAULT_ACL_TYPES as { acltype, label }}
                {@const entry = defaultAcls.find(a => a.acltype === acltype)}
                <tr class:saving={defaultAclsSaving}>
                    <td class="mono small">{label}</td>
                    <td class="acl-radio"><input type="radio" name={acltype} value="allow" checked={entry?.allow === true}  onchange={() => saveDefaultAcl(acltype, true)}  /></td>
                    <td class="acl-radio"><input type="radio" name={acltype} value="deny"  checked={entry?.allow === false} onchange={() => saveDefaultAcl(acltype, false)} /></td>
                </tr>
                {/each}
                </tbody>
            </table>
            {/if}
        </div>

        <div class="settings-section">
            <h3 class="settings-heading">Anonymous Group</h3>
            <p class="settings-hint">Clients connecting without credentials are treated as members of this group. Requires <code>allow_anonymous true</code> in mosquitto.conf.</p>
            {#if anonymousGroupError}<div class="err">{anonymousGroupError}</div>{/if}
            {#if !settingsLoaded}
            <div class="empty">Loading…</div>
            {:else}
            <div class="anon-row">
                <select bind:value={anonymousGroupPending}>
                    <option value="">— none —</option>
                    {#each groups as g}
                    <option value={g.groupname}>{g.groupname}</option>
                    {/each}
                </select>
                <button onclick={saveAnonymousGroup} disabled={anonymousGroupSaving || anonymousGroupPending === (anonymousGroup ?? '')}>
                    {anonymousGroupSaving ? 'Saving…' : 'Save'}
                </button>
            </div>
            {#if anonymousGroup}
            <div class="anon-current">Current: <span class="mono">{anonymousGroup}</span></div>
            {:else}
            <div class="anon-current muted">No anonymous group configured.</div>
            {/if}
            {/if}
        </div>
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

<ConfirmDialog bind:this={dialog} />

<style>
    .users-page {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .plugin-warning {
        flex-shrink: 0;
        padding: 8px 14px;
        background: rgba(200, 140, 0, 0.15);
        border-bottom: 1px solid rgba(200, 140, 0, 0.4);
        font-size: 12px;
        color: #e2a84b;
        line-height: 1.5;
    }
    .plugin-warning code { font-size: 11px; opacity: 0.9; }

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

    .tags { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; }
    .tag { background: rgba(86,156,214,0.12); border: 1px solid rgba(86,156,214,0.25); border-radius: 3px; color: #7ab; display: inline-flex; align-items: center; font-family: monospace; font-size: 10px; gap: 2px; padding: 1px 3px 1px 5px; }
    .tag--group { background: rgba(180,130,40,0.12); border-color: rgba(180,130,40,0.25); color: #ca8; }

    /* Inline badge × button */
    .tag-x { background: none; border: none; color: inherit; cursor: pointer; font-size: 10px; line-height: 1; opacity: 0.55; padding: 0 1px; }
    .tag-x:hover { opacity: 1; color: #e88; }

    /* Inline + button */
    .tag-plus { background: none; border: 1px dashed rgba(86,156,214,0.3); border-radius: 3px; color: rgba(86,156,214,0.5); cursor: pointer; font-size: 11px; line-height: 1; padding: 0px 4px; }
    .tag-plus:hover { border-color: rgba(86,156,214,0.6); color: var(--accent, #569cd6); }
    .tag-plus--group { border-color: rgba(180,130,40,0.3); color: rgba(180,130,40,0.5); }
    .tag-plus--group:hover { border-color: rgba(180,130,40,0.6); color: #ca8; }

    /* Inline add row (appears below tags in cell) */
    .tags-cell { display: flex; flex-direction: column; gap: 4px; }
    .inline-add { display: flex; gap: 4px; align-items: center; }
    .inline-add select { background: var(--input-bg, #1e1e1e); border: 1px solid var(--border, #555); border-radius: 3px; color: var(--text, #eee); font-size: 10px; padding: 2px 4px; max-width: 160px; }
    .inline-confirm { background: var(--accent-dim, rgba(86,156,214,0.12)); border: 1px solid rgba(86,156,214,0.3); border-radius: 3px; color: var(--accent, #569cd6); cursor: pointer; font-size: 10px; padding: 2px 7px; }
    .inline-confirm:disabled { opacity: 0.4; cursor: not-allowed; }
    .inline-cancel { background: none; border: none; color: var(--text-muted, #666); cursor: pointer; font-size: 11px; padding: 0 2px; }
    .inline-cancel:hover { color: #e88; }
    .inline-err { color: #e88; font-size: 10px; }

    .cell-actions { width: 1%; white-space: nowrap; }
    .actions { display: flex; gap: 4px; justify-content: flex-end; }
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

    /* Settings panel */
    .settings-section { border-bottom: 1px solid var(--border, #333); padding: 14px 0; }
    .settings-section:last-child { border-bottom: none; }
    .settings-heading { font-size: 12px; color: var(--text-muted, #aaa); font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 4px; }
    .settings-hint { font-size: 11px; color: var(--text-muted, #777); margin: 0 0 10px; line-height: 1.5; }
    .settings-hint code { font-size: 10.5px; opacity: 0.9; }
    .acl-defaults-table { border-collapse: collapse; font-size: 12px; width: auto; }
    .acl-defaults-table th { color: var(--text-muted, #888); font-weight: 500; padding: 3px 12px 3px 0; text-align: left; border-bottom: 1px solid var(--border, #333); }
    .acl-defaults-table td { padding: 5px 12px 5px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .acl-defaults-table tr.saving { opacity: 0.6; pointer-events: none; }
    .acl-radio { text-align: center; padding-right: 16px !important; }
    .anon-row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
    .anon-row select { background: var(--input-bg, #1e1e1e); border: 1px solid var(--border, #555); border-radius: 4px; color: var(--text, #eee); font-size: 12px; padding: 5px 8px; min-width: 180px; }
    .anon-row button { background: var(--accent-dim, rgba(86,156,214,0.12)); border: 1px solid var(--accent-border, rgba(86,156,214,0.3)); border-radius: 4px; color: var(--accent, #569cd6); cursor: pointer; font-size: 12px; padding: 5px 12px; }
    .anon-row button:disabled { opacity: 0.5; cursor: not-allowed; }
    .anon-current { font-size: 11px; color: var(--text-muted, #888); }
    .anon-current.muted { opacity: 0.6; }
</style>
