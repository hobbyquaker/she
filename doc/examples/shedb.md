# Examples — sheDB

sheDB is available when `--db-path` is configured. All methods are safe no-ops when sheDB is not initialised.

---

## Device registry

Store metadata about your devices. Scripts can look up names, locations, and settings without hardcoding them.

```js
// Populate once (or update via the DB tab in the web UI)
she.db.set('devices/hall/pir', {
    name:     'Hall PIR',
    location: 'hall',
    topic:    'home/motion/hall',
    active:   true,
});

she.db.set('devices/living/temp', {
    name:     'Living room thermometer',
    location: 'living',
    topic:    'home/sensor/living/temp',
    active:   true,
});
```

```js
// Look up a device by topic at runtime
function deviceFor(topic) {
    return she.db.query(
        'devices/#',
        (doc, emit) => { if (doc.topic === topic) emit(doc); },
        results => results[0]
    );
}

she.mqtt.sub('home/motion/hall', { change: true }, (topic, val) => {
    const device = deviceFor(topic);
    she.info(device?.name ?? topic, 'motion:', val);
});
```

---

## Script configuration — self-bootstrapping defaults

Each script creates its own config document with defaults on startup. The user edits the values in the DB tab.

```js
const CFG_ID = 'config/heating';
const DEFAULTS = { defaultTemp: 21, awayTemp: 17, rooms: ['living', 'kitchen', 'hall'] };

if (!she.db.get(CFG_ID)) she.db.set(CFG_ID, DEFAULTS);
const cfg = she.db.get(CFG_ID);

she.mqtt.sub('home/presence', { change: true }, (topic, val) => {
    const target = val ? cfg.defaultTemp : cfg.awayTemp;
    cfg.rooms.forEach(r => she.mqtt.pub(`home/thermostat/${r}/setpoint`, target));
});
```

If you change config values in the DB tab, hot-reload the script to pick them up (or use `she.db.sub` to react live — see below).

---

## React live to config changes

```js
const CFG_ID = 'config/heating';
const DEFAULTS = { defaultTemp: 21, awayTemp: 17 };

if (!she.db.get(CFG_ID)) she.db.set(CFG_ID, DEFAULTS);
let cfg = she.db.get(CFG_ID);

// Re-read config whenever the document changes
she.db.sub(CFG_ID, (id, doc) => {
    if (doc) {
        cfg = doc;
        she.info('heating config updated:', cfg);
    }
});
```

---

## Track last-seen timestamp for each device

```js
she.mqtt.sub('home/sensor/#', { change: true }, (topic, val) => {
    she.db.extend('devices/' + topic.replace('home/sensor/', ''), {
        lastSeen:  Date.now(),
        lastValue: val,
    });
});
```

---

## Event log / ring buffer

Store the last N events for a topic without filling up disk.

```js
const LOG_ID    = 'log/doorbell';
const MAX_ITEMS = 50;

she.mqtt.sub('home/doorbell', { change: true }, (topic, val) => {
    if (!val) return;

    const log = she.db.get(LOG_ID) ?? { events: [] };
    log.events.unshift({ ts: Date.now(), val });
    if (log.events.length > MAX_ITEMS) log.events.length = MAX_ITEMS;
    she.db.set(LOG_ID, log);
});

// Expose via HTTP
she.api.get('/doorbell-log', () => she.db.get('log/doorbell')?.events ?? []);
```

---

## Counter

```js
const COUNTER_ID = 'stats/doorbell-presses';

she.mqtt.sub('home/doorbell', { change: true }, (topic, val) => {
    if (!val) return;
    const doc = she.db.get(COUNTER_ID) ?? { count: 0 };
    she.db.set(COUNTER_ID, { count: doc.count + 1, lastTs: Date.now() });
});
```

---

## Query: list all active devices in a location

```js
const activeInHall = she.db.query(
    'devices/hall/#',
    (doc, emit) => { if (doc.active) emit(doc); }
);
she.info('active hall devices:', activeInHall.map(d => d.name));
```

---

## Query with reduce: count total active devices

```js
const totalActive = she.db.query(
    'devices/#',
    (doc, emit) => { if (doc.active) emit(1); },
    results => results.reduce((sum, n) => sum + n, 0)
);
she.info('total active devices:', totalActive);
```

---

## React to any document change

```js
// Log every change to any document under 'config/'
she.db.sub('config/#', (id, doc) => {
    if (doc === null) she.info(id, 'deleted');
    else she.info(id, 'updated:', JSON.stringify(doc));
});
```

---

## Store and retrieve a flag (e.g. holiday mode)

```js
// Set from the DB tab or via HTTP
she.api.post('/holiday', (req, body) => {
    she.db.set('state/holiday', { active: !!body.active });
    return { ok: true };
});

// Read in another script
const onHoliday = she.db.get('state/holiday')?.active ?? false;
she.info('holiday mode:', onHoliday);
```
