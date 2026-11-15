## she sandbox API
Scripts run in a sandboxed VM with the `she` object injected. First lines: `/* global she */` then `'use strict';`. `require()` works for npm packages installed through the Packages tab (and for Node's built-ins such as `events`). Subscriptions and schedules survive broker reconnects; a saved script is hot-reloaded and loses its in-memory state.

### MQTT
```
she.mqtt.sub(topic, [opts], cb)        Subscribe; topic may be a string or an array; wildcards + (one level) and # (the rest)
    opts.change     only fire when the value changes
    opts.retain     also fire for the retained value present on connect and script start
    opts.shift      delay the callback by N seconds; opts.random adds up to N random seconds
    opts.condition  fn(val) or a one-line JS string over val/obj/objPrev; the callback runs only when truthy
    opts.debounce   SECONDS: bundle events, one callback once nothing came in for N s; opts.maxWait (seconds) runs it at the latest then
    opts.throttle   SECONDS: the first event at once, then at most one callback per N s (with the last event)
    opts.perTopic   with debounce/throttle on an array or wildcard: one bundle per topic; opts.name names it in the timer list
    opts.flushOnUnload  with debounce: run a pending callback once on unload/reload (default: dropped)
    cb(topic, val, obj, objPrev, msg)   obj and objPrev are { val, ts, lc }; debounced: the last event, objPrev from before the first bundled one
she.mqtt.pub(topic, payload, [opts])   Publish; objects are JSON-stringified; opts { qos, retain, changed, status } — status: true marks a deliberate publish to a <prefix>/status/… topic (a derived value beside an adapter's, or a script that is a device's adapter) and silences the status-topic warning; never use it to make a command "work"
    opts.changed    publish only when the payload differs from this script's last publish to the topic (before that: from the topic's state, set→status)
she.mqtt.get(topic)                    Last known value (undefined when never seen); an empty payload removes a topic
she.mqtt.getProp(topic, 'val'|'ts'|'lc')  One property of the state; without a property the whole { val, ts, lc }
she.mqtt.age(topic, ['message'])       Seconds since the last change, or since the last message with 'message'; NaN when never seen
she.mqtt.link(src, target, [fn])       Forward src changes to target, optionally transformed
she.mqtt.or / and / max / min(srcs[], topicOrCb)   Combine sources; publish 1/0 or the extreme value; re-evaluated on every change
she.mqtt.timer(src, ms, topicOrCb)     Publish 1 when src turns truthy, 0 after ms (a number — swapped arguments throw at load); restarted when src fires again
                                        topicOrCb: a topic string or cb(topic, val)
she.mqtt.command(topic, payload, [opts])  → Promise<{ val, ms, tries, already? }>: publish a command and wait for the device's status to confirm it (3.0.0-beta.0)
    confirm topic derived: <inst>/set/<path> → <inst>/status/<path> (val); zigbee2mqtt <base>/<dev>/set → <base>/<dev> (field = the payload's key, or opts.path); else opts.confirm is required (TypeError)
    opts { confirm, path, expect (value or fn(val); default the payload), tolerance (numbers), timeout = 5 SECONDS per attempt, retries = 0, quiet }
    status already at the target → sent anyway, resolves at once with already: true; device offline (<inst>/connected < 2, <dev>/availability offline) → rejects at once
    rejects with Error { reason: 'timeout' | 'offline' | 'superseded' | 'unloaded', topic, payload, tries }; timeout/offline are logged as a warning with the script name (unless quiet)
    and counted in get_health; a rejection nobody catches is NOT an unhandled rejection. A new command to the same topic supersedes the running one. Pending commands are listed by list_timers.
    Use it for commands whose effect matters (heating, gates, switching off); she.mqtt.pub stays fire-and-forget. Callbacks that await it become async: wrap in try/catch.
    Lint: a pub/command to <inst>/status/… or to a zigbee2mqtt device topic is warned about at load (with the line) — commands go to the set topic.
she.mqtt.announce({ component, name, state_topic, command_topic, …, id?, device?, rooms? })  → { id, device, topic, remove() }
    announces an entity the SCRIPT provides through Home Assistant MQTT discovery (device form: homeassistant/device/<id>/config, retained, origin she,
    available while she is connected); Home Assistant, she's home model and mqtt2matter then see it like an adapter's device. Primary broker only.
    component: an HA MQTT platform (switch, sensor, binary_sensor, number, select, button, light, cover, …); every other HA option (unit_of_measurement,
    device_class, value_template, payload_on, min, max, options, icon, …) is passed on. sensor/binary_sensor need state_topic; switch/number/select/button… command_topic.
    name: short, device-relative; id: stable entity id (default from the name). device: default the script itself; 'Garden' or { name, model, id, rooms, … }
    = a named device several scripts may share. rooms: 'Bad' or ['Bad', …] → the device's suggested_area (the first room).
    she sets unique_id, platform, identifiers, origin and availability herself (passing them throws); extra availability entries carry ONLY topic,
    payload_available, payload_not_available, value_template. Mistakes throw a TypeError at the call.
    Calls in one tick → one config per device; re-announcing the same id replaces the entity; republished on every broker connect; remove() takes it back.
    When the script stops its entities go (cleared after 5 s, so a reload changes nothing); one a reloaded script no longer announces disappears.
    The script publishes the state itself: she.mqtt.pub(state_topic, val, { retain: true }) — an announced state topic is NOT warned about by the
    status-topic lint (announce first). A switch expects ON/OFF unless payload_on/state_on are set; { val } objects need value_template "{{ value_json.val }}".
she.mqtt('<name>')                     The same API (sub, pub, get, getProp, age, link, or/and/max/min, timer, command) on an additional broker configured under "brokers" (3.0)
    she.mqtt stays the primary broker; she.mqtt('shed').sub('tele/#', cb), she.mqtt('shed').pub('set/x', 1); .broker is the name (null on the primary)
    an unknown name throws at load; helpers work within one broker — across brokers use the mirror rules of the config, or sub on one side and pub on the other
    offline: pub is queued briefly, command rejects at once with reason 'offline' ("broker \"shed\" not connected"), sub { retain: true } gets the retained values when it connects
    the tools search_mqtt_topics / get_mqtt_topic / publish_mqtt take a "broker" argument for an additional broker's topics
```

### Timing helpers (MILLISECONDS, like setTimeout; cleared on unload/reload; pending runs listed by list_timers with kind and name)
```
she.timeout(ms, cb, [{ name }])         A restartable timer, created idle → handle.restart([ms]) arms or starts over, cancel(), pending(), remaining()
                                        the motion-light pattern: off.restart() on every motion, off.cancel() when the state changes
she.debounce(fn, wait, [opts])          Bundle calls: fn runs with the LAST call's args after `wait` ms of quiet; opts { maxWait, leading=false, trailing=true, flushOnUnload, name }
                                        → wrapped(...args) with cancel(), flush(), pending(); maxWait keeps a never-resting source from starving fn
she.throttle(fn, wait, [opts])          Rate-limit: first call at once, then at most once per `wait` ms; opts { leading=true, trailing=true, name }; trailing:false = fire, then block
she.debounce.keyed / she.throttle.keyed(fn, wait, [opts])   One state per key (the first argument, or opts.key(...args)); cancel(key)/flush(key)/pending(key), without key: all
she.retry(fn, [opts])                   → Promise; fn(attempt) may be async; opts { tries=3, delay=1000, backoff=1, onFail(err, tries), name }
                                        resolves with fn's result; after the last failure: onFail's return value, or rejects without onFail; an unload stops it
she.setTimeout / she.clearTimeout       The sandbox's setTimeout/clearTimeout under she (official aliases); a non-number delay is logged with the script name
```

### Scheduling
```
she.schedule(pattern, [opts], cb)      pattern: cron string | Date | 'sunrise' 'sunset' 'dawn' 'dusk' 'nauticalDawn' 'nauticalDusk' 'solarNoon' 'night'
    opts.shift    seconds offset (-1800 = 30 min before);  opts.random  up to N random seconds later
she.now()                              Milliseconds since the epoch
setTimeout / setInterval               Available; cleared automatically when the script is unloaded; a bad delay is logged with the script name
```

### Time (she.time — the daemon's zone, DST-safe; ts = ms | Date | ISO string, default now)
```
she.time.between(from, to, [ts])       In the window? from/to: 'HH:mm' or a sun event with offset ('sunset-30m', 'dawn+1h', 'sunrise+90s'); from inclusive, to exclusive
                                        to before from crosses midnight: she.time.between('22:00', '06:00') is the whole night in one call
she.time.at(time, [ts])                ms of 'HH:mm' or a sun event on the day of ts; '24:00' = next midnight; NaN when the sun event does not occur
she.time.startOfDay / endOfDay([ts])   ms of midnight / of the day's last ms;  she.time.addDays(ts, n)  the same wall clock n days later (DST-safe, not +86400000)
she.time.parts([ts])                   { year, month 1-12, day, hour, minute, second, millisecond, weekday 0=Sunday, offset (min), zone } — instead of getHours()/getDay()
she.time.isWeekend / isHoliday / isWorkday([ts])   holidays from the config (holidays: 'DE-BW', holidaysExtra: [...]); she.time.holiday([ts]) → name or null
she.time.format(ts, [pattern])         tokens YYYY YY M MM MMM MMMM D DD H HH m mm s ss SSS dd (So) ddd (Sonntag) Z (+01:00) [literal]; default 'YYYY-MM-DD HH:mm:ss'
she.time.iso([ts])                     '2026-10-25T02:41:00+02:00' — ISO 8601 WITH offset: sortable even in the autumn double hour
she.time.duration(a, b)                b - a in ms, the real difference;  she.time.humanize(ms, [{ parts: 2, long }]) → '2 h 40 min' / '2 Stunden 40 Minuten'
    DST rules: a time in the spring gap (02:30) resolves to 03:30; one in the autumn double hour to its first occurrence; windows and durations compare instants
    Prefer she.time over new Date().getHours()/getDay()/toLocale*/padStart: those use the process zone and break around the DST change
```

### sheDB (documents, ids like topics: devices/lamp1)
```
she.db.get(id)                         Document or undefined
she.db.set(id, doc)                    Create or overwrite
she.db.extend(id, partial)             Deep-merge into the document
she.db.delete(id)
she.db.prop(id, 'set'|'create'|'del', prop, val)   One nested property
she.db.sub(pattern, cb)                Document changes; MQTT-style wildcard
she.db.query(filter, mapFn, [reduceFn])  Synchronous ad-hoc query → Array
she.db.getView(id) / subView(pattern, cb) / setView(id, definition)   Stored map/reduce views
```

### Home model (she.home — rooms, floors, functions over the entities announced through HA discovery; needs sheDB)
```
she.home.floors()                      [{ id, name, level, order, rooms: [room ids] }] by order
she.home.rooms()                       [{ id, name, floor, order, icon, aliases, entities: n }] by floor and order
she.home.entities([selection])         entity summaries by name: { id: 'she/entity/…', source, name, rooms: [], floors: [], functions: [], labels: [],
                                        component, device_class, unit, state_topic, command_topic, device: 'she/device/…' }
    selection { room, floor, function, label, component, hidden }: all given must match; room = id, name or alias, '' = without a room;
    only announced, not hidden entities unless hidden: true. An entity can be in SEVERAL rooms (rooms is a list).
    functions (ids): lighting, shading, heating, climate, openings, security, energy, presence, media, maintenance (+ the user's own)
she.home.sub(selection, [{ change }], cb)   cb(entity, val, obj, prev, topic) on every message on a state topic of the selection;
                                        follows added/moved entities; → { entities(), cancel() }; val is the raw payload (z2m: an object)
she.home.entity(idOrTopic)             ONE entity with live state and commands in Home Assistant terms; null when unknown.
                                        idOrTopic = she/entity/… | unique_id | a topic it reads or writes. The summary fields plus:
    .state()        { state: 'ON', brightness: 102, color_temp: 370 } — read through the discovery config and its templates;
                    attributes nothing was received for are left out. PREFER THIS over parsing device payloads yourself.
    .available()    true | false | undefined (availability topics silent)
    .turnOn([attrs]) / .turnOff()   light, switch, fan: ON/OFF; cover: open/closed; button, scene: trigger; NOT a lock (set({ state: 'LOCKED' | 'UNLOCKED' }))
    .setPosition(0-100) (100 = open)   .setTemperature(n)   .trigger()   .set({ any attributes }) → the publishes sent
    .snapshot() → the settable part of the state; .set(snapshot) restores it.  .matches(expected, [{ tolerances }]) → { match, unknown, mismatches }
    .sub((now, before) => …)   { state, available, present }; fires only when state or availability CHANGES; cancelled on unload
    .attributes     { name: { read, write, min?, max?, step?, unit?, options? } } — what THIS entity tells and takes; .primary; .stateless; .topics
    attributes: light state ON|OFF, brightness 0-255, color_temp (mireds), hs [0-360, 0-100], xy, rgb, effect, color_mode;
        switch/binary_sensor state ON|OFF; cover state open|closed|opening|closing|stopped, position, tilt (%, 100 = open);
        climate mode, temperature, temperature_low/high, fan_mode, preset_mode (+ read-only current_temperature, action);
        fan state, percentage, preset_mode; lock state LOCKED|UNLOCKED; select option; number/sensor value
    What an entity cannot take is not sent; the script log says why. Nothing throws for it.
she.home.assign(id, { name, rooms, functions, labels, hidden, notes })   id = she/entity/… | she/device/… | unique_id;
                                        null = inherit again, [] = none on purpose → the summary afterwards; mistakes throw
Standard views (she.db.getView, read-only, objects): she/floors, she/rooms, she/entities/by-room ({room: [summary]}, "" = no room),
    by-floor, by-function, by-room-function ({room: {function: [summary]}}), by-component, by-label, she/topics ({state topic: [summary]}),
    she/devices/by-adapter, she/devices/unassigned ({devices, entities}), she/devices/gone, she/entities/battery
Aggregates (retained, while the home model is on): she/status/room/<room>/<aggregate>, she/status/floor/<floor>/…, she/status/home/…
    aggregate = light (bool) | lights (count) | open (bool) | temperature | humidity (mean, + min, max) | occupied (bool) | power (W, sum)
    payload {val, ts, lc, members: [{id, name, val}]}; val null = nothing known; "she" is the instance name
    e.g. she.mqtt.sub('she/status/room/+/open', { change: true }, (topic, open) => …)
Write scripts against rooms and functions, not topics: she.home.entities({ room: 'bathroom', function: 'openings' }),
    and act on them through she.home.entity(e.id): for (const e of she.home.entities({ room: 'hall', function: 'lighting' })) she.home.entity(e.id).turnOff();
```

### Matter (use names for node, endpoint and cluster)
```
she.matter.sub(node, endpoint, cluster, attr, cb)   → listenerId;  she.matter.unsub(listenerId)
she.matter.get(node, endpoint, cluster, attr)       → Promise<value>
she.matter.send(node, endpoint, cluster, cmd, [args]) → Promise<result>
```

### HTTP, secrets, shared state, logging
```
she.http.fetch(url, [opts], [cb])      → Promise<{ body, code, headers }>; body parsed when JSON; rejects on non-2xx (the error carries body, code, headers)
she.http.sub(path, cb)                 POST webhook at /api/<script><path>; cb(body, { params, query, headers })
she.api.get/post/put/delete(path, handler)   HTTP routes under /api/<script>/; the return value is sent as JSON
she.secrets.get('group/field')         A secret from the Secrets tab (never put secrets into a script); has('group/field')
she.global                             One object shared by all scripts; guard reads with ?. (load order is not guaranteed)
she.config.latitude / longitude        From the daemon config (read-only)
she.debug / info / warn / error(...)   Logging, prefixed with the script name
she.influx.query(q) / write(measurement, fields, [tags], [ts]) / getLast(topic, n) / getRange(topic, from, to)   When Influx is configured
she.elastic.search(index, query) / get(index, id) / index(index, doc, [id]) / find(index, field, text)             When Elastic is configured
```
