'use strict';

/**
 * Home model REST API — Express router mounted at /she/home
 *
 *   GET /she/home  → { available, enabled, decided, language, enabled_at, live, counts }
 *                    `available: false` when sheDB is off (the model needs it);
 *                    `decided: false` on an installation that has never switched it on or off;
 *                    `language: null` while the default functions have not been seeded
 *   PUT /she/home  { enabled, language? } → the same, after switching. `language` (`en` or `de`)
 *                    names the seeded functions and is required until they are seeded.
 *
 * The Home page (roadmap U22):
 *
 *   GET    /she/home/model                 → { status, floors, rooms, rejected, functions, labels, devices, entities }
 *                                             devices and entities without the bulky `ha.config`
 *   POST   /she/home/:kind                 { name, … } → { id }          kind: floors | rooms | functions | labels
 *   PATCH  /she/home/:kind/:id             { … } → the document; a field set to null is removed
 *   DELETE /she/home/:kind/:id[?purge=1]   rooms are remembered as a rejected area unless purged
 *   POST   /she/home/rooms/merge           { keep, others: [] } → the kept room
 *   POST   /she/home/rooms/restore         { id } → { id }: a rejected area becomes a room again
 *   POST   /she/home/assign                { ids: [], set?, add?, remove? } → { updated, errors }
 *                                             set: the `user` fields as given (null = inherit again);
 *                                             add / remove: rooms, functions, labels added to or taken from
 *                                             what the item has now (its own list, else the inherited one)
 *   POST   /she/home/remove                { ids: [] } → { removed, errors }: gone devices and entities
 */

const express = require('express');
const home = require('./home');
const { LANGUAGES } = require('../lib/home-defaults');

const router = express.Router();

const UNAVAILABLE = { available: false, enabled: false, decided: false, reason: 'The home model is kept in sheDB, which is switched off.' };

router.get('/', (req, res) => {
    const model = home.getModel();
    res.json(model ? { available: true, ...model.status() } : UNAVAILABLE);
});

