import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import monacoEditorPlugin from 'vite-plugin-monaco-editor';

export default defineConfig({
    plugins: [svelte(), monacoEditorPlugin.default({})],
    build: {
        outDir: '../dist/web',
        emptyOutDir: true,
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
