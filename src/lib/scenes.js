'use strict';

/**
 * The scene controller's engine.
 *
 * A scene is a stored state of selected entities of the home model — lamp on at 40 %, blind at
 * 30 %, thermostat at 21 °C — and a datapoint of its own: `true` while every member is in that
 * state, whoever brought it there, `false` as soon as one is not. Setting it `true` recalls the
 * state; what setting it `false` does is the scene's `deactivate` mode.
 *
 * Documents (sheDB):
 *
 *   she/scene/<id>           { schema, kind: 'scene', name, icon?, area?, deactivate, settle,
 *                              members: [{ entity, attributes, tolerance?, role?, order?, delay?,
 *                              confirmed?, off? }], created, modified }
 *   she/scene/<id>/restore   { recalled, members: [{ entity, before, scene }] } — written by a
 *                              recall of a scene with `deactivate: 'restore'`
 *   she/scenegroup/<id>      { schema, kind: 'scenegroup', name, area?, scenes: [ids], default? }
 *
 * Topics (`<name>` is she's instance name):
 *
 *   <name>/status/scene/<id>        retained { val, ts, lc, matched, total, mismatch, unknown, recalled? }
 *   <name>/set/scene/<id>           true | false | "toggle" | { val, force }
 *   <name>/status/scenegroup/<id>   retained { val: the matching scene's id or "", ts, lc }
 *   <name>/set/scenegroup/<id>      a scene id: recall it; "" | false | "none": the group's deactivation
 *
 * The live state is computed, never stored: the entity layer reads the members from the state
 * store, and the engine hears from it when one of them changes. The engine knows nothing about
 * MQTT clients or files; what it publishes goes through the injected `publish`.
 */

const { EventEmitter } = require('events');

const SCHEMA = 1;
const P_SCENE = 'she/scene/';
const P_GROUP = 'she/scenegroup/';
const RESTORE = '/restore';

const DEACTIVATE = ['none', 'restore', 'off'];
const ROLES = ['recall+match', 'match', 'recall'];
/** entities that open a house: a member needs `confirmed: true` to be commanded */
const SENSITIVE = new Set(['lock', 'alarm_control_panel']);
/** components with an obvious "off" */
const HAS_OFF = new Set(['light', 'switch', 'fan']);

