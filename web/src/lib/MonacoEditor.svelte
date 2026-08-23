<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import * as monaco from 'monaco-editor';
    import { resolveMonacoTheme } from './theme.js';

    let {
        value = $bindable(''),
        language = 'javascript',
        onSave,
        jsonSchema = null,
        markers = null,
        onMarkers,
    }: {
        value?: string;
        language?: string;
        onSave?: () => void;
        /** JSON Schema to validate a json document against (registered for this editor's model only) */
        jsonSchema?: object | null;
        /** externally computed markers (e.g. a YAML parse error) shown in the gutter */
        markers?: monaco.editor.IMarkerData[] | null;
        /** called with the current markers of this editor's model whenever they change */
        onMarkers?: (markers: monaco.editor.IMarker[]) => void;
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

        const markerSub = onMarkers
            ? monaco.editor.onDidChangeMarkers((uris) => {
                  const model = editor.getModel();
                  if (!model || !uris.some((u) => u.toString() === model.uri.toString())) return;
                  onMarkers!(monaco.editor.getModelMarkers({ resource: model.uri }));
              })
            : null;

        // React to app theme changes and OS preference changes
        window.addEventListener('she:theme-changed', syncTheme);
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        mq.addEventListener('change', syncTheme);

        return () => {
            window.removeEventListener('she:theme-changed', syncTheme);
            mq.removeEventListener('change', syncTheme);
            markerSub?.dispose();
            if (schemaRegistered) unregisterSchema();
        };
    });

    // ── JSON schema for this model (the json language service matches schemas by model URI) ──
    let schemaRegistered = false;
    function schemaUri(): string {
        return 'she://schema/' + (editor?.getModel()?.uri.toString() ?? 'none');
    }
    function unregisterSchema() {
        const opts = monaco.languages.json.jsonDefaults.diagnosticsOptions;
        monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ ...opts, schemas: (opts.schemas ?? []).filter((x) => x.uri !== schemaUri()) });
        schemaRegistered = false;
    }
    $effect(() => {
        if (!editor || language !== 'json') return;
        const model = editor.getModel();
        if (!model) return;
        const opts = monaco.languages.json.jsonDefaults.diagnosticsOptions;
        const others = (opts.schemas ?? []).filter((x) => x.uri !== schemaUri());
        if (jsonSchema) {
            monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
                ...opts,
                validate: true,
                schemas: [...others, { uri: schemaUri(), fileMatch: [model.uri.toString()], schema: jsonSchema }],
            });
            schemaRegistered = true;
        } else if (schemaRegistered) {
            unregisterSchema();
        }
    });

    // ── external markers (yaml lint) ──
    $effect(() => {
        if (!editor) return;
        const model = editor.getModel();
        if (!model) return;
        monaco.editor.setModelMarkers(model, 'she-external', markers ?? []);
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
