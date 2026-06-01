<script lang="ts">
    import { type AiMessage, type AiContext, type AiCurrentScript, type AiExtraFile, type AiToolEvent, type OllamaModelInfo, streamChatWithAI, getAiConfig, getAiModels, getOllamaModelInfo, getAiPrompt, type AiConfig } from '../lib/api.js';
    import hljs from 'highlight.js/lib/core';
    import javascript from 'highlight.js/lib/languages/javascript';
    import { marked } from 'marked';
    hljs.registerLanguage('javascript', javascript);
    marked.use({ breaks: true, gfm: true });

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

    // Model selection — persisted in localStorage
    let availableModels = $state<string[]>([]);
    let selectedModel = $state<string>(localStorage.getItem('she:selectedModel') ?? '');

    // Always-apply session flag (per script, resets on script change)
    let autoApplyScript = $state<string | null>(null);
    const autoApply = $derived(
        autoApplyScript !== null && currentScript?.path === autoApplyScript,
    );

    // Collapsed/expanded code block tracking
    let expandedBlocks = $state(new Set<string>());

    // Ollama info popup
    let showInfoPopup = $state(false);
    let ollamaInfo = $state<OllamaModelInfo | null>(null);
    let infoLoading = $state(false);
    let infoError = $state('');

    // Live request size estimation (system prompt + input text)
    let promptBytes = $state(0);

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
    let ctxTools  = $state(true);

    // File context chips
    let includeCurrentScript = $state(true);
    let uploadedFiles = $state<AiExtraFile[]>([]);
    let isDragOver = $state(false);
    let fileInputEl: HTMLInputElement;

    // Tool events emitted by the server during a tool-calling round
    let toolEvents = $state<AiToolEvent[]>([]);

    let inputEl: HTMLTextAreaElement;
    let messagesEl: HTMLDivElement;

    // ── Derived ──────────────────────────────────────────────────────────────
    const context = $derived<AiContext>({
        apiref: ctxApiref,
        tools:  ctxTools,
    });

    const configured = $derived(aiConfig?.configured ?? false);
    const requestBytes = $derived(promptBytes + new TextEncoder().encode(input).length);
    const activeScript = $derived(includeCurrentScript ? currentScript : null);

    // ── Lifecycle ────────────────────────────────────────────────────────────
    // Reset auto-apply when the active script changes
    $effect(() => {
        const path = currentScript?.path;
        void path;
        includeCurrentScript = true;
        if (autoApplyScript !== null && path !== autoApplyScript) autoApplyScript = null;
    });

    // Auto-apply last assistant message when flag is set
    $effect(() => {
        if (!autoApply) return;
        const last = messages.at(-1);
        if (!last || last.role !== 'assistant') return;
        const blocks = parseBlocks(last.content);
        const jsBlock = blocks.find(b => b.type === 'code' && isJsBlock(b.lang));
        if (jsBlock) {
            const hint = getNewFileHint(jsBlock.text);
            onApply?.(hint ? hint.code : jsBlock.text);
        }
    });

    $effect(() => {
        getAiConfig().then(c => {
            aiConfig = c;
            // Use localStorage value if present, else fall back to config model
            if (c.configured && !selectedModel) selectedModel = c.model;
        }).catch(() => {});
    });

    // Persist model selection across page reloads
    $effect(() => {
        if (selectedModel) localStorage.setItem('she:selectedModel', selectedModel);
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
        }, 10000);
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

    // Re-fetch system prompt size when context or current script changes
    $effect(() => {
        const ctx = context;
        const script = activeScript;
        const files = uploadedFiles;
        if (!configured) return;
        getAiPrompt({ context: ctx, currentScript: script ?? null, extraFiles: files.length > 0 ? files : undefined })
            .then(res => { promptBytes = new TextEncoder().encode(res.prompt).length; })
            .catch(() => {});
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

    const CODE_COLLAPSE_LINES = 15;

    function shouldCollapse(code: string): boolean {
        return code.split('\n').length > CODE_COLLAPSE_LINES;
    }

    function toggleBlock(id: string): void {
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

    function renderMd(text: string): string {
        return marked.parse(text) as string;
    }

    /** Like parseBlocks but handles an unclosed code fence at the end of streamed content. */
    function parseBlocksStreaming(content: string): Block[] {
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
        const tail = normalized.slice(last);
        const openFence = tail.match(/```(\w*)\n([\s\S]*)$/);
        if (openFence) {
            if (openFence.index! > 0) blocks.push({ type: 'text', text: tail.slice(0, openFence.index) });
            blocks.push({ type: 'code', lang: openFence[1] || 'text', text: openFence[2] });
        } else if (tail) {
            blocks.push({ type: 'text', text: tail });
        }
        return blocks;
    }

    function copyCode(text: string) {
        navigator.clipboard.writeText(text).catch(() => {});
    }

    function applyCode(text: string, setAutoApply = false) {
        if (setAutoApply && currentScript) autoApplyScript = currentScript.path;
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
        if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
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

    // ── File context helpers ─────────────────────────────────────────────────

    function fileExt(name: string): string {
        const m = name.match(/\.([^.]+)$/);
        return m ? m[1].toUpperCase() : '?';
    }

    function fileBadgeContent(ext: string): string {
        switch (ext) {
            case 'SH': case 'BASH': return '$';
            case 'MD': case 'MARKDOWN': return '\u21d3';
            case 'JSON': case 'JSONC': return '{}';
            default: return ext;
        }
    }

    function removeUpload(idx: number) {
        uploadedFiles = uploadedFiles.filter((_, i) => i !== idx);
    }

    function openFilePicker() {
        fileInputEl.click();
    }

    async function handleFiles(files: FileList | null) {
        if (!files || files.length === 0) return;
        for (const file of Array.from(files)) {
            const content = await file.text();
            uploadedFiles = [...uploadedFiles, { name: file.name, content }];
        }
    }

    function handleFileInput(e: Event) {
        const target = e.target as HTMLInputElement;
        handleFiles(target.files);
        target.value = '';
    }

    function handleDrop(e: DragEvent) {
        e.preventDefault();
        isDragOver = false;
        handleFiles(e.dataTransfer?.files ?? null);
    }

    function handleDragOver(e: DragEvent) {
        if (e.dataTransfer?.types.includes('Files')) {
            e.preventDefault();
            isDragOver = true;
        }
    }

    function handleDragLeave() {
        isDragOver = false;
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

        abortController = new AbortController();
        toolEvents = [];

        try {
            await streamChatWithAI(
                { messages, currentScript: activeScript, context, modelOverride: selectedModel || undefined, extraFiles: uploadedFiles.length > 0 ? uploadedFiles : undefined },
                (token) => { streamingContent = (streamingContent ?? '') + token; },
                abortController.signal,
                (event) => { toolEvents = [...toolEvents, event]; },
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
                {#if configured}{aiConfig.provider} · {selectedModel || aiConfig.model}{:else}Not configured{/if}
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

        {#each messages as msg, msgIdx}
            <div class="message {msg.role}">
                {#if msg.role === 'user'}
                    <div class="msg-content user-text">{msg.content}</div>
                {:else}
                    {@const blocks = parseBlocks(msg.content)}
                    <div class="msg-content">
                        {#each blocks as block, blockIdx}
                            {#if block.type === 'text'}
                                <div class="text-block">{@html renderMd(block.text)}</div>
                            {:else}
                                {@const hint = isJsBlock(block.lang) ? getNewFileHint(block.text) : null}
                                {@const displayCode = hint ? hint.code : block.text}
                                {@const bid = `${msgIdx}:${blockIdx}`}
                                {@const collapsible = shouldCollapse(displayCode)}
                                {@const isExp = expandedBlocks.has(bid)}
                                <div class="code-block">
                                    <div class="code-header">
                                        <span class="code-lang">{hint ? `new: ${hint.filename}` : block.lang}</span>
                                        <div class="code-actions">
                                            <button onclick={() => copyCode(displayCode)}>Copy</button>
                                            {#if hint && onCreateFile}
                                                <button class="create-btn" onclick={() => onCreateFile!(hint.filename, hint.code)}>Save as new file…</button>
                                            {:else if isJsBlock(block.lang) && currentScript}
                                                <button class="apply-btn" onclick={() => applyCode(block.text)}>Apply</button>
                                                {#if autoApply}
                                                    <span class="auto-badge" title="Auto-applying AI code to this script in this session">auto ✓</span>
                                                {:else}
                                                    <button class="apply-auto-btn" onclick={() => applyCode(block.text, true)} title="Apply and always apply for this script in this session">always</button>
                                                {/if}
                                            {/if}
                                        </div>
                                    </div>
                                    <div class="code-body" class:collapsed={collapsible && !isExp}>
                                        <pre><code class="hljs">{@html highlightCode(displayCode, block.lang ?? '')}</code></pre>
                                        {#if collapsible}
                                            <button class="expand-btn" onclick={() => toggleBlock(bid)}>
                                                {isExp ? '▲ collapse' : '▼ expand'}
                                            </button>
                                        {/if}
                                    </div>
                                </div>
                            {/if}
                        {/each}
                    </div>
                {/if}
            </div>
        {/each}

        <!-- Tool call events (shown while loading or retained after response) -->
        {#if toolEvents.length > 0}
            <div class="tool-events">
                {#each toolEvents as ev}
                    {#if ev.type === 'tool_call'}
                        <div class="tool-event tool-call">
                            <span class="tool-icon">🔧</span>
                            <span class="tool-name">{ev.name.replace(/_/g, ' ')}</span>
                            {#if ev.args && Object.keys(ev.args).length > 0}
                                <span class="tool-args">{Object.entries(ev.args).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(', ')}</span>
                            {/if}
                        </div>
                    {:else}
                        <div class="tool-event tool-result">
                            <span class="tool-icon">✓</span>
                            <span class="tool-name">{ev.name.replace(/_/g, ' ')}</span>
                        </div>
                    {/if}
                {/each}
            </div>
        {/if}

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
                                <div class="code-header">
                                    <span class="code-lang">{block.lang}</span>
                                </div>
                                <pre><code class="hljs">{@html highlightCode(block.text, block.lang ?? '')}</code></pre>
                            </div>
                        {/if}
                    {/each}
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
            <input type="checkbox" bind:checked={ctxApiref} /><span class="checkmark"></span> API ref
        </label>
        <label title="Let the AI query MQTT state, sheDB documents and Matter devices on demand. Disables real-time streaming.">
            <input type="checkbox" bind:checked={ctxTools} /><span class="checkmark"></span> 🔧 Tools
        </label>
        <span class="req-size">{formatBytes(requestBytes)}</span>
    </div>

    <!-- File context chips -->
    <div class="files-row">
        {#if currentScript}
            {@const ext = fileExt(currentScript.path.split('/').pop() ?? currentScript.path)}
            <span class="file-chip" class:inactive={!includeCurrentScript}>
                <span class="badge badge-{ext.toLowerCase()}">{fileBadgeContent(ext)}</span>
                <span class="chip-name">{currentScript.path.split('/').pop()}</span>
                <button class="chip-remove"
                    onclick={() => (includeCurrentScript = !includeCurrentScript)}
                    title={includeCurrentScript ? 'Remove from context' : 'Re-add to context'}>
                    {includeCurrentScript ? '×' : '+'}
                </button>
            </span>
        {/if}
        {#each uploadedFiles as f, i}
            {@const ext = fileExt(f.name)}
            <span class="file-chip">
                <span class="badge badge-{ext.toLowerCase()}">{fileBadgeContent(ext)}</span>
                <span class="chip-name">{f.name}</span>
                <button class="chip-remove" onclick={() => removeUpload(i)} title="Remove from context">×</button>
            </span>
        {/each}
        <button class="add-file-btn" onclick={openFilePicker} title="Attach file to context">+</button>
        <input bind:this={fileInputEl} type="file" multiple class="file-input-hidden" onchange={handleFileInput} />
    </div>

    <!-- Input -->
    <div class="input-row" class:drag-over={isDragOver}
        ondragover={handleDragOver}
        ondragleave={handleDragLeave}
        ondrop={handleDrop}>
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
        word-break: break-word;
    }
    .text-block:first-child { margin-top: 0; }
    .text-block:last-child  { margin-bottom: 0; }
    /* Markdown rendered inside text blocks */
    :global(.text-block > *:first-child) { margin-top: 0; }
    :global(.text-block > *:last-child)  { margin-bottom: 0; }
    :global(.text-block p)          { margin: 4px 0; }
    :global(.text-block strong)     { font-weight: 600; color: var(--fg); }
    :global(.text-block em)         { font-style: italic; }
    :global(.text-block ul),
    :global(.text-block ol)         { margin: 4px 0; padding-left: 18px; }
    :global(.text-block li)         { margin: 2px 0; }
    :global(.text-block table)      { border-collapse: collapse; margin: 6px 0; width: 100%; }
    :global(.text-block th)         { background: var(--bg-widget); font-weight: 600; padding: 3px 8px; border: 1px solid var(--border-sub); text-align: left; }
    :global(.text-block td)         { padding: 3px 8px; border: 1px solid var(--border-sub); }
    :global(.text-block tr:nth-child(even) td) { background: rgba(255,255,255,0.03); }
    :global(.text-block code)       { background: var(--bg-widget); padding: 1px 4px; border-radius: 2px; font-family: 'Cascadia Code','Fira Code',monospace; font-size: 10px; color: var(--fg-brand); }
    :global(.text-block blockquote) { border-left: 3px solid var(--border); padding-left: 8px; color: var(--fg-muted); margin: 4px 0 4px 0; }
    :global(.text-block a)          { color: var(--fg-brand); }
    :global(.text-block hr)         { border: none; border-top: 1px solid var(--border-sub); margin: 8px 0; }

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
    .apply-auto-btn {
        color: var(--fg-muted) !important;
        border-style: dashed !important;
        font-size: 10px;
    }
    .apply-auto-btn:hover { color: var(--fg-brand) !important; border-color: var(--fg-brand) !important; }
    .auto-badge {
        font-size: 10px;
        color: var(--fg-brand);
        padding: 1px 4px;
        border: 1px solid var(--fg-brand);
        border-radius: 3px;
        opacity: 0.75;
    }
    .create-btn { color: var(--accent) !important; border-color: var(--accent) !important; font-weight: 600; }
    .create-btn:hover { background: rgba(var(--accent-rgb, 31,139,76), 0.15) !important; }

    /* Collapsible code body */
    .code-body { position: relative; }
    .code-body.collapsed pre {
        max-height: 200px;
        overflow: hidden;
        -webkit-mask-image: linear-gradient(to bottom, black 55%, transparent 100%);
        mask-image: linear-gradient(to bottom, black 55%, transparent 100%);
    }
    .expand-btn {
        display: block;
        width: 100%;
        background: none;
        border: none;
        border-top: 1px solid var(--border-sub);
        color: var(--fg-muted);
        font-size: 10px;
        padding: 3px 8px;
        cursor: pointer;
        text-align: center;
        letter-spacing: 0.03em;
    }
    .expand-btn:hover { background: var(--bg-hover); color: var(--fg); }

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

    /* highlight.js token colours (atom-one-dark palette, no background) */
    :global(code.hljs) { background: transparent; padding: 0; color: var(--fg-text); }
    :global(.hljs-comment),
    :global(.hljs-quote)              { color: #5c6370; font-style: italic; }
    :global(.hljs-keyword),
    :global(.hljs-selector-tag),
    :global(.hljs-addition)           { color: #c678dd; }
    :global(.hljs-number),
    :global(.hljs-literal),
    :global(.hljs-deletion)           { color: #d19a66; }
    :global(.hljs-string),
    :global(.hljs-doctag),
    :global(.hljs-regexp),
    :global(.hljs-meta .hljs-string)  { color: #98c379; }
    :global(.hljs-title),
    :global(.hljs-section),
    :global(.hljs-built_in)           { color: #61afef; }
    :global(.hljs-type),
    :global(.hljs-class .hljs-title)  { color: #e5c07b; }
    :global(.hljs-tag),
    :global(.hljs-name),
    :global(.hljs-attr),
    :global(.hljs-variable),
    :global(.hljs-template-variable),
    :global(.hljs-params)             { color: #e06c75; }
    :global(.hljs-meta),
    :global(.hljs-link)               { color: #56b6c2; }
    :global(.hljs-emphasis)           { font-style: italic; }
    :global(.hljs-strong)             { font-weight: bold; }

    .streaming .msg-content { opacity: 0.92; }


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
    .req-size {
        margin-left: auto;
        font-size: 10px;
        color: var(--fg-dim);
        white-space: nowrap;
        flex-shrink: 0;
    }

    /* ── File context chips ───────────────────────────────────────────────── */
    .files-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px;
        padding: 3px 8px;
        background: var(--bg-panel);
        border-top: 1px solid var(--border-sub);
        min-height: 28px;
        flex-shrink: 0;
    }
    .file-chip {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        background: var(--bg-app);
        border: 1px solid var(--border-sub);
        border-radius: 4px;
        padding: 1px 3px 1px 1px;
        font-size: 11px;
        color: var(--fg);
        max-width: 220px;
    }
    .file-chip.inactive { opacity: 0.4; }
    .chip-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 170px;
        line-height: 1.4;
    }
    .chip-remove {
        background: none;
        border: none;
        color: var(--fg-dim);
        cursor: pointer;
        padding: 0 2px;
        font-size: 13px;
        line-height: 1;
        flex-shrink: 0;
    }
    .chip-remove:hover { color: var(--fg); }
    .add-file-btn {
        background: none;
        border: 1px dashed var(--border-sub);
        border-radius: 4px;
        color: var(--fg-dim);
        cursor: pointer;
        width: 22px;
        height: 22px;
        font-size: 15px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        line-height: 1;
        padding: 0;
    }
    .add-file-btn:hover { color: var(--fg); border-color: var(--fg-dim); }
    .file-input-hidden { display: none; }
    .badge {
        display: inline-flex; align-items: center; justify-content: center;
        width: 20px; font-size: 8px; font-weight: 700; border-radius: 2px;
        background: transparent; color: #888; flex-shrink: 0;
    }
    .badge-js, .badge-mjs, .badge-cjs { color: #b89a00; font-size: 7px; letter-spacing: -0.5px; }
    .badge-ts, .badge-tsx             { color: #2068c0; }
    .badge-json, .badge-jsonc         { color: #c06010; }
    .badge-md, .badge-markdown        { color: #1888b0; font-size: 11px; }
    .badge-yaml, .badge-yml           { color: #7a28a8; }
    .badge-css, .badge-html           { color: #1570a8; }
    .badge-sh, .badge-bash            { color: #0a8840; }

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
    .input-row.drag-over .textarea-wrap { background: var(--accent); }
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
        animation: shimmer 12s linear infinite;
    }

    /* ── Tool events ─────────────────────────────────────────────────────── */
    .tool-events {
        padding: 4px 12px 2px;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .tool-event {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 11px;
        font-family: monospace;
        color: var(--fg-dim);
        opacity: 0.8;
    }
    .tool-event.tool-call { color: var(--fg-brand); opacity: 1; }
    .tool-event.tool-result { color: var(--fg-muted); }
    .tool-icon { font-style: normal; }
    .tool-args {
        color: var(--fg-dim);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 300px;
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
