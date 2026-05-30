/* global she */
'use strict';

// Round-trip test for she.mqtt.* namespace delegates.

// Receives a number on ns/ping, publishes it incremented by 1 on ns/pong.
she.mqtt.sub('ns/ping', (topic, val) => {
    she.mqtt.pub('ns/pong', String(Number(val) + 1));
});

// Logs the current value of ns/source (via she.mqtt.get) when the topic changes.
she.mqtt.sub('ns/source', () => {
    she.info('ns/source via mqtt.get ' + she.mqtt.get('ns/source'));
});
