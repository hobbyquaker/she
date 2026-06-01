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
