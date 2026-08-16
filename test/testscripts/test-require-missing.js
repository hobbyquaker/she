/* global she */
'use strict';

require('./nonexistent-module-xyz.js');
she.info('unreachable-after-missing-require');
