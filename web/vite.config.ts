import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import monacoEditorPlugin from 'vite-plugin-monaco-editor';

export default defineConfig({
    plugins: [
        svelte(),
        monacoEditorPlugin.default({
            // Only include editor base worker + JavaScript/TypeScript worker
            languageWorkers: ['editorWorkerService', 'typescript'],
        }),
    ],
    build: {
        outDir: '../dist/web',
        emptyOutDir: true,
        rollupOptions: {
            output: {
                // Consolidate Monaco's 80+ per-language syntax files and unused
                // language services (CSS/HTML/JSON) into one lazy chunk.
                // Only tsMode (JavaScript/TypeScript) stays separate as it is needed.
                manualChunks(id) {
                    if (
                        id.includes('monaco-editor/esm/vs/basic-languages') ||
                        id.includes('monaco-editor/esm/vs/language/css') ||
                        id.includes('monaco-editor/esm/vs/language/html') ||
                        id.includes('monaco-editor/esm/vs/language/json')
                    ) {
                        return 'monaco-langs';
                    }
                },
            },
        },
    },
    server: {
        proxy: {
            '/she': 'http://localhost:1884',
            '/api': 'http://localhost:1884',
            '/she/ws': {
                target: 'ws://localhost:1884',
                ws: true,
            },
        },
    },
});
