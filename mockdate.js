#!/usr/bin/env node

const FakeTimers = require('@sinonjs/fake-timers');

FakeTimers.install({ now: new Date(2020, 0, 1, 23, 59, 20), shouldAdvanceTime: true, toFake: ['Date'] });

require('./src/index.js');
