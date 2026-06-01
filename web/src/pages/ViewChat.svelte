<script lang="ts">
    import {
        type AiMessage, type AiContext, type AiCurrentView, type OllamaModelInfo,
        streamChatWithAI, getAiConfig, getAiModels, getOllamaModelInfo, type AiConfig,
    } from '../lib/api.js';
    import hljs from 'highlight.js/lib/core';
    import javascript from 'highlight.js/lib/languages/javascript';
    import { marked } from 'marked';
    hljs.registerLanguage('javascript', javascript);
    marked.use({ breaks: true, gfm: true });

    interface ViewParts {
        filter?: string;
        map?: string;
        reduce?: string;
    }

    interface Props {
        currentView?: AiCurrentView | null;
        onApplyView?: (parts: ViewParts) => void;
    }

    let { currentView = null, onApplyView }: Props = $props();

    // ── State ─────────────────────────────────────────────────────────────────
    let messages     = $state<AiMessage[]>([]);
    let streamingContent = $state<string | null>(null);
    let input        = $state('');
    let loading      = $state(false);
    let error        = $state('');
    let aiConfig     = $state<AiConfig | null>(null);

    let availableModels = $state<string[]>([]);
    let selectedModel   = $state<string>(localStorage.getItem('she:selectedModel') ?? '');

    let expandedBlocks = $state(new Set<string>());

    let showInfoPopup = $state(false);
    let ollamaInfo   = $state<OllamaModelInfo | null>(null);
    let infoLoading  = $state(false);
    let infoError    = $state('');

    let abortController: AbortController | null = null;
    let statusIdx = $state(0);

    const STATUS_MESSAGES = [
        '[core]  reticulating splines…',
        '[io]    calibrating the flux capacitor…',
        '[net]   pinging the oracle (no response)…',
        '[gpu]   overclocking the neurons…',
        '[fs]    loading sarcasm module v4.2…',
        '[mem]   defragmenting the embedding space…',
        '[sched] running gradient descent into madness…',
        '[net]   synchronizing with the hive mind…',
        '[model] tickling the transformer…',
        '[io]    consulting rubber duck debugger…',
    ];

    // Context checkboxes
    let ctxDocIds     = $state(true);
    let ctxSampleDocs = $state(true);

    let inputEl: HTMLTextAreaElement;
    let messagesEl: HTMLDivElement;

    // ── Derived ───────────────────────────────────────────────────────────────
    const context = $derived<AiContext>({
        apiref:     false,
        shedb:      ctxDocIds,
        sampleDocs: ctxSampleDocs,
    });

    const configured = $derived(aiConfig?.configured ?? false);

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    $effect(() => {
        getAiConfig().then(c => {
            aiConfig = c;
            if (c.configured && !selectedModel) selectedModel = c.model;
        }).catch(() => {});
    });

    $effect(() => {
        if (selectedModel) localStorage.setItem('she:selectedModel', selectedModel);
    });

    $effect(() => {
        if (aiConfig?.configured) {
            getAiModels().then(r => { availableModels = r.models; }).catch(() => {});
        }
    });

    $effect(() => {
        const _m = selectedModel; void _m;
        ollamaInfo = null; infoError = '';
    });

    $effect(() => {
        if (!loading) return;
        statusIdx = Math.floor(Math.random() * STATUS_MESSAGES.length);
        const t = setInterval(() => { statusIdx = (statusIdx + 1) % STATUS_MESSAGES.length; }, 10000);
        return () => clearInterval(t);
    });

    $effect(() => {
        if (messagesEl) {
            const _ = messages.length + (streamingContent?.length ?? 0); void _;
            requestAnimationFrame(() => { if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight; });
        }
    });

    // ── Helpers ───────────────────────────────────────────────────────────────

    interface Block { type: 'text' | 'code'; text: string; lang?: string; }

    function parseBlocks(content: string): Block[] {
        const blocks: Block[] = [];
        const re = /```(\w*)\n([\s\S]*?)```/g;
        let last = 0, m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
            if (m.index > last) blocks.push({ type: 'text', text: content.slice(last, m.index) });
            blocks.push({ type: 'code', lang: m[1] || 'text', text: m[2].trimEnd() });
            last = m.index + m[0].length;
        }
        if (last < content.length) blocks.push({ type: 'text', text: content.slice(last) });
        return blocks;
    }

    function parseBlocksStreaming(content: string): Block[] {
        const blocks: Block[] = [];
        const re = /```(\w*)\n([\s\S]*?)```/g;
        let last = 0, m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
            if (m.index > last) blocks.push({ type: 'text', text: content.slice(last, m.index) });
            blocks.push({ type: 'code', lang: m[1] || 'text', text: m[2].trimEnd() });
            last = m.index + m[0].length;
        }
        const tail = content.slice(last);
        const openFence = tail.match(/```(\w*)\n([\s\S]*)$/);
        if (openFence) {
            if (openFence.index! > 0) blocks.push({ type: 'text', text: tail.slice(0, openFence.index) });
            blocks.push({ type: 'code', lang: openFence[1] || 'text', text: openFence[2] });
        } else if (tail) {
            blocks.push({ type: 'text', text: tail });
        }
        return blocks;
    }

    /** Extract view parts from a set of blocks. Returns only the detected parts. */
    function parseViewParts(blocks: Block[]): ViewParts {
        const parts: ViewParts = {};
        for (const b of blocks) {
            if (b.type !== 'code') continue;
            if (b.lang === 'filter') {
                parts.filter = b.text.trim();
            } else if (isJsBlock(b.lang)) {
                const first = b.text.split('\n')[0].trim();
                if (first === '// @view-map') {
                    parts.map = b.text.split('\n').slice(1).join('\n').trim();
                } else if (first === '// @view-reduce') {
                    parts.reduce = b.text.split('\n').slice(1).join('\n').trim();
                }
            }
        }
        return parts;
    }

    function hasViewParts(parts: ViewParts): boolean {
        return parts.filter !== undefined || parts.map !== undefined || parts.reduce !== undefined;
    }

    function viewPartsLabel(parts: ViewParts): string {
        const names: string[] = [];
        if (parts.filter !== undefined) names.push('filter');
        if (parts.map    !== undefined) names.push('map');
        if (parts.reduce !== undefined) names.push('reduce');
        return `Apply ${names.join(' + ')}`;
    }

    const CODE_COLLAPSE_LINES = 15;
    function shouldCollapse(code: string) { return code.split('\n').length > CODE_COLLAPSE_LINES; }
    function toggleBlock(id: string) {
        const next = new Set(expandedBlocks);
        if (next.has(id)) next.delete(id); else next.add(id);
        expandedBlocks = next;
    }

    function highlightCode(code: string, lang: string): string {
        if (isJsBlock(lang)) {
            try { return hljs.highlight(code, { language: 'javascript' }).value; } catch { /* fallthrough */ }
        }
        return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function renderMd(text: string): string { return marked.parse(text) as string; }

    function isJsBlock(lang: string | undefined): boolean {
        return !lang || lang === 'js' || lang === 'javascript';
    }

    function copyCode(text: string) { navigator.clipboard.writeText(text).catch(() => {}); }

    async function openInfoPopup() {
        showInfoPopup = true;
        if (ollamaInfo || infoLoading) return;
        infoLoading = true; infoError = '';
        try { ollamaInfo = await getOllamaModelInfo(selectedModel || aiConfig!.model); }
        catch (e: any) { infoError = (e as Error).message; }
        infoLoading = false;
    }

    function formatBytes(bytes: number): string {
        if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
        if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
        return `${bytes} B`;
    }

    // ── Send ──────────────────────────────────────────────────────────────────
    async function send() {
        const text = input.trim();
        if (!text || loading) return;
        input = ''; error = ''; loading = true;

        messages = [...messages, { role: 'user', content: text }];
        abortController = new AbortController();

        try {
            await streamChatWithAI(
                { messages, currentView, context, modelOverride: selectedModel || undefined },
                (token) => { streamingContent = (streamingContent ?? '') + token; },
                abortController.signal,
            );
            messages = [...messages, { role: 'assistant', content: streamingContent ?? '' }];
        } catch (e: any) {
            if ((e as Error).name === 'AbortError') {
                const partial = streamingContent;
                if (partial?.trim()) messages = [...messages, { role: 'assistant', content: partial + '\n\n*[stopped]*' }];
            } else {
                error = (e as Error).message;
            }
        } finally {
            abortController = null; streamingContent = null; loading = false;
        }
    }

    function stop() { abortController?.abort(); }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    }

    function clearHistory() { messages = []; error = ''; }

    const SUGGESTIONS = [
        'Write a view to list all document IDs',
        'Write a view to sum a numeric property across all documents',
        'Write a view that filters to a specific prefix and emits a field',
        'Write a reduce that returns the maximum value',
        'Explain how the current view works',
    ];

    function useSuggestion(s: string) { input = s; inputEl?.focus(); }
</script>

<div class="chat-panel">
    <!-- Header -->
    <div class="chat-header">
        <span class="chat-title">AI — View assistant</span>
        {#if aiConfig}
            <span class="chat-model" title="Provider: {aiConfig.provider}">
                {#if configured}{aiConfig.provider} · {aiConfig.model}{:else}Not configured{/if}
            </span>
        {/if}
        {#if messages.length > 0}
            <button class="clear-btn" onclick={clearHistory} title="Clear conversation">✕</button>
        {/if}
    </div>

    <!-- Messages -->
    <div class="messages" bind:this={messagesEl}>
        {#if !configured}
            <div class="unconfigured">
                Configure an AI provider in the <strong>Config</strong> tab to use the AI assistant.
            </div>
        {:else if messages.length === 0 && streamingContent === null}
            <div class="suggestions">
                <p class="suggestions-hint">
                    {#if currentView}
                        Working on view <code>{currentView.id}</code>
                    {:else}
                        No view selected. Ask a general sheDB view question.
                    {/if}
                </p>
                {#each SUGGESTIONS as s}
                    <button class="chip" onclick={() => useSuggestion(s)}>{s}</button>
                {/each}
            </div>
        {/if}

        {#each messages as msg, msgIdx}
            <div class="message {msg.role}">
                {#if msg.role === 'user'}
                    <div class="msg-content user-text">{msg.content}</div>
                {:else}
                    {@const blocks = parseBlocks(msg.content)}
                    {@const viewParts = parseViewParts(blocks)}
                    <div class="msg-content">
                        {#each blocks as block, blockIdx}
                            {#if block.type === 'text'}
                                <div class="text-block">{@html renderMd(block.text)}</div>
                            {:else}
                                {@const bid = `${msgIdx}:${blockIdx}`}
                                {@const collapsible = shouldCollapse(block.text)}
                                {@const isExp = expandedBlocks.has(bid)}
                                {@const isFilter = block.lang === 'filter'}
                                <div class="code-block">
                                    <div class="code-header">
                                        <span class="code-lang">{isFilter ? 'filter' : block.lang}</span>
                                        <div class="code-actions">
                                            <button onclick={() => copyCode(block.text)}>Copy</button>
                                        </div>
                                    </div>
                                    <div class="code-body" class:collapsed={collapsible && !isExp}>
                                        <pre><code class="hljs">{@html highlightCode(block.text, block.lang ?? '')}</code></pre>
                                        {#if collapsible}
                                            <button class="expand-btn" onclick={() => toggleBlock(bid)}>
                                                {isExp ? '▲ collapse' : '▼ expand'}
                                            </button>
                                        {/if}
                                    </div>
                                </div>
                            {/if}
                        {/each}
                        <!-- Apply button if this message contains view parts -->
                        {#if hasViewParts(viewParts) && onApplyView}
                            <div class="apply-view-row">
                                <button class="apply-view-btn" onclick={() => onApplyView!(viewParts)}>
                                    {viewPartsLabel(viewParts)}
                                </button>
                            </div>
                        {/if}
                    </div>
                {/if}
            </div>
        {/each}

        <!-- Status shimmer while waiting for first token -->
        {#if loading && streamingContent === null}
            <div class="message assistant">
                <div class="msg-content">
                    <span class="status-shimmer">{STATUS_MESSAGES[statusIdx]}</span>
                </div>
            </div>
        {/if}

        <!-- Streaming message -->
        {#if streamingContent !== null}
            <div class="message assistant streaming">
                <div class="msg-content">
                    {#each parseBlocksStreaming(streamingContent) as block}
                        {#if block.type === 'text'}
                            <div class="text-block">{@html renderMd(block.text)}</div>
                        {:else}
                            <div class="code-block">
                                <div class="code-header"><span class="code-lang">{block.lang}</span></div>
                                <pre><code class="hljs">{@html highlightCode(block.text, block.lang ?? '')}</code></pre>
                            </div>
                        {/if}
                    {/each}
                </div>
            </div>
        {/if}
    </div>

    {#if error}
        <div class="chat-error">{error}</div>
    {/if}

    <!-- Context toggles -->
    <div class="context-row">
        <label title="Include sheDB document IDs in context">
            <input type="checkbox" bind:checked={ctxDocIds} /><span class="checkmark"></span> Doc IDs
        </label>
        <label title="Include sample document content in context (first 10 docs)">
            <input type="checkbox" bind:checked={ctxSampleDocs} /><span class="checkmark"></span> Sample docs
        </label>
    </div>

    <!-- Input -->
    <div class="input-row">
        <div class="textarea-wrap" class:loading>
            <textarea
                bind:this={inputEl}
                bind:value={input}
                onkeydown={handleKeydown}
                placeholder={configured ? 'Ask anything… (Enter to send, Shift+Enter for newline)' : 'AI not configured'}
                rows="3"
                disabled={loading || !configured}
            ></textarea>
        </div>
        {#if loading}
            <button class="stop-btn" onclick={stop} title="Stop generation">■</button>
        {:else}
            <button class="send-btn" onclick={send} disabled={!input.trim() || !configured}>↑</button>
        {/if}
    </div>

    <!-- Model bar -->
    {#if configured && aiConfig}
        <div class="model-bar">
            <span class="model-provider">{aiConfig.provider}</span>
            {#if availableModels.length > 0}
                <select class="model-select" bind:value={selectedModel} disabled={loading}>
                    {#each availableModels as m}
                        <option value={m}>{m}</option>
                    {/each}
                </select>
            {:else}
                <span class="model-name">{selectedModel || aiConfig.model}</span>
            {/if}
            {#if aiConfig.provider === 'ollama'}
                <button class="info-btn" onclick={openInfoPopup} title="Model info">ℹ</button>
            {/if}
        </div>
    {/if}
</div>

<!-- Ollama model info popup -->
{#if showInfoPopup}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="info-overlay" onclick={() => showInfoPopup = false}>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="info-popup" onclick={(e) => e.stopPropagation()}>
            <div class="info-popup-header">
                <span>Ollama · {selectedModel || aiConfig?.model}</span>
                <button onclick={() => showInfoPopup = false} title="Close">✕</button>
            </div>
            <div class="info-popup-body">
                {#if infoLoading}
                    <p class="info-status">Loading…</p>
                {:else if infoError}
                    <p class="info-status info-err">{infoError}</p>
                {:else if ollamaInfo}
                    <dl>
                        {#if ollamaInfo.version}<dt>Ollama version</dt><dd>{ollamaInfo.version}</dd>{/if}
                        {#if ollamaInfo.details?.family}<dt>Family</dt><dd>{ollamaInfo.details.family}</dd>{/if}
                        {#if ollamaInfo.details?.parameter_size}<dt>Parameters</dt><dd>{ollamaInfo.details.parameter_size}</dd>{/if}
                        {#if ollamaInfo.details?.quantization_level}<dt>Quantization</dt><dd>{ollamaInfo.details.quantization_level}</dd>{/if}
                        {#if ollamaInfo.running && ollamaInfo.running.length > 0}
                            <dt>Loaded</dt>
                            <dd>{#each ollamaInfo.running as r}<div class="running-model">{r.name} · {formatBytes(r.size_vram)} VRAM</div>{/each}</dd>
                        {:else if ollamaInfo.running !== null}
                            <dt>Loaded</dt><dd class="dim">Not in memory</dd>
                        {/if}
                    </dl>
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    /* ── Layout ───────────────────────────────────────────────────────────── */
    .chat-panel {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--bg-panel);
        border-left: 1px solid var(--border-sub);
        font-size: 0.85rem;
        overflow: hidden;
    }

    .chat-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border-sub);
        flex-shrink: 0;
    }
    .chat-title { font-weight: 600; font-size: 0.82rem; white-space: nowrap; }
    .chat-model { color: var(--fg-dim); font-size: 0.75rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .clear-btn { margin-left: auto; background: none; border: none; color: var(--fg-dim); cursor: pointer; font-size: 0.8rem; padding: 2px 4px; }
    .clear-btn:hover { color: var(--fg); }

    /* ── Messages ─────────────────────────────────────────────────────────── */
    .messages {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .unconfigured {
        color: var(--fg-dim);
        font-size: 0.82rem;
        padding: 12px;
        text-align: center;
        line-height: 1.6;
    }

    .suggestions { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; }
    .suggestions-hint { color: var(--fg-dim); font-size: 0.78rem; margin: 0 0 4px; }
    .chip {
        background: none;
        border: 1px dashed var(--border);
        color: var(--fg-dim);
        padding: 4px 8px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.78rem;
        text-align: left;
    }
    .chip:hover { border-color: var(--accent); color: var(--fg); }

    .message { display: flex; flex-direction: column; }
    .message.user { align-items: flex-end; }
    .message.assistant { align-items: flex-start; }

    .msg-content { max-width: 100%; }
    .user-text {
        background: var(--bg-active);
        padding: 6px 10px;
        border-radius: 8px 8px 2px 8px;
        font-size: 0.82rem;
        white-space: pre-wrap;
        word-break: break-word;
    }

    /* ── Code blocks ─────────────────────────────────────────────────────── */
    .code-block { margin: 4px 0; border: 1px solid var(--border-sub); border-radius: 4px; overflow: hidden; }
    .code-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 2px 8px;
        background: var(--bg-app);
        border-bottom: 1px solid var(--border-sub);
    }
    .code-lang { font-size: 0.7rem; color: var(--fg-dim); font-family: monospace; }
    .code-actions { display: flex; gap: 4px; }
    .code-actions button {
        background: none; border: 1px solid var(--border); color: var(--fg-dim);
        padding: 1px 6px; border-radius: 3px; cursor: pointer; font-size: 0.72rem;
    }
    .code-actions button:hover { color: var(--fg); border-color: var(--fg-dim); }

    .code-body { position: relative; }
    .code-body.collapsed pre { max-height: 200px; overflow: hidden; mask-image: linear-gradient(to bottom, black 60%, transparent 100%); }
    .code-body pre { margin: 0; padding: 8px; overflow-x: auto; font-size: 0.78rem; background: transparent; }
    .code-body code { font-family: 'Cascadia Code', 'Fira Code', monospace; }
    .expand-btn {
        position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%);
        background: var(--bg-panel); border: 1px solid var(--border);
        color: var(--fg-dim); padding: 1px 10px; border-radius: 3px;
        cursor: pointer; font-size: 0.7rem;
    }
    .expand-btn:hover { color: var(--fg); }

    /* ── Apply view button ───────────────────────────────────────────────── */
    .apply-view-row { margin-top: 6px; }
    .apply-view-btn {
        background: var(--accent);
        color: #fff;
        border: none;
        padding: 5px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.8rem;
        font-weight: 600;
    }
    .apply-view-btn:hover { background: var(--accent-hov); }

    /* ── Markdown styling ────────────────────────────────────────────────── */
    .text-block { font-size: 0.82rem; line-height: 1.55; color: var(--fg-text); }
    :global(.text-block p)          { margin: 0 0 0.4em; }
    :global(.text-block p:last-child) { margin-bottom: 0; }
    :global(.text-block strong)     { font-weight: 700; }
    :global(.text-block em)         { font-style: italic; }
    :global(.text-block ul, .text-block ol) { margin: 0.2em 0 0.4em 1.2em; padding: 0; }
    :global(.text-block li)         { margin-bottom: 0.2em; }
    :global(.text-block code)       { font-family: monospace; font-size: 0.9em; background: var(--bg-app); padding: 0 3px; border-radius: 2px; }
    :global(.text-block a)          { color: var(--accent); }
    :global(code.hljs)              { background: transparent !important; }
    :global(.hljs-keyword)          { color: #c678dd; }
    :global(.hljs-string)           { color: #98c379; }
    :global(.hljs-number)           { color: #d19a66; }
    :global(.hljs-comment)          { color: #5c6370; font-style: italic; }
    :global(.hljs-function)         { color: #61afef; }
    :global(.hljs-built_in)         { color: #e06c75; }
    :global(.hljs-variable)         { color: #abb2bf; }
    :global(.hljs-title)            { color: #61afef; }
    :global(.hljs-params)           { color: #abb2bf; }
    :global(.hljs-attr)             { color: #e06c75; }
    :global(.hljs-literal)          { color: #56b6c2; }
    :global(.hljs-operator)         { color: #56b6c2; }

    /* ── Status shimmer ─────────────────────────────────────────────────── */
    .status-shimmer {
        display: inline-block;
        font-family: monospace;
        font-size: 0.78rem;
        color: transparent;
        background: linear-gradient(90deg, var(--fg-dim) 25%, var(--fg) 50%, var(--fg-dim) 75%);
        background-size: 200% 100%;
        -webkit-background-clip: text;
        background-clip: text;
        animation: shimmer 12s linear infinite;
    }
    @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

    /* ── Error ───────────────────────────────────────────────────────────── */
    .chat-error { padding: 6px 10px; background: #3a1818; color: #f88; font-size: 0.8rem; flex-shrink: 0; }

    /* ── Context toggles ─────────────────────────────────────────────────── */
    .context-row {
        display: flex;
        gap: 10px;
        padding: 4px 10px;
        border-top: 1px solid var(--border-sub);
        flex-shrink: 0;
    }
    .context-row label { display: flex; align-items: center; gap: 4px; font-size: 0.75rem; color: var(--fg-dim); cursor: pointer; user-select: none; }
    .context-row label:hover { color: var(--fg); }
    .context-row input[type='checkbox'] {
        position: absolute;
        opacity: 0;
        width: 0;
        height: 0;
        pointer-events: none;
    }
    .context-row .checkmark {
        flex-shrink: 0;
        width: 11px;
        height: 11px;
        border: 1.5px solid var(--border);
        border-radius: 2px;
        background: var(--bg-app);
        position: relative;
        transition: background 0.12s, border-color 0.12s;
    }
    .context-row input:checked + .checkmark {
        background: var(--accent);
        border-color: var(--accent);
    }
    .context-row input:checked + .checkmark::after {
        content: '';
        position: absolute;
        left: 2px;
        top: -1px;
        width: 3px;
        height: 6px;
        border: 1.5px solid #fff;
        border-top: none;
        border-left: none;
        transform: rotate(45deg);
    }
    .context-row label:hover .checkmark { border-color: var(--accent); }

    /* ── Input area ──────────────────────────────────────────────────────── */
    .input-row {
        display: flex;
        align-items: flex-end;
        gap: 4px;
        padding: 6px;
        border-top: 1px solid var(--border-sub);
        flex-shrink: 0;
        position: relative;
    }
    .textarea-wrap { flex: 1; position: relative; }
    .textarea-wrap textarea {
        width: 100%;
        background: var(--bg-app);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 6px 8px;
        font-size: 0.82rem;
        resize: none;
        font-family: inherit;
        box-sizing: border-box;
    }
    .textarea-wrap textarea:focus { outline: none; border-color: var(--accent); }
    .textarea-wrap.loading::before {
        content: '';
        position: absolute;
        inset: -2px;
        border-radius: 8px;
        padding: 2px;
        background: conic-gradient(from var(--border-angle), #e060a0, #6060e0, #60c0e0, #60e060, #e0c060, #e060a0);
        -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        mask-composite: exclude;
        animation: spin 2s linear infinite;
        @property --border-angle { syntax: '<angle>'; inherits: false; initial-value: 0turn; }
    }
    @keyframes spin { to { --border-angle: 1turn; } }

    .send-btn, .stop-btn {
        flex-shrink: 0;
        width: 32px; height: 32px;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        font-size: 1rem;
        display: flex; align-items: center; justify-content: center;
    }
    .send-btn { background: var(--accent); color: #fff; }
    .send-btn:hover:not(:disabled) { background: var(--accent-hov); }
    .send-btn:disabled { opacity: 0.4; cursor: default; }
    .stop-btn { background: #c0392b; color: #fff; }
    .stop-btn:hover { background: #a93226; }

    /* ── Model bar ───────────────────────────────────────────────────────── */
    .model-bar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 8px;
        border-top: 1px solid var(--border-sub);
        flex-shrink: 0;
        font-size: 0.72rem;
        color: var(--fg-dim);
    }
    .model-provider { flex-shrink: 0; }
    .model-select {
        flex: 1; min-width: 0;
        background: var(--bg-app); color: var(--fg);
        border: 1px solid var(--border); border-radius: 3px;
        padding: 1px 4px; font-size: 0.72rem;
    }
    .model-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .info-btn {
        background: none; border: none; color: var(--fg-dim);
        cursor: pointer; font-size: 0.85rem; padding: 1px 3px;
    }
    .info-btn:hover { color: var(--fg); }

    /* ── Ollama info popup ───────────────────────────────────────────────── */
    .info-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 200;
        display: flex; align-items: center; justify-content: center;
    }
    .info-popup {
        background: var(--bg-panel); border: 1px solid var(--border);
        border-radius: 8px; min-width: 280px; max-width: 400px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .info-popup-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px; border-bottom: 1px solid var(--border-sub);
        font-weight: 600; font-size: 0.85rem;
    }
    .info-popup-header button { background: none; border: none; color: var(--fg-dim); cursor: pointer; font-size: 0.9rem; }
    .info-popup-body { padding: 12px 14px; font-size: 0.82rem; }
    .info-popup-body dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
    .info-popup-body dt { color: var(--fg-dim); }
    .info-popup-body dd { margin: 0; }
    .info-status { color: var(--fg-dim); margin: 0; }
    .info-err { color: #f88; }
    .running-model { font-size: 0.78rem; }
    .dim { color: var(--fg-dim); }
</style>
