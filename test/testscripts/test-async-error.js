/* global she */
'use strict';

she.mqtt.sub('test/async-error', async () => {
    throw new Error('async-muh');
});
