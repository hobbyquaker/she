'use strict';

/**
 * she.home.entity() — one entity of the home model, with its live state and commands.
 *
 * The she.home sandbox module (sandbox/home-sandbox.js) adds it to every script:
 *
 *   const lamp = she.home.entity('lamp1_light');      // id, unique_id, or a topic of the entity
 *   lamp.state();                                     // { state: 'ON', brightness: 102, color_temp: 370 }
 *   lamp.turnOn({ brightness: 128 });
 *   lamp.sub((now, before) => she.log(lamp.name, now.state));
 */

const home = require('../web/home');
const entities = require('../web/home-entities');
const { entitySummary } = require('./home-views');

/**
 * @param {object} ctx  the sandbox context of one script
 * @param {object} [ctx.scriptDomain]  the script's domain: its callbacks are bound to it
 * @param {(fn: Function) => void} [ctx.onUnload]  runs fn when the script is unloaded
 * @param {(msg: string) => void} [ctx.warn]  the script's log
 * @returns {(ref: string) => object|null} she.home.entity
 */
module.exports = function createEntityApi({ scriptDomain, onUnload, warn: warnFn } = {}) {
    const warn = (msg) => (typeof warnFn === 'function' ? warnFn(msg) : undefined);

    /**
     * @param {string} ref  the entity's id (`she/entity/…` or the part behind it), its `unique_id`,
     *                      or a topic it reads or writes
     * @returns {object|null} null when there is no such entity
     */
    function entity(ref) {
        const model = home.getModel();
        if (!model) throw new Error('she.home.entity: the home model needs sheDB (--db-path)');
        const layer = entities.getLayer();
        if (!layer) throw new Error('she.home.entity: the entity library (mqtt-ha-entities) could not be loaded — see the log of the start');
        const id = layer.resolve(ref);
        if (!id) return null;
        const doc = model.entity(id);
        const what = layer.describe(id);
        if (!doc || !what) return null;

        /** send, and say in the script's log what could not be set */
        const set = (attributes) => {
            const { sent, problems } = layer.command(id, attributes);
            for (const problem of problems) warn(`she.home.entity('${ref}'): ${problem}`);
            return sent;
        };
        /** the convenience commands exist for every entity; one that cannot take them says so */
        const needs = (attribute, call) => {
            if (what.attributes[attribute]?.write) return true;
            warn(`she.home.entity('${ref}').${call}: a ${what.component} entity ${attribute in what.attributes ? 'cannot set its ' : 'has no '}${attribute}`);
            return false;
        };
        /** a lock is never opened by something that turns "everything" on: it wants set({state: 'UNLOCKED'}) */
        const switchable = (call) => {
            if (what.component !== 'lock') return needs('state', call);
            warn(`she.home.entity('${ref}').${call}: a lock is not turned on or off — set({ state: 'LOCKED' }) or set({ state: 'UNLOCKED' })`);
            return false;
        };
        const stateWord = (on) => {
            if (what.component === 'cover') return on ? 'open' : 'closed';
            return on ? 'ON' : 'OFF';
        };

        return {
            // the summary she.home.entities() gives, and what the entity tells and takes
            ...entitySummary(doc),
            hidden: !!(doc.eff && doc.eff.hidden),
            present: !doc.ha || doc.ha.present !== false,
            supported: what.supported,
            stateless: what.stateless,
            primary: what.primary,
            attributes: what.attributes,
            topics: what.topics,

            /** the state in Home Assistant's terms: `{state: 'ON', brightness: 102}` */
            state: () => layer.state(id),
            /** true, false, or undefined while the availability topics have said nothing */
            available: () => layer.available(id),
            /** the part of the state that can be set again */
            snapshot: () => layer.snapshot(id),
            /** is the entity in this state? `{match, available, unknown, mismatches, state}` */
            matches: (expected, options) => layer.compare(id, expected, options),

            /** set any attributes; returns the publishes that were sent */
            set,
            /** on (a cover: open) — a light takes attributes: `turnOn({brightness: 128})` */
            turnOn: (attributes = {}) => (what.stateless ? set({}) : switchable('turnOn()') ? set({ ...attributes, state: stateWord(true) }) : []),
            /** off (a cover: closed) */
            turnOff: () => (switchable('turnOff()') ? set({ state: stateWord(false) }) : []),
            /** a cover's position in percent, 100 = open */
            setPosition: (position) => (needs('position', 'setPosition()') ? set({ position }) : []),
            /** a thermostat's setpoint */
            setTemperature: (temperature) => (needs('temperature', 'setTemperature()') ? set({ temperature }) : []),
            /** press a button, activate a scene */
            trigger: () => (what.stateless ? set({}) : (warn(`she.home.entity('${ref}').trigger(): a ${what.component} entity is not triggered, it is set`), [])),

            /**
             * hear when the state or the availability changes: callback(now, before) with
             * `{state, available, present}`; removed when the script is reloaded
             */
            sub(callback) {
                if (typeof callback !== 'function') throw new TypeError('she.home.entity().sub: callback must be a function');
                const heard = (_id, now, before) => callback(now, before);
                const stop = layer.watch(id, scriptDomain ? scriptDomain.bind(heard) : heard);
                if (typeof onUnload === 'function') onUnload(stop);
                return stop;
            },
        };
    }

    return entity;
};
