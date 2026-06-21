<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import * as monaco from 'monaco-editor';
    import { resolveMonacoTheme } from './theme.js';

    let {
        value = $bindable(''),
        language = 'javascript',
        onSave,
    }: {
        value?: string;
        language?: string;
        onSave?: () => void;
    } = $props();

    let container: HTMLDivElement;
    let editor: monaco.editor.IStandaloneCodeEditor;
    let ignoring = false;

    function syncTheme() {
        monaco.editor.setTheme(resolveMonacoTheme());
    }

    onMount(() => {
        const langOpts: Partial<monaco.editor.IStandaloneEditorConstructionOptions> =
            language === 'json'
                ? { formatOnPaste: true, autoIndent: 'full' }
                : {};

        editor = monaco.editor.create(container, {
            value,
            language,
            theme: resolveMonacoTheme(),
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 13,
            fontFamily: "'Cascadia Code', 'Fira Code', monospace",
            automaticLayout: true,
            wordWrap: 'on',
            lineNumbers: 'on',
            renderLineHighlight: 'none',
            overviewRulerLanes: 0,
            scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
            ...langOpts,
        });

        editor.onDidChangeModelContent(() => {
            if (ignoring) return;
            value = editor.getValue();
        });

        if (onSave) {
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave());
        }

        // React to app theme changes and OS preference changes
        window.addEventListener('she:theme-changed', syncTheme);
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        mq.addEventListener('change', syncTheme);

        return () => {
            window.removeEventListener('she:theme-changed', syncTheme);
            mq.removeEventListener('change', syncTheme);
        };
    });

    onDestroy(() => editor?.dispose());

    // Sync when parent changes value (e.g. selecting a different document)
    $effect(() => {
        if (!editor || editor.getValue() === value) return;
        ignoring = true;
        editor.setValue(value);
        ignoring = false;
    });
</script>

<div bind:this={container} class="me"></div>

<style>
    .me { width: 100%; height: 100%; }
</style>