router.put('/', (req, res) => {
    const model = home.getModel();
    if (!model) return res.status(503).json({ error: UNAVAILABLE.reason });
    const { enabled, language } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (true or false) is required' });
    if (language !== undefined && !LANGUAGES.includes(language)) return res.status(400).json({ error: `language must be one of: ${LANGUAGES.join(', ')}` });
    if (enabled && !language && !model.status().language)
        return res.status(400).json({ error: `language (${LANGUAGES.join(' or ')}) is required: the functions are seeded with names in it` });
    try {
        const status = enabled ? model.enable({ language }) : model.disable();
        res.json({ available: true, ...status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── The Home page ─────────────────────────────────────────────────────────────

const KINDS = {
    floors: { create: 'createFloor', update: 'updateFloor', remove: 'deleteFloor' },
    rooms: { create: 'createRoom', update: 'updateRoom', remove: 'deleteRoom' },
    functions: { create: 'createFunction', update: 'updateFunction', remove: 'deleteFunction' },
    labels: { create: 'createLabel', update: 'updateLabel', remove: 'deleteLabel' },
};

/** The model, or a 503 / 409 answer already sent. */
function enabledModel(res) {
    const model = home.getModel();
    if (!model) {
        res.status(503).json({ error: UNAVAILABLE.reason });
        return null;
    }
    if (!model.status().enabled) {
        res.status(409).json({ error: 'the home model is switched off' });
        return null;
    }
    return model;
}

/** A model error: the thing addressed being unknown is a 404, everything else the caller's mistake. */
function fail(res, err, id) {
    const notFound = /^unknown /.test(err.message) && (id === undefined || err.message.endsWith(`: ${id}`));
    res.status(notFound ? 404 : 400).json({ error: err.message });
}

function slimDevice(doc) {
    const ha = doc.ha || {};
    return {
        id: doc._id,
        ha: {
            identifiers: ha.identifiers,
            name: ha.name ?? null,
            manufacturer: ha.manufacturer ?? null,
            model: ha.model ?? null,
            suggested_area: ha.suggested_area ?? null,
            via_device: ha.via_device ?? null,
            origin: ha.origin ?? null,
            entities: ha.entities ?? [],
            present: ha.present !== false,
            gone_since: ha.gone_since ?? null,
        },
        user: doc.user || {},
        eff: doc.eff || {},
    };
}

function slimEntity(doc) {
    const ha = doc.ha || {};
    return {
        id: doc._id,
        ha: {
            unique_id: ha.unique_id,
            device: ha.device ?? null,
            component: ha.component,
            device_class: ha.device_class ?? null,
            entity_category: ha.entity_category ?? null,
            name: ha.name ?? null,
            icon: ha.icon ?? null,
            unit: ha.unit ?? null,
            state_topic: ha.topics?.state?.[0] ?? null,
            present: ha.present !== false,
            gone_since: ha.gone_since ?? null,
        },
        user: doc.user || {},
        eff: doc.eff || {},
    };
}

router.get('/model', (req, res) => {
    const model = home.getModel();
    if (!model) return res.json({ status: UNAVAILABLE });
    const status = { available: true, ...model.status() };
    res.json({
        status,
        floors: model.floors(),
        rooms: model.rooms(),
        rejected: model.rooms({ rejected: true }),
        functions: model.functions(),
        labels: model.labels(),
        devices: model.devices().map(slimDevice),
        entities: model.entities().map(slimEntity),
    });
});

router.post('/rooms/merge', (req, res) => {
    const model = enabledModel(res);
    if (!model) return;
    const { keep, others } = req.body || {};
    if (typeof keep !== 'string' || !Array.isArray(others) || !others.length)
        return res.status(400).json({ error: 'keep (a room id) and others (a list of room ids) are required' });
    try {
        res.json(model.mergeRooms(keep, others));
    } catch (err) {
        fail(res, err, keep);
    }
});

router.post('/rooms/restore', (req, res) => {
    const model = enabledModel(res);
    if (!model) return;
    const id = req.body?.id;
    const area = model.rooms({ rejected: true }).find((r) => r.id === id);
    if (!area) return res.status(404).json({ error: `unknown rejected area: ${id}` });
    try {
        res.json({ id: model.createRoom({ id: area.id, name: area.name, aliases: area.aliases }) });
    } catch (err) {
        fail(res, err);
    }
});

/** The list an add / remove starts from: the item's own, else what it inherits (labels: only its own). */
function baseList(doc, field) {
    if (Array.isArray(doc.user?.[field])) return doc.user[field];
    if (field === 'labels') return [];
    return Array.isArray(doc.eff?.[field]) ? doc.eff[field] : [];
}

router.post('/assign', (req, res) => {
    const model = enabledModel(res);
    if (!model) return;
    const { ids, set, add, remove } = req.body || {};
    if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === 'string')) return res.status(400).json({ error: 'ids (a list of document ids) is required' });
    for (const [k, v] of Object.entries({ set, add, remove }))
        if (v !== undefined && (v === null || typeof v !== 'object' || Array.isArray(v))) return res.status(400).json({ error: `${k} must be an object` });
    if (!set && !add && !remove) return res.status(400).json({ error: 'nothing to assign: give set, add or remove' });
    const resolve = (field, ref) => (field === 'rooms' ? (model.resolveRoom(ref) ?? ref) : ref);
    let updated = 0;
    const errors = [];
    for (const id of ids) {
        try {
            const doc = id.startsWith('she/device/') ? model.device(id) : id.startsWith('she/entity/') ? model.entity(id) : null;
            if (!doc) throw new Error(`unknown device or entity: ${id}`);
            const patch = { ...(set || {}) };
            for (const field of new Set([...Object.keys(add || {}), ...Object.keys(remove || {})])) {
                if (!['rooms', 'functions', 'labels'].includes(field)) throw new Error(`"${field}" cannot be added or removed`);
                if (field === 'functions' && id.startsWith('she/device/')) continue; // functions belong to entities
                const plus = (add?.[field] ?? []).map((r) => resolve(field, r));
                const minus = new Set((remove?.[field] ?? []).map((r) => resolve(field, r)));
                patch[field] = [...new Set([...baseList(doc, field), ...plus])].filter((x) => !minus.has(x));
            }
            if (id.startsWith('she/device/')) delete patch.functions;
            if (!Object.keys(patch).length) continue;
            model.assign(id, patch);
            updated++;
        } catch (err) {
            errors.push({ id, error: err.message });
        }
    }
    res.status(updated || !errors.length ? 200 : 400).json({ updated, errors });
});

router.post('/remove', (req, res) => {
    const model = enabledModel(res);
    if (!model) return;
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids (a list of document ids) is required' });
    const removed = [];
    const errors = [];
    for (const id of ids) {
        try {
            removed.push(...model.remove(id));
        } catch (err) {
            if (!removed.includes(id)) errors.push({ id, error: err.message });
        }
    }
    res.status(removed.length || !errors.length ? 200 : 400).json({ removed, errors });
});

router.post('/:kind', (req, res) => {
    const k = KINDS[req.params.kind];
    if (!k) return res.status(404).json({ error: `unknown kind: ${req.params.kind}` });
    const model = enabledModel(res);
    if (!model) return;
    try {
        res.status(201).json({ id: model[k.create](req.body || {}) });
    } catch (err) {
        res.status(/exists/.test(err.message) ? 409 : 400).json({ error: err.message });
    }
});

router.patch('/:kind/:id', (req, res) => {
    const k = KINDS[req.params.kind];
    if (!k) return res.status(404).json({ error: `unknown kind: ${req.params.kind}` });
    const model = enabledModel(res);
    if (!model) return;
    const patch = { ...(req.body || {}) };
    // null removes a field (JSON has no undefined)
    for (const [key, v] of Object.entries(patch)) if (v === null && !['floor', 'icon', 'order', 'level'].includes(key)) patch[key] = undefined;
    try {
        res.json(model[k.update](req.params.id, patch));
    } catch (err) {
        fail(res, err, req.params.id);
    }
});

router.delete('/:kind/:id', (req, res) => {
    const k = KINDS[req.params.kind];
    if (!k) return res.status(404).json({ error: `unknown kind: ${req.params.kind}` });
    const model = enabledModel(res);
    if (!model) return;
    try {
        if (req.params.kind === 'rooms') model.deleteRoom(req.params.id, { purge: req.query.purge === '1' || req.query.purge === 'true' });
        else model[k.remove](req.params.id);
        res.json({ ok: true });
    } catch (err) {
        fail(res, err, req.params.id);
    }
});

module.exports = { router };
