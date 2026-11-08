'use strict';

/**
 * The runtime model over HTTP: what every script has registered, with statistics and pending timers
 * (`GET /she/runtime`, optionally one script), the hour's gauge history (`GET /she/runtime/history`),
 * and the editor's actions on a timer or handler (`POST /she/runtime/action`). The live view goes
 * over the WebSocket (`runtime:subscribe`); these endpoints serve a one-off read and the actions.
 */

const express = require('express');
const { NotFoundError } = require('../lib/runtime');

const router = express.Router();

let _ctx = null;

/**
 * @param {object} ctx
 * @param {import('../lib/runtime').Runtime} ctx.runtime
 * @param {(label?: string) => object} ctx.snapshot the model, or one script's part by its label
 * @param {() => {intervalMs: number, samples: object[]}} ctx.history
 * @param {(file: string, msg: string) => void} ctx.log writes into a script's log
 */
function init(ctx) {
    _ctx = ctx;
}

router.get('/', (req, res) => {
    if (!_ctx) return res.status(503).json({ error: 'runtime not ready' });
    const label = typeof req.query.script === 'string' ? req.query.script : undefined;
    res.set('Cache-Control', 'no-store');
    res.json(_ctx.snapshot(label));
});

router.get('/history', (req, res) => {
    if (!_ctx) return res.status(503).json({ error: 'runtime not ready' });
    res.set('Cache-Control', 'no-store');
    res.json(_ctx.history());
});

/**
 * An action from the editor's Runtime panel. Body: `{ id, action }` with action `cancel` or `run`.
 * `cancel` removes a pending timer (or an interval) without running it; `run` fires a pending timer
 * now (a debounce: its flush), runs an interval once, or runs a schedule or sun event once — the
 * schedule stays. Every action is written into the script's log.
 */
router.post('/action', (req, res) => {
    if (!_ctx) return res.status(503).json({ error: 'runtime not ready' });
    const { id, action } = req.body || {};
    if (typeof id !== 'string' || (action !== 'cancel' && action !== 'run')) {
        return res.status(400).json({ error: 'expected { id, action: "cancel" | "run" }' });
    }
    let result;
    try {
        result = _ctx.runtime.action(id, action);
    } catch (err) {
        if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
        if (err instanceof TypeError) return res.status(400).json({ error: err.message });
        return res.status(500).json({ error: err.message });
    }
    const what = `${result.kind}${result.name ? ` "${result.name}"` : ''}`;
    _ctx.log(result.script, `${what} ${action === 'cancel' ? 'cancelled' : 'run now'} from the editor`);
    res.json({ ok: true, ...result });
});

module.exports = { router, init };
