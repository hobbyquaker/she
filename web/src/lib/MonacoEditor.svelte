<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import * as monaco from 'monaco-editor';

    let {
        value = $bindable(''),
        language = 'javascript',
    }: {
        value?: string;
        language?: string;
    } = $props();

    let container: HTMLDivElement;
    let editor: monaco.editor.IStandaloneCodeEditor;
    let ignoring = false;

    onMount(() => {
        const langOpts: Partial<monaco.editor.IStandaloneEditorConstructionOptions> =
            language === 'json'
                ? { formatOnPaste: true, autoIndent: 'full' }
                : {};

        editor = monaco.editor.create(container, {
            value,
            language,
            theme: 'vs-dark',
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
