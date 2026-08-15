'use strict';

/**
 * Unified in-memory state store for all interfaces (MQTT, Matter, variables).
 *
 * Keys are namespaced with a double-colon separator:
 *   mqtt::home/sensor/temp
 *   matter::1/1/LevelControl/currentLevel
 *   var::myVariable
 *
 * Events:
 *   'change' (key, val, obj, prevObj)
 *   'delete' (key, prevObj)
 */

const { EventEmitter } = require('events');

class StateStore extends EventEmitter {
    constructor() {
        super();
        this._map = new Map();
    }

    /**
     * Store a value, auto-computing { val, ts, lc } timestamps.
     * Emits 'change' on every call.
     * @param {string} key  Namespaced key, e.g. 'mqtt::home/sensor/temp'
     * @param {*}      val
     */
    set(key, val) {
        const now = Date.now();
        const prev = this._map.get(key);
        const lc = !prev || prev.val !== val ? now : prev.lc;
        const obj = { val, ts: now, lc };
        this._map.set(key, obj);
        this.emit('change', key, val, obj, prev);
    }

    /**
     * Store a pre-constructed state object { val, ts, lc }.
     * Use when the caller has already built the state (e.g. MQTT parse-payload).
     * @param {string} key
     * @param {{ val:*, ts:number, lc:number }} obj
     */
    setObject(key, obj) {
        const prev = this._map.get(key);
        this._map.set(key, obj);
        this.emit('change', key, obj.val, obj, prev);
    }

    /**
     * Remove a key from the store (e.g. when a retained MQTT message is
     * deleted via an empty retained publish). Emits 'delete' (key, prevObj)
     * when the key existed; a no-op otherwise.
     * @param {string} key
     * @returns {boolean} true when the key existed and was removed
     */
    delete(key) {
        const prev = this._map.get(key);
        if (prev === undefined) return false;
        this._map.delete(key);
        this.emit('delete', key, prev);
        return true;
    }

    /**
     * @param {string} key
     * @returns {*} the val of the stored state, or undefined
     */
    get(key) {
        const obj = this._map.get(key);
        return obj !== undefined ? obj.val : undefined;
    }

    /**
     * @param {string} key
     * @returns {{ val:*, ts:number, lc:number } | undefined}
     */
    getObject(key) {
        return this._map.get(key);
    }

    /** @returns {boolean} */
    has(key) {
        return this._map.has(key);
    }

    /**
     * Return all keys, optionally filtered to those starting with nsPrefix.
     * @param {string} [nsPrefix]
     * @returns {string[]}
     */
    keys(nsPrefix) {
        const all = Array.from(this._map.keys());
        return nsPrefix ? all.filter((k) => k.startsWith(nsPrefix)) : all;
    }

    /**
     * Iterate [rawTopic, obj] pairs for all mqtt:: keys, stripping the prefix.
     * Used for wildcard retain-replay in subscribe().
     * @yields {[string, {val:*, ts:number, lc:number}]}
     */
    *mqttEntries() {
        const prefix = 'mqtt::';
        for (const [key, obj] of this._map) {
            if (key.startsWith(prefix)) {
                yield [key.slice(prefix.length), obj];
            }
        }
    }
}

module.exports = StateStore;
