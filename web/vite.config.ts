import { createRequire } from 'module';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import monacoEditorPlugin from 'vite-plugin-monaco-editor';

const require = createRequire(import.meta.url);
const { version } = require('./package.json') as { version: string };

export default defineConfig({
    define: {
        __APP_VERSION__: JSON.stringify(version),
    },
    plugins: [
        svelte({
            onwarn(warning, handler) {
                // a11y warnings are suppressed per-element with svelte-ignore;
                // vite-plugin-svelte echoes them anyway — silence them globally.
                if (warning.code.startsWith('a11y')) return;
                handler(warning);
            },
        }),
        monacoEditorPlugin.default({
            // Include editor base worker + JavaScript/TypeScript + JSON workers
            languageWorkers: ['editorWorkerService', 'typescript', 'json'],
        }),
    ],
    build: {
        outDir: '../dist/web',
        emptyOutDir: true,
        rollupOptions: {
            output: {
                // Consolidate Monaco's 80+ per-language syntax files and unused
                // language services (CSS/HTML) into one lazy chunk.
                // tsMode (JS/TS) and json stay separate — both workers are active.
                manualChunks(id) {
                    if (
                        id.includes('monaco-editor/esm/vs/basic-languages') ||
                        id.includes('monaco-editor/esm/vs/language/css') ||
                        id.includes('monaco-editor/esm/vs/language/html')
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
