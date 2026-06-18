'use strict';

/**
 * broker sandbox module — adds she.broker.* to every script context.
 *
 * Loaded automatically by loadSandbox() in index.js (all *.js files in
 * src/sandbox/ are scanned). If dynsec is not configured, she.broker is still
 * defined but every method rejects with a descriptive error so scripts can
 * detect the situation gracefully.
 *
 * she.broker API:
 *   she.broker.createUser(username, password)          → Promise
 *   she.broker.deleteUser(username)                    → Promise
 *   she.broker.setPassword(username, password)         → Promise
 *   she.broker.listUsers()                             → Promise<User[]>
 *   she.broker.getUser(username)                       → Promise<User>
 *   she.broker.createRole(rolename)                    → Promise
 *   she.broker.deleteRole(rolename)                    → Promise
 *   she.broker.listRoles()                             → Promise<Role[]>
 *   she.broker.getRole(rolename)                       → Promise<Role>
 *   she.broker.addACL(rolename, {type, topic, allow})  → Promise
 *   she.broker.removeACL(rolename, {type, topic})      → Promise
 *   she.broker.assignRole(username, rolename)          → Promise
 *   she.broker.revokeRole(username, rolename)          → Promise
 *   she.broker.createGroup(groupname)                  → Promise
 *   she.broker.deleteGroup(groupname)                  → Promise
 *   she.broker.listGroups()                            → Promise<Group[]>
 *   she.broker.addToGroup(username, groupname)         → Promise
 *   she.broker.removeFromGroup(username, groupname)    → Promise
 *   she.broker.assignRoleToGroup(groupname, rolename)  → Promise
 *
 * ACL types (dynsec):
 *   'publishClientSend' | 'publishClientReceive' |
 *   'subscribeLiteral'  | 'subscribePattern'     |
 *   'unsubscribeLiteral'| 'unsubscribePattern'
 */

const dynsec = require('../lib/dynsec');

module.exports = function (she) {
    she.broker = {
        // ── Users ──────────────────────────────────────────────────────────────
        createUser(username, password) {
            return dynsec.createClient(username, password);
        },
        deleteUser(username) {
            return dynsec.deleteClient(username);
        },
        setPassword(username, password) {
            return dynsec.setClientPassword(username, password);
        },
        listUsers() {
            return dynsec.listClients(/* verbose= */ true);
        },
        getUser(username) {
            return dynsec.getClient(username);
        },

        // ── Roles ──────────────────────────────────────────────────────────────
        createRole(rolename) {
            return dynsec.createRole(rolename);
        },
        deleteRole(rolename) {
            return dynsec.deleteRole(rolename);
        },
        listRoles() {
            return dynsec.listRoles(/* verbose= */ true);
        },
        getRole(rolename) {
            return dynsec.getRole(rolename);
        },
        /**
         * Add an ACL rule to a role.
         * @param {string} rolename
         * @param {{ type: string, topic: string, allow: boolean }} acl
         */
        addACL(rolename, { type, topic, allow }) {
            return dynsec.addRoleACL(rolename, type, topic, allow);
        },
        removeACL(rolename, { type, topic }) {
            return dynsec.removeRoleACL(rolename, type, topic);
        },

        // ── Role ↔ user assignment ─────────────────────────────────────────────
        assignRole(username, rolename) {
            return dynsec.addClientRole(username, rolename);
        },
        revokeRole(username, rolename) {
            return dynsec.removeClientRole(username, rolename);
        },

        // ── Groups ─────────────────────────────────────────────────────────────
        createGroup(groupname) {
            return dynsec.createGroup(groupname);
        },
        deleteGroup(groupname) {
            return dynsec.deleteGroup(groupname);
        },
        listGroups() {
            return dynsec.listGroups(/* verbose= */ true);
        },
        addToGroup(username, groupname) {
            // dynsec groups are addressed by group; client is the arg
            return dynsec.addGroupClient(groupname, username);
        },
        removeFromGroup(username, groupname) {
            return dynsec.removeGroupClient(groupname, username);
        },
        assignRoleToGroup(groupname, rolename) {
            return dynsec.addGroupRole(groupname, rolename);
        },
    };
};
