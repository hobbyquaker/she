'use strict';

/**
 * Scenes REST API — Express router mounted at /she/scenes (the Scenes page, roadmap U23), over the
 * scene engine (`./scenes`) and the entity layer (`./home-entities`).
 *
 *   GET    /she/scenes                     → { available, reason?, scenes: list(), groups: groups() }
 *   GET    /she/scenes/:id                 → { doc, state, members: { <entity id>: live } } — `live` below
 *   PUT    /she/scenes/:id                 { doc, confirmSensitive? } → the stored document
 *                                            409 { error, confirm: [names] } when a lock or an alarm panel
 *                                            is to be commanded and the save was not confirmed
 *   POST   /she/scenes/:id/snapshot        { entities?, fields?, confirmSensitive? } → the stored document
 *   DELETE /she/scenes/:id
 *   POST   /she/scenes/:id/recall          { force? } → the engine's answer { ok, sent, skipped, problems }
 *   POST   /she/scenes/:id/deactivate      → { ok, mode, reason?, sent }
 *   POST   /she/scenes/:id/toggle
 *   POST   /she/scenes/entities            { ids } → { <entity id>: live }
 *   PUT    /she/scenes/groups/:id          { doc } → the stored group
 *   DELETE /she/scenes/groups/:id
 *   POST   /she/scenes/groups/:id/set      { scene: id | '' }
 *
 * `live` is what the editor shows next to a member: `{ component, stateless, attributes (what the
 * entity tells and takes), state (now), snapshot (what a scene would store now), available }`, or
 * null for an entity the layer does not know.
 *
 * Live updates go over the WebSocket: `scenes:scene` `{ id, state }` (the scene's state as
 * `engine.state()` gives it, null when deleted) and `scenes:group` `{ id, state }`. The listeners are
 * attached to the engine the first time this API sees it.
 */

const express = require('express');
const scenes = require('./scenes');
const homeEntities = require('./home-entities');
const { broadcast } = require('./log-ws');

const router = express.Router();

const ID = /^[A-Za-z0-9_-]+$/;

/** engines whose events are already broadcast */
const wired = new WeakSet();

function engineOr503(res) {
    const engine = scenes.getEngine();
    if (!engine) {
        res.status(503).json({ error: 'Scenes need sheDB and the home model.' });
        return null;
    }
    wire(engine);
    return engine;
}

function wire(engine) {
    if (wired.has(engine)) return;
    wired.add(engine);
    engine.on('scene', (id, state) => broadcast({ type: 'scenes:scene', id, state: state ?? null }));
    engine.on('group', (id, state) => broadcast({ type: 'scenes:group', id, state: state ?? null }));
}

/** what the editor shows of an entity now */
function live(layer, id) {
    const d = layer.describe(id);
    if (!d) return null;
    return {
        component: d.component,
        stateless: d.stateless,
        attributes: d.attributes,
        state: layer.state(id),
        snapshot: d.stateless ? {} : layer.snapshot(id),
        available: layer.available(id) ?? null,
    };
}

function badId(res, id) {
    if (ID.test(id)) return false;
    res.status(400).json({ error: 'an id consists of letters, digits, - and _' });
    return true;
}

/** an engine error: a scene with a lock to confirm is 409 and names the members, the rest is 400 */
function fail(res, err) {
    const m = /^scene: (.+) is a (lock|alarm_control_panel) — a scene that commands it has to be confirmed$/.exec(err.message);
    if (m) return res.status(409).json({ error: err.message, confirm: [m[1]] });
    res.status(400).json({ error: err.message });
}

router.get('/', (req, res) => {
    const engine = scenes.getEngine();
    if (!engine) return res.json({ available: false, reason: 'Scenes need sheDB and the home model (its entity layer).', scenes: [], groups: [] });
    wire(engine);
    res.json({ available: true, scenes: engine.list(), groups: engine.groups() });
});

