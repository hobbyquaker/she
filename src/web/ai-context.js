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
        try {
        // Collect all MQTT topics, skipping $SYS/ broker internals
        const topicData = new Map(); // topic → { val, lc }
        for (const [topic, obj] of store.mqttEntries()) {
            if (topic.startsWith('$SYS/')) continue;
            topicData.set(topic, { val: obj.val, lc: obj.lc ?? obj.ts ?? 0 });
        }

        if (topicData.size > 0) {
            // Build a trie so sibling leaf-topics can be collapsed onto one line.
            // Each node tracks: maxLc (for recency sort) and topic (original string,
            // stored only on leaf nodes so lookups never need path reconstruction).
            const mkNode = () => ({ children: new Map(), isLeaf: false, lc: 0, maxLc: 0, topic: null });
            const root = mkNode();
            for (const [topic, { lc }] of topicData) {
                const segs = topic.split('/');
                let node = root;
                for (const seg of segs) {
                    if (!node.children.has(seg)) node.children.set(seg, mkNode());
                    node = node.children.get(seg);
                }
                node.isLeaf = true;
                node.lc = lc;
                node.topic = topic; // exact original key — used for topicData lookups
            }

            // Post-order pass: propagate maxLc up so subtrees can be sorted by recency
            const propagate = (node) => {
                let max = node.isLeaf ? node.lc : 0;
                for (const child of node.children.values()) {
                    const m = propagate(child);
                    if (m > max) max = m;
                }
                node.maxLc = max;
                return max;
            };
            propagate(root);

            // Walk the trie most-recently-changed first.
            // Sibling pure-leaf nodes (no sub-topics) under the same parent are
            // collapsed onto one line: parent/A: v1 # B: v2 # C: v3
            // We use node.topic for all topicData lookups — no path reconstruction.
            const lines = [];
            const walk = (node, atRoot) => {
                const byRecency = [...node.children.entries()].sort(([, a], [, b]) => b.maxLc - a.maxLc);
                const pureLeaves = byRecency.filter(([, c]) => c.isLeaf && c.children.size === 0);
                const branches   = byRecency.filter(([, c]) => !(c.isLeaf && c.children.size === 0));

                if (pureLeaves.length > 1 && !atRoot) {
                    // Collapse siblings: "parentTopic/FIRST: v1 # SIBLING: v2 # ..."
                    // Derive the shared prefix from the first node's stored topic.
                    const [[, firstNode], ...rest] = pureLeaves;
                    const sharedPrefix = firstNode.topic.slice(0, firstNode.topic.lastIndexOf('/'));
                    const v0 = JSON.stringify(topicData.get(firstNode.topic).val);
                    const siblings = rest.map(([, n]) => {
                        const name = n.topic.slice(sharedPrefix.length + 1);
                        return `${name}: ${JSON.stringify(topicData.get(n.topic).val)}`;
                    });
                    lines.push(`${firstNode.topic}: ${v0} # ${siblings.join(' # ')}`);
                } else {
                    for (const [, leafNode] of pureLeaves) {
                        lines.push(`${leafNode.topic}: ${JSON.stringify(topicData.get(leafNode.topic).val)}`);
                    }
                }

                for (const [, child] of branches) {
                    if (child.isLeaf) {
                        lines.push(`${child.topic}: ${JSON.stringify(topicData.get(child.topic).val)}`);
                    }
                    walk(child, false);
                }
            };
            walk(root, true);

            parts.push(
                '## Current MQTT state\n' +
                '($SYS/ broker topics omitted; sorted most-recently-changed first;\n' +
                'sibling leaf-topics sharing a prefix are grouped: prefix/A: v1 # B: v2 # C: v3)\n' +
                lines.join('\n')
            );
        }
        } catch (e) {
            parts.push(`## Current MQTT state\n(Error building MQTT context: ${e.message})`);
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
                    const lines = ['## Paired Matter devices'];
                    for (const n of nodes) {
                        const deviceName = n.name || `node-${n.nodeId}`;
                        lines.push(`\n### ${deviceName} (nodeId: "${n.nodeId}", ${n.online ? 'online' : 'offline'})`);
                        try {
                            const endpoints = controller.getEndpoints(n.nodeId);
                            for (const ep of endpoints) {
                                if (ep.endpointId === 0) continue; // skip root endpoint
                                const epName = ep.name || String(ep.endpointId);
                                lines.push(`- endpoint "${epName}" (id: ${ep.endpointId}): ${ep.clusters.join(', ')}`);
                            }
                        } catch { /* node may be offline */ }
                    }
                    parts.push(lines.join('\n'));
                }
            }
        } catch {
            // matter not initialised — skip silently
        }
    }

    return parts.join('\n\n');
}

module.exports = { buildSystemPrompt };
