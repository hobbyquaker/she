## she sandbox API

Scripts run in a sandboxed VM. The `she` object is injected automatically.

### Script conventions
- First lines: /* global she */ then 'use strict';
- No require() — the module system is not available
- All subscriptions and schedules persist across reconnects

### MQTT
```
she.mqtt.sub(topic, [opts], cb)        Subscribe; wildcards: + (1 level) # (multi)
                                         opts.change: true = only fire when value changes
she.mqtt.pub(topic, payload, [opts])   Publish; opts: { qos, retain }
she.mqtt.get(topic)                    Current retained value (sync)
she.mqtt.set(topic, val)               Publish as retained
she.mqtt.link(src, target, [fn])       Forward src changes to target; optional transform
she.mqtt.age(topic)                    Seconds since topic last received a message
she.mqtt.on('connect'|'disconnect', cb) MQTT lifecycle events
```

### Scheduling
```
she.schedule(pattern, [opts], cb)
  pattern: cron string | Date | suncalc event name
  suncalc events: 'sunrise' 'sunset' 'dawn' 'dusk'
                  'nauticalDawn' 'nauticalDusk' 'solarNoon' 'night'
  opts.shift:  seconds offset (e.g. -1800 = 30 min before event)
  opts.random: max random delay in seconds added to the trigger time
```

### Universal key-value API
```
she.on(key, cb)        Subscribe. Key prefixes: mqtt::  var::  matter::
she.set(key, val)      Set value (mqtt:: or var:: namespaces)
she.get(key)           Current value
she.getObject(key)     Current { val, ts, lc } state object
```

### Variable system (var:: namespace)
Topics prefixed with "var" (default) are persisted as retained MQTT messages
and available across scripts via she.get('var::name') / she.set('var::name', v).

### sheDB
```
she.db.get(id)                      Get document (undefined if not found)
she.db.set(id, doc)                 Create or overwrite document
she.db.extend(id, partial)          Deep-merge partial into existing document
she.db.delete(id)                   Delete document
she.db.sub(pattern, cb)             Subscribe to document changes (MQTT wildcard)
she.db.query(filter, mapFn, [reduceFn])  Synchronous ad-hoc query → Array
```

### Matter

Use names for nodeId, endpointId and cluster, not numbers

```
she.matter.sub(nodeId, endpointId, cluster, attr, cb)    Subscribe to attribute
she.matter.unsub(listenerId)
she.matter.get(nodeId, endpointId, cluster, attr)         → Promise<value>
she.matter.send(nodeId, endpointId, cluster, cmd, [args]) → Promise<result>
```

### Helpers
```
she.mqtt.timer(src, ms, topicOrCb)   Pulse topicOrCb=1 for ms after src goes truthy
                                         topicOrCb: topic string or callback(topic, val)
she.mqtt.or(srcs[], topicOrCb)       Publish 1 if any source truthy, else 0
she.mqtt.and(srcs[], topicOrCb)      Publish 1 if all sources truthy, else 0
she.mqtt.max(srcs[], topicOrCb)      Publish maximum of source values
she.mqtt.min(srcs[], topicOrCb)      Publish minimum of source values (0 if none set)
                                         All topicOrCb: topic string or callback(topic, val)
she.now()                            Current timestamp in ms
she.debug / .info / .warn / .error   Structured logging (prefixed with script name)
she.global                           Shared mutable object across all scripts
she.fetch(url, [opts])               HTTP/HTTPS fetch → Promise<string|object>
                                       Auto-parses JSON by Content-Type.
                                       Throws on non-2xx status.
she.config.latitude                  Read-only: geographic latitude from daemon config
she.config.longitude                 Read-only: geographic longitude from daemon config
```

### Script HTTP API
Scripts can expose HTTP endpoints under `/api/<scriptName>/`.
```
she.api.get(path, handler)           GET /api/<script><path> → handler(req)
she.api.post(path, handler)          POST /api/<script><path> → handler(req, body)
she.api.put(path, handler)           PUT /api/<script><path> → handler(req, body)
she.api.delete(path, handler)        DELETE /api/<script><path> → handler(req)
```
req = { params, query, headers }. Return value (or resolved Promise) is JSON-serialised.
Express path params supported: she.api.get('/items/:id', (req) => ...).
