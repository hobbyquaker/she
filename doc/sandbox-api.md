# Sandbox API Reference

Every `.js` file loaded by mqtt-scripts runs in an isolated VM sandbox. All sandbox methods live on the `she` object injected into every script.

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

## she.mqtt � MQTT access

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
| `topic` | `string` | The topic that fired (wildcard characters replaced with actual segments). |
| `val` | `any` | The `val` property of the new state. |
| `obj` | `object` | Full new state: `{ val, ts, lc }` (timestamp, last-change time). |
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

// delayed execution � useful for debouncing
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

`lc` ≤ `ts` always holds. When a topic is seen for the first time, `lc === ts`.

### Accessing the state object

**In a `she.mqtt.sub()` callback — the `obj` and `objPrev` parameters:**

```js
she.mqtt.sub('home/sensor/temp', (topic, val, obj, objPrev) => {
    she.log('new value:',      val);          // shorthand — same as obj.val
    she.log('received at:',    obj.ts);       // ms timestamp of this message
    she.log('last changed:',   obj.lc);       // ms timestamp of last value change
    she.log('previous value:', objPrev.val);  // val from the previous message
});
```

**Via `she.mqtt.getProp()`:**

```js
// full state object
const state = she.mqtt.getProp('home/sensor/temp');
// → { val: 21.5, ts: 1718000000123, lc: 1718000000123 }

// individual fields
const ts = she.mqtt.getProp('home/sensor/temp', 'ts');
const lc = she.mqtt.getProp('home/sensor/temp', 'lc');
```

**Via `she.mqtt.age()` — uses `lc` internally:**

```js
// seconds elapsed since the value last changed
const seconds = she.mqtt.age('home/sensor/temp');
```

### Variable topics

Topics under the variable prefix (default `var//`) always store their state as a JSON object, so the broker retains and restores the full `{ val, ts, lc }` object across daemon restarts. Regular (non-variable) topics rebuild their state from retained MQTT messages each time the daemon starts.

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

### she.mqtt.get(topic) ? any

Returns the last known value for a topic, or `undefined` if the topic has never been seen.

```js
if (she.mqtt.get('home/presence') === true) {
    she.log('someone is home');
}
```

---

### she.mqtt.getProp(topic, ...property) ? any

Returns a specific property from a topic's full state object.
If `property` is omitted, the whole state object is returned.

```js
const ts = she.mqtt.getProp('home/sensor/temp', 'ts');   // timestamp of last message
const lc = she.mqtt.getProp('home/sensor/temp', 'lc');   // timestamp of last change
const all = she.mqtt.getProp('home/sensor/temp');          // { val, ts, lc }
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

// fixed value � any change on source publishes 0 to target
she.mqtt.link('hm//remote/allOff', 'home/lights/all', 0);

// transform � convert Fahrenheit to Celsius
she.mqtt.link('sensor/temp/raw', 'sensor/temp/celsius', (raw) => (raw - 32) / 1.8);
```

---

### she.mqtt.age(topic) ? number

Returns the number of **seconds** since the topic's value last changed.

```js
if (she.mqtt.age('home/motion/hall') > 300) {
    she.log('no motion for 5 minutes');
    she.mqtt.set('home/light/hall', 0);
}
```

---

## she.now() ? number

Returns the current time in milliseconds since the Unix epoch (equivalent to `Date.now()`).

---

## she.schedule(pattern, [options], callback)

Schedule a recurring or one-shot callback.

| Param | Type | Description |
|---|---|---|
| `pattern` | `string \| Date \| object \| array` | Cron string, `Date` object, node-schedule object literal, or an array of any mix. |
| `[options.random]` | `number` | Random additional delay in seconds. |
| `callback` | `function` | Called with no arguments. |

```js
// every full hour
she.schedule('0 * * * *', () => she.log('tick'));

// Monday�Friday, random between 07:30 and 08:00
she.schedule('30 7 * * 1-5', { random: 30 * 60 }, () => {
    she.mqtt.pub('home/alarm/morning', 1);
});

// once at a specific date and time
she.schedule(new Date(2026, 11, 24, 18, 0, 0), () => she.log('Merry Christmas!'));

// multiple patterns in one call
she.schedule(['0 8 * * *', '0 20 * * *'], callback);
```

---

## she.sunSchedule(pattern, [options], callback)

Schedule a callback relative to a solar event. Uses [suncalc](https://github.com/mourner/suncalc); latitude and longitude are set via `--latitude` / `--longitude`.

| Param | Type | Description |
|---|---|---|
| `pattern` | `string \| string[]` | suncalc event name or array of event names. |
| `[options.shift]` | `number` | Offset in seconds (-86400 ... 86400). Negative = before, positive = after. |
| `[options.random]` | `number` | Random additional delay in seconds. |
| `callback` | `function` | Called with no arguments. |

```js
// raise blinds 15 minutes before sunrise
she.sunSchedule('sunrise', { shift: -900 }, () => she.mqtt.set('home/blinds', 'up'));

// switch outdoor lights on at sunset +/- up to 10 random minutes
she.sunSchedule('sunset', { random: 600 }, () => she.mqtt.set('home/lights/outdoor', 1));

// fire at both dawn and dusk
she.sunSchedule(['dawn', 'dusk'], callback);
```

**Available suncalc events:** `sunrise`, `sunriseEnd`, `goldenHourEnd`, `solarNoon`, `goldenHour`, `sunsetStart`, `sunset`, `dusk`, `nauticalDusk`, `night`, `nadir`, `nightEnd`, `nauticalDawn`, `dawn`.

---

## she.combineBool(srcs, target)

Publishes `1` to `target` when **any** of the source topics is truthy; publishes `0` otherwise. Evaluates immediately and re-evaluates on every source change.

```js
she.combineBool(
    ['home/motion/hall', 'home/motion/kitchen', 'home/motion/living'],
    'home/motion/any'
);
```

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

## she.api � HTTP endpoint registration

Registers HTTP endpoints scoped to the current script. Requires the daemon to be started with `--port`.

```js
she.api.get(path, handler)
she.api.post(path, handler)
she.api.put(path, handler)
she.api.delete(path, handler)
```

Routes are mounted at `/api/<scriptName><path>` where `scriptName` is the filename without the `.js` extension.

**Handler signatures:**
- `GET` / `DELETE`: `(req) => value | Promise`
- `POST` / `PUT`: `(req, body) => value | Promise`

`req` exposes `{ params, query, headers }`. The return value is sent as JSON. Throw or return a rejected Promise to respond with HTTP 500.

```js
// GET /api/controller/status
she.api.get('/status', () => ({
    uptime: process.uptime(),
    presence: she.mqtt.get('home/presence'),
}));

// GET /api/controller/sensor/living -> { temp: 21.5 }
she.api.get('/sensor/:room', (req) => ({
    temp: she.mqtt.get('home/sensor/' + req.params.room + '/temp'),
}));

// POST /api/controller/scene
she.api.post('/scene', (req, body) => {
    she.mqtt.pub('home/scene/set', body.name);
    return { ok: true };
});
```

See [http-api.md](http-api.md) for authentication details and system endpoints.
