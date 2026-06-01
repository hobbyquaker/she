'use strict';

/**
 * AI context builder — assembles the full system prompt from per-request flags,
 * the current editor context (script or DB view/document), and live data
 * from the running daemon (MQTT state, sheDB, Matter devices).
 *
 * Kept separate from ai-api.js so prompt files and context logic can evolve
 * independently of the HTTP routing / provider adapter code.
 */

const fs = require('fs');
const path = require('path');

// Load prompt templates once at startup — plain Markdown files, no escaping needed
const P = path.join(__dirname, 'prompts');
const SCRIPTS_BASE_PROMPT = fs.readFileSync(path.join(P, 'scripts-base.md'), 'utf8').trim();
const SHE_API_REF         = fs.readFileSync(path.join(P, 'she-api-ref.md'),  'utf8').trim();
const DB_VIEW_PROMPT      = fs.readFileSync(path.join(P, 'db-view.md'),       'utf8').trim();
const DB_DOC_PROMPT       = fs.readFileSync(path.join(P, 'db-doc.md'),        'utf8').trim();

/**
 * Build the full system prompt, including optional context sections.
 *
 * @param {object} requestCtx
 *   { apiref, mqtt, shedb, matter, sampleDocs }
 * @param {{ path?: string, content?: string } | null} currentScript
 * @param {{ id?: string, filter?: string, map?: string, reduce?: string } | null} currentView
 * @param {{ id?: string, content?: string } | null} currentDoc
 * @param {import('../lib/state-store') | null} store
 * @returns {string}
 */
function buildSystemPrompt(requestCtx, currentScript, currentView, currentDoc, store) {
    const isViewMode = !!(currentView?.id);
    const isDocMode  = !!(currentDoc?.id);

    let basePrompt;
    if (isViewMode) {
        basePrompt = DB_VIEW_PROMPT;
    } else if (isDocMode) {
        basePrompt = DB_DOC_PROMPT;
    } else {
        basePrompt = SCRIPTS_BASE_PROMPT;
    }

    const parts = [basePrompt];

    if (requestCtx.apiref && !isViewMode && !isDocMode) {
        parts.push(SHE_API_REF);
    }

    if (currentScript?.path && typeof currentScript.content === 'string') {
        parts.push(`## Current script: ${currentScript.path}\n\`\`\`javascript\n${currentScript.content}\n\`\`\``);
    }

    if (currentView?.id) {
        const filterStr  = (currentView.filter || '').trim();
        const mapBody    = (currentView.map    || '').trim();
        const reduceBody = (currentView.reduce || '').trim();
        const viewLines  = [`## Current view: ${currentView.id}`];
        viewLines.push(`Filter: ${filterStr || '(none)'}`);
        viewLines.push(`Map:\n\`\`\`javascript\n${mapBody || '// (empty)'}\n\`\`\``);
        if (reduceBody) {
            viewLines.push(`Reduce:\n\`\`\`javascript\n${reduceBody}\n\`\`\``);
        } else {
            viewLines.push('Reduce: (none)');
        }
        parts.push(viewLines.join('\n'));
    }

    if (currentDoc?.id) {
        const content = typeof currentDoc.content === 'string'
            ? currentDoc.content
            : JSON.stringify(currentDoc.content, null, 2);
        parts.push(`## Current document: ${currentDoc.id}\n\`\`\`json\n${content}\n\`\`\``);
    }

    if (requestCtx.mqtt && store) {
        const topics = [];
        for (const [topic, obj] of store.mqttEntries()) {
            topics.push(`${topic}: ${JSON.stringify(obj.val)}`);
            if (topics.length >= 100) {
                topics.push('… (truncated)');
                break;
            }
        }
        if (topics.length > 0) {
            parts.push(`## Current MQTT state\n${topics.join('\n')}`);
        }
    }

    if (requestCtx.shedb) {
        try {
            const core = require('./shedb').getCore();
            if (core) {
                const ids = Object.keys(core.docs).sort();
                if (ids.length > 0) {
                    parts.push(`## sheDB document IDs (${ids.length} total)\n${ids.slice(0, 200).join('\n')}`);
                }
            }
        } catch {
            // shedb not initialised — skip silently
        }
    }

    if (requestCtx.sampleDocs) {
        try {
            const core = require('./shedb').getCore();
            if (core) {
                const ids = Object.keys(core.docs).sort().slice(0, 10);
                if (ids.length > 0) {
                    const sample = ids.map((id) => `### ${id}\n${JSON.stringify(core.docs[id], null, 2)}`).join('\n\n');
                    parts.push(`## Sample sheDB documents (${ids.length} shown)\n${sample}`);
                }
            }
        } catch {
            // shedb not initialised — skip silently
        }
    }

    if (requestCtx.matter) {
        try {
            const controller = require('../matter/controller');
            if (typeof controller.listPaired === 'function') {
                const nodes = controller.listPaired();
                if (nodes.length > 0) {
                    const list = nodes.map((n) => `  nodeId ${n.nodeId}: ${n.label || 'unnamed'}`).join('\n');
                    parts.push(`## Paired Matter devices\n${list}`);
                }
            }
        } catch {
            // matter not initialised — skip silently
        }
    }

    return parts.join('\n\n');
}

module.exports = { buildSystemPrompt };
