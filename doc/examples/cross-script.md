# Examples — Cross-Script Patterns

Scripts run independently but can share state and communicate through a few well-defined mechanisms.

---

## she.global — shared plain object

`she.global` is a plain object available to every running script. Use it to pass values or pre-computed results without going through MQTT.

```js
// script-a.js — producer
she.global.lastMotion = {};

she.mqtt.sub('home/motion/#', { change: true }, (topic, val) => {
    if (val) she.global.lastMotion[topic] = Date.now();
});
```

```js
// script-b.js — consumer
she.api.get('/last-motion', () => she.global.lastMotion || {});
```

Because scripts load in filesystem order, guard against `she.global.x` not existing yet with `?.` or a default:

```js
const ts = she.global.lastMotion?.['home/motion/hall'] ?? null;
```

---

## Library script — shared utilities

Create a script in a `lib/` subdirectory (mark the folder as a Library in the file tree so she doesn't auto-execute it). Require it like any other Node.js module.

```js
// scripts/lib/utils.js
module.exports = {
    toPercent(val, min, max) {
        return Math.round(((val - min) / (max - min)) * 100);
    },
    formatTemp(val) {
        return `${parseFloat(val).toFixed(1)} °C`;
    },
};
```

```js
// scripts/heating.js
const utils = require('./lib/utils');

she.mqtt.sub('home/sensor/living/temp', { change: true }, (topic, val) => {
    she.info('living room:', utils.formatTemp(val));
});
```

---

## Cross-script event bus using Node.js EventEmitter

`she.global` can hold any object — including a Node.js `EventEmitter`. This gives you a lightweight in-process event bus without MQTT overhead or broker dependency.

Put the setup in a script that loads first (e.g. `00-init.js`):

```js
// scripts/00-init.js
const { EventEmitter } = require('events');
she.global.bus = new EventEmitter();
```

Then any script can publish and subscribe:

```js
// scripts/alarm.js — emit an event
she.mqtt.sub('home/sensor/basement/flood', { change: true }, (topic, val) => {
    if (val) she.global.bus?.emit('alert', { type: 'flood', zone: 'basement', ts: Date.now() });
});
```

```js
// scripts/notify.js — react to any alert
she.global.bus?.on('alert', async ({ type, zone }) => {
    she.warn('alert:', type, 'in', zone);
    // send push notification, publish MQTT, etc.
});
```

Using `?.` makes it safe even if `00-init.js` hasn't run yet, or if you temporarily disable it.

For more advanced use (wildcard event names, `once()`, namespaced events) you can replace `EventEmitter` with `EventEmitter2` — but read the code you introduce; see [Security → Third-party npm packages](../security.md#third-party-npm-packages-in-scripts).

---

## Shared configuration object

Keep configuration in one place and reference it from multiple scripts.

```js
// scripts/lib/config.js
module.exports = {
    rooms: ['living', 'kitchen', 'hall', 'bedroom'],
    defaultTemp: 21,
    awayTemp: 17,
    pushoverToken: '',   // fill in, or load from sheDB
    pushoverUser:  '',
};
```

```js
// scripts/heating.js
const cfg = require('./lib/config');

she.mqtt.sub('home/presence', { change: true }, (topic, val) => {
    const target = val ? cfg.defaultTemp : cfg.awayTemp;
    cfg.rooms.forEach(r => she.mqtt.pub(`home/thermostat/${r}/setpoint`, target));
});
```

---

## Initialise shared state from MQTT retained values at startup

When a script needs to read current values before any message arrives, use `{ retain: true }` to fire immediately for all retained topics.

```js
// scripts/00-init.js — build she.global.state from retained MQTT values
she.global.state = {};

she.mqtt.sub('home/#', { retain: true }, (topic, val) => {
    she.global.state[topic] = val;
});
```

Other scripts can then read `she.global.state['home/presence']` synchronously without waiting for the next MQTT message.

---

## Coordination: only one script acts on a shared resource

Use `she.global` as a lightweight mutex flag when two scripts might otherwise both react to the same event.

```js
// scripts/scene.js
she.global.sceneActive = false;

she.mqtt.sub('home/scene/activate', { change: true }, async (topic, val) => {
    if (she.global.sceneActive) {
        she.warn('scene already running, ignoring:', val);
        return;
    }
    she.global.sceneActive = true;
    try {
        she.mqtt.pub('home/light/living', 180);
        await new Promise(r => setTimeout(r, 2000));
        she.mqtt.pub('home/light/hall', 100);
    } finally {
        she.global.sceneActive = false;
    }
});
```
