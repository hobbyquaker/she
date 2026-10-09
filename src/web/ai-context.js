'use strict';

/**
 * AI context builder (roadmap I25) — assembles the system prompt from sections:
 *
 *   static (the same for every request of a mode and profile; cached by Anthropic, I22):
 *     role · conventions · api reference (full or compact) · tools (when offered) · formats · compact steps
 *   dynamic (per request):
 *     the house (derived from the daemon: name, prefix, topic prefixes, adapters, the user's notes) ·
 *     the current script / view / document · sheDB ids and samples · attachments
 *
 * Profiles: 'capable' for the current hosted models, 'compact' for small local ones — the facts are the same
 * files, the compact profile gets the shorter reference, explicit steps and a budget. Nothing of an installation
 * is in these files: the house section is computed at request time.
 */

const fs = require('fs');
const path = require('path');

const P = path.join(__dirname, 'prompts');
const read = (n) => fs.readFileSync(path.join(P, n), 'utf8').trim();
const ROLE = read('role.md');
const CONVENTIONS = read('conventions.md');
const API_REF = read('api-ref.md');
const API_REF_COMPACT = read('api-ref-compact.md');
const FORMATS = read('formats.md'); // the hand-over through propose_script (I16, I41)
const FORMATS_NOTOOLS = read('formats-notools.md'); // the fenced block with the @new-file hint, for chats without tools
const TOOLS = read('tools.md');
const COMPACT_STEPS = read('compact.md');
const DB_VIEW_PROMPT = read('db-view.md');
const DB_DOC_PROMPT = read('db-doc.md');

const DEFAULT_COMPACT_BUDGET = 24000; // characters, about 6k tokens: a small local model's comfortable share for the prompt

/**
 * The derived house section: what this installation looks like, from the running daemon — never from a file.
 * @param {{ name?: string, variablePrefix?: string, version?: string } | null} cfg
 * @param {Iterable<[string, object]> | null} entries  the state store's mqtt entries
 * @param {Array<{instance: string, adapter?: string|null, connected?: number|null}>} instances
 * @param {Array<{text: string}>} notes  the user's confirmed facts (roadmap I29)
 */
