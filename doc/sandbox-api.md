# Sandbox API Reference

Every `.js` file loaded by mqtt-scripts runs in an isolated VM sandbox. The following globals are available. Most functions are also accessible on the `she` object (e.g. `she.subscribe === subscribe`).

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

## subscribe(topic, [options], callback)

Subscribe to one or more MQTT topics.

| Param | Type | Description |
|---|---|---|
| `topic` | `string \| string[]` | Topic or array of topics. MQTT wildcards (`+`, `#`) are supported. |
| `[options]` | `object \| function \| string` | Options object, or shorthand for `options.condition`. |
| `[options.change]` | `boolean` | Only call callback when the value actually changes (not on every retained publish). |
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
subscribe('home/light/+/state', { change: true }, (topic, val) => {
    she.log(topic, '->', val);
});

// condition as a function
subscribe('home/presence', { condition: (val) => val === true }, () => {
    publish('home/alarm/off', 1);
});

// condition as a shorthand string
subscribe('home/presence', 'val === true', () => {
    publish('home/alarm/off', 1);
});

// delayed execution — useful for debouncing
subscribe('home/motion/hall', { change: true, shift: 5 }, (topic, val) => {
    if (!val) setValue('home/light/hall', 0);
});
```

---

## publish(topic, payload, [options])

Publish an MQTT message.

| Param | Type | Default | Description |
|---|---|---|---|
| `topic` | `string \| string[]` | | Topic or array of topics. |
| `payload` | `string \| object` | | Payload. Objects are JSON-stringified automatically. |
| `[options.qos]` | `number` | `0` | QoS level (0, 1, or 2). |
| `[options.retain]` | `boolean` | `false` | Retain flag. |

```js
publish('home/light/kitchen', 1);
publish('home/sensor/data', { temp: 21.5, hum: 60 }, { retain: true });
```

---

## setValue(topic, val)

Convenience wrapper around `publish`. Writes a value to one or more topics.

```js
setValue('home/light/kitchen', 1);
setValue(['home/light/kitchen', 'home/light/hall'], 0);
```

---

## getValue(topic) → any

Returns the last known value for a topic, or `undefined` if the topic has never been seen.

```js
if (getValue('home/presence') === true) {
    she.log('someone is home');
}
```

---

## getProp(topic, ...property) → any

Returns a specific property from a topic's full state object.  
If `property` is omitted, the whole state object is returned.

```js
const ts = getProp('home/sensor/temp', 'ts');   // timestamp of last message
const lc = getProp('home/sensor/temp', 'lc');   // timestamp of last change
const all = getProp('home/sensor/temp');          // { val, ts, lc }
```

---

## now() → number

Returns the current time in milliseconds since the Unix epoch (equivalent to `Date.now()`).

---

## age(topic) → number

Returns the number of **seconds** since the topic's value last changed.

```js
if (age('home/motion/hall') > 300) {
    she.log('no motion for 5 minutes');
    setValue('home/light/hall', 0);
}
```

---

## schedule(pattern, [options], callback)

Schedule a recurring or one-shot callback.

| Param | Type | Description |
|---|---|---|
| `pattern` | `string \| Date \| object \| array` | Cron string, `Date` object, node-schedule object literal, or an array of any mix. |
| `[options.random]` | `number` | Random additional delay in seconds. |
| `callback` | `function` | Called with no arguments. |

```js
// every full hour
schedule('0 * * * *', () => she.log('tick'));

// Monday–Friday, random between 07:30 and 08:00
schedule('30 7 * * 1-5', { random: 30 * 60 }, () => {
    publish('home/alarm/morning', 1);
});

// once at a specific date and time
schedule(new Date(2026, 11, 24, 18, 0, 0), () => she.log('Merry Christmas!'));

// every Sunday at 14:30
schedule({ hour: 14, minute: 30, dayOfWeek: 0 }, () => {
    setValue('home/reminder/weekly', 1);
});

// multiple patterns in one call
schedule(['0 8 * * *', '0 20 * * *'], callback);
```

---

## sunSchedule(pattern, [options], callback)

Schedule a callback relative to a solar event. Uses [suncalc](https://github.com/mourner/suncalc); latitude and longitude are set via `--latitude` / `--longitude`.

| Param | Type | Description |
|---|---|---|
| `pattern` | `string \| string[]` | suncalc event name or array of event names. |
| `[options.shift]` | `number` | Offset in seconds (−86400 … 86400). Negative = before, positive = after. |
| `[options.random]` | `number` | Random additional delay in seconds. |
| `callback` | `function` | Called with no arguments. |

```js
// raise blinds 15 minutes before sunrise
sunSchedule('sunrise', { shift: -900 }, () => setValue('home/blinds', 'up'));

// switch outdoor lights on at sunset ± up to 10 random minutes
sunSchedule('sunset', { random: 600 }, () => setValue('home/lights/outdoor', 1));

// fire at both dawn and dusk
sunSchedule(['dawn', 'dusk'], callback);
```

**Available suncalc events:** `sunrise`, `sunriseEnd`, `goldenHourEnd`, `solarNoon`, `goldenHour`, `sunsetStart`, `sunset`, `dusk`, `nauticalDusk`, `night`, `nadir`, `nightEnd`, `nauticalDawn`, `dawn`.

---

## link(source, target, [value])

Forward value changes from one or more source topics to one or more target topics.

| Param | Type | Description |
|---|---|---|
| `source` | `string \| string[]` | Topic(s) to subscribe to. |
| `target` | `string \| string[]` | Topic(s) to publish to. |
| `[value]` | `any \| function` | Fixed value to publish, or a transform function `(val) => newVal`. Omit to forward the source value unchanged. |

```js
// simple forward
link('hm//remote/button1', 'home/light/kitchen');

// fixed value — any change on source publishes 0 to target
link('hm//remote/allOff', 'home/lights/all', 0);

// transform — convert Fahrenheit to Celsius
link('sensor/temp/raw', 'sensor/temp/celsius', (raw) => (raw - 32) / 1.8);
```

---

## combineBool(srcs, target)

Publishes `1` to `target` when **any** of the source topics is truthy; publishes `0` otherwise. Evaluates immediately and re-evaluates on every source change.

```js
combineBool(
    ['home/motion/hall', 'home/motion/kitchen', 'home/motion/living'],
    'home/motion/any'
);
```

---

## combineMax(srcs, target)

Publishes the maximum value across all source topics to `target`. Evaluates immediately and re-evaluates on every source change.

```js
combineMax(
    ['home/light/1/brightness', 'home/light/2/brightness'],
    'home/light/max-brightness'
);
```

---

## timer(src, target, time)

Publishes `1` to `target` when `src` becomes truthy, then publishes `0` after `time` milliseconds.

| Param | Type | Description |
|---|---|---|
| `src` | `string \| string[]` | Topic(s) to watch. |
| `target` | `string` | Topic to publish to. |
| `time` | `number` | On-duration in milliseconds. |

```js
// entrance light stays on for 30 s after doorbell
timer('home/doorbell', 'home/light/entrance', 30_000);
```

---

## she.api — HTTP endpoint registration

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
    presence: getValue('home/presence'),
}));

// GET /api/controller/sensor/living → { temp: 21.5 }
she.api.get('/sensor/:room', (req) => ({
    temp: getValue('home/sensor/' + req.params.room + '/temp'),
}));

// POST /api/controller/scene
she.api.post('/scene', (req, body) => {
    publish('home/scene/set', body.name);
    return { ok: true };
});
```

See [http-api.md](http-api.md) for authentication details and system endpoints.
