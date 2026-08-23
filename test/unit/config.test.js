'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// src/config.js parses process.argv + the environment once, at require time.
// Every case therefore sets up argv/env first and then requires a fresh module.
function loadConfig(argv = [], env = {}) {
    jest.resetModules();
    const prevArgv = process.argv;
    const prevEnv = {};
    for (const k of Object.keys(env)) {
        prevEnv[k] = process.env[k];
        if (env[k] === undefined) delete process.env[k];
        else process.env[k] = env[k];
    }
    process.argv = ['node', 'she', ...argv];
    try {
        return require('../../src/config');
    } finally {
        process.argv = prevArgv;
        for (const k of Object.keys(prevEnv)) {
            if (prevEnv[k] === undefined) delete process.env[k];
            else process.env[k] = prevEnv[k];
        }
    }
}

describe('config: environment variables', () => {
    let tmpDir, configFile;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-config-test-'));
        configFile = path.join(tmpDir, 'config.json');
        fs.writeFileSync(configFile, JSON.stringify({ port: 9000, name: 'fromfile' }));
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // Keep the developer's real ~/.she/config/config.json out of every case
    const args = (...extra) => ['--config', configFile, ...extra];

    test('an option can be set from the environment', () => {
        const c = loadConfig(args(), { SHE_VERBOSITY: 'debug' });
        expect(c.verbosity).toBe('debug');
    });

    test('numbers and booleans are coerced, not left as strings', () => {
        const c = loadConfig(args(), { SHE_PORT: '1234', SHE_DISABLE_WATCH: 'true', SHE_LATITUDE: '52.52' });
        expect(c.port).toBe(1234);
        expect(c.latitude).toBe(52.52);
        expect(c.disableWatch).toBe(true);
    });

    test('a bare default without a declared type would arrive as a truthy string', () => {
        // Regression guard: these three are booleans that default to false, so an
        // untyped `SHE_DISABLE_WATCH=false` ("false" is truthy) would silently invert them.
        const c = loadConfig(args(), { SHE_DISABLE_WATCH: 'false', SHE_DISABLE_VARIABLES: 'false', SHE_DB_RETAIN: 'false' });
        expect(c.disableWatch).toBe(false);
        expect(c.disableVariables).toBe(false);
        expect(c.dbRetain).toBe(false);
    });

    test('a boolean env var can turn a default-on option off', () => {
        const c = loadConfig(args(), { SHE_SAFE_MODE_AUTO_DETECT: 'false' });
        expect(c.safeModeAutoDetect).toBe(false);
    });

    test('the documented precedence holds: CLI > env > config file > default', () => {
        expect(loadConfig(args()).port).toBe(9000); // config file
        expect(loadConfig(args(), { SHE_PORT: '1234' }).port).toBe(1234); // env over file
        expect(loadConfig(args('--port', '7777'), { SHE_PORT: '1234' }).port).toBe(7777); // CLI over env
        expect(loadConfig(['--config', path.join(tmpDir, 'missing.json')]).port).toBe(8080); // default
    });

    test('SHE_SECRETS_KEY is not an option and never reaches the config object', () => {
        // The config object is debug-logged at startup — the master key must not be in it.
        const c = loadConfig(args(), { SHE_SECRETS_KEY: 'a'.repeat(64) });
        expect('secretsKey' in c).toBe(false);
        expect('secrets-key' in c).toBe(false);
        expect(JSON.stringify(c)).not.toContain('a'.repeat(64));
    });

    test('SHELL does not leak in through the prefix match', () => {
        // yargs matches the env prefix as a plain string: with 'SHE' instead of 'SHE_',
        // SHELL would land in the config as `ll`.
        const c = loadConfig(args(), { SHELL: '/bin/zsh' });
        expect('ll' in c).toBe(false);
    });
});
