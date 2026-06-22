/* global she */
'use strict';

she.mqtt.sub('test/global/get', () => {
    she.mqtt.pub('test/global/result', String(she.global.testShared ?? 'undefined'));
});
