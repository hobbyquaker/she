## she sandbox API (the common part)
Scripts start with `/* global she */` and `'use strict';`. `require()` works for installed npm packages.
```
she.mqtt.sub(topic, [opts], cb)     cb(topic, val, obj)   opts: { change: true } fires on changes only; { debounce: 5, maxWait: 15 } (SECONDS) bundles events; wildcards + and #
she.mqtt.pub(topic, payload, [opts]) publish (commands: no retain); { changed: true } publishes only when the payload differs from the last one
she.mqtt.get(topic)                 last known value
she.mqtt.age(topic)                 seconds since the value last changed
she.mqtt.timer(src, ms, target)     publish 1 when src turns truthy, 0 after ms
she.mqtt.or(srcs[], target) / and   publish 1 when any / all sources are truthy, else 0
she.schedule('0 7 * * *', cb)       cron string, Date, or 'sunrise' / 'sunset' with { shift: seconds }
she.http.fetch(url, [opts])         → Promise<{ body, code, headers }>
she.debug / info / warn / error     logging
setTimeout / setInterval            available; she.timeout(ms, cb) → handle.restart()/cancel() is a restartable timer (motion light)
she.debounce(fn, ms, [{ maxWait }]) / she.throttle(fn, ms) / she.retry(fn, { tries, delay, onFail })   MILLISECONDS; cleared on reload
she.time.between('22:00', '06:00') / at('06:00') / isWorkday() / format(ts, 'dd HH:mm') / iso(ts) / duration(a, b) / humanize(ms)   the daemon's zone, DST-safe; not getHours()
```
Variables: read `var/status/<name>`, write `she.mqtt.pub('var/set/<name>', value)`.
For anything else ask with the tool she_api_doc or say that you are not sure.
