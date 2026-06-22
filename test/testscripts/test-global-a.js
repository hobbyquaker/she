/* global she */
'use strict';

she.mqtt.sub('test/global/set', (topic, val) => {
    she.global.testShared = val;
});
