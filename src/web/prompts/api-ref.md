## she sandbox API
Scripts run in a sandboxed VM with the `she` object injected. First lines: `/* global she */` then `'use strict';`. `require()` works for npm packages installed through the Packages tab (and for Node's built-ins such as `events`). Subscriptions and schedules survive broker reconnects; a saved script is hot-reloaded and loses its in-memory state.

### MQTT
```
she.mqtt.sub(topic, [opts], cb)        Subscribe; topic may be a string or an array; wildcards + (one level) and # (the rest)
    opts.change     only fire when the value changes
    opts.retain     also fire for the retained value present on connect and script start
    opts.shift      delay the callback by N seconds; opts.random adds up to N random seconds
    opts.condition  fn(val) or a one-line JS string over val/obj/objPrev; the callback runs only when truthy
    cb(topic, val, obj, objPrev, msg)   obj and objPrev are { val, ts, lc }
she.mqtt.pub(topic, payload, [opts])   Publish; objects are JSON-stringified; opts { qos, retain }
she.mqtt.get(topic)                    Last known value (undefined when never seen); an empty payload removes a topic
she.mqtt.getProp(topic, 'val'|'ts'|'lc')  One property of the state; without a property the whole { val, ts, lc }
she.mqtt.age(topic, ['message'])       Seconds since the last change, or since the last message with 'message'; NaN when never seen
she.mqtt.link(src, target, [fn])       Forward src changes to target, optionally transformed
she.mqtt.or / and / max / min(srcs[], topicOrCb)   Combine sources; publish 1/0 or the extreme value; re-evaluated on every change
she.mqtt.timer(src, ms, topicOrCb)     Publish 1 when src turns truthy, 0 after ms; restarted when src fires again
                                        topicOrCb: a topic string or cb(topic, val)
```

### Scheduling
```
she.schedule(pattern, [opts], cb)      pattern: cron string | Date | 'sunrise' 'sunset' 'dawn' 'dusk' 'nauticalDawn' 'nauticalDusk' 'solarNoon' 'night'
    opts.shift    seconds offset (-1800 = 30 min before);  opts.random  up to N random seconds later
she.now()                              Milliseconds since the epoch
setTimeout / setInterval               Available; cleared automatically when the script is unloaded
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
