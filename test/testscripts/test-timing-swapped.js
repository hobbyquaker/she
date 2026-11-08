/* global she */
'use strict';

// she.mqtt.timer with ms and target swapped throws a TypeError naming the signature (here from a
// callback, so the test can trigger it; at the top level the same error ends the script's load)
she.mqtt.sub('timing/swap', () => {
    she.mqtt.timer(['timing/motion'], 'timing/presence', 5 * 60 * 1000);
    she.info('timing-swapped-reached');
});
