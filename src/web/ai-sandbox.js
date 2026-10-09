'use strict';

/**
 * The main-thread side of the AI chat's run_analysis tool (roadmap I42, decision D-9): starts the worker with the
 * model's code, answers its data calls from the loaders it is given, and terminates it when the time is up or the
 * heap limit is hit. Nothing of the daemon is reachable from the worker except through the loaders.
 */

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_HEAP_MB = 256;

/**
 * @param {{ code: string, from?: string, to?: string }} job
 * @param {Record<string, (...args: any[]) => any>} loaders  topics, history, messages, log, script, time
 * @param {{ timeoutMs?: number, heapMb?: number }} [opts]
 * @returns {Promise<{ json?: string, error?: string, logs: string[], ms: number, calls: number }>}
 */
function runAnalysis(job, loaders, opts = {}) {
    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
    const heapMb = Math.max(32, Number(opts.heapMb) || DEFAULT_HEAP_MB);
    const started = Date.now();
    let calls = 0;
    return new Promise((resolve) => {
        let settled = false;
        const worker = new Worker(path.join(__dirname, 'ai-sandbox-worker.js'), {
            workerData: { code: String(job.code || ''), from: job.from ?? null, to: job.to ?? null, timeoutMs },
            resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 32 },
        });
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            worker.terminate().catch(() => {});
            resolve({ ...result, ms: Date.now() - started, calls });
        };
        const timer = setTimeout(() => finish({ error: `the analysis did not finish within ${timeoutMs / 1000} s and was stopped`, logs: [] }), timeoutMs);
        worker.on('message', async (m) => {
            if (!m || typeof m !== 'object') return;
            if (m.type === 'call') {
                calls++;
                const fn = loaders[m.name];
                try {
                    if (typeof fn !== 'function') throw new Error(`data.${m.name} is not available`);
                    const value = await fn(...(Array.isArray(m.args) ? m.args : []));
                    worker.postMessage({ type: 'reply', id: m.id, ok: true, value });
                } catch (e) {
                    worker.postMessage({ type: 'reply', id: m.id, ok: false, error: e && e.message ? e.message : String(e) });
                }
            } else if (m.type === 'done') finish({ json: m.json, logs: m.logs || [] });
            else if (m.type === 'error') finish({ error: m.message, logs: m.logs || [] });
        });
        worker.on('error', (e) => finish({ error: e && e.message ? e.message : String(e), logs: [] }));
        worker.on('exit', (code) => {
            if (!settled)
                finish({ error: code === 0 ? 'the analysis ended without a result' : `the analysis was stopped (exit ${code}; the heap limit of ${heapMb} MB?)`, logs: [] });
        });
    });
}

module.exports = { runAnalysis, DEFAULT_TIMEOUT_MS };
