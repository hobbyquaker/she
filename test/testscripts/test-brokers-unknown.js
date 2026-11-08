/* global she */
'use strict';

// an additional broker that is not configured: a TypeError at load, not a silent nothing
she.mqtt('nope').sub('a', () => {});
