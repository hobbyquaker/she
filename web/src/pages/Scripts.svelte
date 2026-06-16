<script lang="ts">
    import { onMount, onDestroy, tick } from 'svelte';
    import * as monaco from 'monaco-editor';
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
        type GitStatus,
        type GitCommit,
        type TreeEntry,
        type AiExtraFile,
    } from '../lib/api.js';
    import { subscribeLog, type LogEntry } from '../lib/ws.js';
    import ConfirmDialog from '../lib/ConfirmDialog.svelte';
    import InputDialog from '../lib/InputDialog.svelte';
    import Chat from './Chat.svelte';
    import { registerCompletionProviders } from '../lib/completions.js';

    interface Tab {
        path: string;
        dirty: boolean;
        savedContent: string;
        model: monaco.editor.ITextModel | null;
        logEntries: LogEntry[];
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
    let logPanelOpen = $state(true);
    let gitInfo = $state<GitStatus | null>(null);
    let gitAutoCommit = $state(false);
    let gitAutoPush   = $state(false);

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
    let chatExtraFiles = $state<AiExtraFile[]>([]);

    // Script log panel filters
    let logFilterLevel = $state<'all' | 'debug' | 'info' | 'warn' | 'error'>('all');
    let logFilterText = $state('');
    let logFilterRegex = $state(false);
    const LOG_LEVELS = ['all', 'debug', 'info', 'warn', 'error'] as const;
    const LOG_LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const;

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
    let _treeLoaded = false;
    let _mounted = false;

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
    let asideWidth = $state(parseInt(localStorage.getItem('she-scripts-sidebar-width') ?? '220', 10));
    let logHeight = $state(parseInt(localStorage.getItem('she-scripts-log-height') ?? '130', 10));
    let chatWidth = $state(parseInt(localStorage.getItem('she-scripts-chat-width') ?? '340', 10));
    let historyPanelHeight = $state(parseInt(localStorage.getItem('she-scripts-history-height') ?? '220', 10));
    let sidebarResizing = false, sidebarResizeStartX = 0, sidebarResizeStartW = 0;
    let logResizing = false, logResizeStartY = 0, logResizeStartH = 0;
    let chatResizing = false, chatResizeStartX = 0, chatResizeStartW = 0;
    let historyPanelResizing = false, historyPanelResizeStartY = 0, historyPanelResizeStartH = 0;

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
    let commitAllMsg     = $state('');
    let commitAllBusy    = $state(false);
    let commitAllErr     = $state('');

    async function commitAllChanges() {
        if (!commitAllMsg.trim()) return;
        commitAllBusy = true;
        commitAllErr  = '';
        try {
            await commitAll(commitAllMsg.trim());
            if (gitAutoPush) try { await gitPush(); } catch { /* ignore */ }
            commitAllMsg = '';
            changesPopupOpen = false;
            await loadGitStatus();
        } catch (e: any) {
            commitAllErr = e.message;
        } finally {
            commitAllBusy = false;
        }
    }

    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean }): Promise<boolean> };
    let inputDialog: { show(msg: string, opts?: { placeholder?: string; confirm?: string; initial?: string }): Promise<string | null> };

    let currentTab = $derived(tabs.find(t => t.path === activeTab) ?? null);

    const TABS_KEY   = 'she-tabs';
    const ACTIVE_KEY = 'she-active-tab';
    const LOG_KEY    = 'she-log-open';
    const CHAT_KEY   = 'she-chat-open';

    let { active = true }: { active?: boolean } = $props();

    $effect(() => {
        if (!_mounted) return;
        localStorage.setItem(TABS_KEY, JSON.stringify(tabs.map(t => t.path)));
        if (activeTab) localStorage.setItem(ACTIVE_KEY, activeTab);
        else           localStorage.removeItem(ACTIVE_KEY);
    });

    $effect(() => {
        if (!_mounted) return;
        localStorage.setItem(CHAT_KEY, String(chatOpen));
    });

    // Re-layout Monaco when the Scripts panel becomes visible after being hidden.
    $effect(() => {
        if (active && editor) editor.layout();
    });

    // Monaco sandbox type stubs for she API autocomplete
    const she_dts = `
declare const she: {
    log(...args: any[]): void;
    info(...args: any[]): void;
    debug(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
    now(): number;
    /** Schedule with a cron string, Date, node-schedule literal, array of any of those,
     *  or a suncalc event name ('sunrise', 'sunset', 'dawn', 'dusk', …) for solar scheduling.
     *  opts.shift (seconds) offsets solar events; opts.random adds a random delay. */
    schedule(pattern: string | Date | object | (string | Date | object)[], opts?: { shift?: number; random?: number }, cb?: () => void): void;
    combineBool(srcs: string[], target: string): void;
    combineMax(srcs: string[], target: string): void;
    timer(src: string | string[], target: string, time: number): void;
    mqtt: {
        sub(topic: string | string[], opts?: any, cb?: (topic: string, val: any, obj: any, prev: any, msg: any) => void): void;
        pub(topic: string | string[], payload: any, opts?: { qos?: number; retain?: boolean }): void;
        get(topic: string): any;
        set(topic: string | string[], val: any): void;
        getProp(topic: string, ...prop: string[]): any;
        link(source: string | string[], target: string | string[], value?: any): void;
        age(topic: string): number;
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

    onMount(async () => {
        logPanelOpen = localStorage.getItem(LOG_KEY) !== 'false';
        chatOpen     = localStorage.getItem(CHAT_KEY) === 'true';

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
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
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
                if (tab.path === activeTab && logPanelOpen && logEl) {
                    tick().then(() => { if (logEl) logEl.scrollTop = logEl.scrollHeight; });
                }
            }
        });

        await loadTree();
        loadGitStatus();
        try {
            const cfg = await getConfig() as Record<string, unknown>;
            if (typeof cfg.gitAutoCommit === 'boolean') gitAutoCommit = cfg.gitAutoCommit;
            if (typeof cfg.gitAutoPush   === 'boolean') gitAutoPush   = cfg.gitAutoPush;
        } catch { /* best effort */ }

        const savedPaths = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]') as string[];
        const savedActive = localStorage.getItem(ACTIVE_KEY);
        for (const p of savedPaths) {
            await openTabInternal(p, false);
        }
        const restoreActive = savedActive && tabs.some(t => t.path === savedActive)
            ? savedActive : (tabs[0]?.path ?? null);
        if (restoreActive) await switchTab(restoreActive);
        _mounted = true;
    });

    onDestroy(() => {
        if (syntaxCheckTimer) clearTimeout(syntaxCheckTimer);
        unsubLog?.();
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
            if (makeLib) await writeScript(`${dirPath}/.shelib`, '');
            else await deleteScript(`${dirPath}/.shelib`);
            await loadTree();
            await gitAutoAction('all', makeLib ? `lib ${dirPath}` : `unlib ${dirPath}`);
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
            await gitAutoAction('all', makeDisabled ? `disable ${entryPath}` : `enable ${entryPath}`);
        } catch (e: any) { error = e.message; }
    }

    async function openTabInternal(path: string, andSwitch = true) {
        if (tabs.some(t => t.path === path)) {
            if (andSwitch) await switchTab(path);
            return;
        }
        try {
            const { content } = await readScript(path);
            const uri = monaco.Uri.parse(`file:///she-scripts/${encodeURIComponent(path)}`);
            monaco.editor.getModel(uri)?.dispose();
            const model = monaco.editor.createModel(content, langFromPath(path), uri);
            tabs = [...tabs, { path, dirty: false, savedContent: content, model, logEntries: [] }];
            if (andSwitch) await switchTab(path);
        } catch (e: any) { error = (e as Error).message; }
    }

    async function openTab(path: string) { await openTabInternal(path, true); }

    async function switchTab(path: string) {
        const tab = tabs.find(t => t.path === path);
        if (!tab?.model) return;
        closeHistoryDiff();
        proposedCode = null;
        activeTab = path;
        suppressChange = true;
        editor.setModel(tab.model);
        suppressChange = false;
        runSyntaxCheck();
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
    async function gitAutoAction(paths: string[] | 'all', message: string) {
        if (!gitInfo) return;
        try {
            if (paths === 'all') await commitAll(message);
            else await commitFiles(paths, message);
            if (gitAutoPush) try { await gitPush(); } catch { /* ignore push errors */ }
            await loadGitStatus();
        } catch { /* ignore — e.g. nothing to commit */ }
    }

    async function save() {
        if (!activeTab) return;
        const tab = tabs.find(t => t.path === activeTab);
        if (!tab) return;
        saving = true;
        try {
            const value = editor.getValue();
            await writeScript(activeTab, value);
            tab.savedContent = value;
            tab.dirty = false;
            error = '';
            if (gitAutoCommit) {
                await gitAutoAction([activeTab], `update ${activeTab}`);
            } else {
                loadGitStatus();
            }
        } catch (e: any) { error = (e as Error).message; }
        finally { saving = false; }
    }

    async function saveAndCommit() {
        if (!activeTab) return;
        await save();
        if (error) return;
        const msg = await inputDialog.show('Commit message:', { initial: `update ${activeTab}`, placeholder: 'Update script', confirm: 'Commit' });
        if (!msg) return;
        try {
            await commitFile(activeTab, msg);
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
            theme: 'vs-dark',
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
        ctxMenu = { x: e.clientX, y: e.clientY, entry };
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
            await gitAutoAction('all', `rename ${entry.path} → ${target}`);
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
        await gitAutoAction('all', `delete ${entry.path}`);
    }

    async function ctxAddToAiContext(entry: TreeEntry) {
        closeCtxMenu();
        const { content } = await readScript(entry.path);
        if (!chatExtraFiles.some(f => f.name === entry.path)) {
            chatExtraFiles = [...chatExtraFiles, { name: entry.path, content }];
        }
        chatOpen = true;
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
            await gitAutoAction('all', `rename ${src} → ${target}`);
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
        await gitAutoAction('all', `delete ${toDelete}`);
    }

    function clearLog() { if (currentTab) currentTab.logEntries = []; }

    function toggleLogPanel() {
        logPanelOpen = !logPanelOpen;
        localStorage.setItem(LOG_KEY, String(logPanelOpen));
    }

    function fmt(ts: number) {
        return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }

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
    function onSidebarResizeStart(e: MouseEvent) { sidebarResizing = true; sidebarResizeStartX = e.clientX; sidebarResizeStartW = asideWidth; e.preventDefault(); }
    function onLogResizeStart(e: MouseEvent) { logResizing = true; logResizeStartY = e.clientY; logResizeStartH = logHeight; e.preventDefault(); }
    function onChatResizeStart(e: MouseEvent) { chatResizing = true; chatResizeStartX = e.clientX; chatResizeStartW = chatWidth; e.preventDefault(); }
    function onHistoryPanelResizeStart(e: MouseEvent) { historyPanelResizing = true; historyPanelResizeStartY = e.clientY; historyPanelResizeStartH = historyPanelHeight; e.preventDefault(); }

    function onGlobalMouseMove(e: MouseEvent) {
        if (sidebarResizing) asideWidth = Math.max(140, Math.min(500, sidebarResizeStartW + e.clientX - sidebarResizeStartX));
        if (logResizing) logHeight = Math.max(60, Math.min(500, logResizeStartH - (e.clientY - logResizeStartY)));
        if (chatResizing) chatWidth = Math.max(200, Math.min(700, chatResizeStartW - (e.clientX - chatResizeStartX)));
        if (historyPanelResizing) historyPanelHeight = Math.max(80, Math.min(600, historyPanelResizeStartH - (e.clientY - historyPanelResizeStartY)));
    }

    function onGlobalMouseUp() {
        if (sidebarResizing) { sidebarResizing = false; localStorage.setItem('she-scripts-sidebar-width', String(asideWidth)); }
        if (logResizing) { logResizing = false; localStorage.setItem('she-scripts-log-height', String(logHeight)); }
        if (chatResizing) { chatResizing = false; localStorage.setItem('she-scripts-chat-width', String(chatWidth)); }
        if (historyPanelResizing) { historyPanelResizing = false; localStorage.setItem('she-scripts-history-height', String(historyPanelHeight)); }
    }

    function handleKeydown(e: KeyboardEvent) {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { dropdownOpen = false; ctxMenu = null; }
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
            theme: 'vs-dark',
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
            if (gitAutoCommit) {
                await gitAutoAction([activeTab], `update ${activeTab}`);
            } else {
                loadGitStatus();
            }
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

<div class="layout">
    <aside style:width="{asideWidth}px">
        <div class="toolbar">
            <button onclick={newFile} title="New script">+ File</button>
            <button onclick={newFolder} title="New folder">+ Folder</button>
            <button onclick={loadTree} title="Refresh" class="refresh">↻</button>
        </div>
        {#if error}<div class="err">{error}</div>{/if}

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
                {@const ext = (entry.name.split('.').pop() ?? 'txt').toUpperCase()}
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
                        <button class:lib={entry.lib} class:dis={entry.disabled} class:err={hasErr} onclick={() => openTab(entry.path)}>
                            <span class="badge badge-{ext.toLowerCase()}" class:badge-shelib={entry.lib}>{badgeContent(ext)}</span>
                            <span class="fname">{entry.name}</span>
                            {#if isGitMod}<span class="git-mod" title="Uncommitted changes">M</span>{/if}{#if isDirty}<span class="dirty-dot">●</span>{/if}
                            {#if hasErr}<span class="err-dot">●</span>{/if}
                        </button>
                        {#if isJs}
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
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="sidebar-resize-handle" role="separator" onmousedown={onSidebarResizeStart}></div>

    <div class="editor-area">
        {#if tabs.length > 0}
            <div class="tab-bar">
                {#each tabs as tab (tab.path)}
                    <div
                        class="tab"
                        class:active={tab.path === activeTab}
                        onclick={() => switchTab(tab.path)}
                        role="button"
                        tabindex="0"
                        onkeydown={(e) => e.key === 'Enter' && switchTab(tab.path)}
                    >
                        <span class="tab-label">{tab.path.split('/').pop()}</span>
                        {#if tab.dirty}<span class="tab-dirty">●</span>{/if}
                        <button class="tab-close" title="Close" onclick={(e) => { e.stopPropagation(); closeTab(tab.path); }}>×</button>
                    </div>
                {/each}
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
                                onclick={() => { changesPopupOpen = !changesPopupOpen; commitAllErr = ''; }}
                            >✎{gitInfo.changes.length}</button>
                            {#if changesPopupOpen}
                            <div class="changes-backdrop" role="presentation" onclick={() => changesPopupOpen = false}></div>
                            <div class="changes-popup">
                                <div class="changes-popup-hdr">Uncommitted changes</div>
                                <ul class="changes-list">
                                    {#each gitInfo.changes as c}
                                        <li class="changes-item">
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
                                        class="changes-commit-btn"
                                        onclick={commitAllChanges}
                                        disabled={!commitAllMsg.trim() || commitAllBusy}
                                    >{commitAllBusy ? '…' : 'Commit all'}</button>
                                </div>
                                {#if commitAllErr}<div class="changes-err">{commitAllErr}</div>{/if}
                            </div>
                            {/if}
                        </div>
                    {/if}
                    {#if gitInfo.ahead > 0}
                        <span class="git-ahead" title="{gitInfo.ahead} commit(s) ahead of upstream">↑{gitInfo.ahead}</span>
                    {/if}
                    {#if gitInfo.behind > 0}
                        <span class="git-behind" title="{gitInfo.behind} commit(s) behind upstream">↓{gitInfo.behind}</span>
                    {/if}
                </span>
            {/if}
            <div class="split-wrap">
                <div class="split-btn">
                    <button class="split-main" onclick={save} disabled={!currentTab?.dirty || saving}>
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button class="split-arrow" onclick={() => dropdownOpen = !dropdownOpen} disabled={!activeTab} aria-label="Save options">▾</button>
                </div>
                {#if dropdownOpen}
                    <div class="split-backdrop" role="presentation" onclick={() => dropdownOpen = false}></div>
                    <div class="split-menu">
                        <button onclick={() => { dropdownOpen = false; save(); }}>Save</button>
                        <button onclick={() => { dropdownOpen = false; saveAndCommit(); }}>Save & Commit</button>
                        <button onclick={push} disabled={!gitInfo}>Push</button>
                    </div>
                {/if}
            </div>
            {#if activeTab}
                <button onclick={del} class="danger">Delete</button>
            {/if}
            <button
                class="ai-toggle"
                class:ai-open={chatOpen}
                onclick={() => chatOpen = !chatOpen}
                title={chatOpen ? 'Close AI assistant' : 'Open AI assistant'}
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
                    <div class="editor-container" bind:this={editorContainer}></div>
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
                                    <a href="https://github.com/hobbyquaker/she/blob/main/README.md" target="_blank" rel="noopener">README</a>
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

                <div class="log-panel" class:collapsed={!logPanelOpen} style:height={logPanelOpen ? `${logHeight}px` : '26px'}>
                    {#if logPanelOpen}
                        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                        <div class="log-resize-handle" role="separator" onmousedown={onLogResizeStart}></div>
                    {/if}
                    <div class="log-header">
                        <button class="log-toggle" onclick={toggleLogPanel}>
                            {logPanelOpen ? '▾' : '▸'} Script Log
                            {#if activeTab}<span class="log-file"> — {activeTab.split('/').pop()}</span>{/if}
                        </button>
                        {#if logPanelOpen}
                            <select class="log-filter-level" bind:value={logFilterLevel}>
                                {#each LOG_LEVELS as l}<option value={l}>{l}</option>{/each}
                            </select>
                            <input class="log-filter-text" type="search" placeholder="Filter…" bind:value={logFilterText} />
                            <label class="log-filter-regex" title="Interpret filter as a regular expression">
                                <input type="checkbox" bind:checked={logFilterRegex} />
                                <span class="log-filter-checkmark"></span>
                                Regex
                            </label>
                            <button class="log-clear" onclick={clearLog}>Clear</button>
                        {/if}
                    </div>
                    {#if logPanelOpen}
                        <div class="log-body" bind:this={logEl}>
                            {#each (currentTab?.logEntries ?? []).filter(logEntryVisible) as e (e.ts + e.msg)}
                                <div class="log-line {e.level}">
                                    <span class="ts">{fmt(e.ts)}</span>
                                    <span class="lvl">{e.level.toUpperCase()}</span>
                                    <span class="msg">{e.msg}</span>
                                </div>
                            {/each}
                            {#if (currentTab?.logEntries.length ?? 0) === 0}
                                <span class="log-empty">No log output for this script.</span>
                            {/if}
                        </div>
                    {/if}
                </div>
            </div>

            {#if chatOpen}
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <div class="chat-resize-handle" role="separator" onmousedown={onChatResizeStart}></div>
                <div class="chat-container" style:width="{chatWidth}px">
                    <Chat currentScript={chatScript} {onApply} {onCreateFile} bind:extraFiles={chatExtraFiles} />
                </div>
            {/if}
        </div>
    </div>
</div>

<style>
    .layout { display: flex; height: 100%; }

    aside {
        min-width: 140px; max-width: 500px; flex-shrink: 0;
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
    .git-mod { color: #e2c08d; font-size: 10px; font-weight: 600; flex-shrink: 0; }
    .err { color: var(--fg-err); padding: 8px; font-size: 12px; }

    .editor-area { flex: 1; display: flex; flex-direction: column; min-width: 0; }

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

    /* Resize handles */
    .sidebar-resize-handle {
        width: 5px; cursor: col-resize; flex-shrink: 0;
        background: var(--border-sub); transition: background 0.15s;
    }
    .sidebar-resize-handle:hover, .sidebar-resize-handle:active { background: var(--accent); }

    .log-resize-handle {
        height: 5px; cursor: row-resize; flex-shrink: 0;
        background: var(--border-sub); transition: background 0.15s;
    }
    .log-resize-handle:hover, .log-resize-handle:active { background: var(--accent); }

    .chat-resize-handle {
        width: 5px; cursor: col-resize; flex-shrink: 0;
        background: var(--border-sub); transition: background 0.15s;
    }
    .chat-resize-handle:hover, .chat-resize-handle:active { background: var(--accent); }

    .chat-container {
        display: flex; flex-direction: column;
        min-width: 200px; max-width: 700px; flex-shrink: 0;
    }

    .tab-bar {
        display: flex; overflow-x: auto; background: var(--bg-app);
        border-bottom: 1px solid var(--border-sub); flex-shrink: 0; height: 35px; scrollbar-width: none;
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
    .tab-close {
        background: none; border: none; color: var(--fg-muted); cursor: pointer;
        font-size: 14px; padding: 0; width: 16px; height: 16px;
        display: flex; align-items: center; justify-content: center; border-radius: 2px; flex-shrink: 0;
    }
    .tab-close:hover { background: var(--bg-hover); color: var(--fg); }

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
    .changes-commit-btn:not(:disabled):hover { background: var(--accent-hov); }
    .changes-err { padding: 4px 10px 6px; font-size: 11px; color: var(--fg-err); }
    .git-ahead { color: #4fc1ff; font-weight: 600; }
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

    .log-panel {
        flex-shrink: 0; display: flex; flex-direction: column;
        border-top: 1px solid var(--border-sub);
    }
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
    .welcome {
        position: absolute; inset: 0; z-index: 5;
        background: var(--bg-app);
        display: flex; align-items: center; justify-content: center;
    }
    .welcome-inner {
        max-width: 480px; text-align: center; padding: 32px 24px;
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
</style>
