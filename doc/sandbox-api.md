# Sandbox API Reference

Every `.js` file loaded by **she** runs in an isolated VM sandbox. All sandbox methods live on the `she` object injected into every script.

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
    if (!val) she.mqtt.set('home/light/hall', 0);
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

### she.mqtt.set(topic, val)

Convenience wrapper around `pub`. Writes a value to one or more topics.

```js
she.mqtt.set('home/light/kitchen', 1);
she.mqtt.set(['home/light/kitchen', 'home/light/hall'], 0);
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
    she.mqtt.set('home/light/hall', 0);
}
```

---

### she.mqtt.on(event, callback)

Register a callback for MQTT connection lifecycle events.

| `event` | Description |
|---|---|
| `'connect'` | Fired when the MQTT connection is established (or re-established). |
| `'disconnect'` | Fired when the MQTT connection is lost. |

```js
she.mqtt.on('connect', () => she.log('broker connected'));
she.mqtt.on('disconnect', () => she.warn('broker disconnected'));
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

## Universal key-based API

These methods work across all namespaces (`mqtt::`, `var::`, `matter::`), providing a unified interface regardless of where data lives.

### she.on(key, callback)

Subscribe to value changes for a namespaced key. `mqtt::` and `var::` subscriptions fire immediately with the current value if one exists (retain semantics). `matter::` subscriptions do not fire immediately.

| Namespace | Example key | Description |
|---|---|---|
| `mqtt::` | `mqtt::home/sensor/temp` | Subscribes to an MQTT topic |
| `var::` | `var::myCounter` | Subscribes to a variable |
| `matter::` | `matter::1/1/onOff/onOff` | Subscribes to a Matter attribute (numeric IDs only) |

Callback receives `(val, obj, prevObj)` for `mqtt::` and `var::` keys. For `matter::` keys the callback receives `(value, oldValue)` — raw attribute values with no state object wrapper. The `matter::` key format is `matter::nodeId/endpointId/clusterName/attrName`; only numeric node ID and endpoint ID are accepted (unlike `she.matter.sub` which also accepts names).

```js
she.on('mqtt::home/sensor/temp', (val) => she.log('temp:', val));
she.on('var::nightMode', (val) => she.log('night mode:', val));
she.on('matter::1/1/onOff/onOff', (val) => she.log('bulb:', val));
```

---

### she.set(key, val)

Write a value to a namespaced key. Supported namespaces: `mqtt::` (publishes) and `var::` (sets variable).

```js
she.set('mqtt::home/light/hall', 1);
she.set('var::nightMode', true);
```

---

### she.get(key)

Read the current value for a namespaced key. Returns `undefined` if not set.

```js
const temp = she.get('mqtt::home/sensor/temp');
const mode = she.get('var::nightMode');
```

---

### she.getObject(key)

Read the full state object `{ val, ts, lc }` for a namespaced key.

```js
const state = she.getObject('mqtt::home/sensor/temp');
// { val: 21.5, ts: 1718000000123, lc: 1718000000123 }
```

---

## she.now()

Returns the current time in milliseconds since the Unix epoch (equivalent to `Date.now()`).

---

## she.age(topic)

Returns the number of seconds since the given MQTT topic's value last changed. Shorthand for `she.mqtt.age(topic)`.

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
she.schedule('sunrise', { shift: -1620, random: 360 }, () => she.mqtt.set('home/blinds', 'up'));

// switch outdoor lights on at sunset +/- up to 10 random minutes
she.schedule('sunset', { random: 600 }, () => she.mqtt.set('home/lights/outdoor', 1));

// fire at both dawn and dusk
she.schedule(['dawn', 'dusk'], callback);
```

**Available suncalc events:** `sunrise`, `sunriseEnd`, `goldenHourEnd`, `solarNoon`, `goldenHour`, `sunsetStart`, `sunset`, `dusk`, `nauticalDusk`, `night`, `nadir`, `nightEnd`, `nauticalDawn`, `dawn`.

---

## she.combineMax(srcs, target)

Publishes the maximum value across all source topics to `target`. Evaluates immediately and re-evaluates on every source change.

```js
she.combineMax(
    ['home/light/1/brightness', 'home/light/2/brightness'],
    'home/light/max-brightness'
);
```

---

## she.timer(src, target, time)

Publishes `1` to `target` when `src` becomes truthy, then publishes `0` after `time` milliseconds.

| Param | Type | Description |
|---|---|---|
| `src` | `string \| string[]` | Topic(s) to watch. |
| `target` | `string` | Topic to publish to. |
| `time` | `number` | On-duration in milliseconds. |

```js
// entrance light stays on for 30 s after doorbell
she.timer('home/doorbell', 'home/light/entrance', 30_000);
```

---

## she.link(source, target, [value])

Shorthand for `she.mqtt.link()`. See above.

---

## she.global

A plain object shared across all running scripts. Use it to pass values between scripts without going through MQTT.

```js
// script-a.js
she.global.sharedCounter = 0;

// script-b.js
she.global.sharedCounter++;
she.log('counter:', she.global.sharedCounter);
```

---

## she.fetch(url, [options])

Makes an HTTP/HTTPS request using the native `fetch` API and returns a Promise. Automatically parses the response body: if the server returns a `Content-Type` containing `json`, the response is parsed as JSON; otherwise it is returned as plain text.

Throws an `Error` if the response status is not OK (4xx / 5xx).

| Param | Type | Description |
|---|---|---|
| `url` | `string` | The URL to fetch. |
| `[options]` | `object` | Standard [Fetch API options](https://developer.mozilla.org/en-US/docs/Web/API/fetch#options) (`method`, `headers`, `body`, etc.). |

```js
// GET — auto-parsed JSON
const data = await she.fetch('https://api.example.com/status');
she.log('status:', data.status);

// POST with JSON body
const result = await she.fetch('https://api.example.com/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'toggle' }),
});

// Publish the result to MQTT
she.mqtt.set('home/device/response', result.ok);
```

---

---

## she.config

A read-only object exposing daemon configuration values relevant to scripts. Attempting to modify properties throws a `TypeError` (the object is frozen).

| Property | Type | Description |
|---|---|---|
| `she.config.latitude` | `number` | Geographic latitude configured under *Config → Solar events*. Used internally for suncalc event scheduling. |
| `she.config.longitude` | `number` | Geographic longitude configured under *Config → Solar events*. |

```js
she.info('location:', she.config.latitude, she.config.longitude);

// Use coordinates for a custom API call
const weather = await she.fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${she.config.latitude}&longitude=${she.config.longitude}&current_weather=true`
);
she.mqtt.set('home/weather/temperature', weather.current_weather.temperature);
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

## she.matter -- Matter device control

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
