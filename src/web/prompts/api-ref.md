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
she.mqtt.pub(topic, payload, [opts])   Publish; objects are JSON-stringified; opts { qos, retain, changed }
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