const DEFAULTS = {
    /** a status is published after this long without a change of a member */
    debounce: 1000,
    /** seconds after a recall's last command in which a mismatch is not yet told */
    settle: 10,
    /** the loop guard: at most `loopMax` recalls of a scene within `loopWindow` ms */
    loopMax: 5,
    loopWindow: 10000,
};

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** an id for a scene or a group from its name: lower case, dashes */
function slug(s) {
    return String(s)
        .replace(/ß/g, 'ss')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** ids are one topic level and one sheDB path segment */
function checkId(id, what) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${what}: the id must consist of letters, digits, - and _ (got ${JSON.stringify(id)})`);
    return id;
}

/**
 * Check a scene document and return it in its stored form. Throws an Error that names what is wrong.
 * @param {object} doc
 * @returns {object}
 */
function validateScene(doc) {
    if (!isRecord(doc)) throw new Error('scene: the document must be an object');
    if (typeof doc.name !== 'string' || !doc.name.trim()) throw new Error('scene: name is required');
    const out = { ...doc, schema: SCHEMA, kind: 'scene', name: doc.name.trim() };
    const d = doc.deactivate === undefined || doc.deactivate === null ? 'none' : doc.deactivate;
    if (!DEACTIVATE.includes(d) && !(typeof d === 'string' && /^scene:[A-Za-z0-9_-]+$/.test(d))) {
        throw new Error(`scene: deactivate must be one of ${DEACTIVATE.join(', ')} or scene:<id> (got ${JSON.stringify(d)})`);
    }
    out.deactivate = d;
    if (doc.settle !== undefined && doc.settle !== null && !(typeof doc.settle === 'number' && doc.settle >= 0 && doc.settle <= 3600)) {
        throw new Error('scene: settle is a number of seconds between 0 and 3600');
    }
    out.settle = typeof doc.settle === 'number' ? doc.settle : DEFAULTS.settle;
    if (doc.area !== undefined && doc.area !== null && typeof doc.area !== 'string') throw new Error('scene: area is a room id');
    if (!Array.isArray(doc.members)) throw new Error('scene: members must be a list');
    const seen = new Set();
    out.members = doc.members.map((m, i) => {
        const where = `scene: members[${i}]`;
        if (!isRecord(m)) throw new Error(`${where} must be an object`);
        if (typeof m.entity !== 'string' || !m.entity.startsWith('she/entity/')) throw new Error(`${where}.entity must be an entity document id (she/entity/…)`);
        if (seen.has(m.entity)) throw new Error(`${where}: ${m.entity} is a member twice`);
        seen.add(m.entity);
        if (m.attributes !== undefined && !isRecord(m.attributes)) throw new Error(`${where}.attributes must be an object`);
        const role = m.role === undefined || m.role === null ? 'recall+match' : m.role;
        if (!ROLES.includes(role)) throw new Error(`${where}.role must be one of ${ROLES.join(', ')}`);
        if (m.tolerance !== undefined && m.tolerance !== null && !isRecord(m.tolerance)) throw new Error(`${where}.tolerance must be an object { attribute: number }`);
        for (const key of ['order', 'delay']) {
            if (m[key] !== undefined && m[key] !== null && !(typeof m[key] === 'number' && Number.isFinite(m[key]) && (key === 'order' || m[key] >= 0))) {
                throw new Error(`${where}.${key} must be a number${key === 'delay' ? ' of seconds, 0 or more' : ''}`);
            }
        }
        if (m.off !== undefined && m.off !== null && m.off !== false && !isRecord(m.off)) throw new Error(`${where}.off must be an object of attributes, or false`);
        return { ...m, attributes: m.attributes || {}, role };
    });
    return out;
}

/**
 * Check a scene group document.
 * @param {object} doc
 * @returns {object}
 */
function validateGroup(doc) {
    if (!isRecord(doc)) throw new Error('scene group: the document must be an object');
    if (typeof doc.name !== 'string' || !doc.name.trim()) throw new Error('scene group: name is required');
    if (!Array.isArray(doc.scenes) || doc.scenes.some((s) => typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)))
        throw new Error('scene group: scenes must be a list of scene ids');
    if (new Set(doc.scenes).size !== doc.scenes.length) throw new Error('scene group: a scene is listed twice');
    if (doc.default !== undefined && doc.default !== null && !doc.scenes.includes(doc.default)) throw new Error('scene group: default must be one of its scenes');
    if (doc.area !== undefined && doc.area !== null && typeof doc.area !== 'string') throw new Error('scene group: area is a room id');
    return { ...doc, schema: SCHEMA, kind: 'scenegroup', name: doc.name.trim(), default: doc.default ?? null };
}

/**
 * What a set topic's payload asks for.
 * @param {*} val  the parsed payload (`{val}` unwrapped by the caller or not)
 * @returns {{action: 'recall'|'deactivate'|'toggle', force: boolean}|null}
 */
function parseSet(val) {
    let force = false;
    if (isRecord(val)) {
        force = val.force === true;
        val = val.val;
    }
    if (typeof val === 'string') {
        const s = val.trim().toLowerCase();
        if (s === 'toggle') return { action: 'toggle', force };
        if (['true', 'on', '1'].includes(s)) return { action: 'recall', force };
        if (['false', 'off', '0'].includes(s)) return { action: 'deactivate', force };
        return null;
    }
    if (val === true || val === 1) return { action: 'recall', force };
    if (val === false || val === 0) return { action: 'deactivate', force };
    return null;
}

class SceneEngine extends EventEmitter {
    /**
     * @param {object} opts
     * @param {object} opts.core     the sheDB core
     * @param {object} opts.layer    the entity layer (lib/home-entities.js)
     * @param {(topic: string, payload: string, options: {retain: boolean}) => boolean} opts.publish
     * @param {string} opts.name     she's instance name, the first level of the topics
     * @param {object} opts.log
     * @param {object} [opts.announcer]  she's discovery announcer: scenes become switches, groups selects
     * @param {(id: string) => string|null} [opts.entityName]  a readable name for an entity id
     * @param {() => number} [opts.now]
     * @param {number} [opts.debounce]   ms
     */
    constructor({ core, layer, publish, name, log, announcer = null, entityName = null, now = Date.now, ...tuning }) {
        super();
        this.setMaxListeners(0);
        this.core = core;
        this.layer = layer;
        this.publish = publish;
        this.name = name;
        this.log = log;
        this.announcer = announcer;
        this.entityName = entityName || (() => null);
        this.now = now;
        this.opts = { ...DEFAULTS, ...Object.fromEntries(Object.entries(tuning).filter(([k, v]) => k in DEFAULTS && typeof v === 'number')) };

        /** scene id → runtime */
        this._scenes = new Map();
        /** group id → runtime */
        this._groups = new Map();
        this._started = false;
        this._writing = 0;
        this._dirtyGroups = new Set();
        this._groupsQueued = false;

        this._onDoc = (id, doc) => {
            if (this._writing || typeof id !== 'string') return;
            if (id.startsWith(P_SCENE) && !id.endsWith(RESTORE)) this._loadScene(id.slice(P_SCENE.length), isRecord(doc) ? doc : null);
            else if (id.startsWith(P_GROUP)) this._loadGroup(id.slice(P_GROUP.length), isRecord(doc) ? doc : null);
        };
    }

    // ------------------------------------------------------------------
    // Start and stop
    // ------------------------------------------------------------------

    /** Load every scene and group, publish their states, follow the documents. */
    start() {
        if (this._started) return;
        this._started = true;
        for (const id of Object.keys(this.core.docs)) {
            if (id.startsWith(P_SCENE) && !id.endsWith(RESTORE)) this._loadScene(id.slice(P_SCENE.length), this.core.docs[id]);
        }
        for (const id of Object.keys(this.core.docs)) {
            if (id.startsWith(P_GROUP)) this._loadGroup(id.slice(P_GROUP.length), this.core.docs[id]);
        }
        this.core.on('update', this._onDoc);
    }

    /** Stop listening and drop every timer (shutdown, tests). The retained states stay. */
    stop() {
        this.core.off('update', this._onDoc);
        for (const rt of this._scenes.values()) this._release(rt);
        this._scenes.clear();
        this._groups.clear();
        this._started = false;
    }

    /** Publish every state again: after a broker connect. */
    republish() {
        for (const rt of this._scenes.values()) this._publishScene(rt, true);
        for (const g of this._groups.values()) this._publishGroup(g, true);
    }

    _release(rt) {
        clearTimeout(rt.debounceTimer);
        clearTimeout(rt.settleTimer);
        for (const t of rt.sends) clearTimeout(t);
        rt.sends = [];
        for (const stop of rt.watchers) stop();
        rt.watchers = [];
        if (rt.announced) rt.announced.remove();
        rt.announced = null;
    }

    // ------------------------------------------------------------------
    // Documents
    // ------------------------------------------------------------------

    _loadScene(id, doc) {
        const prev = this._scenes.get(id);
        if (prev) this._release(prev);
        if (!doc || !/^[A-Za-z0-9_-]+$/.test(id)) {
            if (prev) {
                this._scenes.delete(id);
                this._clear(`${this.name}/status/scene/${id}`);
                this.emit('scene', id, null);
                this._groupsOf(id).forEach((g) => this._evaluateGroup(g));
            }
            return;
        }
        let scene;
        try {
            scene = validateScene(doc);
        } catch (err) {
            this.log.warn(`scene ${id}: ${err.message} — the scene is not active`);
            if (prev) {
                this._scenes.delete(id);
                this._clear(`${this.name}/status/scene/${id}`);
            }
            return;
        }
        const rt = {
            id,
            doc: scene,
            state: prev ? prev.state : null,
            published: prev ? prev.published : undefined,
            publishedVal: prev ? prev.publishedVal : undefined,
            lc: prev ? prev.lc : undefined,
            recalled: prev ? prev.recalled : undefined,
            recalls: prev ? prev.recalls : [],
            settleUntil: 0,
            debounceTimer: null,
            settleTimer: null,
            sends: [],
            watchers: [],
            announced: null,
        };
        this._scenes.set(id, rt);
        for (const m of scene.members) {
            if (m.role === 'recall') continue;
            rt.watchers.push(this.layer.watch(m.entity, () => this._memberChanged(rt)));
        }
        this._announceScene(rt);
        this._evaluate(rt);
        this._publishScene(rt);
        this._groupsOf(id).forEach((g) => this._evaluateGroup(g));
    }

    _loadGroup(id, doc) {
        const prev = this._groups.get(id);
        if (prev && prev.announced) prev.announced.remove();
        if (!doc || !/^[A-Za-z0-9_-]+$/.test(id)) {
            if (prev) {
                this._groups.delete(id);
                this._clear(`${this.name}/status/scenegroup/${id}`);
                this.emit('group', id, null);
            }
            return;
        }
        let group;
        try {
            group = validateGroup(doc);
        } catch (err) {
            this.log.warn(`scene group ${id}: ${err.message} — the group is not active`);
            if (prev) {
                this._groups.delete(id);
                this._clear(`${this.name}/status/scenegroup/${id}`);
            }
            return;
        }
        const g = { id, doc: group, val: prev ? prev.val : undefined, lc: prev ? prev.lc : undefined, published: prev ? prev.published : undefined, announced: null };
        this._groups.set(id, g);
        this._announceGroup(g);
        this._evaluateGroup(g);
    }

    _groupsOf(sceneId) {
        return [...this._groups.values()].filter((g) => g.doc.scenes.includes(sceneId));
    }

    /** write a document without hearing the own update */
    _write(fn) {
        this._writing++;
        try {
            return fn();
        } finally {
            this._writing--;
        }
    }

    // ------------------------------------------------------------------
    // Home Assistant discovery (scenes as switches, groups as selects)
    // ------------------------------------------------------------------

    _announce(cfg) {
        if (!this.announcer) return null;
        try {
            return this.announcer.announce('she:scenes', 'scenes', { ...cfg, device: { name: 'Scenes', id: 'scenes', model: 'Scene controller' } });
        } catch (err) {
            this.log.warn(`scenes: not announced: ${err.message}`);
            return null;
        }
    }

    _announceScene(rt) {
        rt.announced = this._announce({
            component: 'switch',
            id: `scene_${rt.id}`,
            name: rt.doc.name,
            icon: typeof rt.doc.icon === 'string' && rt.doc.icon ? rt.doc.icon : 'mdi:palette',
            state_topic: `${this.name}/status/scene/${rt.id}`,
            value_template: "{{ 'ON' if value_json.val else 'OFF' }}",
            state_on: 'ON',
            state_off: 'OFF',
            command_topic: `${this.name}/set/scene/${rt.id}`,
            payload_on: 'true',
            payload_off: 'false',
            json_attributes_topic: `${this.name}/status/scene/${rt.id}`,
        });
    }

    _announceGroup(g) {
        g.announced = this._announce({
            component: 'select',
            id: `scenegroup_${g.id}`,
            name: g.doc.name,
            icon: 'mdi:palette-swatch',
            options: ['none', ...g.doc.scenes],
            state_topic: `${this.name}/status/scenegroup/${g.id}`,
            value_template: "{{ value_json.val if value_json.val else 'none' }}",
            command_topic: `${this.name}/set/scenegroup/${g.id}`,
        });
    }

    // ------------------------------------------------------------------
    // Matching
    // ------------------------------------------------------------------

    /** Compute a scene's state from its members now. */
    _evaluate(rt) {
        const mismatch = [];
        const unknown = [];
        let matched = 0;
        let total = 0;
        for (const m of rt.doc.members) {
            if (m.role === 'recall') continue;
            total++;
            const name = this.entityName(m.entity) || m.entity.slice('she/entity/'.length);
            if (!this.layer.entity(m.entity)) {
                unknown.push({ entity: m.entity, name, reason: 'missing' });
                continue;
            }
            const r = this.layer.compare(m.entity, m.attributes, { tolerances: m.tolerance || undefined });
            if (r.available === false) {
                unknown.push({ entity: m.entity, name, reason: 'unavailable' });
                continue;
            }
            for (const attribute of r.unknown) unknown.push({ entity: m.entity, name, attribute, reason: 'no value' });
            for (const x of r.mismatches) mismatch.push({ entity: m.entity, name, attribute: x.attribute, is: x.actual, want: x.expected });
            if (r.match) matched++;
        }
        rt.state = { val: total > 0 && matched === total, matched, total, mismatch, unknown };
        return rt.state;
    }

    /** A member's state changed: tell it after a moment of quiet. */
    _memberChanged(rt) {
        clearTimeout(rt.debounceTimer);
        rt.debounceTimer = setTimeout(() => {
            rt.debounceTimer = null;
            this._evaluate(rt);
            this._publishScene(rt);
        }, this.opts.debounce);
        rt.debounceTimer.unref?.();
    }

    _publishScene(rt, again = false) {
        const s = rt.state;
        if (!s) return;
        // The scene is there and its recall has nothing left to send: it has settled, and what changes
        // from now on is told. This must not wait for a publish — a recall of a scene that is already
        // true changes nothing that would be published at this point.
        if (s.val && rt.settleUntil && !rt.sends.length) this._afterDeactivate(rt);
        // while a recall settles, entities that have not answered yet do not make the scene false
        if (!s.val && this.now() < rt.settleUntil && !again) return;
        const body = JSON.stringify({ val: s.val, matched: s.matched, total: s.total, mismatch: s.mismatch, unknown: s.unknown, recalled: rt.recalled });
        if (!again && body === rt.published) return;
        const ts = this.now();
        const before = rt.publishedVal;
        if (rt.lc === undefined || before !== s.val) rt.lc = ts;
        const payload = { val: s.val, ts, lc: rt.lc, matched: s.matched, total: s.total, mismatch: s.mismatch, unknown: s.unknown };
        if (rt.recalled !== undefined) payload.recalled = rt.recalled;
        if (!this.publish(`${this.name}/status/scene/${rt.id}`, JSON.stringify(payload), { retain: true })) return;
        rt.published = body;
        rt.publishedVal = s.val;
        if (before !== s.val || !again) this.emit('scene', rt.id, this.state(rt.id));
        if (before !== s.val) this._groupsChanged(rt.id);
    }

    /**
     * A scene of a group changed. The group is looked at once the turn is over: when one scene
     * goes and another comes in the same moment, the group shows the new one, not "none" in between.
     */
    _groupsChanged(sceneId) {
        for (const g of this._groupsOf(sceneId)) this._dirtyGroups.add(g.id);
        if (this._groupsQueued) return;
        this._groupsQueued = true;
        setImmediate(() => {
            this._groupsQueued = false;
            const ids = [...this._dirtyGroups];
            this._dirtyGroups.clear();
            for (const id of ids) if (this._groups.has(id)) this._evaluateGroup(this._groups.get(id));
        });
    }

    /** the scene a group shows: the first of its list that is true as published */
    _evaluateGroup(g) {
        let val = '';
        for (const id of g.doc.scenes) {
            const rt = this._scenes.get(id);
            if (rt && rt.publishedVal === true) {
                val = id;
                break;
            }
        }
        const changed = g.val !== val;
        g.val = val;
        if (changed || g.published === undefined) this._publishGroup(g, false, changed);
    }

    _publishGroup(g, again = false, changed = false) {
        if (g.val === undefined) return;
        const ts = this.now();
        if (g.lc === undefined || changed) g.lc = ts;
        if (!this.publish(`${this.name}/status/scenegroup/${g.id}`, JSON.stringify({ val: g.val, ts, lc: g.lc }), { retain: true })) return;
        g.published = g.val;
        if (changed || !again) this.emit('group', g.id, this.groupState(g.id));
    }

    _clear(topic) {
        this.publish(topic, '', { retain: true });
    }

    // ------------------------------------------------------------------
    // Read
    // ------------------------------------------------------------------

    /**
     * A scene's state now: `{id, name, val, matched, total, mismatch, unknown, recalled, settling}`, or null.
     * `mismatch`: `[{entity, name, attribute, is, want}]`; `unknown`: `[{entity, name, attribute?, reason}]`
     * with reason `missing` (not announced any more), `unavailable` or `no value`.
     */
    state(id) {
        const rt = this._scenes.get(id);
        if (!rt) return null;
        const s = this._evaluate(rt);
        return { id, name: rt.doc.name, ...clone(s), recalled: rt.recalled ?? null, settling: this.now() < rt.settleUntil };
    }

    /** The scene documents with their state, by name: `[{id, name, area, deactivate, sensitive, groups, members: n, val, matched, total}]`. */
    list() {
        return [...this._scenes.values()]
            .map((rt) => {
                const s = this._evaluate(rt);
                return {
                    id: rt.id,
                    name: rt.doc.name,
                    area: rt.doc.area ?? null,
                    icon: rt.doc.icon ?? null,
                    deactivate: rt.doc.deactivate,
                    sensitive: this._sensitive(rt.doc).length > 0,
                    groups: this._groupsOf(rt.id).map((g) => g.id),
                    members: rt.doc.members.length,
                    val: s.val,
                    matched: s.matched,
                    total: s.total,
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /** A scene's document (a copy), or null. */
    get(id) {
        const rt = this._scenes.get(id);
        return rt ? clone(rt.doc) : null;
    }

    /**
     * The groups, by name: `[{id, name, area, scenes, default, val}]` — `val` is the id of the scene
     * that matches now (the first of the list when several do), or `''`.
     * @param {{area?: string}} [filter]  only the groups of that room
     */
    groups(filter = {}) {
        return [...this._groups.values()]
            .filter((g) => filter.area === undefined || g.doc.area === filter.area)
            .map((g) => this.groupState(g.id))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /** One group: `{id, name, area, scenes, default, val}`, or null. */
    groupState(id) {
        const g = this._groups.get(id);
        if (!g) return null;
        return { id, name: g.doc.name, area: g.doc.area ?? null, scenes: [...g.doc.scenes], default: g.doc.default ?? null, val: g.val ?? '' };
    }

    /** the members of a scene that are locks or alarm panels */
    _sensitive(doc) {
        return doc.members.filter((m) => SENSITIVE.has(this.layer.entity(m.entity)?.component));
    }

    // ------------------------------------------------------------------
    // Recall
    // ------------------------------------------------------------------

    /**
     * Bring the members into the scene's state.
     * @param {string} id
     * @param {{force?: boolean}} [options]  `force`: command every member, not only those that differ
     *        (a recall of a scene that is already true does that by itself: it repairs)
     * @returns {{ok: boolean, reason?: string, sent: number, skipped: number, problems: string[]}}
     */
    recall(id, options = {}) {
        const rt = this._scenes.get(id);
        if (!rt) return { ok: false, reason: `no scene "${id}"`, sent: 0, skipped: 0, problems: [] };
        const now = this.now();
        rt.recalls = rt.recalls.filter((t) => now - t < this.opts.loopWindow);
        if (rt.recalls.length >= this.opts.loopMax) {
            const reason = `recalled ${rt.recalls.length} times within ${this.opts.loopWindow / 1000} s — dropped (a loop?)`;
            this.log.warn(`scene ${id}: ${reason}`);
            return { ok: false, reason, sent: 0, skipped: 0, problems: [] };
        }
        rt.recalls.push(now);

        // a newer recall takes over: what an older one of the same group has not sent yet is dropped
        const rivals = new Set([rt]);
        for (const g of this._groupsOf(id)) for (const other of g.doc.scenes) if (this._scenes.has(other)) rivals.add(this._scenes.get(other));
        for (const other of rivals) {
            if (other.sends.length) this.log.info(`scene ${other.id}: ${other.sends.length} pending command${other.sends.length === 1 ? '' : 's'} dropped, ${id} was recalled`);
            for (const t of other.sends) clearTimeout(t);
            other.sends = [];
            if (other !== rt && other.settleUntil > now) {
                other.settleUntil = 0;
                clearTimeout(other.settleTimer);
            }
        }

        const state = this._evaluate(rt);
        const all = options.force === true || state.val === true;
        const problems = [];
        const members = rt.doc.members
            .map((m, i) => ({ m, i }))
            .filter(({ m }) => m.role !== 'match')
            .sort((a, b) => (a.m.order ?? 0) - (b.m.order ?? 0) || a.i - b.i)
            .map(({ m }) => m);

        // the state to come back to: taken once, not replaced while the scene still holds
        if (rt.doc.deactivate === 'restore' && !(state.val === true && this.core.get(P_SCENE + id + RESTORE))) {
            const point = { recalled: now, members: [] };
            for (const m of members) {
                const entity = this.layer.entity(m.entity);
                if (!entity || entity.stateless) continue;
                const before = this.layer.snapshot(m.entity);
                if (Object.keys(before).length) point.members.push({ entity: m.entity, before, scene: m.attributes });
            }
            this._write(() => this.core.set(P_SCENE + id + RESTORE, point));
        }

        let sent = 0;
        let skipped = 0;
        let at = 0;
        for (const m of members) {
            const entity = this.layer.entity(m.entity);
            const name = this.entityName(m.entity) || m.entity;
            if (!entity) {
                problems.push(`${name}: not announced any more`);
                continue;
            }
            if (SENSITIVE.has(entity.component) && m.confirmed !== true) {
                problems.push(`${name}: a ${entity.component} is only commanded when the member is confirmed`);
                continue;
            }
            at += (m.delay || 0) * 1000;
            if (!all && !entity.stateless && this.layer.compare(m.entity, m.attributes, { tolerances: m.tolerance || undefined }).match) {
                skipped++;
                continue;
            }
            sent++;
            const send = () => {
                const r = this.layer.command(m.entity, m.attributes);
                for (const p of r.problems) this.log.warn(`scene ${id}: ${name}: ${p}`);
            };
            if (at === 0) {
                const r = this.layer.command(m.entity, m.attributes);
                for (const p of r.problems) problems.push(`${name}: ${p}`);
            } else {
                const t = setTimeout(() => {
                    rt.sends = rt.sends.filter((x) => x !== t);
                    send();
                    if (!rt.sends.length) this._sent(rt);
                }, at);
                t.unref?.();
                rt.sends.push(t);
            }
        }
        for (const p of problems) this.log.warn(`scene ${id}: ${p}`);

        rt.recalled = now;
        rt.settleUntil = now + at + rt.doc.settle * 1000;
        clearTimeout(rt.settleTimer);
        rt.settleTimer = setTimeout(() => this._settled(rt), rt.settleUntil - now);
        rt.settleTimer.unref?.();
        this.log.info(`scene ${id}: recalled${all ? ' (every member)' : ''}: ${sent} commanded, ${skipped} already there`);
        if (!rt.sends.length) this._sent(rt);
        return { ok: true, sent, skipped, problems };
    }

    /**
     * Every command of a recall is out. A scene that is in its state already — recalled while true,
     * or with members that answered at once — has nothing to wait for: its status is told (it carries
     * the new `recalled`) and the settle time ends. Otherwise the members get their time.
     */
    _sent(rt) {
        this._evaluate(rt);
        this._publishScene(rt);
    }

    /** The settle time of a recall is over: what does not match now is told. */
    _settled(rt) {
        rt.settleTimer = null;
        rt.settleUntil = 0;
        const s = this._evaluate(rt);
        if (!s.val) {
            for (const x of s.mismatch) this.log.warn(`scene ${rt.id}: ${x.name} ${x.attribute} is ${JSON.stringify(x.is)}, expected ${JSON.stringify(x.want)}`);
            for (const x of s.unknown) this.log.warn(`scene ${rt.id}: ${x.name}${x.attribute ? ' ' + x.attribute : ''}: ${x.reason}`);
        }
        this._publishScene(rt);
    }

    // ------------------------------------------------------------------
    // Deactivate
    // ------------------------------------------------------------------

    /**
     * What `false` means for this scene: nothing (`none`, the default), back to the state before
     * its recall for the members nobody touched since (`restore`), its lights, switches and fans
     * off (`off`), or another scene (`scene:<id>` — only while this one is true).
     * @param {string} id
     * @returns {{ok: boolean, mode?: string, reason?: string, sent: number}}
     */
    deactivate(id) {
        const rt = this._scenes.get(id);
        if (!rt) return { ok: false, reason: `no scene "${id}"`, sent: 0 };
        const mode = rt.doc.deactivate;
        const ignored = (reason) => {
            this.log.info(`scene ${id}: set false ignored: ${reason}`);
            return { ok: true, mode, reason, sent: 0 };
        };
        // what a recall of this scene has not sent yet is not sent any more
        for (const t of rt.sends) clearTimeout(t);
        rt.sends = [];

        if (mode === 'none') return ignored('the scene has no deactivation');

        if (mode === 'restore') {
            const point = this.core.get(P_SCENE + id + RESTORE);
            if (!isRecord(point) || !Array.isArray(point.members)) return ignored('there is nothing to restore (the scene was not recalled)');
            let sent = 0;
            for (const m of point.members) {
                if (!isRecord(m) || !this.layer.entity(m.entity)) continue;
                // somebody changed it since the recall: it is theirs
                if (!this.layer.compare(m.entity, m.scene || {}).match) continue;
                if (this._guarded(rt.doc, m.entity)) continue;
                const r = this.layer.command(m.entity, m.before || {});
                for (const p of r.problems) this.log.warn(`scene ${id}: restore ${this.entityName(m.entity) || m.entity}: ${p}`);
                if (r.sent.length) sent++;
            }
            this._write(() => this.core.del(P_SCENE + id + RESTORE));
            this._afterDeactivate(rt);
            this.log.info(`scene ${id}: deactivated: ${sent} of ${point.members.length} restored`);
            return { ok: true, mode, sent };
        }

        if (mode === 'off') {
            let sent = 0;
            for (const m of rt.doc.members) {
                if (m.role === 'match' || m.off === false) continue;
                const entity = this.layer.entity(m.entity);
                if (!entity) continue;
                const attributes = isRecord(m.off) ? m.off : HAS_OFF.has(entity.component) ? { state: 'OFF' } : null;
                if (!attributes || this._guarded(rt.doc, m.entity)) continue;
                if (this.layer.compare(m.entity, attributes).match) continue;
                const r = this.layer.command(m.entity, attributes);
                for (const p of r.problems) this.log.warn(`scene ${id}: off ${this.entityName(m.entity) || m.entity}: ${p}`);
                if (r.sent.length) sent++;
            }
            this._afterDeactivate(rt);
            this.log.info(`scene ${id}: deactivated: ${sent} switched off`);
            return { ok: true, mode, sent };
        }

        // scene:<id>
        const fallback = mode.slice('scene:'.length);
        if (!this._evaluate(rt).val) return ignored('the scene is not active');
        if (fallback === id) return ignored('the fallback is the scene itself');
        const r = this.recall(fallback);
        if (!r.ok) {
            this.log.warn(`scene ${id}: fallback ${fallback}: ${r.reason}`);
            return { ok: false, mode, reason: r.reason, sent: 0 };
        }
        this._afterDeactivate(rt);
        return { ok: true, mode, sent: r.sent };
    }

    /** a lock or alarm panel that is not confirmed is not commanded, by any path */
    _guarded(doc, entityId) {
        const entity = this.layer.entity(entityId);
        if (!entity || !SENSITIVE.has(entity.component)) return false;
        const member = doc.members.find((m) => m.entity === entityId);
        return !member || member.confirmed !== true;
    }

    _afterDeactivate(rt) {
        // no settle time (any more): what the scene is from now on is told
        rt.settleUntil = 0;
        clearTimeout(rt.settleTimer);
        rt.settleTimer = null;
    }

    /** Recall when the scene is false, deactivate when it is true. */
    toggle(id, options = {}) {
        const rt = this._scenes.get(id);
        if (!rt) return { ok: false, reason: `no scene "${id}"`, sent: 0 };
        return this._evaluate(rt).val ? this.deactivate(id) : this.recall(id, options);
    }

    // ------------------------------------------------------------------
    // Groups
    // ------------------------------------------------------------------

    /**
     * Set a group: a scene id recalls that scene; `''`, `false`, `null` or `'none'` is the group's
     * deactivation — its default scene when it has one, else the deactivation of the scene that
     * matches now.
     */
    setGroup(id, value, options = {}) {
        const g = this._groups.get(id);
        if (!g) return { ok: false, reason: `no scene group "${id}"`, sent: 0 };
        if (value === '' || value === false || value === null || value === undefined || value === 'none') {
            if (g.doc.default) return this.recall(g.doc.default, options);
            if (!g.val) return { ok: true, reason: 'no scene of the group is active', sent: 0 };
            return this.deactivate(g.val);
        }
        if (typeof value !== 'string' || !g.doc.scenes.includes(value)) return { ok: false, reason: `"${value}" is not a scene of the group ${id}`, sent: 0 };
        return this.recall(value, options);
    }

    // ------------------------------------------------------------------
    // MQTT
    // ------------------------------------------------------------------

    /**
     * A message on a topic of the instance: is it a scene's or a group's set topic?
     * @param {string} topic
     * @param {*} val  the parsed payload
     * @returns {boolean} true when it was one (handled or refused)
     */
    onMessage(topic, val) {
        const base = this.name + '/set/';
        if (!topic.startsWith(base)) return false;
        const rest = topic.slice(base.length);
        if (rest.startsWith('scene/')) {
            const id = rest.slice('scene/'.length);
            const cmd = parseSet(val);
            if (!cmd) {
                this.log.warn(`scene ${id}: set ${JSON.stringify(val)} is not understood — true, false or "toggle"`);
                return true;
            }
            const r = cmd.action === 'recall' ? this.recall(id, { force: cmd.force }) : cmd.action === 'toggle' ? this.toggle(id, { force: cmd.force }) : this.deactivate(id);
            if (!r.ok) this.log.warn(`scene ${id}: ${r.reason}`);
            return true;
        }
        if (rest.startsWith('scenegroup/')) {
            const id = rest.slice('scenegroup/'.length);
            let value = isRecord(val) ? val.val : val;
            // a scene id that looks like a number arrives as one
            if (typeof value === 'number') value = String(value);
            const r = this.setGroup(id, typeof value === 'string' ? value.trim() : value, { force: isRecord(val) && val.force === true });
            if (!r.ok) this.log.warn(`scene group ${id}: ${r.reason}`);
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Write
    // ------------------------------------------------------------------

    /**
     * Create or replace a scene. `created` is kept, `modified` set.
     * @param {string} id
     * @param {object} doc
     * @param {{confirmSensitive?: boolean}} [options]  required to save a scene whose members include a
     *        lock or an alarm panel that is to be commanded; marks those members `confirmed`
     * @returns {object} the stored document
     */
    save(id, doc, options = {}) {
        checkId(id, 'scene');
        const scene = validateScene(doc);
        for (const m of this._sensitive(scene)) {
            if (m.role === 'match') continue;
            if (options.confirmSensitive === true) m.confirmed = true;
            else if (m.confirmed !== true) {
                throw new Error(`scene: ${this.entityName(m.entity) || m.entity} is a ${this.layer.entity(m.entity).component} — a scene that commands it has to be confirmed`);
            }
        }
        const prev = this.core.get(P_SCENE + id);
        const now = this.now();
        scene.created = isRecord(prev) && prev.created ? prev.created : now;
        scene.modified = now;
        scene.sensitive = this._sensitive(scene).some((m) => m.role !== 'match');
        this._write(() => this.core.set(P_SCENE + id, scene));
        // the restore point belonged to the scene as it was
        if (this.core.get(P_SCENE + id + RESTORE)) this._write(() => this.core.del(P_SCENE + id + RESTORE));
        this._loadScene(id, scene);
        return clone(scene);
    }

    /**
     * Take a scene from the present state of entities: create it, or take its members' states
     * again ("update from current state").
     * @param {string} id
     * @param {string[]} [entities]  entity ids; omitted: the members the scene has
     * @param {object} [fields]      name, area, deactivate, … for a new scene (or to change)
     * @param {{confirmSensitive?: boolean}} [options]
     * @returns {object} the stored document
     */
    snapshot(id, entities, fields = {}, options = {}) {
        checkId(id, 'scene');
        const prev = this.core.get(P_SCENE + id);
        const old = isRecord(prev) && Array.isArray(prev.members) ? prev.members : [];
        const ids = Array.isArray(entities) ? entities.map((e) => this.layer.resolve(e) || e) : old.map((m) => m.entity);
        if (!ids.length) throw new Error('scene: snapshot needs entities');
        const members = ids.map((entityId) => {
            const entity = this.layer.entity(entityId);
            if (!entity) throw new Error(`scene: no entity "${entityId}"`);
            const before = old.find((m) => m.entity === entityId) || {};
            const attributes = entity.stateless ? {} : this.layer.snapshot(entityId);
            // an entity that can only tell is a condition
            const writable = entity.stateless || Object.values(entity.attributes()).some((a) => a.write);
            return { ...before, entity: entityId, attributes, role: before.role || (writable ? 'recall+match' : 'match') };
        });
        return this.save(id, { name: id, ...(isRecord(prev) ? prev : {}), ...fields, members }, options);
    }

    /** Delete a scene with its restore point; it is taken out of every group. */
    remove(id) {
        if (!this.core.get(P_SCENE + id)) return false;
        this._write(() => {
            this.core.del(P_SCENE + id);
            if (this.core.get(P_SCENE + id + RESTORE)) this.core.del(P_SCENE + id + RESTORE);
        });
        for (const g of this._groupsOf(id)) {
            const doc = { ...g.doc, scenes: g.doc.scenes.filter((s) => s !== id), default: g.doc.default === id ? null : g.doc.default };
            this._write(() => this.core.set(P_GROUP + g.id, doc));
            this._loadGroup(g.id, doc);
        }
        this._loadScene(id, null);
        return true;
    }

    /** Create or replace a scene group. */
    saveGroup(id, doc) {
        checkId(id, 'scene group');
        const group = validateGroup(doc);
        this._write(() => this.core.set(P_GROUP + id, group));
        this._loadGroup(id, group);
        return clone(group);
    }

    /** Delete a scene group; its scenes stay. */
    removeGroup(id) {
        if (!this.core.get(P_GROUP + id)) return false;
        this._write(() => this.core.del(P_GROUP + id));
        this._loadGroup(id, null);
        return true;
    }
}

module.exports = { SceneEngine, validateScene, validateGroup, parseSet, slug, P_SCENE, P_GROUP, RESTORE, DEFAULTS, SENSITIVE };
