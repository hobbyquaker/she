// @ts-check
import js from '@eslint/js';
import n from 'eslint-plugin-n';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

export default [
    {
        ignores: ['.cache/**', 'node_modules/**', 'coverage/**', 'test/testscripts/**', 'dist/**'],
    },
    {
        linterOptions: {
            reportUnusedDisableDirectives: 'off',
        },
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 'latest',
            globals: {
                ...globals.node,
                ...globals.commonjs,
            },
        },
        plugins: { n },
        rules: {
            'n/no-deprecated-api': 'warn',
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        },
    },
    {
        files: ['test/**/*.test.js', 'test/**/*.spec.js'],
        languageOptions: {
            globals: {
                ...globals.jest,
            },
        },
    },
    {
        // *.svelte.js fixtures are compiled by the Svelte compiler, not run by node: runes are theirs
        files: ['**/*.svelte.js'],
        languageOptions: {
            sourceType: 'module',
            globals: { $state: 'readonly', $derived: 'readonly', $effect: 'readonly', $props: 'readonly', $bindable: 'readonly' },
        },
    },
    prettierRecommended,
];