router.post('/entities', (req, res) => {
    const engine = engineOr503(res);
    if (!engine) return;
    const layer = homeEntities.getLayer();
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return res.status(400).json({ error: 'ids (a list of entity document ids) is required' });
    const out = {};
    for (const id of ids.slice(0, 500)) out[id] = layer ? live(layer, id) : null;
    res.json(out);
});

// ── groups ──

router.put('/groups/:id', (req, res) => {
    const engine = engineOr503(res);
    if (!engine || badId(res, req.params.id)) return;
    try {
        res.json(engine.saveGroup(req.params.id, req.body?.doc));
    } catch (err) {
        fail(res, err);
    }
});

router.delete('/groups/:id', (req, res) => {
    const engine = engineOr503(res);
    if (!engine) return;
    if (!engine.removeGroup(req.params.id)) return res.status(404).json({ error: `no scene group "${req.params.id}"` });
    res.json({ ok: true });
});

router.post('/groups/:id/set', (req, res) => {
    const engine = engineOr503(res);
    if (!engine) return;
    if (!engine.groupState(req.params.id)) return res.status(404).json({ error: `no scene group "${req.params.id}"` });
    const scene = req.body?.scene;
    if (typeof scene !== 'string') return res.status(400).json({ error: 'scene (a scene id, or "" for none) is required' });
    const r = engine.setGroup(req.params.id, scene);
    res.status(r && r.ok === false ? 409 : 200).json(r ?? { ok: true });
});

// ── scenes ──

router.get('/:id', (req, res) => {
    const engine = engineOr503(res);
    if (!engine) return;
    const doc = engine.get(req.params.id);
    if (!doc) return res.status(404).json({ error: `no scene "${req.params.id}"` });
    const layer = homeEntities.getLayer();
    const members = {};
    for (const m of doc.members) members[m.entity] = layer ? live(layer, m.entity) : null;
    res.json({ doc, state: engine.state(req.params.id), members });
});

router.put('/:id', (req, res) => {
    const engine = engineOr503(res);
    if (!engine || badId(res, req.params.id)) return;
    const { doc, confirmSensitive } = req.body || {};
    try {
        res.json(engine.save(req.params.id, doc, { confirmSensitive: confirmSensitive === true }));
    } catch (err) {
        fail(res, err);
    }
});

router.post('/:id/snapshot', (req, res) => {
    const engine = engineOr503(res);
    if (!engine || badId(res, req.params.id)) return;
    const { entities, fields, confirmSensitive } = req.body || {};
    if (entities !== undefined && !(Array.isArray(entities) && entities.every((x) => typeof x === 'string')))
        return res.status(400).json({ error: 'entities must be a list of entity ids' });
    if (fields !== undefined && (fields === null || typeof fields !== 'object' || Array.isArray(fields))) return res.status(400).json({ error: 'fields must be an object' });
    try {
        res.json(engine.snapshot(req.params.id, entities, fields || {}, { confirmSensitive: confirmSensitive === true }));
    } catch (err) {
        fail(res, err);
    }
});

router.delete('/:id', (req, res) => {
    const engine = engineOr503(res);
    if (!engine) return;
    if (!engine.remove(req.params.id)) return res.status(404).json({ error: `no scene "${req.params.id}"` });
    res.json({ ok: true });
});

for (const action of ['recall', 'deactivate', 'toggle']) {
    router.post(`/:id/${action}`, (req, res) => {
        const engine = engineOr503(res);
        if (!engine) return;
        if (!engine.get(req.params.id)) return res.status(404).json({ error: `no scene "${req.params.id}"` });
        const r =
            action === 'recall'
                ? engine.recall(req.params.id, { force: req.body?.force === true })
                : action === 'toggle'
                  ? engine.toggle(req.params.id)
                  : engine.deactivate(req.params.id);
        res.status(r && r.ok === false ? 409 : 200).json(r ?? { ok: true });
    });
}

module.exports = { router };
