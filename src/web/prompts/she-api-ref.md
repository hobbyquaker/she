## she sandbox API

Scripts run in a sandboxed VM. The `she` object is injected automatically.

### Script conventions
- First lines: /* global she */ then 'use strict';
- No require() — the module system is not available
- All subscriptions and schedules persist across reconnects

### MQTT
```
she.mqtt.sub(topic, [opts], cb)        Subscribe; wildcards: + (1 level) # (multi)
                                         +//sensor  →  +/status/sensor shorthand
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
```
she.matter.sub(nodeId, endpointId, cluster, attr, cb)    Subscribe to attribute
she.matter.unsub(listenerId)
she.matter.get(nodeId, endpointId, cluster, attr)         → Promise<value>
she.matter.send(nodeId, endpointId, cluster, cmd, [args]) → Promise<result>
```

### Helpers
```
she.timer(src, target, ms)           Pulse target=1 for ms after src goes truthy
she.combineBool(srcs[], target)      Publish OR of source values to target
she.combineMax(srcs[], target)       Publish maximum of source values to target
she.link(src, target, [fn])          Alias for she.mqtt.link
she.age(topic)                       Alias for she.mqtt.age
she.now()                            Current timestamp in ms
she.debug / .info / .warn / .error   Structured logging (prefixed with script name)
she.global                           Shared mutable object across all scripts
```
