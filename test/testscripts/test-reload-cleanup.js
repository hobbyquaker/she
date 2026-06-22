/* global she */
'use strict';
she.info('test-reload-cleanup.js running');
she.mqtt.sub('ns/cleanup-test', (t, v) => { she.info('cleanup-fired ' + v); });

// reload trigger
