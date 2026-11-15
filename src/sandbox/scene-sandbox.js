'use strict';

/**
 * Scene sandbox module — adds she.scene.* to every script.
 *
 *   she.scene.list()                          → [{id, name, area, deactivate, groups, members, val, matched, total}]
 *   she.scene.state(id)                       → {id, name, val, matched, total, mismatch, unknown, recalled, settling} | null
 *   she.scene.recall(id, [{force}])           → {ok, sent, skipped, problems, reason?}
 *   she.scene.deactivate(id)                  → {ok, mode, sent, reason?}
 *   she.scene.toggle(id)
 *   she.scene.snapshot(id, [entities], [fields]) → the scene document: create it from the present state
 *                                               of the entities, or take its members' states again
 *   she.scene.remove(id)
 *   she.scene.sub([id], cb)                   → cb(id, state) when a scene's published state changes
 *   she.scene.groups([{area}])                → [{id, name, area, scenes, default, val}]
 *   she.scene.group(id)                       → one group | null
 *   she.scene.setGroup(id, sceneId | '')      → recall a scene of the group, or the group's deactivation
 *
 * The topics (<name>/status|set/scene/<id>) are the contract; these are conveniences over the same engine.
 */

const scenes = require('../web/scenes');

function engine(api) {
    const e = scenes.getEngine();
    if (!e) throw new Error(`she.scene.${api}: scenes need sheDB (--db-path) and the home model's entity layer`);
    return e;
}

module.exports = function (she, ctx = {}) {
    const { scriptDomain, onUnload } = ctx;

    she.scene = {
        list: () => engine('list').list(),
        state: (id) => engine('state').state(String(id)),
        recall: (id, options) => engine('recall').recall(String(id), options || {}),
        deactivate: (id) => engine('deactivate').deactivate(String(id)),
        toggle: (id, options) => engine('toggle').toggle(String(id), options || {}),
        get: (id) => engine('get').get(String(id)),

        /**
         * Create a scene from the present state of entities, or take the states of its members again.
         * @param {string} id
         * @param {string[]} [entities]  ids, unique_ids or topics; omitted: the scene's members
         * @param {object} [fields]      name, area, deactivate, settle
         */
        snapshot(id, entities, fields) {
            if (entities !== undefined && entities !== null && !Array.isArray(entities)) {
                fields = entities;
                entities = undefined;
            }
            // a script has no editor to confirm in: a lock becomes a condition unless the script says so
            const { confirmSensitive, ...rest } = fields || {};
            return engine('snapshot').snapshot(String(id), entities || undefined, rest, { confirmSensitive: confirmSensitive === true });
        },

        remove: (id) => engine('remove').remove(String(id)),

        /**
         * Hear when a scene's state as published changes (after the debounce).
         * @param {string|Function} id  a scene id, or the callback for every scene
         * @param {(id: string, state: object|null) => void} [cb]  state is null when the scene was deleted
         */
        sub(id, cb) {
            if (typeof id === 'function') {
                cb = id;
                id = null;
            }
            if (typeof cb !== 'function') throw new TypeError('she.scene.sub: callback is not a function');
            const e = engine('sub');
            const bound = scriptDomain ? scriptDomain.bind(cb) : cb;
            const heard = (sceneId, state) => {
                if (id === null || id === undefined || sceneId === String(id)) bound(sceneId, state);
            };
            e.on('scene', heard);
            const cancel = () => e.off('scene', heard);
            if (typeof onUnload === 'function') onUnload(cancel);
            return cancel;
        },

        groups: (filter) => engine('groups').groups(filter || {}),
        group: (id) => engine('group').groupState(String(id)),
        setGroup: (id, value, options) => engine('setGroup').setGroup(String(id), value, options || {}),
    };
};
