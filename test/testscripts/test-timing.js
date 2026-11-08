/* global she */
'use strict';

// Timing helpers and the sub/pub options: the daemon-side wiring of the timing library.

// sub with debounce (seconds): one callback per bundle, objPrev from before the first bundled event
she.mqtt.sub(['timing/a', 'timing/b'], { debounce: 0.5, maxWait: 2 }, (topic, val, obj, objPrev) => {
    she.info('timing-debounced ' + topic + ' ' + val + ' prev=' + (objPrev ? objPrev.val : 'none'));
});

// pub with changed: the same payload twice reaches the broker once
she.mqtt.sub('timing/pub-trigger', (topic, val) => {
    she.mqtt.pub('timing/changed-out', val, { changed: true });
    she.info('timing-pub-done ' + val);
});

// a restartable timeout, armed from a callback; a reload must clear it
const off = she.timeout(3000, () => she.info('timing-timeout-fired'), { name: 'off' });
she.mqtt.sub('timing/arm', () => {
    off.restart();
    she.info('timing-armed pending=' + off.pending());
});

// a debounce with flushOnUnload: the pending run happens once when the script is unloaded
const flushed = she.debounce((v) => she.info('timing-flushed ' + v), 60000, { flushOnUnload: true, name: 'flush-me' });
she.mqtt.sub('timing/flush-later', (topic, val) => flushed(val));

// a delay that is not a number is reported with the script's name and runs at once
she.mqtt.sub('timing/bad-delay', () => {
    setTimeout(() => she.info('timing-bad-delay-fired'), '5m');
});

// she.setTimeout is an alias of the sandbox setTimeout
she.mqtt.sub('timing/alias', () => {
    const id = she.setTimeout(() => she.info('timing-alias-fired'), 10);
    she.info('timing-alias-id ' + typeof id);
});
