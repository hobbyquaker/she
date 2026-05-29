// @ts-check
import js from '@eslint/js';
import n from 'eslint-plugin-n';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

export default [
    {
        ignores: ['.cache/**', 'node_modules/**', 'coverage/**', 'test/testscripts/**'],
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
        files: ['test.js'],
        languageOptions: {
            globals: {
                ...globals.jest,
            },
        },
    },
    prettierRecommended,
];