function houseSection(cfg, entries, instances, notes) {
    const lines = ['## This installation'];
    if (cfg?.name)
        lines.push(
            `- the daemon's MQTT name is \`${cfg.name}\`${cfg.version ? ` (she ${cfg.version})` : ''}; its variables live under \`${cfg.variablePrefix || 'var'}/status/…\` and \`${cfg.variablePrefix || 'var'}/set/…\``,
        );
    if (entries) {
        const counts = new Map();
        let total = 0;
        for (const [topic] of entries) {
            total++;
            const first = topic.split('/')[0];
            counts.set(first, (counts.get(first) || 0) + 1);
        }
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
        if (total) lines.push(`- about ${roundish(total)} topics on the broker; the largest prefixes: ${top.map(([k, v]) => `\`${k}/\` (${roundish(v)})`).join(', ')}`);
    }
    const known = (instances || []).filter((i) => i.adapter).map((i) => `\`${i.instance}/\` ${i.adapter}${i.connected === 0 ? ' (offline)' : ''}`);
    if (known.length) lines.push(`- adapter instances: ${known.slice(0, 20).join(', ')}${known.length > 20 ? ` … (${known.length})` : ''}`);
    if (notes && notes.length) {
        lines.push('- your memory, facts from earlier chats (trust them over guesses; add with remember, drop with forget):');
        for (const n of notes.slice(0, 300)) lines.push(`  - [${n.id}] ${String(n.text).replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    return lines.length > 1 ? lines.join('\n') : '';
}

/** 8702 → "8700", 143 → "140", 12 → "12": stable across requests, so the cached prefix is not disturbed by every message */
function roundish(n) {
    if (n < 20) return String(n);
    const m = Math.pow(10, Math.floor(Math.log10(n)) - 1);
    return String(Math.round(n / m) * m);
}

/**
 * Build the full system prompt as one string (the OpenAI-compatible providers, the /prompt route).
 */
function buildSystemPrompt(requestCtx, currentScript, currentView, currentDoc, store, extraFiles, opts) {
    const { staticText, dynamicText } = buildSystemPromptParts(requestCtx, currentScript, currentView, currentDoc, store, extraFiles, opts);
    return dynamicText ? staticText + '\n\n' + dynamicText : staticText;
}

/**
 * The prompt in its static and dynamic part.
 * @param {object} requestCtx  { apiref, tools, shedb, sampleDocs }
 * @param {{ profile?: 'capable'|'compact', toolsOffered?: boolean, budgetChars?: number, house?: string }} [opts]
 * @returns {{ staticText: string, dynamicText: string, dropped: string[] }}
 */
function buildSystemPromptParts(requestCtx, currentScript, currentView, currentDoc, store, extraFiles, opts = {}) {
    const profile = opts.profile === 'compact' ? 'compact' : 'capable';
    const isViewMode = !!currentView?.id;
    const isDocMode = !!currentDoc?.id;
    const toolsOffered = opts.toolsOffered !== undefined ? !!opts.toolsOffered : !!requestCtx.tools;

    const staticParts = [];
    if (isViewMode) staticParts.push(DB_VIEW_PROMPT);
    else if (isDocMode) staticParts.push(DB_DOC_PROMPT);
    else {
        staticParts.push(ROLE, CONVENTIONS);
        if (requestCtx.apiref !== false) staticParts.push(profile === 'compact' ? API_REF_COMPACT : API_REF);
        if (toolsOffered) staticParts.push(TOOLS);
        staticParts.push(toolsOffered ? FORMATS : FORMATS_NOTOOLS);
        if (profile === 'compact') staticParts.push(COMPACT_STEPS);
    }

    // dynamic sections, each with a name so the budget can drop the least important first
    const sections = [];
    if (opts.house) sections.push({ name: 'house', text: opts.house });
    if (currentScript?.path && typeof currentScript.content === 'string') {
        sections.push({ name: 'script', text: `## Current script: ${currentScript.path}\n\`\`\`javascript\n${currentScript.content}\n\`\`\`` });
    }
    if (currentView?.id) {
        const filterStr = (currentView.filter || '').trim();
        const mapBody = (currentView.map || '').trim();
        const reduceBody = (currentView.reduce || '').trim();
        const viewLines = [`## Current view: ${currentView.id}`, `Filter: ${filterStr || '(none)'}`, `Map:\n\`\`\`javascript\n${mapBody || '// (empty)'}\n\`\`\``];
        viewLines.push(reduceBody ? `Reduce:\n\`\`\`javascript\n${reduceBody}\n\`\`\`` : 'Reduce: (none)');
        sections.push({ name: 'view', text: viewLines.join('\n') });
    }
    if (currentDoc?.id) {
        const content = typeof currentDoc.content === 'string' ? currentDoc.content : JSON.stringify(currentDoc.content, null, 2);
        sections.push({ name: 'doc', text: `## Current document: ${currentDoc.id}\n\`\`\`json\n${content}\n\`\`\`` });
    }
    if (requestCtx.shedb) {
        try {
            const core = require('./shedb').getCore();
            if (core) {
                const ids = Object.keys(core.docs).sort();
                if (ids.length > 0) sections.push({ name: 'shedb-ids', text: `## sheDB document IDs (${ids.length} total)\n${ids.slice(0, 200).join('\n')}` });
            }
        } catch {
            /* shedb not initialised */
        }
    }
    if (requestCtx.sampleDocs) {
        try {
            const core = require('./shedb').getCore();
            if (core) {
                const ids = Object.keys(core.docs).sort().slice(0, 10);
                if (ids.length > 0) {
                    const sample = ids.map((id) => `### ${id}\n${JSON.stringify(core.docs[id], null, 2)}`).join('\n\n');
                    sections.push({ name: 'shedb-samples', text: `## Sample sheDB documents (${ids.length} shown)\n${sample}` });
                }
            }
        } catch {
            /* shedb not initialised */
        }
    }
    for (const f of extraFiles || []) {
        const ext = (f.name.match(/\.([^.]+)$/) || [])[1] || '';
        sections.push({ name: 'file:' + f.name, text: `## Attached file: ${f.name}\n\`\`\`${ext.toLowerCase()}\n${f.content}\n\`\`\`` });
    }

    // the budget (compact profile, or an explicit one): drop the least important sections first
    const dropped = [];
    const budget = opts.budgetChars || (profile === 'compact' ? DEFAULT_COMPACT_BUDGET : 0);
    if (budget > 0) {
        const staticLen = staticParts.join('\n\n').length;
        const order = ['shedb-samples', 'shedb-ids', 'file:', 'script'];
        const size = () => staticLen + sections.reduce((n, s) => n + s.text.length + 2, 0);
        for (const kind of order) {
            while (size() > budget) {
                const idx = kind === 'file:' ? sections.map((s) => s.name).findLastIndex((n) => n.startsWith('file:')) : sections.findIndex((s) => s.name === kind);
                if (idx === -1) break;
                dropped.push(sections[idx].name);
                sections.splice(idx, 1);
            }
        }
        if (dropped.length) sections.push({ name: 'dropped', text: `(Left out to fit the model's context: ${dropped.join(', ')}. Ask for a part of it if needed.)` });
    }

    return { staticText: staticParts.join('\n\n'), dynamicText: sections.map((s) => s.text).join('\n\n'), dropped };
}

/** which prompt profile fits a provider entry; `profile` on the entry overrides */
function profileFor(ai) {
    if (ai?.profile === 'compact' || ai?.profile === 'capable') return ai.profile;
    if (!ai) return 'capable';
    if (ai.provider === 'ollama') return 'compact';
    if (ai.provider === 'openai') {
        const u = String(ai.baseUrl || '').toLowerCase();
        if (/localhost|127\.0\.0\.1|\.lan\b|\.local\b|\.home\b|:1234\b|:11434\b|:8080\b/.test(u)) return 'compact';
    }
    return 'capable';
}

/** strip the <think>…</think> blocks a thinking model returns as text (compact profile) */
function stripThinking(text) {
    return String(text)
        .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
        .replace(/^<think>[\s\S]*$/i, '')
        .trim();
}

/** a stateful filter for a token stream: tokens inside <think>…</think> are swallowed */
function thinkFilter(onToken) {
    let inside = false;
    let buf = '';
    return (token) => {
        buf += token;
        for (;;) {
            if (inside) {
                const end = buf.indexOf('</think>');
                if (end === -1) {
                    buf = buf.slice(-8); // keep a tail in case the tag is split
                    return;
                }
                buf = buf.slice(end + 8).replace(/^\s+/, '');
                inside = false;
            } else {
                const start = buf.indexOf('<think>');
                if (start === -1) {
                    // emit all but a possible partial tag at the end
                    const keep = buf.lastIndexOf('<');
                    const safe = keep === -1 || buf.length - keep > 7 ? buf : buf.slice(0, keep);
                    if (safe) onToken(safe);
                    buf = buf.slice(safe.length);
                    return;
                }
                if (start > 0) onToken(buf.slice(0, start));
                buf = buf.slice(start + 7);
                inside = true;
            }
        }
    };
}

module.exports = { buildSystemPrompt, buildSystemPromptParts, houseSection, profileFor, stripThinking, thinkFilter, DEFAULT_COMPACT_BUDGET };
