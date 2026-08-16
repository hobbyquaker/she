/* global she */
'use strict';

// lib/libtest2.js throws a ReferenceError while loading — the require must
// propagate it and stop this script.
require('./lib/libtest2.js');
she.info('unreachable-after-failing-require');
