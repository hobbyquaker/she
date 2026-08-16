/* global she */
'use strict';

she.mqtt.sub('test/age/trigger', () => {
    she.info('age-result ' + she.mqtt.age('test/age/value'));
});
