<script lang="ts">
    import { type AiMessage, type AiContext, type AiCurrentScript, type OllamaModelInfo, streamChatWithAI, getAiConfig, getAiModels, getOllamaModelInfo, type AiConfig } from '../lib/api.js';

    interface Props {
        currentScript?: AiCurrentScript | null;
        onApply?: (code: string) => void;
        onCreateFile?: (suggestedName: string, code: string) => void;
    }

    let { currentScript = null, onApply, onCreateFile }: Props = $props();

    // ── State ────────────────────────────────────────────────────────────────
    let messages = $state<AiMessage[]>([]);
    let streamingContent = $state<string | null>(null); // null = not streaming
    let input = $state('');
    let loading = $state(false);
    let error = $state('');
    let aiConfig = $state<AiConfig | null>(null);

    // Model selection
    let availableModels = $state<string[]>([]);
    let selectedModel = $state<string>('');

    // Ollama info popup
    let showInfoPopup = $state(false);
    let ollamaInfo = $state<OllamaModelInfo | null>(null);
    let infoLoading = $state(false);
    let infoError = $state('');

    // Streaming cancellation + status shimmer
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
        '[core]  solving P=NP as a warmup…',
        '[gpu]   burning GPU cycles for warmth…',
        '[mem]   compressing knowledge into tensors…',
        '[net]   asking my inner voice (busy)…',
        '[fs]    mining opinions from the void…',
        '[core]  summoning attention heads…',
        '[io]    tokenizing the vibes…',
        '[sched] hallucinating thoughtfully…',
        '[net]   traversing the knowledge graph…',
        '[model] manifesting an answer…',
    ];

    let ctxApiref = $state(true);
    let ctxMqtt   = $state(false);
    let ctxShedb  = $state(false);
    let ctxMatter = $state(false);

    let inputEl: HTMLTextAreaElement;
    let messagesEl: HTMLDivElement;

    // ── Derived ──────────────────────────────────────────────────────────────
    const context = $derived<AiContext>({
        apiref: ctxApiref,
        mqtt:   ctxMqtt,
        shedb:  ctxShedb,
        matter: ctxMatter,
    });

    const configured = $derived(aiConfig?.configured ?? false);

    // ── Lifecycle ────────────────────────────────────────────────────────────
    $effect(() => {
        getAiConfig().then(c => {
            aiConfig = c;
            if (c.configured && !selectedModel) selectedModel = c.model;
        }).catch(() => {});
    });

    $effect(() => {
        if (aiConfig?.configured) {
            getAiModels().then(r => { availableModels = r.models; }).catch(() => {});
        }
    });

    // Reset cached info when model changes
    $effect(() => {
        const _m = selectedModel;
        void _m;
        ollamaInfo = null;
        infoError = '';
    });

    // Cycle status messages while loading
    $effect(() => {
        if (!loading) return;
        statusIdx = Math.floor(Math.random() * STATUS_MESSAGES.length);
        const t = setInterval(() => {
            statusIdx = (statusIdx + 1) % STATUS_MESSAGES.length;
        }, 2500);
        return () => clearInterval(t);
    });

    $effect(() => {
        // Auto-scroll to bottom when messages or streaming content changes
        if (messagesEl) {
            // Use the fact that we read messages/streamingContent to track them
            const _ = messages.length + (streamingContent?.length ?? 0);
            void _;
            requestAnimationFrame(() => {
                if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
            });
        }
    });

    // ── Helpers ──────────────────────────────────────────────────────────────

    interface Block {
        type: 'text' | 'code';
        text: string;
        lang?: string;
    }

    function parseBlocks(content: string): Block[] {
        // Normalize: if an @new-file hint appears on the line immediately before a
        // code fence (outside it), move it inside the fence as the first line.
        // LLMs sometimes emit the hint outside the ``` block instead of inside.
        const normalized = content.replace(
            /(\n|^)(\/{2} @[a-z-]+:[^\n]+)\n(```\w*)\n/g,
            '$1$3\n$2\n',
        );
        const blocks: Block[] = [];
        const re = /```(\w*)\n([\s\S]*?)```/g;
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(normalized)) !== null) {
            if (m.index > last) blocks.push({ type: 'text', text: normalized.slice(last, m.index) });
            blocks.push({ type: 'code', lang: m[1] || 'text', text: m[2].trimEnd() });
            last = m.index + m[0].length;
        }
        if (last < normalized.length) blocks.push({ type: 'text', text: normalized.slice(last) });
        return blocks;
    }

    function copyCode(text: string) {
        navigator.clipboard.writeText(text).catch(() => {});
    }

    function applyCode(text: string) {
        onApply?.(text);
    }

    function isJsBlock(lang: string | undefined): boolean {
        return !lang || lang === 'js' || lang === 'javascript';
    }

    /**
     * If the code block starts with `// @new-file: filename.js`, extract the
     * suggested filename and strip that line from the code to be saved.
     */
    function getNewFileHint(text: string): { filename: string; code: string } | null {
        const m = text.match(/^\/\/ @new-file:\s*(\S+\.js)[ \t]*\n/);
        if (!m) return null;
        return { filename: m[1], code: text.slice(m[0].length) };
    }

    function formatBytes(bytes: number): string {
        if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
        if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
        return `${bytes} B`;
    }

    async function openInfoPopup() {
        showInfoPopup = true;
        if (ollamaInfo || infoLoading) return;
        infoLoading = true;
        infoError = '';
        try {
            ollamaInfo = await getOllamaModelInfo(selectedModel || aiConfig!.model);
        } catch (e: any) {
            infoError = (e as Error).message;
        }
        infoLoading = false;
    }

    // ── Send ─────────────────────────────────────────────────────────────────

    async function send() {
        const text = input.trim();
        if (!text || loading) return;
        input = '';
        error = '';
        loading = true;

        const userMsg: AiMessage = { role: 'user', content: text };
        messages = [...messages, userMsg];

        streamingContent = '';
        abortController = new AbortController();

        try {
            await streamChatWithAI(
                { messages, currentScript, context, modelOverride: selectedModel || undefined },
                (token) => { streamingContent = (streamingContent ?? '') + token; },
                abortController.signal,
            );
            messages = [...messages, { role: 'assistant', content: streamingContent ?? '' }];
        } catch (e: any) {
            if ((e as Error).name === 'AbortError') {
                // Save partial response if anything was streamed
                const partial = streamingContent;
                if (partial && partial.trim()) {
                    messages = [...messages, { role: 'assistant', content: partial + '\n\n*[stopped]*' }];
                }
            } else {
                error = (e as Error).message;
            }
        } finally {
            abortController = null;
            streamingContent = null;
            loading = false;
        }
    }

    function stop() {
        abortController?.abort();
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    }

    function clearHistory() { messages = []; error = ''; }

    const SUGGESTIONS = [
        'Explain what this script does',
        'Add error handling',
        'Add a 30-minute schedule before sunrise',
        'Write a new script that forwards MQTT topic A to topic B',
        'Write a new script that turns lights on at sunset',
    ];

    function useSuggestion(s: string) {
        input = s;
        inputEl?.focus();
    }
</script>

<div class="chat-panel">
    <!-- Header -->
    <div class="chat-header">
        <span class="chat-title">AI Assistant</span>
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
            <!-- Suggestion chips -->
            <div class="suggestions">
                <p class="suggestions-hint">
                    {#if currentScript}
                        Chatting in context of <code>{currentScript.path.split('/').pop()}</code>
                    {:else}
                        No script open. Ask a general she scripting question.
                    {/if}
                </p>
                {#each SUGGESTIONS as s}
                    <button class="chip" onclick={() => useSuggestion(s)}>{s}</button>
                {/each}
            </div>
        {/if}

        {#each messages as msg (msg)}
            <div class="message {msg.role}">
                {#if msg.role === 'user'}
                    <div class="msg-content user-text">{msg.content}</div>
                {:else}
                    {@const blocks = parseBlocks(msg.content)}
                    <div class="msg-content">
                        {#each blocks as block}
                            {#if block.type === 'text'}
                                <p class="text-block">{block.text}</p>
                            {:else}
                                {@const hint = isJsBlock(block.lang) ? getNewFileHint(block.text) : null}
                                {@const displayCode = hint ? hint.code : block.text}
                                <div class="code-block">
                                    <div class="code-header">
                                        <span class="code-lang">{hint ? `new: ${hint.filename}` : block.lang}</span>
                                        <div class="code-actions">
                                            <button onclick={() => copyCode(displayCode)}>Copy</button>
                                            {#if hint && onCreateFile}
                                                <button class="create-btn" onclick={() => onCreateFile!(hint.filename, hint.code)}>Save as new file…</button>
                                            {:else if isJsBlock(block.lang) && currentScript}
                                                <button class="apply-btn" onclick={() => applyCode(block.text)}>Apply to editor</button>
                                            {/if}
                                        </div>
                                    </div>
                                    <pre><code>{displayCode}</code></pre>
                                </div>
                            {/if}
                        {/each}
                    </div>
                {/if}
            </div>
        {/each}

        <!-- Streaming message -->
        {#if streamingContent !== null}
            <div class="message assistant streaming">
                <div class="msg-content">
                    {#each parseBlocks(streamingContent) as block}
                        {#if block.type === 'text'}
                            <p class="text-block">{block.text}</p>
                        {:else}
                            <div class="code-block">
                                <div class="code-header">
                                    <span class="code-lang">{block.lang}</span>
                                </div>
                                <pre><code>{block.text}</code></pre>
                            </div>
                        {/if}
                    {/each}
                    <span class="cursor">▋</span>
                </div>
            </div>
        {/if}
    </div>

    <!-- Error -->
    {#if error}
        <div class="chat-error">{error}</div>
    {/if}

    <!-- Context toggles -->
    <div class="context-row">
        <label title="Include she API reference in context">
            <input type="checkbox" bind:checked={ctxApiref} /> API ref
        </label>
        <label title="Include current MQTT state in context">
            <input type="checkbox" bind:checked={ctxMqtt} /> MQTT
        </label>
        <label title="Include sheDB document IDs in context">
            <input type="checkbox" bind:checked={ctxShedb} /> DB
        </label>
        <label title="Include paired Matter devices in context">
            <input type="checkbox" bind:checked={ctxMatter} /> Matter
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

    <!-- Status bar (visible while streaming) -->
    {#if loading}
        <div class="status-row">
            <span class="status-shimmer">{STATUS_MESSAGES[statusIdx]}</span>
        </div>
    {/if}

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

<!-- Ollama model info popup (outside .chat-panel so overlay covers full viewport) -->
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
                        {#if ollamaInfo.version}
                            <dt>Ollama version</dt><dd>{ollamaInfo.version}</dd>
                        {/if}
                        {#if ollamaInfo.details?.family}
                            <dt>Family</dt><dd>{ollamaInfo.details.family}</dd>
                        {/if}
                        {#if ollamaInfo.details?.parameter_size}
                            <dt>Parameters</dt><dd>{ollamaInfo.details.parameter_size}</dd>
                        {/if}
                        {#if ollamaInfo.details?.quantization_level}
                            <dt>Quantization</dt><dd>{ollamaInfo.details.quantization_level}</dd>
                        {/if}
                        {#if ollamaInfo.details?.format}
                            <dt>Format</dt><dd>{ollamaInfo.details.format}</dd>
                        {/if}
                        {#if ollamaInfo.running && ollamaInfo.running.length > 0}
                            <dt>Loaded</dt>
                            <dd>
                                {#each ollamaInfo.running as r}
                                    <div class="running-model">{r.name} · {formatBytes(r.size_vram)} VRAM</div>
                                {/each}
                            </dd>
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
    .chat-panel {
        width: 100%;
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        background: var(--bg-panel);
        border-left: 1px solid var(--border-sub);
        min-height: 0;
        height: 100%;
    }

    .chat-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--border-sub);
        flex-shrink: 0;
    }
    .chat-title { font-size: 12px; font-weight: 600; color: var(--fg); flex: 1; }
    .chat-model { font-size: 10px; color: var(--fg-muted); }
    .clear-btn {
        background: none; border: none; color: var(--fg-muted); cursor: pointer;
        font-size: 11px; padding: 1px 4px; border-radius: 2px;
    }
    .clear-btn:hover { background: var(--bg-hover); color: var(--fg); }

    .messages {
        flex: 1;
        overflow-y: auto;
        padding: 8px 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-height: 0;
    }

    .unconfigured {
        padding: 20px 14px;
        color: var(--fg-muted);
        font-size: 12px;
        line-height: 1.5;
    }
    .unconfigured strong { color: var(--fg); }

    .suggestions {
        padding: 12px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .suggestions-hint { font-size: 11px; color: var(--fg-muted); margin: 0 0 6px; }
    .suggestions-hint code { color: var(--fg-brand); background: var(--bg-widget); padding: 0 3px; border-radius: 2px; }
    .chip {
        background: var(--bg-widget);
        border: 1px solid var(--border-sub);
        color: var(--fg);
        font-size: 11px;
        padding: 5px 8px;
        border-radius: 4px;
        cursor: pointer;
        text-align: left;
    }
    .chip:hover { background: var(--bg-hover); border-color: var(--border); }

    .message {
        padding: 0 10px;
    }
    .message.user { align-self: flex-end; max-width: 90%; }
    .message.assistant { align-self: flex-start; width: 100%; }

    .msg-content { font-size: 12px; line-height: 1.5; }

    .user-text {
        background: var(--accent);
        color: #fff;
        border-radius: 10px 10px 2px 10px;
        padding: 7px 10px;
        word-break: break-word;
        white-space: pre-wrap;
    }

    .text-block {
        color: var(--fg-text);
        margin: 4px 0;
        white-space: pre-wrap;
        word-break: break-word;
    }
    .text-block:first-child { margin-top: 0; }
    .text-block:last-child { margin-bottom: 0; }

    .code-block {
        background: var(--bg-app);
        border: 1px solid var(--border-sub);
        border-radius: 4px;
        margin: 6px 0;
        overflow: hidden;
        font-size: 11px;
    }
    .code-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        background: var(--bg-widget);
        border-bottom: 1px solid var(--border-sub);
    }
    .code-lang { color: var(--fg-muted); font-size: 10px; flex: 1; }
    .code-actions { display: flex; gap: 4px; }
    .code-actions button, .apply-btn {
        background: none;
        border: 1px solid var(--border-sub);
        color: var(--fg-muted);
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 3px;
        cursor: pointer;
    }
    .code-actions button:hover { background: var(--bg-hover); color: var(--fg); }
    .apply-btn { color: var(--fg-brand) !important; border-color: var(--fg-brand) !important; }
    .apply-btn:hover { background: rgba(var(--accent-rgb, 31,139,76), 0.15) !important; }
    .create-btn { color: var(--accent) !important; border-color: var(--accent) !important; font-weight: 600; }
    .create-btn:hover { background: rgba(var(--accent-rgb, 31,139,76), 0.15) !important; }
    pre {
        margin: 0;
        padding: 8px;
        overflow-x: auto;
        font-family: 'Cascadia Code', 'Fira Code', monospace;
        font-size: 11px;
        line-height: 1.4;
        color: var(--fg-text);
    }
    code { font-family: inherit; }

    .streaming .msg-content { opacity: 0.92; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
    .cursor { animation: blink 0.9s step-end infinite; color: var(--fg-brand); font-size: 14px; line-height: 1; }

    .chat-error {
        background: rgba(200,50,50,0.15);
        border-top: 1px solid rgba(200,50,50,0.4);
        color: var(--fg-err);
        font-size: 11px;
        padding: 6px 10px;
        flex-shrink: 0;
        word-break: break-word;
    }

    .context-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 5px 10px;
        border-top: 1px solid var(--border-sub);
        background: var(--bg-app);
        flex-shrink: 0;
    }
    .context-row label {
        display: flex;
        align-items: center;
        gap: 3px;
        font-size: 10px;
        color: var(--fg-muted);
        cursor: pointer;
        user-select: none;
    }
    .context-row label:hover { color: var(--fg); }
    .context-row input[type='checkbox'] {
        accent-color: var(--fg-brand);
        width: 11px;
        height: 11px;
    }

    .input-row {
        display: flex;
        gap: 6px;
        padding: 6px 10px 8px;
        border-top: 1px solid var(--border-sub);
        background: var(--bg-panel);
        flex-shrink: 0;
        align-items: flex-end;
    }
    /* Spinning border around textarea */
    @property --border-angle {
        syntax: '<angle>';
        initial-value: 0deg;
        inherits: false;
    }
    @keyframes border-spin {
        to { --border-angle: 360deg; }
    }
    .textarea-wrap {
        flex: 1;
        min-width: 0;
        display: flex;
        border-radius: 5px;
        padding: 1px;
        background: var(--border);
        transition: background 0.2s;
        position: relative;
    }
    .textarea-wrap:focus-within { background: var(--fg-brand); }
    .textarea-wrap.loading,
    .textarea-wrap.loading:focus-within {
        padding: 1.5px;
        background: transparent;
        transition: none;
    }
    /* Gradient border ring — only the padding area is painted via CSS mask */
    .textarea-wrap.loading::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        padding: 1.5px;
        background: conic-gradient(
            from var(--border-angle),
            transparent 0%,
            transparent 45%,
            #3baee0 60%,
            #90d4ff 68%,
            #ffffff 73%,
            #90d4ff 78%,
            #3baee0 88%,
            transparent 95%,
            transparent 100%
        );
        -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
        animation: border-spin 2s linear infinite;
        pointer-events: none;
    }
    textarea {
        flex: 1;
        min-width: 0;
        resize: none;
        background: var(--bg-app);
        border: none;
        border-radius: 4px;
        color: var(--fg);
        font-size: 12px;
        padding: 6px 8px;
        font-family: inherit;
        line-height: 1.4;
        min-height: 0;
    }
    textarea:focus { outline: none; }
    textarea::placeholder { color: var(--fg-dim); }
    textarea:disabled { opacity: 0.5; cursor: not-allowed; }

    .send-btn {
        background: var(--accent);
        color: #fff;
        border: none;
        border-radius: 4px;
        width: 32px;
        height: 32px;
        cursor: pointer;
        font-size: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }
    .send-btn:disabled { opacity: 0.4; cursor: default; }
    .send-btn:not(:disabled):hover { background: var(--accent-hov); }

    .stop-btn {
        background: rgba(200, 60, 60, 0.12);
        color: #e06060;
        border: 1px solid rgba(200, 60, 60, 0.35);
        border-radius: 4px;
        width: 32px;
        height: 32px;
        cursor: pointer;
        font-size: 11px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: background 0.15s, border-color 0.15s;
    }
    .stop-btn:hover { background: rgba(200, 60, 60, 0.25); border-color: rgba(200, 60, 60, 0.65); }

    /* Status shimmer bar */
    @keyframes shimmer {
        0%   { background-position: -300% center; }
        100% { background-position:  300% center; }
    }
    .status-row {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 2px 10px 4px;
        background: var(--bg-panel);
        flex-shrink: 0;
        min-height: 20px;
    }
    .status-shimmer {
        font-size: 11px;
        font-family: monospace;
        font-style: normal;
        background: linear-gradient(
            90deg,
            var(--fg-dim)   0%,
            var(--fg-muted) 25%,
            var(--fg-brand) 43%,
            #d0f0ff         50%,
            var(--fg-brand) 57%,
            var(--fg-muted) 75%,
            var(--fg-dim)   100%
        );
        background-size: 300% auto;
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        animation: shimmer 2.5s linear infinite;
    }

    /* ── Model bar ───────────────────────────────────────────────────────── */
    .model-bar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px 5px;
        background: var(--bg-panel);
        flex-shrink: 0;
    }
    .model-provider {
        font-size: 9px;
        color: var(--fg-dim);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        flex-shrink: 0;
    }
    .model-select {
        flex: 1;
        min-width: 0;
        background: var(--bg-app);
        border: 1px solid var(--border-sub);
        border-radius: 3px;
        color: var(--fg);
        font-size: 11px;
        padding: 1px 4px;
        cursor: pointer;
        font-family: inherit;
    }
    .model-select:disabled { opacity: 0.5; cursor: not-allowed; }
    .model-select:focus { outline: none; border-color: var(--fg-brand); }
    .model-name {
        flex: 1;
        font-size: 11px;
        color: var(--fg-muted);
        font-family: monospace;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .info-btn {
        background: none;
        border: 1px solid var(--border-sub);
        border-radius: 3px;
        color: var(--fg-muted);
        font-size: 11px;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
        flex-shrink: 0;
        line-height: 1;
    }
    .info-btn:hover { background: var(--bg-hover); color: var(--fg); border-color: var(--border); }

    /* ── Info popup ──────────────────────────────────────────────────────── */
    .info-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        z-index: 300;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .info-popup {
        background: var(--bg-panel);
        border: 1px solid var(--border);
        border-radius: 6px;
        min-width: 260px;
        max-width: 400px;
        width: 90%;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
        overflow: hidden;
    }
    .info-popup-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        border-bottom: 1px solid var(--border-sub);
        background: var(--bg-widget);
        font-size: 12px;
        font-weight: 600;
        color: var(--fg);
    }
    .info-popup-header button {
        background: none;
        border: none;
        color: var(--fg-muted);
        cursor: pointer;
        font-size: 12px;
        padding: 0 2px;
        line-height: 1;
    }
    .info-popup-header button:hover { color: var(--fg); }
    .info-popup-body { padding: 10px 14px; }
    .info-popup-body dl {
        margin: 0;
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 5px 14px;
        font-size: 11px;
        align-items: baseline;
    }
    .info-popup-body dt { color: var(--fg-muted); white-space: nowrap; }
    .info-popup-body dd { margin: 0; color: var(--fg); word-break: break-word; }
    .info-popup-body .dim { color: var(--fg-dim); font-style: italic; }
    .running-model { font-size: 10px; line-height: 1.6; }
    .info-status { font-size: 11px; color: var(--fg-muted); margin: 0; }
    .info-err { color: var(--fg-err) !important; }
</style>
