# Sandbox API Reference

Every `.js` file loaded by **she** runs in an isolated VM sandbox. All sandbox methods live on the `she` object injected into every script.

---

## Contents

- [Logging](#logging)
- [she.mqtt — MQTT access](#shemqtt----mqtt-access)
  - [she.mqtt.sub()](#shemqttsubtopic-options-callback)
  - [MQTT State Object](#mqtt-state-object)
  - [she.mqtt.pub()](#shemqttpubtopic-payload-options)
  - [she.mqtt.get()](#shemqttgettopic)
  - [she.mqtt.getProp()](#shemqttgetproptopic-property)
  - [she.mqtt.link()](#shemqttlinksource-target-value)
  - [she.mqtt.age()](#shemqttagetopic)
  - [she.mqtt.and()](#shemqttandsrcs-target)
  - [she.mqtt.or()](#shemqttorsrcs-target)
  - [she.mqtt.max()](#shemqttmaxsrcs-target)
  - [she.mqtt.min()](#shemqttminsrcs-target)
  - [she.mqtt.timer()](#shemqtttimersrc-ms-target)
- [she.now()](#shenow)
- [she.schedule()](#sheschedulepattern-options-callback)
- [she.global](#sheglobal)
  - [Cross-script event bus](#cross-script-event-bus)
- [she.http — HTTP helpers](#shehttp----http-helpers)
  - [she.http.fetch()](#shehttpfetchurl-options-callback)
  - [she.http.sub()](#shehttpsubpath-callback)
- [she.config](#sheconfig)
- [she.api — Script HTTP routes](#sheapi----script-http-routes)
- [she.db — sheDB document store](#shedb----shedb-document-store)
  - [she.db.get()](#shedbgetid)
  - [she.db.set()](#shedbsetid-doc)
  - [she.db.extend()](#shedbextendid-partial)
  - [she.db.delete()](#shedbdeleteid)
  - [she.db.prop()](#shedbpropid-method-prop-val)
  - [she.db.sub()](#shedbsubpattern-callback)
  - [she.db.query()](#shedbqueryfilter-mapfn-reducefn)
  - [she.db.getView()](#shedbgetviewid)
  - [she.db.subView()](#shedbsubviewpattern-callback)
  - [she.db.setView()](#shedbsetviewid-definition)
- [she.matter — Matter integration](#shematter----matter-integration)
  - [she.matter.sub()](#shemattersubnodeid-endpointid-clustername-attrname-callback)
  - [she.matter.unsub()](#shematterunsublistenerid)
  - [she.matter.get()](#shemattergetnodeid-endpointid-clustername-attrname)
  - [she.matter.send()](#shemattersendnodeid-endpointid-clustername-command-args)
- [she.influx — InfluxDB integration](#sheinflux----influxdb-integration)
  - [she.influx.query()](#sheinfluxqueryfluxquery)
  - [she.influx.write()](#sheinfluxwritemeasurement-fields-tags-timestamp)
  - [she.influx.getLast()](#sheinfluxgetlasttopic-n)
  - [she.influx.getRange()](#sheinfluxgetrangetopic-from-to)
- [she.elastic — Elasticsearch integration](#sheelastic----elasticsearch-integration)
  - [she.elastic.search()](#sheelasticsearchindex-query)
  - [she.elastic.get()](#sheelasticgetindex-id)
  - [she.elastic.index()](#sheelasticindexindex-doc-id)
  - [she.elastic.find()](#sheelasticfindindex-field-text-size10)
- [Async / await](#async--await)

---

## Logging

```js
she.log(arg, ...)    // alias for she.info
she.info(arg, ...)
she.debug(arg, ...)
she.warn(arg, ...)
she.error(arg, ...)
```

Messages are automatically prefixed with the calling script's name and written via pino. Log level is controlled by `--verbosity`.

```js
she.log('relay toggled', topic, val);
she.debug('raw payload', obj);
she.error('unexpected state', err.message);
```

---

## she.mqtt -- MQTT access

All MQTT operations are available under `she.mqtt`. This is the primary API for script authors.

### she.mqtt.sub(topic, [options], callback)

Subscribe to one or more MQTT topics.

| Param | Type | Description |
|---|---|---|
| `topic` | `string \| string[]` | Topic or array of topics. MQTT wildcards (`+`, `#`) are supported. |
| `[options]` | `object \| function \| string` | Options object, or shorthand for `options.condition`. |
| `[options.change]` | `boolean` | Only call callback when the value actually changes. |
| `[options.retain]` | `boolean` | Also call callback for retained messages received on connect. |
| `[options.shift]` | `number` | Delay execution by this many seconds. Must be positive. |
| `[options.random]` | `number` | Random additional delay in seconds. Must be positive. |
| `[options.condition]` | `function \| string` | Only call callback when this evaluates to truthy. String must be single-line JS. |
| `callback` | `function` | See callback parameters below. |

**Callback parameters:**

| Param | Type | Description |
|---|---|---|
| `topic` | `string` | The topic that fired. |
| `val` | `any` | The `val` property of the new state. |
| `obj` | `object` | Full new state: `{ val, ts, lc }`. |
| `objPrev` | `object` | Previous state object. |
| `msg` | `object` | Raw MQTT.js message object. |

```js
// react to any light state change
she.mqtt.sub('home/light/+/state', { change: true }, (topic, val) => {
    she.log(topic, '->', val);
});

// condition as a function
she.mqtt.sub('home/presence', { condition: (val) => val === true }, () => {
    she.mqtt.pub('home/alarm/off', 1);
});

// condition as a shorthand string
she.mqtt.sub('home/presence', 'val === true', () => {
    she.mqtt.pub('home/alarm/off', 1);
});

// delayed execution -- useful for debouncing
she.mqtt.sub('home/motion/hall', { change: true, shift: 5 }, (topic, val) => {
    if (!val) she.mqtt.pub('home/light/hall', 0);
});
```

---

## MQTT State Object

Every MQTT topic tracked by she has an in-memory **state object** with three fields:

| Field | Type | Description |
|---|---|---|
| `val` | `any` | Parsed payload value. Valid JSON payloads are decoded automatically; anything else stays as a string. |
| `ts` | `number` | Unix timestamp (ms) of the **last received message**, regardless of whether the value changed. |
| `lc` | `number` | Unix timestamp (ms) of the **last value change**. Carries the previous value forward when the same value arrives again. |

`lc` <= `ts` always holds. When a topic is seen for the first time, `lc === ts`.

**In a `she.mqtt.sub()` callback:**

```js
she.mqtt.sub('home/sensor/temp', (topic, val, obj, objPrev) => {
    she.log('new value:',      val);          // shorthand -- same as obj.val
    she.log('received at:',    obj.ts);       // ms timestamp of this message
    she.log('last changed:',   obj.lc);       // ms timestamp of last value change
    she.log('previous value:', objPrev.val);  // val from the previous message
});
```

**Via `she.mqtt.getProp()`:**

```js
const state = she.mqtt.getProp('home/sensor/temp');         // { val, ts, lc }
const ts    = she.mqtt.getProp('home/sensor/temp', 'ts');   // ms of last message
const lc    = she.mqtt.getProp('home/sensor/temp', 'lc');   // ms of last change
```

### Variable topics

Topics under the variable prefix (default `var`) are stored in the `var::` namespace and published retained, so the broker restores their full `{ val, ts, lc }` state across daemon restarts.

---

### she.mqtt.pub(topic, payload, [options])

Publish an MQTT message.

| Param | Type | Default | Description |
|---|---|---|---|
| `topic` | `string \| string[]` | | Topic or array of topics. |
| `payload` | `string \| object` | | Payload. Objects are JSON-stringified automatically. |
| `[options.qos]` | `number` | `0` | QoS level (0, 1, or 2). |
| `[options.retain]` | `boolean` | `false` | Retain flag. |

```js
she.mqtt.pub('home/light/kitchen', 1);
she.mqtt.pub('home/sensor/data', { temp: 21.5, hum: 60 }, { retain: true });
```

---

### she.mqtt.get(topic)

Returns the last known value for a topic, or `undefined` if the topic has never been seen.

```js
if (she.mqtt.get('home/presence') === true) {
    she.log('someone is home');
}
```

---

### she.mqtt.getProp(topic, ...property)

Returns a specific property from a topic's full state object. If `property` is omitted, the whole state object is returned.

```js
const ts  = she.mqtt.getProp('home/sensor/temp', 'ts');   // timestamp of last message
const lc  = she.mqtt.getProp('home/sensor/temp', 'lc');   // timestamp of last change
const all = she.mqtt.getProp('home/sensor/temp');           // { val, ts, lc }
```

---

### she.mqtt.link(source, target, [value])

Forward value changes from one or more source topics to one or more target topics.

| Param | Type | Description |
|---|---|---|
| `source` | `string \| string[]` | Topic(s) to subscribe to. |
| `target` | `string \| string[]` | Topic(s) to publish to. |
| `[value]` | `any \| function` | Fixed value to publish, or a transform function `(val) => newVal`. Omit to forward unchanged. |

```js
// simple forward
she.mqtt.link('hm//remote/button1', 'home/light/kitchen');

// fixed value -- any change on source publishes 0 to target
she.mqtt.link('hm//remote/allOff', 'home/lights/all', 0);

// transform -- convert Fahrenheit to Celsius
she.mqtt.link('sensor/temp/raw', 'sensor/temp/celsius', (raw) => (raw - 32) / 1.8);
```

---

### she.mqtt.age(topic)

Returns the number of **seconds** since the topic's value last changed.

```js
if (she.mqtt.age('home/motion/hall') > 300) {
    she.log('no motion for 5 minutes');
    she.mqtt.pub('home/light/hall', 0);
}
```

---

### she.mqtt.and(srcs, target)

Publishes `1` to `target` when **all** of the source topics are truthy; publishes `0` otherwise. Evaluates immediately and re-evaluates on every source change.

`target` may be a **topic string** or a **callback function** called as `callback(topic, val)`.

```js
// only activate if both sensors agree
she.mqtt.and(['home/presence/ground', 'home/presence/upper'], 'home/presence/all');
```

---

### she.mqtt.or(srcs, target)

Publishes `1` to `target` when **any** of the source topics is truthy; publishes `0` otherwise. Evaluates immediately and re-evaluates on every source change.

`target` may be a **topic string** or a **callback function**. When a function, it is called as `callback(topic, val)` — `topic` is the triggering source topic (or `null` on the initial evaluation), and `val` is the computed result.

```js
// forward to a topic
she.mqtt.or(
    ['home/motion/hall', 'home/motion/kitchen', 'home/motion/living'],
    'home/motion/any'
);

// callback — cross-namespace sink
she.mqtt.or(['light/1/on', 'light/2/on'], (topic, val) => {
    she.matter.send('bulb', 1, 'OnOff', val ? 'on' : 'off');
});
```

---

### she.mqtt.max(srcs, target)

Publishes the maximum value across all source topics to `target`. Evaluates immediately and re-evaluates on every source change.

`target` may be a **topic string** or a **callback function** called as `callback(topic, val)`.

```js
she.mqtt.max(
    ['home/light/1/brightness', 'home/light/2/brightness'],
    'home/light/max-brightness'
);
```

---

### she.mqtt.min(srcs, target)

Publishes the minimum value across all source topics to `target`. Evaluates immediately and re-evaluates on every source change. Returns `0` if no sources have a value yet.

`target` may be a **topic string** or a **callback function** called as `callback(topic, val)`.

```js
she.mqtt.min(
    ['home/light/1/brightness', 'home/light/2/brightness'],
    'home/light/min-brightness'
);
```

---

### she.mqtt.timer(src, ms, target)

Publishes `1` to `target` when `src` becomes truthy, then publishes `0` after `ms` milliseconds. Cancels and restarts the timer if `src` fires again before the timeout.

`target` may be a **topic string** or a **callback function** called as `callback(topic, val)` — `topic` is the MQTT topic that triggered the timer (or `null` when the timeout fires).

When `target` is a topic string, any lingering `1` left over from a previous daemon run is cleared by an initial startup timeout.

| Param | Type | Description |
|---|---|---|
| `src` | `string \| string[]` | Topic(s) to watch. |
| `ms` | `number` | On-duration in milliseconds. |
| `target` | `string \| function` | Topic to publish to, or `callback(topic, val)`. |

```js
// entrance light stays on for 30 s after doorbell
she.mqtt.timer('home/doorbell', 30_000, 'home/light/entrance');

// callback — drive a Matter device instead of publishing
she.mqtt.timer('home/motion/hall', 30_000, (topic, val) => {
    she.matter.send('bulb', 1, 'OnOff', val ? 'on' : 'off');
});
```

---

## she.now()

Returns the current time in milliseconds since the Unix epoch (equivalent to `Date.now()`).

---

## she.schedule(pattern, [options], callback)

Schedule a recurring or one-shot callback, including solar events based on sun position.

| Param | Type | Description |
|---|---|---|
| `pattern` | `string \| Date \| object \| array` | Cron string, suncalc event name, `Date` object, node-schedule object literal, or an array of any mix. |
| `[options.shift]` | `number` | Offset in seconds for solar events (-86400 to 86400). Negative = before, positive = after. |
| `[options.random]` | `number` | Random additional delay in seconds. |
| `callback` | `function` | Called with no arguments. |

Cron strings must contain at least one space. A string **without** spaces is interpreted as a suncalc event name. Latitude and longitude for solar events are set via `--latitude` / `--longitude`.

```js
// every full hour
she.schedule('0 * * * *', () => she.log('tick'));

// Monday-Friday, random between 07:30 and 08:00
she.schedule('30 7 * * 1-5', { random: 30 * 60 }, () => {
    she.mqtt.pub('home/alarm/morning', 1);
});

// once at a specific date and time
she.schedule(new Date(2026, 11, 24, 18, 0, 0), () => she.log('Merry Christmas!'));

// multiple patterns in one call
she.schedule(['0 8 * * *', '0 20 * * *'], callback);

// raise blinds 27-33 minutes before sunrise
she.schedule('sunrise', { shift: -1620, random: 360 }, () => she.mqtt.pub('home/blinds', 'up'));

// switch outdoor lights on at sunset +/- up to 10 random minutes
she.schedule('sunset', { random: 600 }, () => she.mqtt.pub('home/lights/outdoor', 1));

// fire at both dawn and dusk
she.schedule(['dawn', 'dusk'], callback);
```

**Available suncalc events:** `sunrise`, `sunriseEnd`, `goldenHourEnd`, `solarNoon`, `goldenHour`, `sunsetStart`, `sunset`, `dusk`, `nauticalDusk`, `night`, `nadir`, `nightEnd`, `nauticalDawn`, `dawn`.

---

## she.global

A plain object shared across all running scripts. Use it to pass values, pre-computed results, or utility functions between scripts without going through MQTT.

```js
// script-a.js
she.global.sharedCounter = 0;

// script-b.js
she.global.sharedCounter++;
she.log('counter:', she.global.sharedCounter);
```

Because scripts load in filesystem order you cannot guarantee that another script has already populated `she.global` when yours runs. Guard reads with `?.` or a default:

```js
const count = she.global.sharedCounter ?? 0;
```

### Cross-script event bus

`she.global` can hold any object — including a Node.js `EventEmitter`. This gives you a lightweight in-process pub/sub channel without MQTT or broker involvement.

```js
// scripts/00-init.js — set up the bus once, before other scripts load
const { EventEmitter } = require('events');
she.global.bus = new EventEmitter();
```

```js
// scripts/alarm.js — emit an event
she.mqtt.sub('home/sensor/basement/flood', { change: true }, (topic, val) => {
    if (val) she.global.bus?.emit('alert', { type: 'flood', zone: 'basement' });
});
```

```js
// scripts/notify.js — react to any alert
she.global.bus?.on('alert', ({ type, zone }) => {
    she.warn('alert:', type, 'in', zone);
});
```

Using `?.` makes the call a safe no-op if `00-init.js` hasn't run or is disabled.

See [Cross-script patterns](examples/cross-script.md) for more patterns including library scripts and shared configuration.

---

## she.http -- HTTP helpers

### she.http.fetch(url, [options], [callback])

Makes an HTTP/HTTPS request using the native `fetch` API. Automatically parses the response body: if the server returns a `Content-Type` containing `json`, the response is parsed as JSON; otherwise it is returned as plain text.

Rejects / calls `callback(err)` if the response status is not OK (4xx / 5xx). On error the `Error` object additionally carries `body`, `code`, and `headers` from the failed response.

| Param | Type | Description |
|---|---|---|
| `url` | `string` | The URL to fetch. |
| `[options]` | `object` | Standard [Fetch API options](https://developer.mozilla.org/en-US/docs/Web/API/fetch#options) (`method`, `headers`, `body`, etc.). |
| `[callback]` | `function` | Node.js-style `callback(err, res)`. When omitted a Promise is returned. |

**Response object (`res`):**

| Field | Type | Description |
|---|---|---|
| `res.body` | `string \| object` | Parsed response body (JSON object or plain text string). |
| `res.code` | `number` | HTTP status code, e.g. `200`. |
| `res.headers` | `object` | Response headers as a plain object. |

```js
// Promise style — destructure body
const { body } = await she.http.fetch('https://api.example.com/status');
she.log('status:', body.status);

// Access code and headers too
const { body, code, headers } = await she.http.fetch('https://api.example.com/data');
she.log('HTTP', code, headers['content-type']);

// POST with JSON body
const { body: result } = await she.http.fetch('https://api.example.com/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'toggle' }),
});
she.mqtt.pub('home/device/response', result.ok);

// Callback style — avoids async/await in script top-level
she.http.fetch('https://api.example.com/status', (err, res) => {
    if (err) return she.warn('fetch failed:', err.message);
    she.log('status:', res.body.status, '— HTTP', res.code);
});

// Callback with options
she.http.fetch('https://api.example.com/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'toggle' }),
}, (err, res) => {
    if (err) return she.warn('command failed:', err.message);
    she.mqtt.pub('home/device/response', res.body.ok);
});
```

---

### she.http.sub(path, callback)

Registers a `POST` endpoint at `/api/<scriptName><path>` that calls `callback` on every incoming request. The endpoint always responds `{ ok: true }` (200) when the callback resolves, or `{ error }` (500) if it throws.

| Param | Type | Description |
|---|---|---|
| `path` | `string` | Route path appended to `/api/<scriptName>`, e.g. `'/webhook/doorbell'`. |
| `callback` | `function` | Called as `callback(body, { params, query, headers })`. |

```js
// POST /api/myscript/webhook/doorbell
she.http.sub('/webhook/doorbell', (body) => {
    she.log('doorbell payload:', body);
    she.mqtt.pub('home/doorbell', 1);
});

// async callback is supported
she.http.sub('/webhook/sensor', async (body) => {
    await she.mqtt.pub('home/sensor/raw', body);
});
```

---

## she.config

A read-only object exposing daemon configuration values relevant to scripts. Attempting to modify properties throws a `TypeError` (the object is frozen).

| Property | Type | Description |
|---|---|---|
| `she.config.latitude` | `number` | Geographic latitude configured under *Config → Solar events*. Used internally for suncalc event scheduling. |
| `she.config.longitude` | `number` | Geographic longitude configured under *Config → Solar events*. |

```js
she.info('location:', she.config.latitude, she.config.longitude);

// Use coordinates for a custom API call -- wrap in async IIFE (top-level await is not supported)
(async () => {
    try {
        const { body: weather } = await she.http.fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${she.config.latitude}&longitude=${she.config.longitude}&current_weather=true`
        );
        she.mqtt.pub('home/weather/temperature', weather.current_weather.temperature);
    } catch (err) {
        she.warn('weather fetch failed:', err.message);
    }
})();
```

---

## she.api -- Script HTTP routes

Register HTTP endpoints served under `/api/<scriptName>/`. Routes are registered at script load and removed on hot-reload. Registering the same method + path twice throws.

| Method | Description |
|---|---|
| `she.api.get(path, handler)` | Register a `GET` route |
| `she.api.post(path, handler)` | Register a `POST` route |
| `she.api.put(path, handler)` | Register a `PUT` route |
| `she.api.delete(path, handler)` | Register a `DELETE` route |

`path` is appended to `/api/<scriptName>`, e.g. a script `devices.js` with `she.api.get('/list', ...)` handles `GET /api/devices/list`. Express path parameters (`:id`) are supported.

The handler receives:
- First arg: `req` — `{ params, query, headers }`
- Second arg (POST / PUT only): `body` — parsed request body

The return value (or resolved Promise value) is JSON-serialised and sent. Thrown errors and rejected Promises respond with HTTP 500.

```js
// GET /api/myscript/temperature
she.api.get('/temperature', () => ({
    value: she.mqtt.get('home/sensor/temp'),
}));

// POST /api/myscript/scene
she.api.post('/scene', (req, body) => {
    she.mqtt.pub('home/scene/activate', body.scene);
    return { ok: true };
});

// GET /api/myscript/devices/:id
she.api.get('/devices/:id', (req) => she.db.get('devices/' + req.params.id));
```

---

## she.db -- sheDB document store

Available when `--db-path` is configured. All methods are no-ops (or return `undefined`/`[]`) when sheDB is not initialised, so scripts do not need to guard against it.

### she.db.get(id)

Returns the document with the given ID, or `undefined` if not found.

```js
const device = she.db.get('devices/hall/pir');
if (device) she.log(device.name);
```

---

### she.db.set(id, doc)

Create or fully overwrite a document.

```js
she.db.set('devices/hall/pir', { name: 'Hall PIR', location: 'hall', active: true });
```

---

### she.db.extend(id, partial)

Deep-merge `partial` into an existing document. Creates the document if it does not exist.

```js
she.db.extend('devices/hall/pir', { lastSeen: Date.now() });
```

---

### she.db.delete(id)

Delete a document.

```js
she.db.delete('devices/hall/pir');
```

---

### she.db.prop(id, method, prop, val)

Mutate a nested property without rewriting the whole document.

| `method` | Description |
|---|---|
| `'set'` | Set `prop` to `val` (overwrites if exists) |
| `'create'` | Set `prop` to `val` only if it does not already exist |
| `'del'` | Delete `prop` (`val` is ignored) |

`prop` uses dot-notation for nested paths, e.g. `'config.network.ip'`.

```js
she.db.prop('devices/hall/pir', 'set', 'active', false);
she.db.prop('devices/hall/pir', 'del', 'lastSeen');
```

---

### she.db.sub(pattern, callback)

Subscribe to document changes matching an MQTT wildcard pattern. The callback fires when any matching document is created, updated, or deleted. Subscriptions are automatically removed when the script is hot-reloaded.

```js
she.db.sub('devices/#', (id, doc) => {
    if (doc === null) she.log(id, 'was deleted');
    else she.log(id, 'changed:', doc);
});
```

---

### she.db.query(filter, mapFn, [reduceFn])

Ad-hoc synchronous query -- runs immediately, does not persist.

| Param | Type | Description |
|---|---|---|
| `filter` | `string \| null` | MQTT wildcard to pre-filter document IDs. `null` = all documents. |
| `mapFn` | `function` | Called as `mapFn(doc, emit)`. Call `emit(item)` to include an item in the result. |
| `[reduceFn]` | `function` | Called as `reduceFn(results)`. Return value replaces the result array. |

```js
// list all active devices in the hall
const active = she.db.query('devices/hall/#', (doc, emit) => {
    if (doc.active) emit(doc.name);
});
she.log('active:', active);
```

---

### she.db.getView(id)

Return the current computed result array of a named view, or `undefined` if the view does not exist, has not yet completed, or produced a runtime error.

```js
const lights = she.db.getView('activeLights');
if (lights) she.log('active lights:', lights.length);
```

---

### she.db.subView(pattern, callback)

Subscribe to view result changes matching an MQTT wildcard pattern. `callback(id, result)` fires whenever a matching view recomputes; `result` is `undefined` if the view errored. Subscriptions are automatically removed when the script is hot-reloaded.

```js
she.db.subView('stats/#', (id, result) => {
    she.info('view updated:', id, result?.length, 'items');
});
```

---

### she.db.setView(id, definition)

Create or update a named persistent view. Equivalent to saving a view via the web UI.

| Field | Type | Description |
|---|---|---|
| `map` | `string` | **Required.** Map function body. `this` = current document; call `emit(value)` to include in result. |
| `filter` | `string` | Optional MQTT wildcard to pre-filter which documents the map function receives. |
| `reduce` | `string` | Optional reduce function body. Receives `result` array; must `return` a new value. |
| `publish` | `boolean` | Publish result to MQTT topic `<dbPrefix>view/<id>` on every update. |
| `retain` | `boolean` | Send the MQTT publish as a retained message (requires `publish: true`). |
| `description` | `string` | Optional short description shown in the web UI sidebar. |

```js
// Create a view that lists all active devices
she.db.setView('activeDevices', {
    filter: 'devices/#',
    map: 'if (this.active) emit({ id: this._id, name: this.name });',
    publish: true,
});

// Read its result later (once the worker has computed it)
she.schedule('*/1 * * * *', () => {
    const devices = she.db.getView('activeDevices');
    she.info('active devices:', devices?.length ?? 0);
});
```

## she.matter -- Matter integration

Available when `--matter-storage` is configured. Methods throw or log errors if the Matter controller is not running.

### she.matter.sub(nodeId, endpointId, clusterName, attrName, callback)

Subscribe to attribute changes on a paired Matter device. Returns a `listenerId`.

| Param | Type | Description |
|---|---|---|
| `nodeId` | `string \| number` | Decimal node ID string or device name |
| `endpointId` | `number \| string` | Endpoint number or endpoint name |
| `clusterName` | `string` | camelCase cluster name, e.g. `'onOff'` |
| `attrName` | `string` | camelCase attribute name, e.g. `'onOff'` |
| `callback` | `function` | Called as `callback(value, oldValue)` |

```js
const id = she.matter.sub('1', 1, 'onOff', 'onOff', (val) => {
    she.log('bulb is now', val ? 'on' : 'off');
});
```

---

### she.matter.unsub(listenerId)

Cancel a specific Matter attribute subscription.

```js
she.matter.unsub(id);
```

---

### she.matter.get(nodeId, endpointId, clusterName, attrName)

Read a single attribute value. Returns a Promise.

```js
const isOn = await she.matter.get('1', 1, 'onOff', 'onOff');
she.log('current state:', isOn);
```

---

### she.matter.send(nodeId, endpointId, clusterName, command, [args])

Invoke a cluster command. Returns a Promise.

```js
// toggle a smart bulb
await she.matter.send('1', 1, 'onOff', 'toggle');

// set brightness level
await she.matter.send('1', 1, 'levelControl', 'moveToLevel', { level: 128, transitionTime: 10 });
```

---

## she.influx -- InfluxDB integration

Enabled when an `influx` config block is present in `config.json`:

```json
{
  "influx": {
    "url": "http://localhost:8086",
    "token": "my-token",
    "org": "my-org",
    "bucket": "mqtt"
  }
}
```

All methods return Promises. When InfluxDB is not configured every method resolves to an empty result immediately.

### she.influx.query(fluxQuery)

Execute an arbitrary [Flux query](https://docs.influxdata.com/flux/v0/) and return the result rows as plain objects.

```js
she.influx.query(`
  from(bucket: "mqtt")
    |> range(start: -1h)
    |> filter(fn: (r) => r["_measurement"] == "temperature")
`).then((rows) => she.log(rows));
```

### she.influx.write(measurement, fields, [tags], [timestamp])

Write a single data point. `fields` is `{ fieldName: value }`.

```js
she.influx.write('temperature', { value: 21.5 }, { room: 'living' });
she.influx.write('events', { count: 1 }, {}, Date.now());
```

### she.influx.getLast(topic, n)

Return the last `n` recorded values for an MQTT `topic`.

```js
she.influx.getLast('home/sensor/temp', 10).then((pts) => {
    pts.forEach((p) => she.log(new Date(p.ts).toISOString(), p.val));
});
```

### she.influx.getRange(topic, from, to)

Return all recorded values for an MQTT `topic` within the given time range. `from` and `to` accept a `Date`, ISO string, or millisecond timestamp.

```js
she.influx.getRange('home/energy/meter', new Date('2024-01-01'), new Date('2024-01-02'))
    .then((pts) => she.log('readings:', pts.length));
```

---

## she.elastic -- Elasticsearch integration

Enabled when an `elastic` config block is present in `config.json`:

```json
{
  "elastic": {
    "node": "http://localhost:9200",
    "auth": { "apiKey": "my-api-key" }
  }
}
```

All methods return Promises. When Elasticsearch is not configured every method resolves to an empty result immediately.

### she.elastic.search(index, query)

Run an Elasticsearch [query DSL](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl.html) against an index.

```js
she.elastic.search('events', { match_all: {} }).then(({ hits, total }) => {
    she.log(total, 'hits:', hits);
});
```

### she.elastic.get(index, id)

Retrieve a single document by ID. Returns `null` when the document does not exist.

```js
she.elastic.get('devices', 'living-room-sensor').then((doc) => {
    if (doc) she.log('doc:', doc);
});
```

### she.elastic.index(index, doc, [id])

Create or replace a document. Omit `id` to let Elasticsearch auto-generate one.

```js
she.elastic.index('events', { type: 'motion', room: 'hall', ts: Date.now() })
    .then(({ id }) => she.log('indexed as', id));
```

### she.elastic.find(index, field, text, [size=10])

Convenience wrapper for a `match` query on a single field.

```js
she.elastic.find('events', 'room', 'living', 5).then((docs) => {
    she.log('found:', docs);
});
```

---

## Async / await

`async` functions and `await` work inside any **callback** passed to `she.mqtt.sub()`, `she.schedule()`, `she.http.sub()`, etc.

```js
she.mqtt.sub('home/doorbell', async (topic, val) => {
    try {
        const { body } = await she.http.fetch('https://api.example.com/notify');
        she.log('notified:', body.ok);
    } catch (err) {
        she.error('notification failed:', err.message);
    }
});
```

**Always wrap `await` in `try/catch` inside callbacks.** An unhandled rejection inside a callback cannot be attributed to a specific script — it appears in the logs without a script name. The daemon does not crash (a global handler catches it), but the log entry is hard to trace back.

```js
// ✗ unhandled rejection on fetch error
she.schedule('0 * * * *', async () => {
    const { body } = await she.http.fetch('https://example.com/data');
    she.mqtt.pub('home/data', body.value);
});

// ✓ errors are caught and logged with the script name
she.schedule('0 * * * *', async () => {
    try {
        const { body } = await she.http.fetch('https://example.com/data');
        she.mqtt.pub('home/data', body.value);
    } catch (err) {
        she.error('fetch failed:', err.message);
    }
});
```

**Top-level `await` does not work.** Scripts run in a classic-script VM context, not an ES module, so `await` outside a function body is a `SyntaxError`. If you need to perform async setup (e.g. fetch initial state) before registering callbacks, write an explicit async IIFE and chain `.catch()` on it:

```js
// ✗ SyntaxError — top-level await is not supported
const data = await she.http.fetch('https://example.com/init');

// ✓ async IIFE
(async () => {
    try {
        const { body: data } = await she.http.fetch('https://example.com/init');
        she.mqtt.sub('home/device', (topic, val) => {
            // data is available here
        });
    } catch (err) {
        she.error('startup error:', err.message);
    }
})();
```

Register callbacks **inside** the IIFE so they are set up after the async work completes. Be aware that any code after the first `await` yields to the event loop, so scripts that follow in load order may run their top-level body before your async IIFE resumes. If other scripts depend on values you write to `she.global`, this load-order guarantee is lost.
