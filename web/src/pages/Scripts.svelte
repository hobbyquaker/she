<script lang="ts">
    import { onMount, onDestroy, tick, untrack } from 'svelte';
    import * as monaco from 'monaco-editor';
    import { resolveMonacoTheme } from '../lib/theme.js';
    import {
        listScriptsTree,
        readScript,
        writeScript,
        deleteScript,
        renameScript,
        createScriptDir,
        commitFile,
        commitFiles,
        commitAll,
        gitStatus,
        gitPush,
        getGitLog,
        getGitFileAtCommit,
        getConfig,
        restartDaemon,
        searchScripts,
        type GitStatus,
        type GitCommit,
        type TreeEntry,
        type AiExtraFile,
        type SearchMatch,
        type SearchResult,
    } from '../lib/api.js';
    import { subscribeLog, subscribeWs, subscribeRuntime, getHistoryEntries, type LogEntry } from '../lib/ws.js';
    import { fmtLogTs as fmt } from '../lib/format.js';
    import { splitLogMessage, scriptResolver, collectScriptPaths } from '../lib/log-links.js';
    import ConfirmDialog from '../lib/ConfirmDialog.svelte';
    import InputDialog from '../lib/InputDialog.svelte';
    import CommitDialog from '../lib/CommitDialog.svelte';
    import { resolveCommitMode, defaultCommitMessage, type CommitMode } from '../lib/git-commit.js';
    import { generateCommitMessage, getAiConfig } from '../lib/api.js';
    import Chat from './Chat.svelte';
    import { registerCompletionProviders } from '../lib/completions.js';
    import { createDock, type Dock, type DockOpenOptions } from '../lib/dock.js';
    import '../lib/dockview.css';
    import RuntimeHandlers from '../lib/RuntimeHandlers.svelte';
    import { runtimeAction, type RuntimeSnapshot } from '../lib/api.js';

    interface Tab {
        path: string;
        dirty: boolean;
        savedContent: string;
        model: monaco.editor.ITextModel | null;
        logEntries: LogEntry[];
        /** the tab is on screen but its content is still on the wire (slow link, VPN) */
        loading?: boolean;
        /** the file changed on disk while this tab had unsaved edits (U12): the user chooses */
        changedOnDisk?: boolean;
    }

    let tree = $state<TreeEntry[]>([]);
    /** key = entry.path → true if expanded */
    let expandedDirs = $state<Record<string, boolean>>({});
    /** currently selected directory (for "new file inside") */
    let selectedDir = $state<string | null>(null);
    /** context menu state */
    let ctxMenu = $state<{ x: number; y: number; entry: TreeEntry } | null>(null);
    /** drag source path */
    let dragSrc = $state<string | null>(null);
    /** folder path being dragged over */
    let dragOver = $state<string | null>(null);
    let tabs = $state<Tab[]>([]);
    let activeTab = $state<string | null>(null);
    let saving = $state(false);
    let error = $state('');
    let dropdownOpen = $state(false);
    // which dock panels are open — mirrored from the dock, so the toolbar toggles show it
    let logOpen = $state(true);
    let runtimeOpen = $state(false);
    let filesOpen = $state(true);
    let gitInfo = $state<GitStatus | null>(null);
    /** what happens after a save, rename or delete: nothing, the commit dialog, or an automatic commit */
    let gitCommitMode = $state<CommitMode>('off');
    /** auto mode: the AI writes the message (the daemon falls back to the default) */
    let gitCommitAi   = $state(false);
    let gitAutoPush   = $state(false);
    /** an AI provider is configured — the "Generate with AI" buttons are enabled */
    let aiConfigured  = $state(false);
    const AI_HINT = 'No AI provider configured — add one on the Config page';
    let unsubGit: (() => void) | null = null;

    // Git history panel
    let historyEntry = $state<TreeEntry | null>(null);
    let historyCommits = $state<GitCommit[]>([]);
    let historyLoading = $state(false);
    let historyLimit = $state(30);
    // History diff overlay
    let historyDiffContainer = $state<HTMLDivElement | undefined>(undefined);
    let historyDiffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
    let historyDiffOrigModel: monaco.editor.ITextModel | null = null;
    let historyDiffModModel: monaco.editor.ITextModel | null = null;
    let historyDiffOpen = $state(false);
    let historyDiffHash = $state('');
    let historyDiffBinary = $state(false);
    let logEl = $state<HTMLDivElement | undefined>(undefined);

    let scriptErrors = $state<Set<string>>(new Set());
    const scriptHadError = new Set<string>();
    let scriptRunning = $state<Set<string>>(new Set());
    let chatExtraFiles = $state<AiExtraFile[]>([]);

    // --- Search panel ---
    let searchOpen      = $state(false);
    let searchMode      = $state<'text' | 'files'>('text');
    let searchQuery     = $state('');
    let searchCaseSensitive = $state(false);
    let searchRegex     = $state(false);
    let searchReplaceOpen = $state(false);
    let searchReplaceText = $state('');
    let searchResults   = $state<SearchResult[]>([]);
    let searchFileResults = $state<string[]>([]);
    let searchTruncated = $state(false);
    let searchLoading   = $state(false);
    let searchError     = $state('');
    let searchInputEl   = $state<HTMLInputElement | undefined>(undefined);
    let replaceItems    = $state<{ path: string; checked: boolean; original: string; replaced: string; changes: number }[]>([]);
    let replaceConfirmOpen = $state(false);
    let replaceLoading  = $state(false);
    let _searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Tab bar scroll state
    let tabBarEl = $state<HTMLDivElement | undefined>(undefined);
    let canScrollLeft  = $state(false);
    let canScrollRight = $state(false);
    let _tabBarResizeObserver: ResizeObserver | null = null;

    function updateTabScrollBounds() {
        if (!tabBarEl) return;
        canScrollLeft  = tabBarEl.scrollLeft > 0;
        canScrollRight = tabBarEl.scrollLeft + tabBarEl.clientWidth < tabBarEl.scrollWidth - 1;
    }

    function scrollTabBar(dir: -1 | 1) {
        tabBarEl?.scrollBy({ left: dir * 200, behavior: 'smooth' });
    }

    // ---- Search helpers ----
    function openSearch(mode: 'text' | 'files' = 'text') {
        searchOpen = true;
        searchMode = mode;
        tick().then(() => searchInputEl?.focus());
    }
    function closeSearch() {
        searchOpen = false;
        searchQuery = '';
        searchResults = [];
        searchFileResults = [];
        searchTruncated = false;
        searchError = '';
        searchReplaceOpen = false;
        replaceConfirmOpen = false;
    }
    function triggerSearch() {
        if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
        _searchDebounceTimer = setTimeout(runSearch, 300);
    }
    async function runSearch() {
        const q = searchQuery.trim();
        if (!q) { searchResults = []; searchFileResults = []; searchTruncated = false; searchError = ''; return; }
        searchLoading = true; searchError = '';
        try {
            if (searchMode === 'files') {
                const r = await searchScripts(q, { mode: 'files' }) as { results: string[]; truncated: boolean };
                searchFileResults = r.results;
                searchTruncated = r.truncated;
            } else {
                const r = await searchScripts(q, { regex: searchRegex, caseSensitive: searchCaseSensitive }) as { results: SearchResult[]; truncated: boolean };
                searchResults = r.results;
                searchTruncated = r.truncated;
            }
        } catch (e: unknown) {
            searchError = (e as Error).message || 'Search failed';
        } finally {
            searchLoading = false;
        }
    }
    async function jumpToMatch(path: string, match: SearchMatch) {
        await openTab(path);
        if (editor) {
            editor.revealLineInCenter(match.line);
            editor.setPosition({ lineNumber: match.line, column: match.col });
            editor.focus();
        }
    }
    function _escRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    async function buildReplacePreview() {
        if (!searchQuery.trim() || !searchResults.length) return;
        replaceLoading = true;
        const items: typeof replaceItems = [];
        const flags = 'g' + (searchCaseSensitive ? '' : 'i');
        for (const result of searchResults) {
            try {
                const f = await readScript(result.path);
                const re = searchRegex ? new RegExp(searchQuery, flags) : new RegExp(_escRegex(searchQuery), flags);
                const replaced = f.content.replace(re, searchReplaceText);
                if (replaced !== f.content)
                    items.push({ path: result.path, checked: true, original: f.content, replaced, changes: result.matches.length });
            } catch { /* skip */ }
        }
        replaceItems = items;
        replaceLoading = false;
        replaceConfirmOpen = true;
    }
    async function applyReplace() {
        for (const item of replaceItems.filter(i => i.checked)) {
            try {
                await writeScript(item.path, item.replaced);
                const tab = tabs.find(t => t.path === item.path);
                if (tab?.model) { tab.model.setValue(item.replaced); tab.savedContent = item.replaced; tab.dirty = false; }
            } catch { /* skip */ }
        }
        replaceConfirmOpen = false;
        await runSearch();
    }
    function onLayoutKeydown(e: KeyboardEvent) {
        if (e.ctrlKey && e.shiftKey && e.key === 'F') {
            e.preventDefault();
            searchOpen && searchMode === 'text' ? closeSearch() : openSearch('text');
        }
    }

    $effect(() => {
        if (!tabBarEl) return;
        _tabBarResizeObserver?.disconnect();
        _tabBarResizeObserver = new ResizeObserver(updateTabScrollBounds);
        _tabBarResizeObserver.observe(tabBarEl);
        updateTabScrollBounds();
    });

    // Script log panel filters
    let logFilterLevel = $state<'all' | 'debug' | 'info' | 'warn' | 'error'>('all');
    let logFilterText = $state('');
    let logFilterRegex = $state(false);
    let logAutoscroll = $state(true);
    const LOG_LEVELS = ['all', 'debug', 'info', 'warn', 'error'] as const;
    const LOG_LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const;

    // Script locations in log messages (stack frames etc.) link into the editor
    const resolveScript = $derived(scriptResolver(collectScriptPaths(tree)));

    /** Open a script and optionally place the cursor on a line (e.g. from a stack frame). */
    async function openAtLine(path: string, line?: number, column?: number) {
        await openTab(path);
        if (line && editor) {
            editor.revealLineInCenter(line);
            editor.setPosition({ lineNumber: line, column: column ?? 1 });
            editor.focus();
        }
    }

    function logEntryVisible(e: LogEntry): boolean {
        if (logFilterLevel !== 'all' && LOG_LEVEL_ORDER[e.level] < LOG_LEVEL_ORDER[logFilterLevel]) return false;
        if (!logFilterText) return true;
        if (logFilterRegex) {
            try { return new RegExp(logFilterText, 'i').test(e.msg); } catch { /* invalid regex */ }
        }
        return e.msg.toLowerCase().includes(logFilterText.toLowerCase());
    }
    let libTip = $state<{ x: number; y: number } | null>(null);
    function showLibTip(e: MouseEvent) {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        libTip = { x: rect.left, y: rect.top };
    }
    function hideLibTip() { libTip = null; }

    let editorContainer: HTMLDivElement;
    let editor: monaco.editor.IStandaloneCodeEditor;
    let emptyModel: monaco.editor.ITextModel;
    let suppressChange = false;
    let unsubLog: (() => void) | null = null;
    let unsubRunning: (() => void) | null = null;
    let unsubChanged: (() => void) | null = null;
    let _treeLoaded = false;
    // reactive on purpose: the persistence effects below return early until mount, and an effect that read no
    // signal before returning would never run again - with a plain boolean the chat and tab state were never saved
    let _mounted = $state(false);

    // Chat panel & diff view
    let chatOpen = $state(false);
    let proposedCode = $state<string | null>(null);
    let autoAccept = $state(false);
    let acceptDropOpen = $state(false);
    let diffEditorContainer = $state<HTMLDivElement | undefined>(undefined);
    let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
    let proposedOriginalModel: monaco.editor.ITextModel | null = null;
    let proposedModifiedModel: monaco.editor.ITextModel | null = null;

    // Resizable panels
    let historyPanelHeight = $state(parseInt(localStorage.getItem('she-scripts-history-height') ?? '220', 10));
    let historyPanelResizing = false, historyPanelResizeStartY = 0, historyPanelResizeStartH = 0;

    // ── Docking ──────────────────────────────────────────────────────────────
    // The editor is the fixed centre; Files, Log, Runtime and the AI chat are panels that dock around
    // it (bottom, left, right, split, tabbed), remembered per browser. The panels' markup is rendered
    // into a hidden parking container below and adopted by the dock when a panel is open.
    // v2: the stored format changed (layout plus the panels' remembered groups); older entries are dropped
    const DOCK_KEY = 'she-scripts-dock-layout-v2';
    let dock: Dock | null = null;
    let dockEl = $state<HTMLDivElement | undefined>(undefined);
    let hostFiles: HTMLElement, hostEditor: HTMLElement, hostLog: HTMLElement, hostRuntime: HTMLElement, hostChat: HTMLElement;
    const PANEL_TITLE: Record<string, string> = { files: 'Files', log: 'Log', runtime: 'Runtime', chat: 'AI assistant' };
    /**
     * The default layout, and where a panel that was never placed goes when it is opened from the
     * toolbar: Files in a narrow column on the left, the AI assistant in a third of the width on the
     * right (both full height), Log and Runtime side by side in the bottom quarter under the editor.
     */
    function panelHome(id: string): DockOpenOptions {
        const w = dockEl?.clientWidth || 1600, h = dockEl?.clientHeight || 900;
        switch (id) {
            case 'files': return { position: { direction: 'left' }, width: 215 };
            case 'chat': return { position: { direction: 'right' }, width: Math.round(w / 3) };
            case 'log': return { position: { referencePanel: 'editor', direction: 'below' }, height: Math.round(h / 4) };
            case 'runtime': return { position: { referencePanel: 'log', direction: 'right', fallback: 'below' }, height: Math.round(h / 4) };
            default: return {};
        }
    }
    function syncDockState(open: Set<string>) {
        filesOpen = open.has('files');
        logOpen = open.has('log');
        runtimeOpen = open.has('runtime');
        chatOpen = open.has('chat');
    }
    function togglePanel(id: string) {
        if (!dock) return;
        if (dock.isOpen(id)) dock.close(id);
        else dock.open(id, panelHome(id));
    }
    function toggleTitle(id: string, open: boolean) {
        return `${open ? 'Hide' : 'Show'} ${PANEL_TITLE[id]} panel`;
    }
    function createEditorDock() {
        if (!dockEl || dock) return;
        try { localStorage.removeItem('she-scripts-dock-layout'); } catch { /* the previous format's entry, if any */ }
        dock = createDock(dockEl, {
            panels: [
                { id: 'editor', title: 'Editor', element: hostEditor },
                { id: 'files', title: 'Files', element: hostFiles },
                { id: 'log', title: 'Log', element: hostLog },
                { id: 'runtime', title: 'Runtime', element: hostRuntime },
                { id: 'chat', title: 'AI assistant', element: hostChat },
            ],
            centre: 'editor',
            storageKey: DOCK_KEY,
            defaultLayout: (open) => {
                open('files', panelHome('files'));
                open('chat', { ...panelHome('chat'), inactive: true });
                open('log', panelHome('log'));
                open('runtime', { ...panelHome('runtime'), inactive: true });
            },
            onChange: syncDockState,
        });
        // for the browser console and UI automation (screenshots): the dock's API
        (window as any).__sheDock = dock;
    }
    onDestroy(() => dock?.dispose());

    // ── Runtime panel: the open script's handlers and timers, live, with actions ──
    let runtimeSnap = $state<RuntimeSnapshot | null>(null);
    let runtimeNow = $state(Date.now());
    let runtimeError = $state('');
    const runtimeRows = $derived.by(() => {
        if (!runtimeSnap || !activeTab) return [];
        const sc = runtimeSnap.scripts.find((x) => x.label === activeTab);
        return sc ? sc.handlers : [];
    });
    const runtimeLive = $derived(runtimeSnap !== null && Date.now() - runtimeSnap.ts < 5000);
    $effect(() => {
        if (!_mounted || !active || !runtimeOpen || !activeTab) {
            runtimeSnap = null;
            return;
        }
        const label = activeTab;
        const unsub = subscribeRuntime(label, (msg) => {
            runtimeSnap = msg as RuntimeSnapshot;
        });
        const tick = setInterval(() => { runtimeNow = Date.now(); }, 200);
        return () => {
            unsub();
            clearInterval(tick);
        };
    });
    async function doRuntimeAction(id: string, action: 'cancel' | 'run') {
        runtimeError = '';
        try {
            await runtimeAction(id, action);
        } catch (e: any) {
            runtimeError = e?.message ?? String(e);
        }
    }

    const chatScript = $derived(
        activeTab && currentTab
            ? { path: activeTab, content: currentTab.model?.getValue() ?? currentTab.savedContent }
            : null,
    );

    /** Set of file paths (relative to scriptDir) that have uncommitted git changes. */
    const gitChangedPaths = $derived(new Set(gitInfo?.changes.map(c => c.file) ?? []));

    /** Set of directory paths that contain at least one uncommitted-changed file. */
    const gitChangedDirs = $derived.by(() => {
        const dirs = new Set<string>();
        for (const file of gitChangedPaths) {
            const parts = file.split('/');
            for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
        }
        return dirs;
    });

    // ── Uncommitted-changes popup ─────────────────────────────────────────────
    let changesPopupOpen = $state(false);
    let pushPopupOpen = $state(false);
    let commitAllMsg     = $state('');
    let commitAllBusy    = $state(false);
    let commitAllErr     = $state('');
    let commitAllAiBusy  = $state(false);
    let checkedFiles     = $state<Set<string>>(new Set());

    /** the ✨ button of the uncommitted-changes popup: the AI writes the message for the checked files */
    async function generateCommitAllMsg() {
        if (!gitInfo || checkedFiles.size === 0 || commitAllAiBusy) return;
        commitAllAiBusy = true;
        commitAllErr = '';
        try {
            const selected = gitInfo.changes.filter(c => checkedFiles.has(c.file)).map(c => c.file);
            const all = selected.length === gitInfo.changes.length;
            const r = await generateCommitMessage(all ? [] : selected);
            commitAllMsg = r.message.split('\n')[0]; // the popup's single-line field takes the summary line
        } catch (e: any) {
            commitAllErr = e.message;
        } finally {
            commitAllAiBusy = false;
        }
    }

    async function commitAllChanges() {
        if (!commitAllMsg.trim() || checkedFiles.size === 0) return;
        commitAllBusy = true;
        commitAllErr  = '';
        try {
            const selected = gitInfo!.changes.filter(c => checkedFiles.has(c.file)).map(c => c.file);
            if (selected.length === gitInfo!.changes.length) {
                await commitAll(commitAllMsg.trim());
            } else {
                await commitFiles(selected, commitAllMsg.trim());
            }
            if (gitAutoPush) try { await gitPush(); } catch { /* ignore */ }
            commitAllMsg = '';
            await loadGitStatus();
            if (!gitInfo?.changes.length) {
                changesPopupOpen = false;
            } else {
                checkedFiles = new Set(gitInfo!.changes.map(c => c.file));
            }
        } catch (e: any) {
            commitAllErr = e.message;
        } finally {
            commitAllBusy = false;
        }
    }

    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean }): Promise<boolean> };
    let inputDialog: { show(msg: string, opts?: { placeholder?: string; confirm?: string; initial?: string }): Promise<string | null> };
    let commitDialog: {
        show(opts: { title?: string; files?: string[]; initial: string; confirm?: string; aiAvailable: boolean; aiHint?: string; generate?: () => Promise<string> }): Promise<string | null>;
    };

    let currentTab = $derived(tabs.find(t => t.path === activeTab) ?? null);

    const TABS_KEY   = 'she-tabs';
    const ACTIVE_KEY = 'she-active-tab';

    let {
        active = true,
        sub = null,
        onsub,
    }: { active?: boolean; sub?: string | null; onsub?: (s: string) => void } = $props();

    // ── URL: #/scripts/<path of the file in the editor> ────────────────────────
    // The address bar names the open script, and a link to one opens it. Same shape as the
    // sub-tab routing of the other pages, but the sub is a whole path here.
    let routeReady = $state(false); // the restore in onMount decides the first path, not an effect
    let seenSub: string | null | undefined = undefined;
    $effect(() => {
        const want = sub;
        if (!routeReady || want === seenSub) return;
        seenSub = want;
        // a deep link, the back button, an edited address: open what the url names
        if (want && want !== untrack(() => activeTab)) untrack(() => { openTab(want); });
    });
    // ...and the other way round: whatever ends up in the editor names itself in the url
    $effect(() => {
        const path = activeTab;
        if (!routeReady || !active) return;
        seenSub = path ?? '';
        onsub?.(path ?? '');
    });


    $effect(() => {
        if (!_mounted) return;
        localStorage.setItem(TABS_KEY, JSON.stringify(tabs.map(t => t.path)));
        if (activeTab) localStorage.setItem(ACTIVE_KEY, activeTab);
        else           localStorage.removeItem(ACTIVE_KEY);
    });

    // Re-layout Monaco when the Scripts panel becomes visible after being hidden, and when the browser
    // tab comes back from the background (App dispatches she:visible after forcing a repaint).
    $effect(() => {
        if (active && editor) editor.layout();
    });
    $effect(() => {
        const relayout = () => { if (active && editor) editor.layout(); };
        window.addEventListener('she:visible', relayout);
        return () => window.removeEventListener('she:visible', relayout);
    });

    // Monaco sandbox type stubs for she API autocomplete
    const she_dts = `
/** the MQTT API of one broker: she.mqtt is the primary, she.mqtt('<name>') an additional broker */
interface SheMqtt {
    /** null on the primary, the broker's name on she.mqtt('<name>') */
    readonly broker: string | null;
    /** opts: change, retain, shift, random, condition — and debounce / maxWait / throttle (SECONDS), perTopic, name, flushOnUnload */
    sub(
        topic: string | string[],
        opts?: { change?: boolean; retain?: boolean; shift?: number; random?: number; condition?: string | ((...args: any[]) => any); debounce?: number; maxWait?: number; throttle?: number; perTopic?: boolean; name?: string; flushOnUnload?: boolean } | string | ((...args: any[]) => any),
        cb?: (topic: string, val: any, obj: any, prev: any, msg: any) => void,
    ): void;
    /** opts.changed: publish only when the payload differs from this script's last publish to the topic;
     *  opts.status: a deliberate publish to a <prefix>/status/… topic — no status-topic warning for this call */
    pub(topic: string | string[], payload: any, opts?: { qos?: number; retain?: boolean; changed?: boolean; status?: boolean }): void;
    get(topic: string): any;
    getProp(topic: string, ...prop: string[]): any;
    link(source: string | string[], target: string | string[], value?: any): void;
    age(topic: string): number;
    or(srcs: string[], target: string | ((topic: string | null, val: 0 | 1) => void)): void;
    and(srcs: string[], target: string | ((topic: string | null, val: 0 | 1) => void)): void;
    max(srcs: string[], target: string | ((topic: string | null, val: number) => void)): void;
    min(srcs: string[], target: string | ((topic: string | null, val: number) => void)): void;
    timer(src: string | string[], ms: number, target: string | ((topic: string | null, val: 0 | 1) => void)): void;
    /**
     * Publish a command and wait for the device's status to confirm it.
     * Resolves with { val, ms, tries } (already: true when the status was at the target before);
     * rejects with an Error { reason: 'timeout' | 'offline' | 'superseded' | 'unloaded' | 'cancelled', topic, payload, tries }.
     * The confirm topic is derived: <inst>/set/<path> → <inst>/status/<path>, zigbee2mqtt <base>/<dev>/set → <base>/<dev>; else pass opts.confirm.
     */
    command(topic: string, payload: string | number | boolean | object, opts?: {
        /** the status topic that shows the effect (derived when omitted) */
        confirm?: string;
        /** the field of a JSON status payload to look at */
        path?: string;
        /** the value to expect (default: the payload), or a function */
        expect?: any | ((val: any) => boolean);
        /** for numbers */
        tolerance?: number;
        /** seconds per attempt (default 5) */
        timeout?: number;
        /** further attempts after a timeout (default 0) */
        retries?: number;
        /** no warning in the log when the command fails */
        quiet?: boolean;
    }): Promise<{ val: any; ms: number; tries: number; already?: boolean }>;
}
declare const she: {
    log(...args: any[]): void;
    info(...args: any[]): void;
    debug(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
    now(): number;
    /** The sandbox's setTimeout / clearTimeout (tracked, cleared on reload); a delay that is not a number is logged with the script name. */
    setTimeout(fn: (...args: any[]) => void, ms?: number, ...args: any[]): any;
    clearTimeout(id: any): void;
    /** A restartable one-shot timer (milliseconds), created idle: restart() arms it, another restart() starts over, cancel() disarms. */
    timeout(ms: number, cb: () => void, opts?: { name?: string }): { restart(ms?: number): any; start(ms?: number): any; cancel(): any; pending(): boolean; remaining(): number };
    /** Bundle calls: fn runs with the last call's arguments after 'wait' ms of quiet, at the latest after opts.maxWait ms. Milliseconds. */
    debounce: {
        <F extends (...args: any[]) => any>(fn: F, wait: number, opts?: { maxWait?: number; leading?: boolean; trailing?: boolean; flushOnUnload?: boolean; name?: string }): F & { cancel(): void; flush(): any; pending(): boolean };
        /** One debounce state per key — the first argument, or opts.key(...args). */
        keyed<F extends (...args: any[]) => any>(fn: F, wait: number, opts?: { maxWait?: number; leading?: boolean; trailing?: boolean; flushOnUnload?: boolean; name?: string; key?: (...args: Parameters<F>) => any }): F & { cancel(key?: any): void; flush(key?: any): any; pending(key?: any): boolean; keys(): any[] };
    };
    /** Rate-limit calls: the first at once, then at most once per 'wait' ms (with the last arguments). Milliseconds. */
    throttle: {
        <F extends (...args: any[]) => any>(fn: F, wait: number, opts?: { leading?: boolean; trailing?: boolean; name?: string }): F & { cancel(): void; flush(): any; pending(): boolean };
        keyed<F extends (...args: any[]) => any>(fn: F, wait: number, opts?: { leading?: boolean; trailing?: boolean; name?: string; key?: (...args: Parameters<F>) => any }): F & { cancel(key?: any): void; flush(key?: any): any; pending(key?: any): boolean; keys(): any[] };
    };
    /** Call fn(attempt) until it succeeds; waits opts.delay ms (× opts.backoff per failure) between attempts; after the last failure onFail(err, tries) or a rejection. */
    retry<T>(fn: (attempt: number) => T | Promise<T>, opts?: { tries?: number; delay?: number; backoff?: number; onFail?: (err: any, tries: number) => any; name?: string }): Promise<T>;
    /** Schedule with a cron string, Date, node-schedule literal, array of any of those,
     *  or a suncalc event name ('sunrise', 'sunset', 'dawn', 'dusk', …) for solar scheduling.
     *  opts.shift (seconds) offsets solar events; opts.random adds a random delay. */
    schedule(pattern: string | Date | object | (string | Date | object)[], opts?: { shift?: number; random?: number }, cb?: () => void): void;
    /** Time windows, wall-clock instants, holidays and formatting in the daemon's zone, DST-safe. ts: ms, Date or ISO string, default now. */
    time: {
        /** The IANA zone, the locale and the holiday region in use. */
        zone: string;
        locale: string;
        holidays: string | null;
        now(): number;
        /** Is ts in the window? from/to: 'HH:mm' or a sun event with offset ('sunset-30m', 'dawn+1h'); from inclusive, to exclusive; a 'to' before 'from' crosses midnight. */
        between(from: string | number | Date, to: string | number | Date, ts?: number | Date | string): boolean;
        /** The instant (ms) of 'HH:mm' or a sun event ('sunset-30m') on the day of ts; NaN when the sun event does not occur that day. */
        at(time: string | number | Date, ts?: number | Date | string): number;
        startOfDay(ts?: number | Date | string): number;
        endOfDay(ts?: number | Date | string): number;
        /** The same wall-clock time n days later — 23, 24 or 25 hours on the DST days. */
        addDays(ts: number | Date | string, days: number): number;
        /** The wall clock of the zone: month 1–12, weekday 0 = Sunday, offset in minutes. */
        parts(ts?: number | Date | string): { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number; weekday: number; offset: number; zone: string };
        isWeekend(ts?: number | Date | string): boolean;
        /** A public holiday of the configured region (config: holidays, holidaysExtra); false, with one warning, when none is configured. */
        isHoliday(ts?: number | Date | string): boolean;
        holiday(ts?: number | Date | string): string | null;
        isWorkday(ts?: number | Date | string): boolean;
        /** Tokens: YYYY YY M MM MMM MMMM D DD H HH m mm s ss SSS dd ddd Z, [literal]. Default 'YYYY-MM-DD HH:mm:ss'. */
        format(ts: number | Date | string, pattern?: string): string;
        /** ISO 8601 with the zone's offset: '2026-10-25T02:41:00+02:00'. */
        iso(ts?: number | Date | string): string;
        /** b - a in milliseconds, the real difference. */
        duration(a: number | Date | string, b: number | Date | string): number;
        /** '2 h 40 min'; long: '2 Stunden 40 Minuten'; parts: how many units. */
        humanize(ms: number, opts?: { parts?: number; long?: boolean }): string;
    };
    /**
     * The primary broker's MQTT API — and, called with a name, the same API for an additional broker
     * configured under "brokers": she.mqtt('shed').sub('tele/#', cb). An unknown name throws at load.
     */
    mqtt: SheMqtt & { (broker: string): SheMqtt };
    http: {
        fetch(url: string, opts?: RequestInit): Promise<any>;
        sub(path: string, callback: (body: any, req: { params: any; query: any; headers: any }) => any): void;
    };
    api: {
        get(path: string, handler: (req: any) => any): void;
        post(path: string, handler: (req: any, body: any) => any): void;
        put(path: string, handler: (req: any, body: any) => any): void;
        delete(path: string, handler: (req: any) => any): void;
    };
    db: {
        get(id: string): any;
        set(id: string, doc: object): void;
        extend(id: string, partial: object): void;
        delete(id: string): void;
        prop(id: string, method: 'set' | 'create' | 'del', prop: string, val?: any): void;
        sub(pattern: string, callback: (id: string, doc: any) => void): void;
        query(filter: string | null, mapFn: Function, reduceFn?: Function): any[];
    };
    matter: {
        sub(nodeId: string, endpointId: number, cluster: string, attr: string, cb: (val: any, old: any) => void): number;
        unsub(listenerId: number): void;
        get(nodeId: string, endpointId: number, cluster: string, attr: string): Promise<any>;
        send(nodeId: string, endpointId: number, cluster: string, command: string, args?: object): Promise<any>;
        on(nodeId: string, endpointId: number, cluster: string, event: string, cb: (val: any) => void): number;
    };
    influx: {
        query(fluxQuery: string): Promise<any[]>;
        write(measurement: string, fields: object, tags?: object, timestamp?: number | Date): Promise<void>;
        getLast(topic: string, n: number): Promise<Array<{ ts: number; val: any }>>;
        getRange(topic: string, from: number | string | Date, to: number | string | Date): Promise<Array<{ ts: number; val: any }>>;
    };
    elastic: {
        search(index: string, query: object): Promise<{ hits: any[]; total: number }>;
        get(index: string, id: string): Promise<object | null>;
        index(index: string, doc: object, id?: string): Promise<{ id: string }>;
        find(index: string, field: string, text: string, size?: number): Promise<any[]>;
    };
};
`;

    function onBeforeUnload(e: BeforeUnloadEvent) {
        if (tabs.some(t => t.dirty)) e.preventDefault();
    }

    onMount(async () => {
        window.addEventListener('beforeunload', onBeforeUnload);
        // the dock first: Monaco below is created inside the editor panel once it is in place
        createEditorDock();

        monaco.languages.typescript.javascriptDefaults.addExtraLib(she_dts, 'she-api.d.ts');
        monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
            target: monaco.languages.typescript.ScriptTarget.ES2022,
            allowNonTsExtensions: true,
            checkJs: true,
        });
        monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
            noSyntaxValidation: false,
            noSemanticValidation: true, // semantic checks are noisy for plain JS scripts
        });

        registerCompletionProviders();

        emptyModel = monaco.editor.createModel('', 'javascript');
        editor = monaco.editor.create(editorContainer, {
            model: emptyModel,
            theme: resolveMonacoTheme(),
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
        });

        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => {
            searchOpen && searchMode === 'text' ? closeSearch() : openSearch('text');
        });

        // Use a native keydown listener on Monaco's DOM node for Ctrl-S so
        // that the browser's built-in "Save Page" action is reliably prevented.
        // editor.addCommand() alone is insufficient — the browser can fire its
        // native handler before Monaco's keybinding system processes the event.
        editor.getDomNode()?.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                save();
            }
        });

        editor.onDidChangeModelContent(() => {
            if (suppressChange) return;
            const tab = tabs.find(t => t.path === activeTab);
            if (tab) tab.dirty = editor.getValue() !== tab.savedContent;
            if (syntaxCheckTimer) clearTimeout(syntaxCheckTimer);
            syntaxCheckTimer = setTimeout(runSyntaxCheck, 600);
        });

        unsubLog = subscribeLog((entry) => {
            // Match log label: "some/path/script.js: message" (may be just "script.js:" at root)
            const match = entry.msg.match(/^([^:\n]+\.js):\s/);
            if (!match) return;
            const relPath = match[1];

            // Update error marker state (affects file tree icons)
            if (entry.level === 'error') {
                scriptHadError.add(relPath);
                if (!scriptErrors.has(relPath)) {
                    scriptErrors = new Set([...scriptErrors, relPath]);
                }
            } else if (scriptHadError.has(relPath)) {
                scriptHadError.delete(relPath);
                const next = new Set(scriptErrors);
                next.delete(relPath);
                scriptErrors = next;
            }

            // Route log entry to the matching open tab
            const tab = tabs.find(t => t.path === relPath);
            if (tab) {
                tab.logEntries = [...tab.logEntries.slice(-199), entry];
                if (tab.path === activeTab && logOpen && logEl && logAutoscroll) {
                    tick().then(() => { if (logEl) logEl.scrollTop = logEl.scrollHeight; });
                }
            }
        });

        unsubRunning = subscribeWs('script:running', (msg) => {
            const p = msg.path as string;
            if (msg.running) {
                scriptRunning = new Set([...scriptRunning, p]);
            } else {
                const s = new Set(scriptRunning);
                s.delete(p);
                scriptRunning = s;
            }
        });

        // a file written from outside this tab — an applied AI draft, another browser tab, an editor on disk —
        // is re-read into its open tab (U12); a tab with unsaved edits keeps them and gets a marker instead
        unsubChanged = subscribeWs('script:changed', (msg) => { void reloadTabFromDisk(msg.path as string, false); });
        // the daemon committed a rename or delete by itself (auto mode)
        unsubGit = subscribeWs('git:changed', () => { void loadGitStatus(); });

        await loadTree();
        loadGitStatus();
        try {
            const cfg = await getConfig() as Record<string, unknown>;
            const commit = resolveCommitMode(cfg);
            gitCommitMode = commit.mode;
            gitCommitAi   = commit.ai;
            gitAutoPush   = commit.autoPush;
        } catch { /* best effort */ }
        try { aiConfigured = (await getAiConfig()).configured; } catch { /* best effort */ }

        try {
            const status = await getDaemonStatus();
            scriptRunning = new Set(status.runningScripts ?? []);
        } catch { /* best effort */ }

        const savedPaths = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]') as string[];
        const savedActive = localStorage.getItem(ACTIVE_KEY);
        for (const p of savedPaths) {
            await openTabInternal(p, false);
        }
        // a url naming a script wins over the tab that was open last
        const deepLink = sub;
        const restoreActive = savedActive && tabs.some(t => t.path === savedActive)
            ? savedActive : (tabs[0]?.path ?? null);
        if (deepLink) await openTabInternal(deepLink, true);
        else if (restoreActive) await switchTab(restoreActive);
        seenSub = deepLink;
        _mounted = true;
        routeReady = true;

        // Keep all Monaco editors in sync with the app theme
        const syncMonacoTheme = () => monaco.editor.setTheme(resolveMonacoTheme());
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        window.addEventListener('she:theme-changed', syncMonacoTheme);
        mq.addEventListener('change', syncMonacoTheme);

        // Open a script requested by another page (e.g. clicking a script
        // location in the Logs tab). All pages stay mounted, so this is live
        // even while the Scripts tab is hidden. Optional line/column place the
        // Monaco cursor (e.g. stack-frame locations).
        const onOpenScript = (e: Event) => {
            const { path, line, column } = (e as CustomEvent).detail ?? {};
            if (typeof path === 'string' && path) openAtLine(path, typeof line === 'number' ? line : undefined, typeof column === 'number' ? column : undefined);
        };
        window.addEventListener('she:open-script', onOpenScript);

        return () => {
            window.removeEventListener('she:theme-changed', syncMonacoTheme);
            mq.removeEventListener('change', syncMonacoTheme);
            window.removeEventListener('she:open-script', onOpenScript);
        };
    });

    onDestroy(() => {
        window.removeEventListener('beforeunload', onBeforeUnload);
        _tabBarResizeObserver?.disconnect();
        if (syntaxCheckTimer) clearTimeout(syntaxCheckTimer);
        unsubLog?.();
        unsubRunning?.();
        unsubChanged?.();
        unsubGit?.();
        for (const tab of tabs) tab.model?.dispose();
        emptyModel?.dispose();
        editor?.dispose();
    });

    async function loadTree() {
        try {
            tree = await listScriptsTree();
            if (!_treeLoaded) {
                _treeLoaded = true;
                // Auto-expand all directories on first load
                const dirs: Record<string, boolean> = {};
                function collectDirs(entries: TreeEntry[]) {
                    for (const e of entries) {
                        if (e.type === 'dir') { dirs[e.path] = true; if (e.children) collectDirs(e.children); }
                    }
                }
                collectDirs(tree);
                expandedDirs = dirs;
            }
            error = '';
        } catch (e: any) { error = e.message; }
    }

    function toggleDir(path: string) { expandedDirs[path] = !expandedDirs[path]; }

    function badgeContent(ext: string): string {
        switch (ext) {
            case 'SH': case 'BASH': return '$';
            case 'MD': case 'MARKDOWN': return '\u21d3';
            case 'JSON': case 'JSONC': return '{}';
            default: return ext;
        }
    }

    async function toggleLib(dirPath: string, makeLib: boolean) {
        try {
            const marker = `${dirPath}/.shelib`;
            if (makeLib) await writeScript(marker, '');
            else await deleteScript(marker);
            await loadTree();
            // a deleted marker is committed by the daemon in auto mode, a written one by the editor
            await afterScriptChange([marker], makeLib ? `lib ${dirPath}` : `unlib ${dirPath}`, !makeLib);
        } catch (e: any) { error = e.message; }
    }

    async function toggleDisabled(entryPath: string, makeDisabled: boolean) {
        const name = entryPath.split('/').pop()!;
        const dir  = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/')) : '';
        const marker = dir ? `${dir}/.shedisable-${name}` : `.shedisable-${name}`;
        try {
            if (makeDisabled) await writeScript(marker, '');
            else await deleteScript(marker);
            await loadTree();
            await afterScriptChange([marker], makeDisabled ? `disable ${entryPath}` : `enable ${entryPath}`, !makeDisabled);
        } catch (e: any) { error = e.message; }
    }

    /** Opens in flight — a second click on the same file while the first is still loading must not
     *  create (and dispose) a second model; both callers wait for the same promise. */
    const opening = new Map<string, Promise<void>>();

    function modelUri(path: string) {
        return monaco.Uri.parse(`file:///she-scripts/${encodeURIComponent(path)}`);
    }

    /** A model for the path: reuse the one Monaco already has for the URI (never dispose a model that may be in use). */
    function modelFor(path: string, content: string) {
        const uri = modelUri(path);
        const existing = monaco.editor.getModel(uri);
        if (existing && !existing.isDisposed()) {
            if (existing.getValue() !== content) existing.setValue(content);
            return existing;
        }
        return monaco.editor.createModel(content, langFromPath(path), uri);
    }

    async function openTabInternal(path: string, andSwitch = true) {
        if (tabs.some(t => t.path === path)) {
            if (andSwitch) await switchTab(path);
            return;
        }
        const inflight = opening.get(path);
        if (inflight) {
            await inflight;
            if (andSwitch) await switchTab(path);
            return;
        }
        const job = openTabLoad(path, andSwitch);
        opening.set(path, job);
        try {
            await job;
        } finally {
            opening.delete(path);
        }
    }

    async function openTabLoad(path: string, andSwitch: boolean) {
        // The tab appears at once and shows a spinner — over a slow link the read below
        // takes seconds, and a click that seems to do nothing reads as a hung UI.
        tabs = [...tabs, { path, dirty: false, savedContent: '', model: null, logEntries: [], loading: true }];
        if (andSwitch) await switchTab(path);
        try {
            const { content } = await readScript(path);
            if (!tabs.some((t) => t.path === path)) return; // closed while it was loading
            const model = modelFor(path, content);
            tabs = tabs.map((t) => (t.path === path ? { ...t, savedContent: content, model, loading: false } : t));
            if (activeTab === path) await switchTab(path);
            // Log history is a second round trip — the editor must not wait for it.
            loadTabLogHistory(path);
        } catch (e: any) {
            error = (e as Error).message;
            const wasActive = activeTab === path;
            tabs = tabs.filter((t) => t.path !== path);
            if (wasActive) {
                activeTab = tabs[tabs.length - 1]?.path ?? null;
                if (activeTab) await switchTab(activeTab);
                else editor.setModel(emptyModel);
            }
        }
    }

    /** Seed log history for a script from the daemon's jsonl log file. */
    async function loadTabLogHistory(path: string) {
        try {
            const history = await getHistoryEntries();
            const logEntries = history.filter((e) => {
                const m = e.msg.match(/^([^:\n]+\.js):\s/);
                return m && m[1] === path;
            });
            if (logEntries.length === 0) return;
            tabs = tabs.map((t) => (t.path === path ? { ...t, logEntries } : t));
        } catch { /* best-effort */ }
    }

    async function openTab(path: string) { await openTabInternal(path, true); }

    /** why a tree entry that is a link out of the script directory neither runs nor opens */
    const OUTSIDE_TIP = 'a link that points outside the script directory — it is not loaded and cannot be opened here. Copy the file into the script directory to use it.';

    const activeTabLoading = $derived(!!tabs.find((t) => t.path === activeTab)?.loading);

    /**
     * Re-read a tab's file from disk (U12). A tab without edits takes the new content, keeping the cursor when it
     * is the active one; a tab whose editor already shows the file's content (the AI's Apply on the foreground
     * file) is just marked clean; a tab with other edits keeps them and shows the "changed on disk" bar until the
     * user reloads (force) or keeps its text.
     */
    async function reloadTabFromDisk(path: string, force: boolean) {
        const tab = tabs.find((t) => t.path === path);
        if (!tab || tab.loading || !tab.model) return;
        let content: string;
        try { content = (await readScript(path)).content; } catch { return; }
        const shown = tab.model.getValue();
        if (content === tab.savedContent && !force) return; // our own save coming back through the watcher
        if (content === shown) {
            tabs = tabs.map((t) => (t.path === path ? { ...t, savedContent: content, dirty: false, changedOnDisk: false } : t));
            return;
        }
        if (tab.dirty && !force) {
            tabs = tabs.map((t) => (t.path === path ? { ...t, changedOnDisk: true } : t));
            return;
        }
        const isActive = activeTab === path;
        const pos = isActive ? editor.getPosition() : null;
        tabs = tabs.map((t) => (t.path === path ? { ...t, savedContent: content, dirty: false, changedOnDisk: false } : t));
        tab.model.setValue(content);
        if (isActive && pos) editor.setPosition(pos);
    }

    async function switchTab(path: string) {
        const tab = tabs.find(t => t.path === path);
        if (!tab) return;
        if (!tab.model) {
            // still loading: show the tab as active with an empty editor behind the spinner
            if (!tab.loading) return;
            closeHistoryDiff();
            proposedCode = null;
            activeTab = path;
            suppressChange = true;
            editor.setModel(emptyModel);
            editor.updateOptions({ readOnly: true });
            suppressChange = false;
            await tick();
            tabBarEl?.querySelector<HTMLElement>(`[data-tab-path="${CSS.escape(path)}"]`)
                ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
            updateTabScrollBounds();
            return;
        }
        if (tab.model.isDisposed()) {
            // should not happen any more; recover instead of crashing the click handler
            tab.model = modelFor(path, tab.savedContent);
        }
        closeHistoryDiff();
        proposedCode = null;
        activeTab = path;
        suppressChange = true;
        editor.setModel(tab.model);
        editor.updateOptions({ readOnly: false });
        suppressChange = false;
        runSyntaxCheck();
        await tick();
        tabBarEl?.querySelector<HTMLElement>(`[data-tab-path="${CSS.escape(path)}"]`)
            ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
        updateTabScrollBounds();
    }

    async function closeTab(path: string) {
        const tab = tabs.find(t => t.path === path);
        if (!tab) return;
        if (tab.dirty) {
            if (!(await dialog.show(`Discard unsaved changes to ${path}?`, { confirm: 'Discard' }))) return;
        }
        const idx = tabs.findIndex(t => t.path === path);
        tab.model?.dispose();
        tabs = tabs.filter(t => t.path !== path);
        if (activeTab === path) {
            const next = tabs[idx] ?? tabs[idx - 1] ?? null;
            if (next) await switchTab(next.path);
            else { activeTab = null; editor.setModel(emptyModel); }
        }
    }

    async function loadGitStatus() {
        try { gitInfo = await gitStatus(); }
        catch { gitInfo = null; }
    }

    /** Commit files (or entire scriptDir when paths==='all') and optionally push. Silent on error. */
    async function gitAutoAction(paths: string[] | 'all', message: string, ai = false) {
        if (!gitInfo) return;
        try {
            if (paths === 'all') await commitAll(message, ai);
            else await commitFiles(paths, message, ai);
            if (gitAutoPush) try { await gitPush(); } catch { /* ignore push errors */ }
            await loadGitStatus();
        } catch { /* ignore — e.g. nothing to commit */ }
    }

    /**
     * After a save, rename or delete: what the commit mode says. auto — commit now (the daemon commits renames and
     * deletes itself and announces it, so `serverCommits` skips the editor's commit); ask — the commit dialog;
     * off — just refresh the status.
     */
    async function afterScriptChange(files: string[], message: string, serverCommits = false) {
        if (!gitInfo) return;
        if (gitCommitMode === 'auto') {
            if (!serverCommits) await gitAutoAction(files, message, gitCommitAi);
            return;
        }
        if (gitCommitMode === 'ask') { await askCommit(files); return; }
        loadGitStatus();
    }

    /**
     * The commit dialog for the uncommitted changes under the given paths (a path covers the files below it, so a
     * deleted or renamed folder works): the default message pre-filled, the AI on a button, Cancel leaves the
     * change uncommitted.
     */
    async function askCommit(paths: string[]) {
        await loadGitStatus();
        const changed = gitInfo?.changes.map(c => c.file).filter(f => paths.some(p => f === p || f.startsWith(p + '/'))) ?? [];
        if (!changed.length) return;
        const msg = await commitDialog.show({
            title: 'Commit changes',
            files: changed,
            initial: defaultCommitMessage(changed),
            aiAvailable: aiConfigured,
            aiHint: AI_HINT,
            generate: () => generateCommitMessage(changed).then(r => r.message),
        });
        if (!msg) return;
        try {
            await commitFiles(changed, msg);
            if (gitAutoPush) try { await gitPush(); } catch { /* ignore */ }
            await loadGitStatus();
        } catch (e: any) { error = 'Git: ' + (e as Error).message; }
    }

    /** Save the active tab; then the commit mode applies, unless the caller commits itself (`skipCommit`). */
    async function save(skipCommit = false) {
        if (!activeTab) return;
        const tab = tabs.find(t => t.path === activeTab);
        if (!tab || tab.loading) return; // the editor still holds the empty placeholder buffer
        saving = true;
        try {
            const value = editor.getValue();
            await writeScript(activeTab, value);
            tab.savedContent = value;
            tab.dirty = false;
            error = '';
            saving = false; // the save is done; a commit (and the AI's message) must not hold the button
            if (skipCommit) loadGitStatus();
            else await afterScriptChange([activeTab], `update ${activeTab}`);
        } catch (e: any) { error = (e as Error).message; }
        finally { saving = false; }
    }

    async function saveAndCommit() {
        if (!activeTab) return;
        const path = activeTab;
        await save(true);
        if (error) return;
        const msg = await commitDialog.show({
            title: `Commit ${path}`,
            initial: defaultCommitMessage([path]),
            aiAvailable: aiConfigured,
            aiHint: AI_HINT,
            generate: () => generateCommitMessage([path]).then(r => r.message),
        });
        if (!msg) return;
        try {
            await commitFile(path, msg);
            if (gitAutoPush) try { await gitPush(); } catch { /* ignore */ }
            loadGitStatus();
        } catch (e: any) { error = 'Git: ' + (e as Error).message; }
    }

    async function push() {
        dropdownOpen = false;
        try {
            await gitPush();
            await loadGitStatus();
            error = '';
        } catch (e: any) { error = 'Git push: ' + (e as Error).message; }
    }

    // ── Git history ───────────────────────────────────────────────────────────

    function fmtRelDate(isoDate: string): string {
        const ms = Date.now() - new Date(isoDate).getTime();
        const sec = Math.floor(ms / 1000);
        if (sec < 60) return 'just now';
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min}m ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr}h ago`;
        const d = Math.floor(hr / 24);
        if (d < 30) return `${d}d ago`;
        const mo = Math.floor(d / 30);
        if (mo < 12) return `${mo}mo ago`;
        return `${Math.floor(mo / 12)}y ago`;
    }

    async function showHistory(entry: TreeEntry) {
        closeCtxMenu();
        historyEntry = entry;
        historyCommits = [];
        historyLimit = 30;
        await loadHistory();
    }

    async function loadHistory() {
        if (!historyEntry) return;
        historyLoading = true;
        try {
            historyCommits = await getGitLog(historyEntry.path, historyLimit);
        } catch { /* ignore */ } finally {
            historyLoading = false;
        }
    }

    async function loadMoreHistory() {
        historyLimit += 30;
        await loadHistory();
    }

    function closeHistory() {
        historyEntry = null;
        historyCommits = [];
        closeHistoryDiff();
    }

    async function openHistoryDiff(commit: GitCommit) {
        if (!historyEntry) return;
        closeHistoryDiff();
        await openTab(historyEntry.path);

        let result: { content: string | null; binary: boolean };
        try {
            result = await getGitFileAtCommit(commit.hash, historyEntry.path);
        } catch { return; }

        historyDiffHash = commit.hash;
        historyDiffBinary = result.binary;
        historyDiffOpen = true;

        if (result.binary || result.content === null) return;

        // Get current content — prefer open tab, fall back to disk
        let currentContent = '';
        const tab = tabs.find(t => t.path === historyEntry!.path);
        if (tab?.model) {
            currentContent = tab.model.getValue();
        } else {
            try { currentContent = (await readScript(historyEntry.path)).content; } catch { /* ok */ }
        }

        await tick();
        if (!historyDiffContainer) return;

        const lang = langFromPath(historyEntry.path);
        historyDiffOrigModel = monaco.editor.createModel(result.content, lang);
        historyDiffModModel  = monaco.editor.createModel(currentContent, lang);
        historyDiffEditor = monaco.editor.createDiffEditor(historyDiffContainer, {
            theme: resolveMonacoTheme(),
            readOnly: true,
            renderSideBySide: true,
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
        });
        historyDiffEditor.setModel({ original: historyDiffOrigModel, modified: historyDiffModModel });
    }

    function closeHistoryDiff() {
        historyDiffOpen = false;
        historyDiffBinary = false;
        historyDiffEditor?.dispose();
        historyDiffEditor = null;
        historyDiffOrigModel?.dispose();
        historyDiffOrigModel = null;
        historyDiffModModel?.dispose();
        historyDiffModModel = null;
    }

    async function newFile() {
        const prefix = selectedDir ? `${selectedDir}/` : '';
        const name = await inputDialog.show('New script name:', {
            placeholder: prefix ? `${prefix}myscript.js` : 'myscript.js',
            initial: prefix,
            confirm: 'Create',
        });
        if (!name) return;
        const defaultContent = name.endsWith('.js') ? `/* global she */\n'use strict';\n\n` : '';
        await writeScript(name, defaultContent);
        await loadTree();
        await openTabInternal(name, true);
    }

    async function newFolder() {
        const prefix = selectedDir ? `${selectedDir}/` : '';
        const name = await inputDialog.show('New folder name:', {
            placeholder: prefix ? `${prefix}subfolder` : 'myfolder',
            initial: prefix,
            confirm: 'Create',
        });
        if (!name) return;
        await createScriptDir(name);
        expandedDirs[name] = true;
        await loadTree();
    }

    // ── Context menu ─────────────────────────────────────────────────────────
    function openCtxMenu(e: MouseEvent, entry: TreeEntry) {
        e.preventDefault();
        const MENU_W = 180;
        const MENU_H = 200;
        const x = Math.min(e.clientX, window.innerWidth  - MENU_W);
        const y = Math.min(e.clientY, window.innerHeight - MENU_H);
        ctxMenu = { x, y, entry };
    }

    function closeCtxMenu() { ctxMenu = null; }

    async function ctxNewFileHere(dirPath: string) {
        closeCtxMenu();
        selectedDir = dirPath;
        expandedDirs[dirPath] = true;
        await newFile();
    }

    async function ctxNewFolderHere(dirPath: string) {
        closeCtxMenu();
        selectedDir = dirPath;
        await newFolder();
    }

    async function ctxRename(entry: TreeEntry) {
        closeCtxMenu();
        const dir = entry.path.includes('/')
            ? entry.path.slice(0, entry.path.lastIndexOf('/') + 1)
            : '';
        const newBasename = await inputDialog.show(
            entry.type === 'dir' ? 'Rename folder:' : 'Rename script:',
            { initial: entry.name, placeholder: entry.name, confirm: 'Rename' },
        );
        if (!newBasename || newBasename === entry.name) return;
        const target = dir + newBasename;
        try {
            await renameScript(entry.path, target);
            // update any open tab
            const tab = tabs.find(t => t.path === entry.path);
            if (tab) {
                tab.path = target;
                if (activeTab === entry.path) activeTab = target;
            }
            await loadTree();
            await afterScriptChange([entry.path, target], `rename ${entry.path} → ${target}`, true);
        } catch (e: any) { error = e.message; }
    }

    function countDescendants(entry: TreeEntry): number {
        if (!entry.children) return 0;
        let n = 0;
        for (const child of entry.children) {
            n++;
            if (child.type === 'dir') n += countDescendants(child);
        }
        return n;
    }

    async function ctxDelete(entry: TreeEntry) {
        closeCtxMenu();
        let msg = `Delete ${entry.type === 'dir' ? 'folder' : 'file'} "${entry.path}"?`;
        if (entry.type === 'dir') {
            const count = countDescendants(entry);
            if (count > 0) msg += ` This will also delete ${count} item${count === 1 ? '' : 's'} inside.`;
        }
        if (!(await dialog.show(msg, { confirm: 'Delete', danger: true }))) return;
        if (entry.type === 'dir') {
            for (const tab of [...tabs]) {
                if (tab.path.startsWith(entry.path + '/')) await closeTab(tab.path);
            }
        } else {
            await closeTab(entry.path);
        }
        await deleteScript(entry.path);
        await loadTree();
        await afterScriptChange([entry.path], `delete ${entry.path}`, true);
    }

    async function ctxAddToAiContext(entry: TreeEntry) {
        closeCtxMenu();
        const { content } = await readScript(entry.path);
        if (!chatExtraFiles.some(f => f.name === entry.path)) {
            chatExtraFiles = [...chatExtraFiles, { name: entry.path, content }];
        }
        dock?.open('chat', panelHome('chat'));
    }

    // ── Drag-drop ─────────────────────────────────────────────────────────────
    function onDragStart(e: DragEvent, path: string) {
        dragSrc = path;
        e.dataTransfer?.setData('text/plain', path);
    }

    function onDragOver(e: DragEvent, dirPath: string) {
        e.preventDefault();
        if (dragSrc && (dragSrc === dirPath || dirPath.startsWith(dragSrc + '/'))) {
            e.dataTransfer && (e.dataTransfer.dropEffect = 'none');
            dragOver = null;
            return;
        }
        e.dataTransfer && (e.dataTransfer.dropEffect = 'move');
        dragOver = dirPath;
    }

    function onDragLeave() { dragOver = null; }

    async function onDrop(e: DragEvent, dirPath: string) {
        e.preventDefault();
        dragOver = null;

        // OS file/folder drop (kind==='file' distinguishes from internal text/plain drags)
        const fileItems = Array.from(e.dataTransfer?.items ?? []).filter(i => i.kind === 'file');
        if (fileItems.length > 0 && !dragSrc) {
            for (const item of fileItems) {
                const entry = item.webkitGetAsEntry?.();
                if (entry) await uploadEntry(entry, dirPath, true);
            }
            await loadTree();
            return;
        }

        // Internal drag: rename/move
        const src = dragSrc ?? e.dataTransfer?.getData('text/plain');
        dragSrc = null;
        if (!src || src === dirPath || dirPath.startsWith(src + '/')) return;
        const filename = src.split('/').pop()!;
        const target = dirPath ? `${dirPath}/${filename}` : filename;
        if (target === src) return;
        try {
            await renameScript(src, target);
            // Update open tabs (handles both single-file and folder moves)
            for (const tab of tabs) {
                if (tab.path === src) {
                    if (activeTab === src) activeTab = target;
                    tab.path = target;
                } else if (tab.path.startsWith(src + '/')) {
                    const newPath = target + tab.path.slice(src.length);
                    if (activeTab === tab.path) activeTab = newPath;
                    tab.path = newPath;
                }
            }
            await loadTree();
            await afterScriptChange([src, target], `rename ${src} → ${target}`, true);
        } catch (e: any) { error = e.message; }
    }

    /** Recursively upload a FileSystemEntry (file or directory) into targetDir. */
    async function uploadEntry(entry: FileSystemEntry, targetDir: string, topLevel: boolean) {
        if (entry.isFile) {
            const file = await new Promise<File>((resolve, reject) =>
                (entry as FileSystemFileEntry).file(resolve, reject));
            const text = await file.text();
            const dest = targetDir ? `${targetDir}/${entry.name}` : entry.name;
            await writeScript(dest, text);
            // Auto-disable top-level .js uploads for safety
            if (topLevel && entry.name.endsWith('.js')) {
                await toggleDisabled(dest, true);
            }
        } else if (entry.isDirectory) {
            const reader = (entry as FileSystemDirectoryEntry).createReader();
            let all: FileSystemEntry[] = [];
            let batch: FileSystemEntry[];
            do {
                batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
                    reader.readEntries(resolve, reject));
                all = [...all, ...batch];
            } while (batch.length > 0);
            for (const child of all) {
                await uploadEntry(child, targetDir ? `${targetDir}/${entry.name}` : entry.name, false);
            }
            // Auto-disable top-level dropped folders for safety
            if (topLevel) {
                const dest = targetDir ? `${targetDir}/${entry.name}` : entry.name;
                await toggleDisabled(dest, true);
            }
        }
    }

    async function saveAs() {
        const name = await inputDialog.show('Save as:', {
            placeholder: 'copy.js',
            initial: activeTab,
            confirm: 'Save',
        });
        if (!name) return;
        await writeScript(name, editor.getValue());
        await loadTree();
        await openTabInternal(name, true);
    }

    async function del() {
        if (!activeTab) return;
        if (!(await dialog.show(`Delete ${activeTab}?`, { confirm: 'Delete', danger: true }))) return;
        const toDelete = activeTab;
        await closeTab(toDelete);
        await deleteScript(toDelete);
        await loadTree();
        await afterScriptChange([toDelete], `delete ${toDelete}`, true);
    }

    function clearLog() { if (currentTab) currentTab.logEntries = []; }



    /** Map a file path to its Monaco language identifier. */
    function langFromPath(path: string): string {
        const ext = path.split('.').pop()?.toLowerCase() ?? '';
        const map: Record<string, string> = {
            js: 'javascript', mjs: 'javascript', cjs: 'javascript',
            ts: 'typescript', tsx: 'typescript',
            json: 'json', jsonc: 'json',
            md: 'markdown', markdown: 'markdown',
            yaml: 'yaml', yml: 'yaml',
            sh: 'shell', bash: 'shell',
            css: 'css', html: 'html', xml: 'xml',
            ini: 'ini', toml: 'ini',
        };
        return map[ext] ?? 'plaintext';
    }

    // ── Syntax checking ──────────────────────────────────────────────────
    let syntaxCheckTimer: ReturnType<typeof setTimeout> | null = null;

    async function runSyntaxCheck() {
        const tab = tabs.find(t => t.path === activeTab);
        if (!tab?.model) return;
        const model = tab.model;
        try {
            const getWorker = await monaco.languages.typescript.getJavaScriptWorker();
            const worker = await getWorker(model.uri);
            const diags = await worker.getSyntacticDiagnostics(model.uri.toString());
            const markers: monaco.editor.IMarkerData[] = diags.map(d => {
                const start = model.getPositionAt(d.start ?? 0);
                const end = model.getPositionAt((d.start ?? 0) + (d.length ?? 0));
                return {
                    severity: monaco.MarkerSeverity.Error,
                    startLineNumber: start.lineNumber,
                    startColumn: start.column,
                    endLineNumber: end.lineNumber,
                    endColumn: end.column,
                    message: typeof d.messageText === 'string' ? d.messageText : JSON.stringify(d.messageText),
                    source: 'she-syntax',
                };
            });
            monaco.editor.setModelMarkers(model, 'she-syntax', markers);

            // Reflect live syntax errors in the file tree
            if (activeTab) {
                if (markers.length > 0) {
                    scriptHadError.add(activeTab);
                    if (!scriptErrors.has(activeTab)) {
                        scriptErrors = new Set([...scriptErrors, activeTab]);
                    }
                } else if (scriptHadError.has(activeTab)) {
                    scriptHadError.delete(activeTab);
                    const next = new Set(scriptErrors);
                    next.delete(activeTab);
                    scriptErrors = next;
                }
            }
        } catch { /* worker not ready yet */ }
    }

    // ── Panel resize handlers ────────────────────────────────────────────────
    function onHistoryPanelResizeStart(e: MouseEvent) { historyPanelResizing = true; historyPanelResizeStartY = e.clientY; historyPanelResizeStartH = historyPanelHeight; e.preventDefault(); }

    function onGlobalMouseMove(e: MouseEvent) {
        if (historyPanelResizing) historyPanelHeight = Math.max(80, Math.min(600, historyPanelResizeStartH - (e.clientY - historyPanelResizeStartY)));
    }

    function onGlobalMouseUp() {
        if (historyPanelResizing) { historyPanelResizing = false; localStorage.setItem('she-scripts-history-height', String(historyPanelHeight)); }
    }

    function handleKeydown(e: KeyboardEvent) {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { dropdownOpen = false; ctxMenu = null; pushPopupOpen = false; }
    }

    // ── AI apply / diff view ──────────────────────────────────────────────────

    async function onCreateFile(suggestedName: string, code: string) {
        const name = await inputDialog.show('Save new script as:', {
            placeholder: 'myscript.js',
            initial: suggestedName,
            confirm: 'Create',
        });
        if (!name) return;
        try {
            await writeScript(name, code);
            await loadTree();
            await openTabInternal(name, true);
        } catch (e: any) { error = (e as Error).message; }
    }

    async function onApply(code: string) {
        if (autoAccept && activeTab) {
            // Skip the diff view and apply directly
            proposedCode = code;
            await acceptProposal();
            return;
        }
        proposedCode = code;
        await tick();
        if (!diffEditorContainer) return;

        // Dispose any previous diff editor
        proposedOriginalModel?.dispose();
        proposedModifiedModel?.dispose();
        diffEditor?.dispose();

        const originalContent = currentTab?.model?.getValue() ?? '';
        proposedOriginalModel = monaco.editor.createModel(originalContent, 'javascript');
        proposedModifiedModel = monaco.editor.createModel(code, 'javascript');

        diffEditor = monaco.editor.createDiffEditor(diffEditorContainer, {
            theme: resolveMonacoTheme(),
            readOnly: true,
            renderSideBySide: true,
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
        });
        diffEditor.setModel({
            original: proposedOriginalModel,
            modified: proposedModifiedModel,
        });
    }

    // Reset auto-accept when the active script changes
    $effect(() => {
        void activeTab;
        autoAccept = false;
        acceptDropOpen = false;
    });

    async function acceptProposal() {
        if (proposedCode === null || !activeTab) return;
        const code = proposedCode;
        proposedCode = null;

        // Apply to the Monaco model
        const tab = tabs.find(t => t.path === activeTab);
        if (tab?.model) {
            suppressChange = true;
            tab.model.setValue(code);
            suppressChange = false;
            tab.dirty = false;
            tab.savedContent = code;
        }

        // Write to disk
        try {
            await writeScript(activeTab, code);
            error = '';
            await afterScriptChange([activeTab], `update ${activeTab}`);
        } catch (e: any) { error = (e as Error).message; }

        cleanupDiffEditor();
    }

    function discardProposal() {
        proposedCode = null;
        cleanupDiffEditor();
    }

    function cleanupDiffEditor() {
        diffEditor?.dispose();
        diffEditor = null;
        proposedOriginalModel?.dispose();
        proposedOriginalModel = null;
        proposedModifiedModel?.dispose();
        proposedModifiedModel = null;
    }
</script>

<svelte:window onkeydown={handleKeydown} onmousemove={onGlobalMouseMove} onmouseup={onGlobalMouseUp} />
<ConfirmDialog bind:this={dialog} />
<InputDialog bind:this={inputDialog} />
<CommitDialog bind:this={commitDialog} />

<!-- context menu -->
{#if ctxMenu}
    <div
        class="ctx-backdrop"
        role="presentation"
        onclick={closeCtxMenu}
        oncontextmenu={(e) => { e.preventDefault(); closeCtxMenu(); }}
    ></div>
    <div class="ctx-menu" style:left="{ctxMenu.x}px" style:top="{ctxMenu.y}px">
        {#if ctxMenu.entry.type === 'dir'}
            <button onclick={() => ctxNewFileHere(ctxMenu!.entry.path)}>New file here</button>
            <button onclick={() => ctxNewFolderHere(ctxMenu!.entry.path)}>New subfolder here</button>
            <hr/>
            <button onclick={() => ctxRename(ctxMenu!.entry)}>Rename folder…</button>
            <button class="danger" onclick={() => ctxDelete(ctxMenu!.entry)}>Delete folder…</button>
        {:else}
            <button onclick={() => openTab(ctxMenu!.entry.path)}>Open</button>
            <button onclick={() => ctxRename(ctxMenu!.entry)}>Rename…</button>
            <button onclick={() => ctxAddToAiContext(ctxMenu!.entry)}>Add to AI context</button>
            {#if gitInfo}
            <button onclick={() => showHistory(ctxMenu!.entry)}>Show git history</button>
            {/if}
            <hr/>
            <button class="danger" onclick={() => ctxDelete(ctxMenu!.entry)}>Delete</button>
        {/if}
    </div>
{/if}

{#if libTip}
<div class="lib-tip-float" style:left="{libTip.x}px" style:top="{libTip.y - 4}px">
    Library directory — files here are not auto-loaded as scripts
</div>
{/if}

<div class="layout" onkeydown={onLayoutKeydown}>
    <div class="dock" bind:this={dockEl}></div>
    <!-- The panels are rendered here and adopted by the dock while they are open -->
    <div class="dock-parking" aria-hidden="true">
    <aside bind:this={hostFiles}>
        <div class="toolbar">
            <button onclick={newFile} title="New script">+ File</button>
            <button onclick={newFolder} title="New folder">+ Folder</button>
            <button class="search-toggle" class:active={searchOpen} onclick={() => searchOpen ? closeSearch() : openSearch('text')} title="Find in files / Find files (Ctrl+Shift+F)">&#x2315;</button>
            <button onclick={loadTree} title="Refresh" class="refresh">↻</button>
        </div>
        {#if error}<div class="err">{error}</div>{/if}

        {#if searchOpen}
        <div class="search-panel">
            <div class="search-mode-bar">
                <button class:active={searchMode==='text'} onclick={() => { searchMode='text'; triggerSearch(); }}>Text</button>
                <button class:active={searchMode==='files'} onclick={() => { searchMode='files'; triggerSearch(); }}>Files</button>
                <button class="search-close-btn" onclick={closeSearch} title="Close">×</button>
            </div>
            <div class="search-input-row">
                <input bind:value={searchQuery} bind:this={searchInputEl}
                    placeholder={searchMode==='text' ? 'Find in files…' : 'Find files…'}
                    oninput={triggerSearch}
                    onkeydown={(e) => e.key==='Escape' && closeSearch()} />
                {#if searchMode === 'text'}
                <button class:active={searchCaseSensitive} title="Case sensitive" onclick={() => { searchCaseSensitive=!searchCaseSensitive; triggerSearch(); }}>Aa</button>
                <button class:active={searchRegex} title="Use regex" onclick={() => { searchRegex=!searchRegex; triggerSearch(); }}>.*</button>
                <button class:active={searchReplaceOpen} title="Replace" onclick={() => searchReplaceOpen=!searchReplaceOpen}>⇄</button>
                {/if}
            </div>
            {#if searchMode === 'text' && searchReplaceOpen}
            <div class="search-input-row">
                <input bind:value={searchReplaceText} placeholder="Replace with…" />
                <button onclick={buildReplacePreview}
                    disabled={!searchQuery.trim() || searchResults.length===0 || replaceLoading}>
                    {replaceLoading ? '…' : 'Preview'}
                </button>
            </div>
            {/if}
            <div class="search-results">
                {#if searchLoading}
                <div class="search-status">Searching…</div>
                {:else if searchError}
                <div class="search-status search-err">{searchError}</div>
                {:else if searchQuery.trim()}
                    {#if searchMode === 'text'}
                        {#if searchResults.length === 0}
                        <div class="search-status">No results.</div>
                        {:else}
                        {#if searchTruncated}<div class="search-status search-trunc">Showing first 500 matches.</div>{/if}
                        {#each searchResults as result}
                        <div class="search-file-group">
                            <button class="search-file-btn" onclick={() => openTab(result.path)}>
                                <span class="search-fname">{result.path}</span>
                                <span class="search-fcount">{result.matches.length}</span>
                            </button>
                            {#each result.matches as match}
                            <button class="search-match-row" onclick={() => jumpToMatch(result.path, match)}>
                                <span class="search-lnum">{match.line}</span>
                                <span class="search-preview">{match.preview}</span>
                            </button>
                            {/each}
                        </div>
                        {/each}
                        {/if}
                    {:else}
                        {#if searchFileResults.length === 0}
                        <div class="search-status">No files found.</div>
                        {:else}
                        {#if searchTruncated}<div class="search-status search-trunc">Showing first 200 results.</div>{/if}
                        {#each searchFileResults as fp}
                        <button class="search-match-row search-file-result" onclick={() => openTab(fp)}>
                            <span class="search-preview">{fp}</span>
                        </button>
                        {/each}
                        {/if}
                    {/if}
                {/if}
            </div>
            {#if replaceConfirmOpen}
            <div class="replace-confirm">
                <div class="replace-confirm-hdr">
                    <span>Replace in {replaceItems.filter(i=>i.checked).length} file(s)</span>
                    <div class="replace-confirm-btns">
                        <button onclick={applyReplace} disabled={replaceItems.filter(i=>i.checked).length===0}>Apply</button>
                        <button onclick={() => replaceConfirmOpen=false}>Cancel</button>
                    </div>
                </div>
                <div class="replace-confirm-list">
                    {#each replaceItems as item}
                    <label class="replace-item">
                        <input type="checkbox" bind:checked={item.checked} />
                        <span class="replace-checkmark"></span>
                        <span class="replace-item-path">{item.path}</span>
                        <span class="replace-item-n">{item.changes}×</span>
                    </label>
                    {/each}
                </div>
            </div>
            {/if}
        </div>
        {/if}

        {#snippet treeEntry(entry: TreeEntry, parentDisabled: boolean = false)}
            {#if entry.type === 'dir'}
                <li class="tree-dir">
                    <div
                        class="dir-row"
                        class:dir-selected={selectedDir === entry.path}
                        class:drag-target={dragOver === entry.path}
                        role="treeitem"
                        aria-selected={selectedDir === entry.path}
                        tabindex="-1"
                        draggable="true"
                        ondragstart={(e) => onDragStart(e, entry.path)}
                        ondragover={(e) => onDragOver(e, entry.path)}
                        ondragleave={onDragLeave}
                        ondrop={(e) => onDrop(e, entry.path)}
                        oncontextmenu={(e) => openCtxMenu(e, entry)}
                    >
                        <button class="chevron" class:open={expandedDirs[entry.path]} onclick={() => toggleDir(entry.path)}>
                            ›
                        </button>
                        <span
                            class="dir-name"
                            class:lib={entry.lib}
                            role="button"
                            tabindex="0"
                            onclick={() => { selectedDir = entry.path; expandedDirs[entry.path] = true; }}
                            onkeydown={(e) => e.key === 'Enter' && (selectedDir = entry.path)}
                        >{entry.name}</span>
                        {#if gitChangedPaths.has(entry.path) || gitChangedDirs.has(entry.path)}<span class="git-mod" title="Uncommitted changes">M</span>{/if}
                        <label class="lib-label" title="Library directory — files here are not auto-loaded as scripts" onmouseenter={showLibTip} onmouseleave={hideLibTip}>
                            <input type="checkbox" checked={entry.lib} onchange={() => toggleLib(entry.path, !entry.lib)} />
                            <span class="lib-checkmark"></span>
                            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H3V3z"/><line x1="3" y1="12" x2="13" y2="12"/><line x1="6" y1="3" x2="6" y2="12"/></svg>
                        </label>
                        <label class="dis-label" title="Disable — scripts in this folder will not be executed">
                            <input type="checkbox" checked={entry.disabled} onchange={() => toggleDisabled(entry.path, !entry.disabled)} />
                            <span class="dis-checkmark"></span>
                            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><line x1="3.8" y1="12.2" x2="12.2" y2="3.8"/></svg>
                        </label>
                    </div>
                    {#if expandedDirs[entry.path] && entry.children}
                        <ul class="tree-children">
                            {#each entry.children as child (child.path)}
                                {@render treeEntry(child, entry.disabled || parentDisabled)}
                            {/each}
                        </ul>
                    {/if}
                </li>
            {:else}
                {@const hasErr = scriptErrors.has(entry.path)}
                {@const isGitMod = gitChangedPaths.has(entry.path)}
                {@const isDirty = tabs.some(t => t.path === entry.path && t.dirty)}
                {@const ext = entry.outside && !entry.name.includes('.') ? '' : (entry.name.split('.').pop() ?? 'txt').toUpperCase()}
                {@const isJs = entry.name.endsWith('.js')}
                <li
                    class="tree-file"
                    class:active={tabs.some(t => t.path === entry.path)}
                    class:active-tab={entry.path === activeTab}
                    draggable="true"
                    ondragstart={(e) => onDragStart(e, entry.path)}
                    oncontextmenu={(e) => openCtxMenu(e, entry)}
                >
                    <div class="file-row">
                        <button
                            class:lib={entry.lib}
                            class:dis={entry.disabled}
                            class:err={hasErr}
                            class:outside={entry.outside}
                            title={entry.outside ? OUTSIDE_TIP : undefined}
                            onclick={() => (entry.outside ? (error = `${entry.path}: ${OUTSIDE_TIP}`) : openTab(entry.path))}
                        >
                            <span class="badge badge-{ext.toLowerCase()}" class:badge-shelib={entry.lib}>{badgeContent(ext)}</span>
                            <span class="fname">{entry.name}</span>
                            {#if entry.outside}
                                <span class="outside-mark" aria-label="outside, not loaded">
                                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 9.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.8.8"/><path d="M9.5 6.5a3 3 0 0 0-4.2 0L3 8.8A3 3 0 0 0 7.2 13l.8-.8"/></svg>
                                    outside, not loaded
                                </span>
                            {/if}
                            {#if isGitMod}<span class="git-mod" title="Uncommitted changes">M</span>{/if}{#if isDirty}<span class="dirty-dot">●</span>{/if}
                            {#if isJs && scriptRunning.has(entry.path) && !hasErr}<span class="run-dot" title="Running">●</span>{/if}
                            {#if hasErr}<span class="err-dot">●</span>{/if}
                        </button>
                        {#if isJs && !entry.outside}
                            <label class="dis-label" class:dis-locked={parentDisabled} title={parentDisabled ? 'Disabled by parent directory' : 'Disable — this script will not be executed'}>
                                <input type="checkbox" checked={entry.disabled} disabled={parentDisabled} onchange={() => toggleDisabled(entry.path, !entry.disabled)} />
                                <span class="dis-checkmark"></span>
                                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><line x1="3.8" y1="12.2" x2="12.2" y2="3.8"/></svg>
                            </label>
                        {:else}
                            <span class="dis-spacer"></span>
                        {/if}
                    </div>
                </li>
            {/if}
        {/snippet}

        <ul class="tree">
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <li
                class="tree-root-drop"
                class:drag-target={dragOver === ''}
                role="presentation"
                ondragover={(e) => onDragOver(e, '')}
                ondragleave={onDragLeave}
                ondrop={(e) => onDrop(e, '')}
            ></li>
            {#each tree as entry (entry.path)}
                {@render treeEntry(entry)}
            {/each}
        </ul>

        {#if historyEntry}
        <div class="history-panel" style:height="{historyPanelHeight}px">
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div class="history-resize-handle" role="separator" onmousedown={onHistoryPanelResizeStart}></div>
            <div class="history-hdr">
                <span class="history-title" title={historyEntry.path}>History: {historyEntry.name}</span>
                <button class="history-close" onclick={closeHistory}>✕</button>
            </div>
            <div class="history-body">
                {#if historyLoading && historyCommits.length === 0}
                    <div class="history-empty">Loading…</div>
                {:else if historyCommits.length === 0}
                    <div class="history-empty">No commits found.</div>
                {:else}
                    {#each historyCommits as commit (commit.hash)}
                        <button class="history-row" onclick={() => openHistoryDiff(commit)}>
                            <span class="history-subject">{commit.subject}</span>
                            <span class="history-meta">{commit.hash.slice(0, 7)} · {fmtRelDate(commit.date)}</span>
                        </button>
                    {/each}
                    {#if historyCommits.length >= historyLimit}
                    <button class="history-load-more" onclick={loadMoreHistory} disabled={historyLoading}>
                        {historyLoading ? 'Loading…' : 'Load more'}
                    </button>
                    {/if}
                {/if}
            </div>
        </div>
        {/if}
    </aside>

    <div class="editor-area" bind:this={hostEditor}>
        {#if tabs.length > 0}
            <div class="tab-bar-wrap">
                <button class="tab-scroll-btn" onclick={() => scrollTabBar(-1)} disabled={!canScrollLeft} aria-label="Scroll tabs left">‹</button>
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <div class="tab-bar" bind:this={tabBarEl}
                    onscroll={updateTabScrollBounds}
                    onwheel={(e) => { e.preventDefault(); tabBarEl!.scrollLeft += e.deltaY; updateTabScrollBounds(); }}
                    role="tablist"
                >
                    {#each tabs as tab (tab.path)}
                        <div
                            class="tab"
                            class:active={tab.path === activeTab}
                            data-tab-path={tab.path}
                            onclick={() => switchTab(tab.path)}
                            role="tab"
                            tabindex="0"
                            onkeydown={(e) => e.key === 'Enter' && switchTab(tab.path)}
                        >
                            <span class="tab-label">{tab.path.split('/').pop()}</span>
                            {#if tab.loading}<span class="tab-spinner" title="Loading…"></span>
                            {:else if tab.changedOnDisk}<span class="tab-changed" title="Changed on disk while this tab has unsaved edits">⟳</span>
                            {:else if tab.dirty}<span class="tab-dirty">●</span>{/if}
                            <button class="tab-close" title="Close" onclick={(e) => { e.stopPropagation(); closeTab(tab.path); }}>×</button>
                        </div>
                    {/each}
                </div>
                <button class="tab-scroll-btn" onclick={() => scrollTabBar(1)} disabled={!canScrollRight} aria-label="Scroll tabs right">›</button>
            </div>
        {/if}

        <div class="editor-toolbar">
            <span class="filename">{activeTab ?? 'No file selected'}</span>
            {#if gitInfo}
                <span class="git-status">
                    <span class="git-branch" title="Branch: {gitInfo.branch}">⎇ {gitInfo.branch}</span>
                    {#if gitInfo.changes.length > 0}
                        <div class="changes-wrap">
                            <button
                                class="git-changes"
                                title="{gitInfo.changes.length} uncommitted change(s) — click to view"
                                onclick={() => { if (!changesPopupOpen) checkedFiles = new Set(gitInfo!.changes.map(c => c.file)); changesPopupOpen = !changesPopupOpen; commitAllErr = ''; }}
                            >✎{gitInfo.changes.length}</button>
                            {#if changesPopupOpen}
                            <div class="changes-backdrop" role="presentation" onclick={() => changesPopupOpen = false}></div>
                            <div class="changes-popup">
                                <div class="changes-popup-hdr">Uncommitted changes</div>
                                <ul class="changes-list">
                                    {#each gitInfo.changes as c}
                                        <li class="changes-item">
                                            <label class="changes-cb-wrap">
                                            <input
                                                type="checkbox"
                                                class="changes-check"
                                                checked={checkedFiles.has(c.file)}
                                                onchange={() => {
                                                    const s = new Set(checkedFiles);
                                                    if (s.has(c.file)) s.delete(c.file); else s.add(c.file);
                                                    checkedFiles = s;
                                                }}
                                            />
                                            <span class="changes-checkmark"></span>
                                            </label>
                                            <span class="changes-status">{c.status}</span>
                                            <span class="changes-file">{c.file}</span>
                                        </li>
                                    {/each}
                                </ul>
                                <div class="changes-commit-row">
                                    <input
                                        class="changes-msg-input"
                                        type="text"
                                        placeholder="Commit message…"
                                        bind:value={commitAllMsg}
                                        onkeydown={(e) => e.key === 'Enter' && commitAllChanges()}
                                    />
                                    <button
                                        class="changes-ai-btn"
                                        onclick={generateCommitAllMsg}
                                        disabled={!aiConfigured || commitAllAiBusy || commitAllBusy || checkedFiles.size === 0}
                                        title={aiConfigured ? 'Generate the message with AI from the selected changes' : AI_HINT}
                                        aria-label="Generate the commit message with AI"
                                    >{commitAllAiBusy ? '…' : 'AI'}</button>
                                    <button
                                        class="changes-commit-btn"
                                        onclick={commitAllChanges}
                                        disabled={!commitAllMsg.trim() || commitAllBusy || checkedFiles.size === 0}
                                    >{commitAllBusy ? '…' : checkedFiles.size === gitInfo?.changes.length ? 'Commit all' : `Commit ${checkedFiles.size}`}</button>
                                </div>
                                {#if commitAllErr}<div class="changes-err">{commitAllErr}</div>{/if}
                            </div>
                            {/if}
                        </div>
                    {/if}
                    {#if gitInfo.ahead > 0}
                        <div class="changes-wrap">
                            <button
                                class="git-ahead"
                                title="{gitInfo.ahead} commit(s) ahead of upstream — click to push"
                                onclick={() => pushPopupOpen = !pushPopupOpen}
                            >↑{gitInfo.ahead}</button>
                            {#if pushPopupOpen}
                            <div class="changes-backdrop" role="presentation" onclick={() => pushPopupOpen = false}></div>
                            <div class="changes-popup">
                                <div class="changes-popup-hdr">{gitInfo.ahead} unpushed commit(s)</div>
                                <div class="changes-commit-row">
                                    <button class="changes-commit-btn" onclick={() => { pushPopupOpen = false; push(); }}>Push</button>
                                </div>
                            </div>
                            {/if}
                        </div>
                    {/if}
                    {#if gitInfo.behind > 0}
                        <span class="git-behind" title="{gitInfo.behind} commit(s) behind upstream">↓{gitInfo.behind}</span>
                    {/if}
                </span>
            {/if}
            <div class="split-wrap">
                <div class="split-btn">
                    <button class="split-main" onclick={() => save()} disabled={!currentTab?.dirty || saving}>
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button class="split-arrow" onclick={() => dropdownOpen = !dropdownOpen} disabled={!activeTab} aria-label="Save options">▾</button>
                </div>
                {#if dropdownOpen}
                    <div class="split-backdrop" role="presentation" onclick={() => dropdownOpen = false}></div>
                    <div class="split-menu">
                        <button onclick={() => { dropdownOpen = false; save(); }}>Save</button>
                        <button onclick={() => { dropdownOpen = false; saveAndCommit(); }}>Save &amp; Commit</button>
                    </div>
                {/if}
            </div>
            {#if activeTab}
                <button onclick={del} class="danger">Delete</button>
            {/if}
            <div class="panel-toggles" role="group" aria-label="Panels">
                <button class:on={filesOpen} aria-pressed={filesOpen} onclick={() => togglePanel('files')} title="{toggleTitle('files', filesOpen)} — drag a panel's tab to dock it elsewhere">Files</button>
                <button class:on={logOpen} aria-pressed={logOpen} onclick={() => togglePanel('log')} title={toggleTitle('log', logOpen)}>Log</button>
                <button class:on={runtimeOpen} aria-pressed={runtimeOpen} onclick={() => togglePanel('runtime')} title="{toggleTitle('runtime', runtimeOpen)} — the script's handlers and timers, live">Runtime</button>
                <button class="reset" onclick={() => dock?.reset()} title="Reset the panel layout">⟲</button>
            </div>
            <button
                class="ai-toggle"
                class:ai-open={chatOpen}
                aria-pressed={chatOpen}
                onclick={() => togglePanel('chat')}
                title={toggleTitle('chat', chatOpen)}
            >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
                    <line x1="5.5" y1="5" x2="4" y2="2.5"/>
                    <line x1="10.5" y1="5" x2="12" y2="2.5"/>
                    <path d="M3 11 V7 A5 3.5 0 0 0 13 7 V11 Z" stroke-linejoin="round"/>
                    <circle cx="6" cy="8.2" r="0.7" fill="currentColor" stroke="none"/>
                    <circle cx="10" cy="8.2" r="0.7" fill="currentColor" stroke="none"/>
                </svg>
                AI
            </button>
        </div>

        <div class="editor-body">
            <div class="editor-left">
                <div class="editor-stack">
                    {#if currentTab?.changedOnDisk}
                        <div class="disk-bar">
                            <span>This file changed on disk while this tab has unsaved edits.</span>
                            <button onclick={() => reloadTabFromDisk(currentTab!.path, true)} title="Replace the tab's text with the file on disk">Reload from disk</button>
                            <button class="ghost" onclick={() => { tabs = tabs.map((t) => (t.path === activeTab ? { ...t, changedOnDisk: false } : t)); }} title="Keep the tab's text; saving overwrites the file">Keep mine</button>
                        </div>
                    {/if}
                    <div class="editor-container" bind:this={editorContainer}></div>
                    {#if activeTabLoading}
                        <div class="editor-loading">
                            <span class="spinner"></span>
                            <span>Loading {activeTab?.split('/').pop()}…</span>
                        </div>
                    {/if}
                    {#if !activeTab}
                        <div class="welcome">
                            <div class="welcome-inner">
                                <div class="welcome-logo">she</div>
                                <p class="welcome-sub">Smart Home Engine — a scriptable smart home automation engine</p>
                                <div class="welcome-hint">
                                    <strong>Quick start:</strong> click <kbd>+ File</kbd> in the sidebar to create your first script,
                                    or click an existing file to open it. Scripts run in a sandboxed VM with access to the
                                    <code>she</code> object for MQTT, scheduling, and more.
                                </div>
                                <div class="welcome-links">
                                    <a href="https://github.com/hobbyquaker/she" target="_blank" rel="noopener">GitHub</a>
                                    <span>·</span>
                                    <a href="https://github.com/hobbyquaker/she/blob/main/doc/sandbox-api.md" target="_blank" rel="noopener">API reference</a>
                                    <span>·</span>
                                    <a href="https://github.com/hobbyquaker/she/blob/main/README.md#Documentation" target="_blank" rel="noopener">Documentation</a>
                                </div>
                                <div class="welcome-shortcuts">
                                    <div class="welcome-shortcuts-title">Keyboard shortcuts</div>
                                    <div class="welcome-shortcuts-grid">
                                        <span class="keys"><kbd>Ctrl</kbd><kbd>S</kbd></span><span>Save</span>
                                        <span class="keys"><kbd>Ctrl</kbd><kbd>F</kbd></span><span>Find</span>
                                        <span class="keys"><kbd>Ctrl</kbd><kbd>H</kbd></span><span>Find &amp; Replace</span>
                                        <span class="keys"><kbd>Ctrl</kbd><kbd>G</kbd></span><span>Go to line</span>
                                        <span class="keys"><kbd>Ctrl</kbd><kbd>Z</kbd></span><span>Undo</span>
                                        <span class="keys"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Z</kbd></span><span>Redo</span>
                                        <span class="keys"><kbd>Ctrl</kbd><kbd>/</kbd></span><span>Toggle comment</span>
                                        <span class="keys"><kbd>Alt</kbd><kbd>↑ / ↓</kbd></span><span>Move line up / down</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    {/if}
                    {#if proposedCode !== null}
                        <div class="diff-overlay">
                            <div class="diff-bar">
                                <span class="diff-title">Proposed changes — <em>{activeTab?.split('/').pop()}</em></span>
                                <div class="diff-actions">
                                    <div class="split-wrap">
                                        <div class="split-btn accept-split">
                                            <button class="split-main" onclick={acceptProposal}>
                                                {autoAccept ? 'Auto-accept ✓' : 'Accept'}
                                            </button>
                                            <button class="split-arrow" onclick={() => acceptDropOpen = !acceptDropOpen} aria-label="Accept options">▾</button>
                                        </div>
                                        {#if acceptDropOpen}
                                            <div class="split-backdrop" role="presentation" onclick={() => acceptDropOpen = false}></div>
                                            <div class="split-menu">
                                                {#if !autoAccept}
                                                    <button onclick={() => { acceptDropOpen = false; autoAccept = true; acceptProposal(); }}>Always accept in this session</button>
                                                {:else}
                                                    <button onclick={() => { acceptDropOpen = false; autoAccept = false; }}>Disable auto-accept</button>
                                                {/if}
                                            </div>
                                        {/if}
                                    </div>
                                    <button class="discard-btn" onclick={discardProposal}>Discard</button>
                                </div>
                            </div>
                            <div class="diff-container" bind:this={diffEditorContainer}></div>
                        </div>
                    {/if}
                    {#if historyDiffOpen}
                    <div class="diff-overlay">
                        <div class="diff-bar">
                            <span class="diff-title">Commit <code>{historyDiffHash.slice(0, 7)}</code> → current — <em>{historyEntry?.name}</em></span>
                            <div class="diff-actions">
                                <button class="discard-btn" onclick={closeHistoryDiff}>Close</button>
                            </div>
                        </div>
                        {#if historyDiffBinary}
                            <div class="history-diff-notice">Binary file — diff not available.</div>
                        {:else}
                            <div class="diff-container" bind:this={historyDiffContainer}></div>
                        {/if}
                    </div>
                    {/if}
                </div>
            </div>
        </div>
    </div>

    <div class="log-panel" bind:this={hostLog}>
                    <div class="log-header">
                        <span class="log-title">
                            Script Log
                            {#if activeTab}<span class="log-file"> — {activeTab.split('/').pop()}</span>{/if}
                        </span>
                            <select class="log-filter-level" bind:value={logFilterLevel}>
                                {#each LOG_LEVELS as l}<option value={l}>{l}</option>{/each}
                            </select>
                            <input class="log-filter-text" type="search" placeholder="Filter…" bind:value={logFilterText} />
                            <label class="log-filter-regex" title="Interpret filter as a regular expression">
                                <input type="checkbox" bind:checked={logFilterRegex} />
                                <span class="log-filter-checkmark"></span>
                                Regex
                            </label>
                            <label class="log-filter-autoscroll">
                                <input type="checkbox" bind:checked={logAutoscroll} />
                                <span class="log-filter-checkmark"></span>
                                Auto-scroll
                            </label>
                            <button class="log-clear" onclick={clearLog}>Clear</button>
                    </div>
                        <div class="log-body" bind:this={logEl}>
                            <!-- Unkeyed on purpose: duplicate entries are legal in a log stream -->
                            {#each (currentTab?.logEntries ?? []).filter(logEntryVisible) as e}
                                <div class="log-line {e.level}">
                                    <span class="ts">{fmt(e.ts)}</span>
                                    <span class="lvl">{e.level.toUpperCase()}</span>
                                    <span class="msg">
                                        {#each splitLogMessage(e.msg, resolveScript) as seg}
                                            {#if seg.link}
                                                {@const l = seg.link}
                                                <button class="script-link" title="Open {l.path}{l.line ? ` at line ${l.line}` : ''}" onclick={() => openAtLine(l.path, l.line, l.column)}>{seg.text}</button>
                                            {:else}{seg.text}{/if}
                                        {/each}
                                    </span>
                                </div>
                            {/each}
                            {#if (currentTab?.logEntries.length ?? 0) === 0}
                                <span class="log-empty">{activeTab ? 'No log output for this script.' : 'Open a script to see its log.'}</span>
                            {/if}
                        </div>
    </div>

    <div class="runtime-panel" bind:this={hostRuntime}>
        <div class="rt-header">
            <span class="rt-title">Runtime {#if activeTab}<span class="log-file">— {activeTab.split('/').pop()}</span>{/if}</span>
            {#if activeTab && !scriptRunning.has(activeTab)}<span class="rt-note">not running</span>{/if}
            <span class="rt-live" class:on={runtimeLive}>{runtimeLive ? '● live' : ''}</span>
            {#if runtimeError}<span class="rt-error">{runtimeError}</span>{/if}
        </div>
        <div class="rt-body">
            <RuntimeHandlers handlers={runtimeRows} now={runtimeNow} actions onjump={(_script, line) => { if (activeTab) openAtLine(activeTab, line); }} onaction={doRuntimeAction}
                emptyText={!activeTab ? 'Open a script to see what it registered.' : activeTab && !scriptRunning.has(activeTab) ? 'This script is not running.' : runtimeSnap ? 'This script has registered nothing.' : 'Loading…'} />
        </div>
    </div>

    <div class="chat-container" bind:this={hostChat}>
        <Chat currentScript={chatScript} {onApply} {onCreateFile} bind:extraFiles={chatExtraFiles} />
    </div>
    </div>
</div>

<style>
    .layout { position: relative; height: 100%; }
    .dock { position: absolute; inset: 0; }
    .dock-parking { display: none; }
    /* a panel fills the dock's content container (parked, the hosts are display: none anyway) */
    aside, .editor-area, .log-panel, .runtime-panel, .chat-container { width: 100%; height: 100%; min-height: 0; }
    /* the dock's own chrome in the app's colours */
    :global(.dockview-theme-she) {
        --dv-group-view-background-color: var(--bg-app);
        --dv-tabs-and-actions-container-background-color: var(--bg-panel);
        /* a slim tab strip: lower than the panels' own header rows beneath it */
        --dv-tabs-and-actions-container-height: 18px;
        --dv-tabs-and-actions-container-font-size: 11px;
        --dv-activegroup-visiblepanel-tab-background-color: var(--bg-app);
        --dv-activegroup-hiddenpanel-tab-background-color: var(--bg-panel);
        --dv-inactivegroup-visiblepanel-tab-background-color: var(--bg-app);
        --dv-inactivegroup-hiddenpanel-tab-background-color: var(--bg-panel);
        --dv-activegroup-visiblepanel-tab-color: var(--fg-text);
        --dv-activegroup-hiddenpanel-tab-color: var(--fg-muted);
        --dv-inactivegroup-visiblepanel-tab-color: var(--fg);
        --dv-inactivegroup-hiddenpanel-tab-color: var(--fg-muted);
        --dv-tab-divider-color: var(--border-sub);
        --dv-separator-border: var(--border-sub);
        --dv-paneview-header-border-color: var(--border-sub);
        --dv-paneview-active-outline-color: var(--accent);
        --dv-icon-hover-background-color: var(--bg-hover);
        --dv-scrollbar-background-color: var(--border);
        --dv-tabs-container-scrollbar-color: var(--border);
        --dv-sash-color: transparent;
        --dv-active-sash-color: var(--accent);
        --dv-active-sash-transition-duration: 0.1s;
        --dv-active-sash-transition-delay: 0.3s;
        --dv-drag-over-background-color: rgba(14, 99, 156, 0.25);
        --dv-drag-over-border-color: var(--accent);
        --dv-drag-over-border: 1px solid var(--accent);
        --dv-edge-dock-indicator-color: var(--accent-hov);
        --dv-tab-group-color: var(--accent);
        --dv-overlay-z-index: 50;
        --dv-border-radius: 0px; --dv-tab-border-radius: 0px; --dv-sash-border-radius: 0px; --dv-dropdown-border-radius: 3px;
        --dv-tab-margin: 0; --dv-spacing-padding: 0px; --dv-tab-font-size: inherit; --dv-tab-close-icon-size: inherit;
        --dv-floating-box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35); --dv-floating-border: 1px solid var(--border); --dv-floating-group-border: none;
        --dv-floating-group-dragging-opacity: 0.5; --dv-floating-titlebar-height: 22px;
        --dv-context-menu-background-color: var(--bg-panel); --dv-context-menu-color: var(--fg);
        --dv-tab-group-chip-padding: 2px 6px; --dv-tab-group-chip-border-radius: 4px; --dv-tab-group-chip-font-size: 11px;
        --dv-tab-group-line-opacity: 0.6;
    }
    :global(.dockview-theme-she .dv-tab) { padding: 0 4px 0 8px; }
    :global(.dockview-theme-she .dv-tab.dv-active-tab) { border-top: 1px solid var(--accent); }
    :global(.dockview-theme-she .dv-default-tab .dv-default-tab-content) { margin-right: 2px; }
    .panel-toggles { display: inline-flex; gap: 2px; margin-left: 4px; }
    .panel-toggles button {
        background: none; border: 1px solid transparent; color: var(--fg-muted); border-radius: 3px;
        padding: 2px 6px; font-size: 11px; cursor: pointer;
    }
    .panel-toggles button:hover { color: var(--fg); background: var(--bg-hover); }
    .panel-toggles button.on { color: var(--fg-text); background: var(--bg-active); }
    .panel-toggles button.reset { font-size: 12px; padding: 0 5px; }

    aside {
        background: var(--bg-panel);
        display: flex; flex-direction: column; overflow: hidden;
    }
    .toolbar {
        display: flex; align-items: center; gap: 4px; padding: 8px;
        border-bottom: 1px solid var(--border-sub);
    }
    .toolbar button {
        flex: 1; background: var(--accent); color: #fff; border: none;
        padding: 4px 6px; border-radius: 3px; cursor: pointer; font-size: 12px; line-height: 1;
    }
    .toolbar button.refresh { flex: 0 0 auto; padding: 4px 8px; }
    .toolbar button:hover { background: var(--accent-hov); }

    .tree { flex: 1; overflow-y: auto; list-style: none; padding: 4px 0; margin: 0; }

    /* ── Git history panel ── */
    .history-panel {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        border-top: 1px solid var(--border-sub);
        background: var(--bg-panel);
        overflow: hidden;
    }
    .history-resize-handle {
        height: 5px; cursor: row-resize; flex-shrink: 0;
        background: var(--border-sub); transition: background 0.15s;
    }
    .history-resize-handle:hover, .history-resize-handle:active { background: var(--accent); }
    .history-hdr {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 5px 8px;
        border-bottom: 1px solid var(--border-sub);
        flex-shrink: 0;
    }
    .history-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--fg-muted);
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .history-close {
        background: none;
        border: none;
        color: var(--fg-muted);
        cursor: pointer;
        font-size: 12px;
        padding: 0 2px;
        line-height: 1;
        flex-shrink: 0;
    }
    .history-close:hover { color: var(--fg); }
    .history-body {
        flex: 1;
        overflow-y: auto;
        padding: 2px 0;
    }
    .history-row {
        display: block;
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        padding: 4px 8px;
        cursor: pointer;
        color: var(--fg);
    }
    .history-row:hover { background: var(--bg-active); }
    .history-subject {
        display: block;
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .history-meta {
        display: block;
        font-size: 10px;
        color: var(--fg-muted);
        margin-top: 1px;
    }
    .history-empty {
        padding: 8px;
        font-size: 11px;
        color: var(--fg-muted);
    }
    .history-load-more {
        display: block;
        width: 100%;
        background: none;
        border: none;
        border-top: 1px solid var(--border-sub);
        padding: 5px 8px;
        font-size: 11px;
        color: var(--fg-muted);
        cursor: pointer;
        text-align: center;
    }
    .history-load-more:hover:not(:disabled) { background: var(--bg-active); color: var(--fg); }
    .history-load-more:disabled { opacity: 0.5; cursor: default; }
    .history-diff-notice {
        padding: 16px;
        font-size: 12px;
        color: var(--fg-muted);
    }
    .tree-root-drop { height: 8px; list-style: none; }
    .tree-root-drop.drag-target { background: var(--bg-active); outline: 1px dashed var(--fg-brand); outline-offset: -1px; }
    .tree-dir, .tree-file { list-style: none; }
    .tree-children { list-style: none; padding: 0; margin: 0 0 0 10px; border-left: 1px solid var(--indent-line); }
    .dir-row {
        display: flex; align-items: center; gap: 4px;
        padding: 3px 0 3px 6px; cursor: default;
    }
    .chevron {
        background: none; border: none; color: var(--fg-muted); cursor: pointer;
        padding: 0; font-size: 14px; font-weight: 300; line-height: 1; width: 12px; flex-shrink: 0;
        display: inline-flex; align-items: center; justify-content: center;
        transition: transform 0.12s ease;
    }
    .chevron.open { transform: rotate(90deg); }
    .dir-name { color: var(--fg); font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dir-name.lib { color: var(--fg-muted); font-style: italic; }
    .lib-label {
        display: flex; align-items: center; gap: 2px; color: var(--fg-muted);
        cursor: pointer; flex-shrink: 0; user-select: none; padding-right: 2px;
    }
    .lib-label input[type='checkbox'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .lib-checkmark {
        flex-shrink: 0; width: 10px; height: 10px;
        border: 1.5px solid var(--border); border-radius: 2px;
        background: var(--bg-input); position: relative;
        transition: background 0.12s, border-color 0.12s;
    }
    .lib-label input:checked + .lib-checkmark { background: var(--accent); border-color: var(--accent); }
    .lib-label input:checked + .lib-checkmark::after {
        content: ''; position: absolute;
        left: 2px; top: 0; width: 3px; height: 6px;
        border: 1.5px solid #fff; border-top: none; border-left: none;
        transform: rotate(45deg);
    }
    .lib-label:hover .lib-checkmark { border-color: var(--accent); }
    .lib-tip-float {
        position: fixed;
        transform: translateY(-100%);
        background: var(--bg-panel); border: 1px solid var(--border); border-radius: 4px;
        padding: 5px 8px; font-size: 11px; color: var(--fg);
        width: 200px; line-height: 1.4; z-index: 200; white-space: normal; pointer-events: none;
    }

    .dis-label {
        display: flex; align-items: center; gap: 2px; color: var(--fg-muted);
        cursor: pointer; flex-shrink: 0; user-select: none; padding-right: 4px;
    }
    .dis-label input[type='checkbox'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .dis-checkmark {
        flex-shrink: 0; width: 10px; height: 10px;
        border: 1.5px solid var(--border); border-radius: 2px;
        background: var(--bg-input); position: relative;
        transition: background 0.12s, border-color 0.12s;
    }
    .dis-label input:checked + .dis-checkmark { background: var(--fg-warn); border-color: var(--fg-warn); }
    .dis-label input:checked + .dis-checkmark::after {
        content: ''; position: absolute;
        left: 2px; top: 0; width: 3px; height: 6px;
        border: 1.5px solid #fff; border-top: none; border-left: none;
        transform: rotate(45deg);
    }
    .dis-label:hover .dis-checkmark { border-color: var(--fg-warn); }
    .dis-label.dis-locked { cursor: not-allowed; opacity: 0.4; pointer-events: none; }
    .dis-spacer { width: 28px; flex-shrink: 0; }

    .tree-file button {
        display: flex; align-items: center; gap: 5px; width: 100%; text-align: left;
        background: none; border: none; color: var(--fg);
        padding: 3px 8px 3px 6px;
        cursor: pointer; font-size: 12px;
    }
    .tree-file button.lib .fname { color: var(--fg-muted); font-style: italic; }
    .tree-file button.dis .fname { color: var(--fg-dim); }
    .tree-file button.err .fname { color: var(--fg-err); }
    .tree-file button.outside .fname { color: var(--fg-dim); flex: 0 1 auto; }
    .outside-mark {
        display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0;
        color: var(--fg-warn); font-size: 10px; white-space: nowrap;
    }
    .tree-file button:hover { background: var(--bg-hover); }
    .tree-file.active-tab button { background: var(--bg-active); color: var(--fg-text); }
    .tree-file.active:not(.active-tab) button { background: var(--bg-hover); }
    .file-row { display: flex; align-items: center; }

    .badge {
        display: inline-flex; align-items: center; justify-content: center;
        width: 22px; font-size: 9px; font-weight: 700; border-radius: 2px;
        background: transparent; color: #888; flex-shrink: 0;
    }
    /* Language colours — foreground only, works on dark and light backgrounds */
    .badge-js, .badge-mjs, .badge-cjs { color: #b89a00; font-size: 8px; letter-spacing: -0.5px; }
    .badge-ts, .badge-tsx             { color: #2068c0; }
    .badge-json, .badge-jsonc         { color: #c06010; }
    .badge-md, .badge-markdown        { color: #1888b0; font-size: 12px; }
    .badge-yaml, .badge-yml           { color: #7a28a8; }
    .badge-css, .badge-html           { color: #1570a8; }
    .badge-sh, .badge-bash            { color: #0a8840; }
    .badge.badge-shelib { color: var(--fg-muted); }
    .fname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dirty-dot { color: #e5c07b; font-size: 8px; flex-shrink: 0; }
    .err-dot { color: var(--fg-err); font-size: 8px; flex-shrink: 0; }
    .run-dot { color: var(--fg-ok); font-size: 8px; flex-shrink: 0; }
    .git-mod { color: #e2c08d; font-size: 10px; font-weight: 600; flex-shrink: 0; }
    .err { color: var(--fg-err); padding: 8px; font-size: 12px; }

    .editor-area { display: flex; flex-direction: column; min-width: 0; }

    .editor-body { flex: 1; display: flex; min-height: 0; }
    .editor-left { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }

    .editor-stack { flex: 1; position: relative; min-height: 0; }
    .editor-container { position: absolute; inset: 0; }

    /* Diff overlay — sits on top of the editor-container */
    .diff-overlay {
        position: absolute; inset: 0; z-index: 10;
        display: flex; flex-direction: column;
        background: var(--bg-app);
    }
    .diff-bar {
        display: flex; align-items: center; gap: 8px;
        padding: 5px 10px; background: var(--bg-panel);
        border-bottom: 1px solid var(--border-sub); flex-shrink: 0;
    }
    .diff-title { flex: 1; font-size: 12px; color: var(--fg-muted); }
    .diff-title em { color: var(--fg); font-style: normal; }
    .diff-actions { display: flex; gap: 6px; }
    .accept-btn { display: none; } /* superseded by split button */
    .accept-split .split-main,
    .accept-split .split-arrow {
        background: #1a6b30;
    }
    .accept-split .split-main:not(:disabled):hover,
    .accept-split .split-arrow:not(:disabled):hover {
        background: #22883d;
    }
    .discard-btn {
        background: none; color: var(--fg-muted);
        border: 1px solid var(--border); padding: 3px 10px; border-radius: 3px; cursor: pointer; font-size: 12px;
    }
    .discard-btn:hover { background: var(--bg-hover); color: var(--fg); }
    .diff-container { flex: 1; min-height: 0; }

    /* AI toggle button */
    .ai-toggle {
        background: var(--bg-widget) !important;
        color: var(--fg-brand) !important;
        border: 1px solid var(--border) !important;
        font-weight: 600 !important;
        display: inline-flex !important;
        align-items: center !important;
        gap: 4px !important;
    }
    .ai-toggle:hover { background: var(--bg-hover) !important; }
    .ai-toggle.ai-open { background: var(--fg-brand) !important; color: #fff !important; border-color: var(--fg-brand) !important; }

    .chat-container { display: flex; flex-direction: column; min-width: 0; }

    .runtime-panel { display: flex; flex-direction: column; min-height: 0; background: var(--bg-app); }
    .rt-header {
        display: flex; align-items: center; gap: 8px; padding: 4px 8px; flex-shrink: 0;
        background: var(--bg-panel); border-bottom: 1px solid var(--border-sub); font-size: 11px; color: var(--fg-muted);
    }
    .rt-title { flex: 1; }
    .rt-note { color: var(--fg-warn); }
    .rt-live { color: var(--fg-dim); }
    .rt-live.on { color: var(--fg-ok); }
    .rt-error { color: var(--fg-err); }
    .rt-body { flex: 1; overflow: auto; min-height: 0; }

    /* Loading state: a tab opens on click and spins until its content arrives. */
    @keyframes she-spin { to { transform: rotate(360deg); } }
    .tab-spinner, .spinner {
        display: inline-block;
        border: 2px solid var(--fg-dim);
        border-top-color: var(--fg-brand);
        border-radius: 50%;
        animation: she-spin 0.7s linear infinite;
        flex-shrink: 0;
    }
    .tab-spinner { width: 9px; height: 9px; }
    .spinner { width: 18px; height: 18px; }

    .editor-loading {
        position: absolute;
        inset: 0;
        z-index: 5;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        background: var(--bg-app);
        color: var(--fg-muted);
        font-size: 13px;
    }

    .tab-bar-wrap {
        display: flex; align-items: stretch; background: var(--bg-app);
        border-bottom: 1px solid var(--border-sub); flex-shrink: 0; height: 35px;
    }
    .tab-scroll-btn {
        flex-shrink: 0; width: 22px; background: var(--bg-app); border: none;
        border-right: 1px solid var(--border-sub); color: var(--fg-muted); cursor: pointer;
        font-size: 14px; padding: 0; display: flex; align-items: center; justify-content: center;
    }
    .tab-scroll-btn:last-child { border-right: none; border-left: 1px solid var(--border-sub); }
    .tab-scroll-btn:disabled { opacity: 0.25; cursor: default; pointer-events: none; }
    .tab-scroll-btn:not(:disabled):hover { color: var(--fg); background: var(--bg-hover); }
    .tab-bar {
        display: flex; overflow-x: hidden; flex: 1;
        scrollbar-width: none;
    }
    .tab-bar::-webkit-scrollbar { display: none; }
    .tab {
        display: flex; align-items: center; gap: 5px; padding: 0 10px; height: 35px;
        min-width: 0; max-width: 180px; cursor: pointer; font-size: 12px;
        color: var(--fg-muted); background: var(--bg-app);
        border-right: 1px solid var(--border-sub); flex-shrink: 0; user-select: none;
    }
    .tab:hover { background: var(--bg-hover); color: var(--fg); }
    .tab.active { background: var(--bg-panel); color: var(--fg); border-top: 2px solid var(--fg-brand); }
    .tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .tab-dirty { color: #e5c07b; font-size: 8px; flex-shrink: 0; }
    .tab-changed { color: #e5c07b; font-size: 11px; flex-shrink: 0; }
    .disk-bar {
        display: flex; align-items: center; gap: 8px; padding: 4px 10px; font-size: 11px;
        background: var(--bg-widget); border-bottom: 1px solid var(--border); color: var(--fg);
    }
    .disk-bar button { background: var(--accent); border: none; color: #fff; padding: 2px 8px; font-size: 11px; border-radius: 3px; cursor: pointer; }
    .disk-bar button.ghost { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    /* the close × of the editor's file tabs — and of the dock's panel tabs, the same button */
    .tab-close, :global(.dockview-theme-she .dv-default-tab .dv-default-tab-action) {
        background: none; border: none; color: var(--fg-muted); cursor: pointer;
        font-size: 14px; line-height: 1; padding: 0; width: 16px; height: 16px;
        display: flex; align-items: center; justify-content: center; border-radius: 2px; flex-shrink: 0;
    }
    .tab-close:hover, :global(.dockview-theme-she .dv-default-tab .dv-default-tab-action:hover) { background: var(--bg-hover); color: var(--fg); }

    .editor-toolbar {
        display: flex; align-items: center; gap: 6px; padding: 6px 10px;
        background: var(--bg-panel); border-bottom: 1px solid var(--border-sub); flex-shrink: 0;
    }
    .filename { flex: 1; font-size: 12px; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .split-wrap { position: relative; flex-shrink: 0; }
    .split-btn { display: flex; }
    .split-main {
        background: var(--accent); color: #fff; border: none;
        padding: 4px 10px; border-radius: 3px 0 0 3px; cursor: pointer; font-size: 12px; line-height: 1;
    }
    .split-main:disabled { opacity: 0.4; cursor: default; }
    .split-main:not(:disabled):hover { background: var(--accent-hov); }
    .split-arrow {
        background: var(--accent); color: #fff; border: none;
        border-left: 1px solid rgba(255,255,255,0.2);
        padding: 4px 6px; border-radius: 0 3px 3px 0; cursor: pointer; font-size: 10px; line-height: 1;
    }
    .split-arrow:disabled { opacity: 0.4; cursor: default; }
    .split-arrow:not(:disabled):hover { background: var(--accent-hov); }
    .split-backdrop { position: fixed; inset: 0; z-index: 9; }
    .split-menu {
        position: absolute; top: calc(100% + 2px); right: 0; z-index: 10;
        background: var(--bg-widget); border: 1px solid var(--border); border-radius: 3px;
        display: flex; flex-direction: column; min-width: 140px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    }
    .split-menu button {
        background: none; border: none; color: var(--fg); text-align: left;
        padding: 7px 12px; cursor: pointer; font-size: 12px;
    }
    .split-menu button:hover { background: var(--bg-hover); }
    .split-menu button:disabled { opacity: 0.4; cursor: default; }
    .split-menu button:disabled:hover { background: none; }

    .git-status { display: flex; align-items: center; gap: 5px; flex-shrink: 0; font-size: 11px; }
    .git-branch { color: var(--fg-muted); }
    .git-changes {
        background: none; border: none; padding: 0; cursor: pointer;
        color: var(--fg-warn); font-weight: 600; font-size: 11px;
    }
    .git-changes:hover { text-decoration: underline; }
    .changes-wrap { position: relative; }
    .changes-backdrop { position: fixed; inset: 0; z-index: 19; }
    .changes-popup {
        position: absolute; top: calc(100% + 4px); left: 50%; transform: translateX(-50%);
        z-index: 20; background: var(--bg-widget); border: 1px solid var(--border);
        border-radius: 4px; box-shadow: 0 4px 18px rgba(0,0,0,0.5);
        min-width: 280px; max-width: 400px; display: flex; flex-direction: column;
    }
    .changes-popup-hdr {
        padding: 7px 10px; font-size: 11px; font-weight: 600; color: var(--fg-muted);
        border-bottom: 1px solid var(--border-sub); flex-shrink: 0;
    }
    .changes-list {
        list-style: none; padding: 4px 0; margin: 0; max-height: 180px; overflow-y: auto;
    }
    .changes-item { display: flex; align-items: center; gap: 6px; padding: 3px 10px; }
    .changes-cb-wrap { display: flex; align-items: center; flex-shrink: 0; cursor: pointer; }
    .changes-check { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .changes-checkmark {
        flex-shrink: 0; width: 12px; height: 12px;
        border: 1.5px solid var(--border); border-radius: 3px;
        background: var(--bg-input); position: relative;
        transition: background 0.12s, border-color 0.12s;
    }
    .changes-check:checked + .changes-checkmark { background: var(--accent); border-color: var(--accent); }
    .changes-check:checked + .changes-checkmark::after {
        content: ''; position: absolute; left: 2px; top: 0px; width: 4px; height: 7px;
        border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg);
    }
    .changes-cb-wrap:hover .changes-checkmark { border-color: var(--accent); }
    .changes-status { font-size: 10px; font-weight: 700; color: var(--fg-warn); flex-shrink: 0; width: 16px; }
    .changes-file { font-size: 11px; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .changes-commit-row {
        display: flex; gap: 4px; padding: 6px 8px;
        border-top: 1px solid var(--border-sub); flex-shrink: 0;
    }
    .changes-msg-input {
        flex: 1; background: var(--bg-input); border: 1px solid var(--border-sub);
        color: var(--fg); padding: 3px 6px; border-radius: 3px; font-size: 11px;
    }
    .changes-commit-btn {
        background: var(--accent); color: #fff; border: none;
        padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; flex-shrink: 0;
    }
    .changes-commit-btn:disabled { opacity: 0.4; cursor: default; }
    .changes-ai-btn {
        background: var(--bg-input); color: var(--fg); border: 1px solid var(--border-sub);
        padding: 3px 6px; border-radius: 3px; cursor: pointer; font-size: 11px; flex-shrink: 0;
    }
    .changes-ai-btn:disabled { opacity: 0.4; cursor: default; }
    .changes-ai-btn:not(:disabled):hover { background: var(--bg-hover); }
    .changes-commit-btn:not(:disabled):hover { background: var(--accent-hov); }
    .changes-err { padding: 4px 10px 6px; font-size: 11px; color: var(--fg-err); }
    .git-ahead {
        background: none; border: none; padding: 0; cursor: pointer;
        color: #4fc1ff; font-weight: 600; font-size: 11px;
    }
    .git-ahead:hover { text-decoration: underline; }
    .git-behind { color: var(--fg-err); font-weight: 600; }

    .editor-toolbar > button {
        background: var(--accent); color: #fff; border: none;
        padding: 4px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; line-height: 1;
    }
    .editor-toolbar > button:disabled { opacity: 0.4; cursor: default; }
    .editor-toolbar > button:not(:disabled):hover { background: var(--accent-hov); }
    .editor-toolbar > button.danger { background: var(--accent-del); }
    .editor-toolbar > button.danger:hover { background: var(--accent-del-hov); }

    /* editor-container is now absolute inside .editor-stack */

    .log-panel { display: flex; flex-direction: column; min-height: 0; }
    .log-title { color: var(--fg-muted); font-size: 11px; flex: 1; }
    .log-header {
        display: flex; align-items: center; gap: 6px; padding: 4px 8px;
        background: var(--bg-panel); border-bottom: 1px solid var(--border-sub); flex-shrink: 0;
    }
    .log-toggle {
        background: none; border: none; color: var(--fg-muted); cursor: pointer;
        font-size: 11px; padding: 0; flex: 1; text-align: left;
    }
    .log-toggle:hover { color: var(--fg); }
    .log-file { font-style: italic; }
    .log-clear {
        background: none; border: none; color: var(--fg-muted); cursor: pointer;
        font-size: 11px; padding: 0 4px; border-radius: 2px;
    }
    .log-clear:hover { background: var(--bg-hover); color: var(--fg); }
    .log-filter-level {
        background: var(--bg-input); color: var(--fg); border: 1px solid var(--border);
        padding: 1px 4px; border-radius: 3px; font-size: 11px;
    }
    .log-filter-text {
        flex: 1; max-width: 160px;
        background: var(--bg-input); color: var(--fg); border: 1px solid var(--border);
        padding: 1px 5px; border-radius: 3px; font-size: 11px;
    }
    .log-filter-regex {
        display: flex; align-items: center; gap: 4px; cursor: pointer;
        font-size: 11px; color: var(--fg-muted); user-select: none; white-space: nowrap;
    }
    .log-filter-regex input[type='checkbox'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .log-filter-autoscroll {
        display: flex; align-items: center; gap: 4px; cursor: pointer;
        font-size: 11px; color: var(--fg-muted); user-select: none; white-space: nowrap;
    }
    .log-filter-autoscroll input[type='checkbox'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .log-filter-autoscroll input:checked + .log-filter-checkmark { background: var(--accent); border-color: var(--accent); }
    .log-filter-autoscroll input:checked + .log-filter-checkmark::after {
        content: ''; position: absolute; left: 2px; top: 0px; width: 4px; height: 7px;
        border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg);
    }
    .log-filter-autoscroll:hover .log-filter-checkmark { border-color: var(--accent); }
    .log-filter-checkmark {
        flex-shrink: 0; width: 12px; height: 12px;
        border: 1.5px solid var(--border); border-radius: 3px;
        background: var(--bg-input); position: relative;
        transition: background 0.12s, border-color 0.12s;
    }
    .log-filter-regex input:checked + .log-filter-checkmark { background: var(--accent); border-color: var(--accent); }
    .log-filter-regex input:checked + .log-filter-checkmark::after {
        content: ''; position: absolute; left: 2px; top: 0px; width: 4px; height: 7px;
        border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg);
    }
    .log-filter-regex:hover .log-filter-checkmark { border-color: var(--accent); }
    .log-body { flex: 1; overflow-y: auto; font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 11px; padding: 2px 0; }
    .log-line { display: flex; gap: 8px; padding: 0 8px; line-height: 1.6; }
    .log-line:hover { background: var(--bg-hover); }
    .log-line .ts { color: var(--fg-dim); flex-shrink: 0; }
    .log-line .lvl { width: 44px; flex-shrink: 0; font-weight: bold; }
    .log-line.debug .lvl { color: var(--fg-muted); }
    .log-line.info  .lvl { color: #4fc1ff; }
    .log-line.warn  .lvl { color: var(--fg-warn); }
    .log-line.error .lvl { color: var(--fg-err); }
    .log-line .msg { color: var(--fg-text); word-break: break-all; }
    .script-link {
        background: none; border: none; padding: 0;
        font: inherit; color: var(--fg-brand); cursor: pointer;
    }
    .script-link:hover { text-decoration: underline; }
    .log-empty { color: var(--fg-dim); font-size: 11px; padding: 4px 8px; font-style: italic; }

    /* ── Folder selected / drag target ─────────────────────────────────────── */
    .dir-row.dir-selected { background: var(--bg-hover); }
    .dir-row.dir-selected .dir-name { color: var(--fg-brand); }
    .dir-row.drag-target { background: var(--bg-active); outline: 1px dashed var(--fg-brand); outline-offset: -1px; }
    .dir-name { cursor: pointer; }
    .dir-name:hover { color: var(--fg-brand); }

    /* ── Context menu ───────────────────────────────────────────────────────── */
    .ctx-backdrop { position: fixed; inset: 0; z-index: 99; }
    .ctx-menu {
        position: fixed; z-index: 100;
        background: var(--bg-widget); border: 1px solid var(--border);
        border-radius: 4px; box-shadow: 0 6px 24px rgba(0,0,0,0.5);
        display: flex; flex-direction: column; min-width: 160px; padding: 3px 0;
    }
    .ctx-menu button {
        background: none; border: none; color: var(--fg); text-align: left;
        padding: 6px 14px; cursor: pointer; font-size: 12px;
    }
    .ctx-menu button:hover { background: var(--bg-hover); }
    .ctx-menu button.danger { color: var(--fg-err); }
    .ctx-menu hr { border: none; border-top: 1px solid var(--border-sub); margin: 3px 0; }

    /* ── Welcome page ───────────────────────────────────────────────────────── */
    /* centred while it fits; in a low editor it scrolls from its top instead of spilling over the toolbar
       above, where it used to cover the panel toggles and swallow their clicks */
    .welcome {
        position: absolute; inset: 0; z-index: 5;
        background: var(--bg-app);
        display: flex; overflow: auto;
    }
    .welcome-inner {
        max-width: 480px; text-align: center; padding: 32px 24px; margin: auto;
    }
    .welcome-logo {
        font-size: 52px; font-weight: 700; letter-spacing: -2px;
        color: var(--fg-brand); line-height: 1; margin-bottom: 8px;
        font-family: 'Cascadia Code', 'Fira Code', monospace;
    }
    .welcome-sub {
        color: var(--fg-muted); font-size: 13px; margin: 0 0 24px;
    }
    .welcome-hint {
        background: var(--bg-panel); border: 1px solid var(--border-sub);
        border-radius: 6px; padding: 14px 18px; font-size: 13px; color: var(--fg);
        line-height: 1.6; text-align: left; margin-bottom: 20px;
    }
    .welcome-hint kbd {
        background: var(--bg-widget); border: 1px solid var(--border);
        border-radius: 3px; padding: 1px 5px; font-size: 11px; font-family: inherit;
    }
    .welcome-hint code { color: var(--fg-brand); font-size: 12px; }
    .welcome-links {
        display: flex; align-items: center; justify-content: center; gap: 8px;
        font-size: 12px;
    }
    .welcome-links a { color: var(--fg-brand); text-decoration: none; }
    .welcome-links a:hover { text-decoration: underline; }
    .welcome-links span { color: var(--fg-dim); }
    .welcome-shortcuts {
        margin-top: 20px; text-align: left;
        background: var(--bg-panel); border: 1px solid var(--border-sub);
        border-radius: 6px; padding: 12px 18px;
    }
    .welcome-shortcuts-title {
        font-size: 11px; font-weight: 600; text-transform: uppercase;
        letter-spacing: 0.06em; color: var(--fg-muted); margin-bottom: 10px;
    }
    .welcome-shortcuts-grid {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 5px 12px; align-items: center;
        font-size: 12px;
    }
    .welcome-shortcuts-grid .keys {
        display: flex; gap: 3px; align-items: center;
    }
    .welcome-shortcuts-grid kbd {
        background: var(--bg-widget); border: 1px solid var(--border);
        border-radius: 3px; padding: 1px 5px; font-size: 11px;
        font-family: inherit; white-space: nowrap;
    }
    .welcome-shortcuts-grid span { color: var(--fg-muted); padding-left: 4px; }

    /* ── Search panel ── */
    .toolbar button.search-toggle {
        flex: 0 0 auto; background: none; border: 1px solid transparent;
        color: var(--fg-muted); padding: 3px 7px; font-size: 15px; border-radius: 3px;
    }
    .toolbar button.search-toggle:hover { color: var(--fg); background: var(--bg-hover); }
    .toolbar button.search-toggle.active { color: var(--fg-brand); border-color: var(--fg-brand); background: rgba(86,156,214,0.1); }

    .search-panel {
        display: flex; flex-direction: column; flex-shrink: 0;
        border-bottom: 1px solid var(--border-sub); background: var(--bg-panel);
    }
    .search-mode-bar {
        display: flex; gap: 1px; padding: 4px 6px 0; align-items: center;
    }
    .search-mode-bar button {
        background: none; border: none; border-bottom: 2px solid transparent;
        color: var(--fg-muted); cursor: pointer; font-size: 11px; padding: 2px 8px 3px;
    }
    .search-mode-bar button:hover { color: var(--fg); }
    .search-mode-bar button.active { color: var(--fg); border-bottom-color: var(--fg-brand); }
    .search-close-btn { margin-left: auto; font-size: 14px; padding: 2px 5px !important; }
    .search-input-row {
        display: flex; align-items: center; gap: 3px; padding: 4px 6px;
    }
    .search-input-row input {
        flex: 1; min-width: 0; font-size: 12px; padding: 3px 6px;
        background: var(--bg-input); border: 1px solid var(--border); border-radius: 3px;
        color: var(--fg); outline: none;
    }
    .search-input-row input:focus { border-color: var(--accent); }
    .search-input-row button {
        flex-shrink: 0; background: none; border: 1px solid transparent;
        color: var(--fg-muted); cursor: pointer; padding: 2px 5px;
        border-radius: 2px; font-size: 11px; white-space: nowrap;
    }
    .search-input-row button:hover { color: var(--fg); background: var(--bg-hover); }
    .search-input-row button.active { color: var(--fg-brand); background: rgba(86,156,214,0.12); border-color: var(--accent); }
    .search-input-row button:disabled { opacity: 0.35; cursor: default; pointer-events: none; }
    .search-results { overflow-y: auto; max-height: 240px; }
    .search-status { padding: 5px 8px; color: var(--fg-muted); font-size: 11px; }
    .search-err { color: var(--fg-err); }
    .search-trunc { color: #d4944a; }
    .search-file-group {}
    .search-file-btn {
        display: flex; align-items: center; gap: 4px; width: 100%;
        background: none; border: none; color: var(--fg); cursor: pointer;
        text-align: left; padding: 3px 8px 2px; font-size: 11px; font-weight: 600;
    }
    .search-file-btn:hover { background: var(--bg-hover); }
    .search-fname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .search-fcount {
        background: var(--fg-brand); color: #fff; border-radius: 8px;
        padding: 0 5px; font-size: 9px; font-weight: 700; flex-shrink: 0;
    }
    .search-match-row {
        display: flex; align-items: baseline; gap: 6px; width: 100%;
        background: none; border: none; color: var(--fg-muted); cursor: pointer;
        text-align: left; padding: 1px 8px 1px 16px; font-family: monospace;
    }
    .search-match-row:hover { background: var(--bg-hover); color: var(--fg); }
    .search-lnum { color: var(--fg-brand); font-size: 10px; flex-shrink: 0; min-width: 24px; text-align: right; }
    .search-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
    .search-file-result { padding-left: 8px; }

    .replace-confirm { border-top: 1px solid var(--border-sub); background: var(--bg-app); }
    .replace-confirm-hdr {
        display: flex; align-items: center; justify-content: space-between;
        padding: 5px 8px; font-size: 11px; color: var(--fg);
        border-bottom: 1px solid var(--border-sub);
    }
    .replace-confirm-btns { display: flex; gap: 4px; }
    .replace-confirm-btns button {
        font-size: 11px; padding: 2px 8px; border-radius: 2px; cursor: pointer;
        background: var(--accent); border: none; color: #fff;
    }
    .replace-confirm-btns button + button { background: none; border: 1px solid var(--border); color: var(--fg-muted); }
    .replace-confirm-btns button:disabled { opacity: 0.4; cursor: default; pointer-events: none; }
    .replace-confirm-list { padding: 4px 8px; max-height: 100px; overflow-y: auto; }
    .replace-item {
        display: flex; align-items: center; gap: 6px; padding: 2px 0;
        font-size: 11px; cursor: pointer; user-select: none;
    }
    .replace-item input[type='checkbox'] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .replace-checkmark {
        flex-shrink: 0; width: 12px; height: 12px;
        border: 1.5px solid var(--border); border-radius: 3px;
        background: var(--bg-input); position: relative;
        transition: background 0.12s, border-color 0.12s;
    }
    .replace-item input:checked + .replace-checkmark { background: var(--accent); border-color: var(--accent); }
    .replace-item input:checked + .replace-checkmark::after {
        content: ''; position: absolute; left: 2px; top: 0px; width: 4px; height: 7px;
        border: 1.5px solid #fff; border-top: none; border-left: none; transform: rotate(45deg);
    }
    .replace-item:hover .replace-checkmark { border-color: var(--accent); }
    .replace-item-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
    .replace-item-n { color: var(--fg-muted); flex-shrink: 0; }
</style>
