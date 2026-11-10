/* global she */
'use strict';

// she.mqtt.command against the test broker: each case is started by a trigger topic and logs its
// outcome, so the integration test can publish the status echo itself.

// the lint at load: a literal publish to a status topic
she.mqtt.pub('lint/status/lamp/STATE', 1);

function report(name, p) {
    p.then(
        (r) => she.log(`command ${name} ok`, r),
        (e) => she.log(`command ${name} failed`, e.reason, e.topic, e.payload, e.tries),
    );
}

she.mqtt.sub('cmdtest/trigger/echo', () => report('echo', she.mqtt.command('cmd/set/lamp/STATE', 1, { timeout: 2 })));
she.mqtt.sub('cmdtest/trigger/timeout', () => report('timeout', she.mqtt.command('cmd/set/lamp/LEVEL', 0.5, { timeout: 1, retries: 1 })));
she.mqtt.sub('cmdtest/trigger/offline', () => report('offline', she.mqtt.command('offline/set/lamp/STATE', 1)));
she.mqtt.sub('cmdtest/trigger/z2m', () => report('z2m', she.mqtt.command('z2m/lamp/set', { state: 'ON' }, { timeout: 2 })));
she.mqtt.sub('cmdtest/trigger/already', () => report('already', she.mqtt.command('cmd/set/lamp/STATE', 1)));
she.mqtt.sub('cmdtest/trigger/pending', () => report('pending', she.mqtt.command('cmd/set/lamp/LONG', 1, { timeout: 60 })));

// { status: true }: a deliberate publish to a status topic is not warned about; an unmarked one is
she.mqtt.sub('cmdtest/trigger/statuspub', () => {
    const base = ['lint', 'status', 'derived'].join('/');
    she.mqtt.pub(base + '/MARKED', 1, { retain: true, status: true });
    she.mqtt.pub(base + '/UNMARKED', 1);
    she.log('statuspub done');
});
