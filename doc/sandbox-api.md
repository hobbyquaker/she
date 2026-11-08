# Sandbox API Reference

Every `.js` file loaded by **she** runs in an isolated VM sandbox. All sandbox methods live on the `she` object injected into every script.

---

## Contents

- [Logging](#logging)
- [she.mqtt — MQTT access](#shemqtt----mqtt-access)
- [she.now()](#shenow)
- [Timing helpers](#timing-helpers) — `she.timeout`, `she.debounce`, `she.throttle`, `she.retry`, `she.setTimeout`
- [she.schedule()](#sheschedulepattern-options-callback)
- [she.time — Time windows, holidays, formatting](#shetime----time-windows-holidays-formatting)
- [she.global](#sheglobal)
- [she.http — HTTP helpers](#shehttp----http-helpers)
- [she.config](#sheconfig)
- [she.secrets](#shesecrets)
- [she.api — Script HTTP routes](#sheapi----script-http-routes)
- [she.db — sheDB document store](#shedb----shedb-document-store)
- [she.matter — Matter integration](#shematter----matter-integration)
- [she.influx — InfluxDB integration](#sheinflux----influxdb-integration)
- [she.elastic — Elasticsearch integration](#sheelastic----elasticsearch-integration)
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
| `[options.debounce]` | `number` | **Seconds.** Bundle events: call the callback once no event came in for this long. See [Debounce and throttle in a subscription](#debounce-and-throttle-in-a-subscription). |
| `[options.maxWait]` | `number` | **Seconds.** With `debounce`: call the callback at the latest this long after the first bundled event, even while events keep coming. |
| `[options.throttle]` | `number` | **Seconds.** Call the callback for the first event at once, then at most once per window — with the last event — while events keep coming. |
| `[options.perTopic]` | `boolean` | With `debounce` or `throttle` on an array or a wildcard: one bundle per topic instead of one for the whole subscription. |
| `[options.name]` | `string` | The name of the pending debounce/throttle in the timer list (default: the topic). |
| `[options.flushOnUnload]` | `boolean` | With `debounce`: run a pending callback once when the script is unloaded or reloaded (default: it is dropped). |
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

// delayed execution
she.mqtt.sub('home/motion/hall', { change: true, shift: 5 }, (topic, val) => {
    if (!val) she.mqtt.pub('home/light/hall', 0);
});
```

#### Debounce and throttle in a subscription

A dashboard text that depends on twenty topics would be rebuilt twenty times when they all change within a second. `debounce` bundles the events: the callback runs once, when no event came in for `debounce` seconds — and, with `maxWait`, at the latest `maxWait` seconds after the first event of a bundle, so a topic that never rests cannot starve it. `throttle` is the other shape: react to the first event at once, then at most once per window.

```js
// one rebuild per burst, at the latest every 15 s while values keep changing
she.mqtt.sub(topics, { debounce: 5, maxWait: 15 }, () => {
    const html = render(topics.map((t) => she.mqtt.get(t)));
    she.mqtt.pub('var/set/Infobox', html, { changed: true });
});
```

The callback receives the **last** bundled event's `topic`, `val`, `obj` and `msg`, and the `objPrev` from **before the first** bundled event — so `obj.val !== objPrev.val` still tells whether the value really changed over the whole bundle. On an array of topics or a wildcard, one bundle serves all topics; `perTopic: true` keeps one per topic (the idle ones are forgotten). The units are **seconds**, like `shift` and `random`.

A pending bundle is dropped when the script is unloaded or hot-reloaded, like a `setTimeout`; `flushOnUnload: true` runs it once instead. Pending bundles appear in the timer list (`list_timers` in the AI chat) as `debounce "<name>"` / `throttle "<name>"` with the time they are due.

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
| `[options.changed]` | `boolean` | `false` | Publish only when the payload differs from the one this script last published to the topic. Before the script's first publish of a run, the comparison is with the topic's current value in the state store — for a command topic (`<prefix>/set/<name>`) with its `status` sibling, where a variable's or an adapter's state lives. |

```js
she.mqtt.pub('home/light/kitchen', 1);
she.mqtt.pub('home/sensor/data', { temp: 21.5, hum: 60 }, { retain: true });

// a value that is recomputed often but rarely changes: publish it only when it did
she.mqtt.pub('var/set/Infobox', html, { changed: true });
```

`changed` compares by value (`'21.5'` and `'21.50'` are the same, so are `[1,2]` and `{"val":[1,2]}`). The last payloads are remembered per script, for up to 200 topics; a hot reload starts over with the state store — which also covers the broker's echo of your own publish that has not arrived yet.

---

### she.mqtt.get(topic)

Returns the last known value for a topic, or `undefined` if the topic has never been seen.

A message with an **empty payload** removes the topic from the state store (mqtt-smarthome convention — this is also what "clearing" a retained message looks like), so `she.mqtt.get()` returns `undefined` again afterwards. Subscription callbacks still fire for empty-payload messages (they are commonly used as plain triggers) with `''` as the value.

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

### she.mqtt.age(topic, [mode])

Returns the number of **seconds** since the topic's value last changed (based on the state's `lc` timestamp). Pass `'message'` as second argument to get the seconds since the last *received message* instead (`ts`) — repeated identical values reset that clock, which is what you want for sensor heartbeat checks.

This works for every topic — payloads don't need to carry their own timestamps; she stamps arrival time on every message. Returns `NaN` for topics never seen.

```js
if (she.mqtt.age('home/motion/hall') > 300) {
    she.log('no motion for 5 minutes');
    she.mqtt.pub('home/light/hall', 0);
}

// seconds since the last message, regardless of value changes
if (she.mqtt.age('home/sensor/temp', 'message') > 600) {
    she.warn('temperature sensor silent for 10 minutes');
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
| `ms` | `number` | On-duration in milliseconds. Must be a number: swapped arguments throw a `TypeError` at load (`she.mqtt.timer(src, ms, target): ms must be a number of milliseconds`). |
| `target` | `string \| function` | Topic to publish to, or `callback(topic, val)`. |

For a timer that is restarted from your own logic rather than by a topic, see [`she.timeout`](#shetimeoutms-callback-options).

```js
// entrance light stays on for 30 s after doorbell
she.mqtt.timer('home/doorbell', 30_000, 'home/light/entrance');

// callback — drive a Matter device instead of publishing
she.mqtt.timer('home/motion/hall', 30_000, (topic, val) => {
    she.matter.send('bulb', 1, 'OnOff', val ? 'on' : 'off');
});
```

### she.mqtt.command(topic, payload, [options])

Publishes a command and waits for the device's status to confirm it. Returns a Promise that resolves with `{ val, ms, tries }` — the confirming value, how long it took, how many attempts it needed — or rejects with an `Error` whose `reason` says why. `she.mqtt.pub` stays fire-and-forget; use `command` where it matters that the command took effect: heating, gates, switching things off.

| Param | Type | Description |
|---|---|---|
| `topic` | `string` | The command topic (`inst//path` is `inst/set/path`). |
| `payload` | `string \| number \| boolean \| object` | What to send; objects are JSON-stringified. |
| `options.confirm` | `string` | The status topic that shows the effect. Derived when omitted (see below). |
| `options.path` | `string` | The field of a JSON status payload to look at (`'state'`, `'POWER'`). |
| `options.expect` | `any \| (val) => boolean` | The value to expect, or a function. Default: the payload (its `val` for `{ val }` objects, its single field for one-key objects). |
| `options.tolerance` | `number` | For numbers: `|status − expect| ≤ tolerance` confirms. Default `0`. |
| `options.timeout` | `number` | Seconds per attempt. Default `5`. |
| `options.retries` | `number` | Further attempts after a timeout (the payload is sent again). Default `0`. |
| `options.quiet` | `boolean` | No warning in the log when the command fails; the Promise still rejects. |

**Where the confirmation is read** — a small table of conventions, not script code:

| Command topic | Status topic | Value |
|---|---|---|
| `<inst>/set/<path>` (mqtt-smarthome) | `<inst>/status/<path>` | the `val` of the status payload |
| `<base>/<device>/set` (zigbee2mqtt) | `<base>/<device>` | the field named by the payload's single key or `options.path`; `state` for a bare `"ON"` |
| `<base>/<device>/set/<attribute>` (zigbee2mqtt, when `<base>/<device>` is known and no status topic is) | `<base>/<device>` | the attribute |
| anything else | `options.confirm` required | `options.path`, or the whole value |

Values are compared loosely: `true`, `1`, `"ON"` and `"on"` confirm each other, `false`, `0`, `"OFF"` likewise; numbers by value within `tolerance`; strings case-insensitively. An object payload with several fields expects every field.

**What happens:**

- **The status already shows the target** — the command is sent anyway (the device may be out of sync with its last report) and the Promise resolves at once with `{ val, ms: 0, tries: 1, already: true }`; many devices send no echo for an unchanged value.
- **The device is known to be offline** — `<inst>/connected` below 2, or zigbee2mqtt's `<base>/<device>/availability` `offline` — nothing is sent and the Promise rejects at once with `reason: 'offline'`.
- **No confirmation within `timeout`** — the payload is sent again while `retries` are left, then the Promise rejects with `reason: 'timeout'`.
- **A newer `command` to the same topic** from the same script replaces a running one, which rejects with `reason: 'superseded'` (no warning).
- **The script is unloaded or reloaded** while a command is pending — it rejects with `reason: 'unloaded'` (no warning).
- **Cancelled from the editor's Runtime panel** — `reason: 'cancelled'`.

The error carries `reason`, `topic`, `payload` (as sent), `tries` and `confirm` (the status topic). A timeout or an offline device is logged as a warning with the script's name, topic and payload — unless `quiet` — and counted in the daemon's status (`commandsFailed`, shown on the Runtime page and by the assistant's health tool). A rejection the script does not handle is **not** an unhandled rejection: the warning is the report. A pending command is a timer of the script: it shows in the Runtime page and the editor's Runtime panel with its topic and attempt, and the assistant's timer list prints it as `command "<topic>" in 4s`.

```js
// heating: insist on the setpoint, give up after three attempts
she.mqtt.sub('var/status/heatingTarget', { change: true }, async (topic, val) => {
    try {
        const r = await she.mqtt.command('hm/set/thermostat/SET_TEMPERATURE', val, { tolerance: 0.1, timeout: 10, retries: 2 });
        she.info('setpoint confirmed after', r.ms, 'ms');
    } catch (e) {
        she.error('setpoint not confirmed:', e.reason);   // the warning is already in the log
    }
});

// zigbee2mqtt: the state object confirms the field
await she.mqtt.command('zigbee2mqtt/kitchen/set', { state: 'OFF' });

// a device with its own convention: say where the effect shows
await she.mqtt.command('tasmota/cmnd/POWER', 'ON', { confirm: 'tasmota/tele/STATE', path: 'POWER' });

// fire and forget stays fire and forget
she.mqtt.pub('hm/set/lamp/STATE', true);
```

**Lint.** When a script is loaded, its literal publish topics are checked: a `she.mqtt.pub` (or `setValue`, `command`) to `<inst>/status/…`, or to a topic zigbee2mqtt publishes as a device's state, is logged as a warning with the script name and line — the command would never reach the device. The same check runs once per topic at runtime for topics built dynamically.

---

## she.now()

Returns the current time in milliseconds since the Unix epoch (equivalent to `Date.now()`).

---

## Timing helpers

The patterns scripts build from `setTimeout`/`clearTimeout` and timestamp variables — a light that goes off some minutes after the last motion, a mailbox sensor that must not fire twice in a minute, a dashboard that is rebuilt once per burst of changes, a flaky fetch that is tried again — as helpers. All of them use the script's tracked timers: **a pending run is dropped when the script is unloaded or hot-reloaded**, like a `setTimeout` (a debounce can ask for `flushOnUnload`), and **pending runs appear in the timer list** (`list_timers` in the AI chat) with their kind, name and due time. An exception in the wrapped function is logged with the script's name like one in a subscription callback.

**Units: milliseconds**, like `setTimeout` — the subscription options `debounce`/`maxWait`/`throttle` take seconds, like `shift`.

### she.setTimeout(fn, ms, ...args) / she.clearTimeout(id)

The sandbox's `setTimeout` and `clearTimeout` under the `she` object — the same functions, officially. A delay that is given but is not a number of milliseconds (`undefined` from a missing config field, `'5m'`, `NaN`) is logged with the script's name (`setTimeout: delay is not a number of milliseconds (got "5m"), using 0`) and runs at once; `setTimeout(fn)` without a delay runs on the next tick as in Node. `setInterval`/`clearInterval` exist as globals only.

### she.timeout(ms, callback, [options])

A restartable one-shot timer. It is created **idle**; `restart()` arms it, another `restart()` starts the delay over, `cancel()` disarms it. This replaces the `let timer; clearTimeout(timer); timer = setTimeout(...)` dance of every motion light.

| Param | Type | Description |
|---|---|---|
| `ms` | `number` | Delay in milliseconds. |
| `callback` | `function` | Called with no arguments when the delay ran out. |
| `[options.name]` | `string` | Name in the timer list (default: the callback's name). |

Returns a handle:

| Method | Description |
|---|---|
| `restart([ms])` | Arm the timer, or start the delay over; a new `ms` replaces the delay. `start()` is the same. Returns the handle. |
| `cancel()` | Disarm. Returns the handle. |
| `pending()` | `true` while armed. |
| `remaining()` | Milliseconds until it fires, `0` when idle. |

```js
// motion light: off 5 minutes after the last motion, unless the door was opened meanwhile
const off = she.timeout(5 * 60_000, () => she.mqtt.pub('home/light/hall', 0), { name: 'hall light off' });
she.mqtt.sub('home/motion/hall', (topic, val) => {
    if (!val) return;
    she.mqtt.pub('home/light/hall', 1);
    off.restart();
});
she.mqtt.sub('home/door/front', { change: true }, (topic, val) => {
    if (val) off.cancel();
});

// re-evaluate at the next deadline, whichever event comes first
const evaluate = she.timeout(0, () => evaluateNow());
function plan(nextMs) {
    evaluate.restart(Math.max(0, nextMs - she.now()) + 100);
}
```

### she.debounce(fn, wait, [options])

Bundle calls: `fn` runs with the arguments of the **last** call once `wait` ms passed without a new one — and, with `maxWait`, at the latest `maxWait` ms after the first call of a bundle. Without `maxWait`, a source that never rests starves the callback; name the limit when that can happen.

| Param | Type | Default | Description |
|---|---|---|---|
| `fn` | `function` | | What to run. |
| `wait` | `number` | | Quiet period in milliseconds. |
| `[options.maxWait]` | `number` | | Run at the latest this many ms after the first bundled call. |
| `[options.leading]` | `boolean` | `false` | Also run on the first call of a bundle. |
| `[options.trailing]` | `boolean` | `true` | Run after the quiet period. |
| `[options.flushOnUnload]` | `boolean` | `false` | Run a pending call when the script is unloaded or reloaded. |
| `[options.name]` | `string` | `fn.name` | Name in the timer list. |

Returns the wrapped function with `cancel()` (drop the pending call), `flush()` (run it now; returns `fn`'s result) and `pending()` (`true` while a call waits).

```js
// recompute the heating once per burst of sensor changes, at the latest every 30 s
const recompute = she.debounce(computeSetpoints, 5_000, { maxWait: 30_000, name: 'heating' });
she.mqtt.sub(['home/temp/+', 'home/window/+', 'var/status/Mode'], () => recompute());
```

### she.debounce.keyed(fn, wait, [options]) / she.throttle.keyed(…)

The same, with a **separate state per key**. The key is the first argument of the call unless `options.key(...args)` says otherwise. `cancel(key)`, `flush(key)` and `pending(key)` act on one key, without a key on all of them; `keys()` lists the active ones. Idle keys are forgotten, so a wildcard subscription does not accumulate state.

```js
// a setpoint changed by hand counts once it stayed for 30 s — per room
const settled = she.debounce.keyed((room, setpoint) => markManual(room, setpoint), 30_000, { name: 'manual' });
she.mqtt.sub('home/thermostat/+/setpoint', (topic, val) => settled(topic.split('/')[2], val));
```

### she.throttle(fn, wait, [options])

Rate-limit calls: `fn` runs for the first call of a window at once and, when more calls came in, once more with the last arguments when the window ends — never more often than every `wait` ms.

| Param | Type | Default | Description |
|---|---|---|---|
| `fn` | `function` | | What to run. |
| `wait` | `number` | | Window in milliseconds. |
| `[options.leading]` | `boolean` | `true` | Run on the first call of a window. |
| `[options.trailing]` | `boolean` | `true` | Run once more at the end of a window when calls came in meanwhile. |
| `[options.name]` | `string` | `fn.name` | Name in the timer list. |

Returns the wrapped function with `cancel()`, `flush()` and `pending()` as above.

```js
// mailbox: the flap sensor bounces — notify once, then ignore it for a minute
const notify = she.throttle(() => she.mqtt.pub('notify/set/push', 'Post ist da'), 60_000, { trailing: false, name: 'mailbox' });
she.mqtt.sub('home/mailbox/flap', (topic, val) => {
    if (val) notify();
});
```

### she.retry(fn, [options])

Call `fn` until it succeeds, waiting between the attempts. `fn(attempt)` may return a promise. The promise resolves with `fn`'s result; when every attempt failed it calls `onFail(err, tries)` and resolves with its return value — or, without `onFail`, rejects with the last error (so `await` it in a `try/catch`). An unload stops the attempts; the promise then never settles.

| Param | Type | Default | Description |
|---|---|---|---|
| `fn` | `function` | | The attempt; gets the attempt number (1, 2, …). |
| `[options.tries]` | `number` | `3` | Attempts in total. |
| `[options.delay]` | `number` | `1000` | Milliseconds before the second attempt. |
| `[options.backoff]` | `number` | `1` | The delay is multiplied by this after each failure (`2` doubles it). |
| `[options.onFail]` | `function` | | `(err, tries)` after the last failure. |
| `[options.name]` | `string` | `fn.name` | Name in the timer list (`retry "<name> attempt 2/3"`). |

```js
// a weather service that fails now and then: three attempts a minute apart, then a warning
she.schedule('*/30 * * * *', () => {
    she.retry(() => she.http.fetch('https://weather.example.com/forecast'), {
        tries: 3,
        delay: 60_000,
        onFail: (err) => she.warn('forecast not loaded:', err.message),
        name: 'forecast',
    }).then((res) => {
        if (res) she.mqtt.pub('var/set/Forecast', res.body);
    });
});
```

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

## she.time -- Time windows, holidays, formatting

What scripts otherwise build from `getHours()`, `getDay()` and `padStart` — "after 6", "at night", "on a weekend", a formatted timestamp — once, in the daemon's time zone and safe across the daylight-saving changes. Every helper takes a timestamp in milliseconds (what `she.now()`, `obj.ts` and `Date.now()` give), a `Date` or an ISO string, and defaults to now.

**Configuration** (config file or *Config → Location*): `timezone` (IANA name; default the system zone — the zone `she.schedule` uses as well), `locale` (names and words, default `de-DE`), `holidays` (the region for `isHoliday()`: `DE`, a German state such as `DE-BW`, `AT`), `holidaysExtra` (a list of `MM-DD` or `YYYY-MM-DD`, each optionally followed by a name). An invalid value is logged at start-up and replaced by the default. Sun events use the coordinates of `she.schedule` (`latitude`/`longitude`).

| Method | Returns | Description |
|---|---|---|
| `she.time.between(from, to, [ts])` | `boolean` | Is `ts` in the window? `from`/`to` are `'HH:mm'` / `'HH:mm:ss'` or a sun event with an optional offset (`'sunset-30m'`, `'dawn+1h'`, `'sunrise+90s'`; units `ms`, `s`, `m`, `h`). `from` inclusive, `to` exclusive; a `to` before `from` crosses midnight (`'22:00', '06:00'`). |
| `she.time.at(time, [ts])` | `number` | The instant (ms) of `time` on the day of `ts` — `'06:00'` or a sun event like `'sunset-30m'`; `'24:00'` is the next midnight. `NaN` when a sun event does not occur that day. |
| `she.time.startOfDay([ts])` / `endOfDay([ts])` | `number` | Midnight of the day, and the day's last millisecond. |
| `she.time.addDays(ts, days)` | `number` | The same wall-clock time `days` days later (negative: earlier) — 23, 24 or 25 hours on the change days, not `+ 86400000`. |
| `she.time.parts([ts])` | `object` | `{ year, month (1–12), day, hour, minute, second, millisecond, weekday (0 = Sunday), offset (minutes), zone }` in the configured zone — the replacement for `getHours()` and friends. |
| `she.time.isWeekend([ts])` | `boolean` | Saturday or Sunday. |
| `she.time.isHoliday([ts])` | `boolean` | A public holiday of the configured region, or an extra one; `false` (and one warning per script) when none is configured. |
| `she.time.holiday([ts])` | `string \| null` | The holiday's name (`'Karfreitag'`), or `null`. |
| `she.time.isWorkday([ts])` | `boolean` | Neither weekend nor holiday. |
| `she.time.format(ts, [pattern])` | `string` | The tokens below; default `'YYYY-MM-DD HH:mm:ss'`. |
| `she.time.iso([ts])` | `string` | ISO 8601 with the zone's offset: `2026-10-25T02:41:00+02:00`. |
| `she.time.duration(a, b)` | `number` | `b − a` in ms — the real difference between two instants. |
| `she.time.humanize(ms, [{ parts, long }])` | `string` | `'2 h 40 min'`: the two largest units (`d`, `h`, `min`, `s`; `ms` below one second). `parts` shows more units, `long: true` spells them out in the locale (`'2 Stunden 40 Minuten'`). |
| `she.time.zone` / `.locale` / `.holidays` | `string` | The settings in use (`holidays` is `null` when not configured). |

**Format tokens**: `YYYY` `YY` year · `M` `MM` month, `MMM` `MMMM` its name · `D` `DD` day · `H` `HH` hour (24 h) · `m` `mm` minute · `s` `ss` second · `SSS` milliseconds · `dd` weekday short (`So`), `ddd` long (`Sonntag`) · `Z` offset (`+01:00`) · `[text]` literal. Names follow `locale`.

**Daylight-saving time.** The behaviour is fixed, and the tests pin it:
- A time that does not exist — `at('02:30')` on the day the clocks go forward — is the instant one hour later on the wall clock: 03:30. A window `02:00–03:00` is empty that day; `01:30–03:30` lasts one hour.
- A time that exists twice — `at('02:30')` on the day the clocks go back — is its first occurrence (still summer time). A window `02:00–03:00` lasts two hours that day; `22:00–06:00` nine.
- `between`, `duration` and `addDays` compare instants, so none of them is off by an hour.

```js
// a night window — one call, over midnight
if (she.time.between('22:00', '06:00')) she.mqtt.pub('home/set/hall/light', 30);

// relative to the sun: from half an hour before sunset until 23:00
she.mqtt.sub('home/status/hall/motion', (topic, val) => {
    if (val && she.time.between('sunset-30m', '23:00')) she.mqtt.pub('home/set/hall/light', 1);
});

// an event list that stays sortable in the double hour: the ISO timestamp carries the offset
she.mqtt.sub('home/status/+/door', (topic, val, obj) => {
    events.unshift({ at: she.time.iso(obj.ts), text: she.time.format(obj.ts, 'dd HH:mm') + ' ' + topic });
});

// a sleep duration across the autumn change: 02:40 CEST → 06:25 CET is 4 h 45 min, not 3 h 45 min
const night = she.time.duration(asleepTs, awakeTs);
she.mqtt.pub('var/set/sleep/last', she.time.humanize(night));

// on working days only, every five minutes between 6 and 8 in the morning
she.schedule('*/5 6-7 * * *', () => {
    if (she.time.isWorkday()) she.mqtt.pub('home/set/kitchen/radio', 1);
});

// tomorrow at 06:00 — right on the 23- and 25-hour days as well
const wake = she.time.at('06:00', she.time.addDays(she.now(), 1));
```

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

Makes an HTTP/HTTPS request using the native `fetch` API. Automatically parses the response body: if the server returns a `Content-Type` containing `json`, the response is parsed as JSON; otherwise it is returned as plain text. When a JSON `Content-Type` carries a body that does not actually parse, the raw text body is returned instead of throwing.

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
| `she.config.timezone` | `string` | The IANA time zone `she.time` and `she.schedule` work in — the configured one, or the system's. |
| `she.config.locale` | `string` | The locale of `she.time.format`'s names (default `de-DE`). |
| `she.config.holidays` | `string \| null` | The holiday region of `she.time.isHoliday()`, or `null` when none is configured. |

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

## she.secrets

Read access to the **Secrets** tab's store — named groups of string values (SMTP passwords, API tokens, PEM keys) kept encrypted outside the scripts directory, so they never end up in a script file or in git. Values are entered in the web UI (or with `she --secret-set`). Fields are *secret* (the daemon never sends the value to a browser — scripts are the only readers) or *plain* (a user name, a host — shown in the UI); scripts read both the same way.

| Method | Returns | Description |
|---|---|---|
| `she.secrets.get('group/field')` | `string \| undefined` | The value. Unknown path → `undefined` and one warning per script and path. |
| `she.secrets.get('group')` | `object \| undefined` | A frozen `{ field: value }` copy of the whole group. |
| `she.secrets.has('group/field')` | `boolean` | Existence check without a warning. |

Synchronous — the store is held in memory. Changes made in the Secrets tab are visible to the next `get()` immediately; a script that copied a value into a variable at load time keeps the old one until it is reloaded. When the store is locked (key missing at daemon start), `get()` returns `undefined` for everything and the warning says so.

Known secret values are replaced with `***` in the log output (Logs tab, log file, console), so an accidental `she.info(response)` does not leak a token. Values shorter than 6 characters are not redacted.

```js
const smtp = she.secrets.get('smtp'); // { host, user, password }

she.mqtt.sub('alarm/mail', async () => {
    if (!smtp) return she.warn('smtp secrets missing');
    await she.http.fetch('https://mailer.local/send', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + she.secrets.get('mailer/token') },
        body: { to: 'me@example.org', text: 'alarm' },
    });
});
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

**Events.** When `attrName` names a cluster *event* instead of an attribute, the callback gets the event's payload and, as its second argument, `{ event: true, cluster, name, ts }`. Battery buttons (IKEA BILRESA, the *Generic Switch* endpoints of the JUNG/smattex buttons) report presses as events of the Switch cluster — `initialPress`, `shortRelease`, `longPress`, `longRelease`, `multiPressOngoing`, `multiPressComplete` — which carry what the `currentPosition` attribute does not: the press count and long presses.

```js
she.matter.sub('bilresa', 1, 'switch', 'multiPressComplete', (ev) => {
    if (ev.totalNumberOfPressesCounted === 2) she.mqtt.pub('hm/set/Licht Bad/STATE', true);
});
she.matter.sub('bilresa', 1, 'switch', 'longPress', () => she.mqtt.pub('hm/set/Licht Bad/STATE', false));
```

The Matter page's event feed shows the same events, tagged `event`.

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

// set brightness level (0–254); transitionTime is in tenths of a second
await she.matter.send('1', 1, 'levelControl', 'moveToLevel', { level: 128, transitionTime: 10 });

// like moveToLevel, but also turns the device on when it is off
await she.matter.send('1', 1, 'levelControl', 'moveToLevelWithOnOff', { level: 254 });
```

**Groups.** A group made on the Matter page's Bindings tab is addressed as `'group:<name>'` (or `'group:<id>'`) with the endpoint left `null`: one multicast command reaches every member, and nothing answers — the promise resolves when the message is out (best effort; on Thread a lost multicast is not retried).

```js
await she.matter.send('group:Wohnzimmer', null, 'onOff', 'off');
await she.matter.send('group:Wohnzimmer', null, 'levelControl', 'moveToLevelWithOnOff', { level: 64, transitionTime: 20 });
```

Argument names follow the Matter *command* schema, which differs from the attribute names you read — e.g. the readable attribute is `currentLevel`, but `moveToLevel` takes `level`. Mandatory boilerplate fields are filled with neutral defaults when omitted: `optionsMask`/`optionsOverride` (empty bitmap — "obey the device's options") and `transitionTime` (`0` = instant). Any other mandatory field (like `level`) must be provided or the command fails TLV validation with a `Missing mandatory field` error naming the field.

---

## she.influx -- InfluxDB integration

Enabled when an `influx` config block is present in `config.json`. Both InfluxDB 2.x and classic InfluxDB 1.x are supported — the same `she.influx` API works against either.

**InfluxDB 2.x** (token / org / bucket):

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

**InfluxDB 1.x** (database / username / password):

```json
{
  "influx": {
    "url": "http://localhost:8086",
    "database": "she",
    "username": "user",
    "password": "secret"
  }
}
```

`username`/`password` are optional (omit them when the server runs without authentication); an optional `retentionPolicy` selects the retention policy for writes. The API version is inferred from the keys (`database` → 1.x, `token` → 2.x) and can be forced with `"version": 1`. Both variants can also be configured in the web UI (Settings → InfluxDB).

All methods return Promises. When InfluxDB is not configured every method resolves to an empty result immediately.

### she.influx.query(query)

Execute an arbitrary query and return the result rows as plain objects. Against InfluxDB 2.x the query is a [Flux query](https://docs.influxdata.com/flux/v0/); against 1.x it is an [InfluxQL query](https://docs.influxdata.com/influxdb/v1/query_language/).

```js
// InfluxDB 2.x — Flux
she.influx.query(`
  from(bucket: "mqtt")
    |> range(start: -1h)
    |> filter(fn: (r) => r["_measurement"] == "temperature")
`).then((rows) => she.log(rows));

// InfluxDB 1.x — InfluxQL (time comes back as a millisecond timestamp)
she.influx.query(`SELECT value FROM mqtt WHERE "topic" = 'home/sensor/temp' ORDER BY time DESC LIMIT 20`)
    .then((rows) => she.log(rows));
```

### she.influx.write(measurement, fields, [tags], [timestamp])

Write a single data point. `fields` is `{ fieldName: value }`.

```js
she.influx.write('temperature', { value: 21.5 }, { room: 'living' });
she.influx.write('events', { count: 1 }, {}, Date.now());
```

### she.influx.getLast(topic, n)

Return the last `n` recorded values for an MQTT `topic`, oldest first (looking back 30 days at most). Against InfluxDB 2.x, points are expected to carry a `topic` tag and the value is read from the `_value` field. Against 1.x, a **measurement named like the topic** is queried first (the common mqtt-to-influx schema, e.g. influx4mqtt: measurement = topic, field = `value`); if that yields nothing, a `topic`-tag scan across all measurements is tried. The value is read from the `value` field, falling back to the first data column.

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
