'use strict';

const { redactConfig, redactUrl, isSecretKey } = require('../../src/lib/redact-config');

describe('redactConfig()', () => {
    const config = {
        '_': [],
        '$0': 'she',
        'url': 'mqtt://she:Sup3rSecret@broker.example:1883',
        'port': 8080,
        'p': 8080,
        'data-dir': '/var/lib/she',
        'dataDir': '/var/lib/she',
        'name': 'she',
        'verbosity': 'debug',
        'auth': 'password',
        'password': '$2a$10$hashOfTheUiPassword',
        'apiKey': 'sk-ant-abcdef',
        'mqttKey': '/etc/she/client.key',
        'brokers': { shed: { url: 'mqtts://garden:Pl4nts@shed.local:8883', password: 'Pl4nts', mirror: [{ from: 'tele/#' }] } },
        'broker': { dynsec: { adminUsername: 'admin', adminPassword: 'DynSecr3t' }, ssh: { user: 'root', privateKey: '-----BEGIN KEY-----' } },
        'influx': { url: 'http://influx:8086', token: 'influxTok3n', org: 'home' },
        'elastic': { node: 'https://elastic:El4stic@es.local:9200', auth: { apiKey: 'esKey', password: 'El4stic' } },
        'redis': { url: 'redis://:R3dis@localhost:6379' },
        'holidays': ['DE', 'DE-HH'],
        'safeMode': false,
        'scriptTimeout': 5000,
    };

    it('masks every secret and strips URL credentials, and the result is deep-copied', () => {
        const out = redactConfig(config);
        const text = JSON.stringify(out);
        for (const secret of ['Sup3rSecret', 'hashOfTheUiPassword', 'sk-ant-abcdef', 'Pl4nts', 'DynSecr3t', 'BEGIN KEY', 'influxTok3n', 'El4stic', 'esKey', 'R3dis']) {
            expect(text).not.toContain(secret);
        }
        expect(out.url).toBe('mqtt://***:***@broker.example:1883');
        expect(out.password).toBe('***');
        expect(out.apiKey).toBe('***');
        expect(out.mqttKey).toBe('***');
        expect(out.brokers.shed).toEqual({ url: 'mqtts://***:***@shed.local:8883', password: '***', mirror: [{ from: 'tele/#' }] });
        expect(out.broker.dynsec).toEqual({ adminUsername: 'admin', adminPassword: '***' });
        expect(out.broker.ssh).toEqual({ user: 'root', privateKey: '***' });
        expect(out.influx).toEqual({ url: 'http://influx:8086', token: '***', org: 'home' });
        expect(out.elastic).toEqual({ node: 'https://***:***@es.local:9200', auth: { apiKey: '***', password: '***' } });
        expect(out.redis.url).toBe('redis://***:***@localhost:6379');
        // the safe scalars stay
        expect(out).toMatchObject({ port: 8080, name: 'she', verbosity: 'debug', auth: 'password', holidays: ['DE', 'DE-HH'], safeMode: false, scriptTimeout: 5000 });
        // the original is untouched
        expect(config.url).toBe('mqtt://she:Sup3rSecret@broker.example:1883');
        expect(config.brokers.shed.password).toBe('Pl4nts');
    });

    it("drops yargs' bookkeeping: _, $0, single-letter aliases and the kebab-case twins", () => {
        const out = redactConfig(config);
        expect(out).not.toHaveProperty('_');
        expect(out).not.toHaveProperty('$0');
        expect(out).not.toHaveProperty('p');
        expect(out).not.toHaveProperty('data-dir');
        expect(out.dataDir).toBe('/var/lib/she');
    });

    it('is a string without [object Object] when logged the way the daemon does', () => {
        const line = 'loaded config: ' + JSON.stringify(redactConfig(config));
        expect(line).not.toContain('[object Object]');
        expect(line).toContain('"name":"she"');
    });

    it('leaves empty secrets, numbers, booleans and non-URL strings alone; a list under a secret key is masked', () => {
        expect(redactConfig({ password: '', port: 1, flag: true, dir: '/x', apiKeys: ['a'] })).toEqual({ password: '', port: 1, flag: true, dir: '/x', apiKeys: ['***'] });
        expect(redactConfig(null)).toBeNull();
    });
});

describe('redactUrl() and isSecretKey()', () => {
    it('strips only userinfo', () => {
        expect(redactUrl('mqtt://localhost')).toBe('mqtt://localhost');
        expect(redactUrl('mqtt://u:p@h:1883/path?x=1')).toBe('mqtt://***:***@h:1883/path?x=1');
        expect(redactUrl('mqtt://u@h')).toBe('mqtt://***:***@h');
        expect(redactUrl('not a url')).toBe('not a url');
        expect(redactUrl('mqtt://user:p@ss@h')).toBe('mqtt://***:***@h');
    });
    it('matches the secret keys', () => {
        for (const k of ['password', 'mqttPassword', 'adminPassword', 'token', 'apiKey', 'secretsKey', 'privateKey', 'passphrase', 'SECRET']) expect(isSecretKey(k)).toBe(true);
        for (const k of ['url', 'name', 'keys', 'dataDir', 'adminUsername', 'keyboard']) expect(isSecretKey(k)).toBe(false);
    });
});
