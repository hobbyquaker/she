/* global she */
'use strict';

// What the runtime model should list for this script: a subscription, a variable listener, a
// schedule, an interval, a long one-shot timer and a debounce — plus a route to arm timers on demand.

she.mqtt.sub('runtime/input', { change: true }, (topic, val) => {
    she.log('runtime input', val);
    if (val === 'throw') throw new Error('runtime test error');
});

she.on('var::runtimeVar', () => {});

she.schedule('0 3 * * *', () => she.log('runtime schedule ran'));

setInterval(() => {}, 60000);

setTimeout(() => she.log('runtime long timer fired'), 3600000);

const bundle = she.debounce(() => she.log('runtime debounce ran'), 3600000, { name: 'runtime bundle' });

she.api.get('/arm', () => {
    bundle();
    return { ok: true };
});
