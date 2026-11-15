# Examples — Home model

Scripts written against rooms, functions and labels of the [home model](../home-model.md) instead of topics. None
of them names a device: a new window contact in the bathroom, a replaced lamp or a sensor moved to another room is
picked up without touching the script. They need sheDB and the home model switched on.

The room ids (`bathroom`, `living-room`, …) and the label names are examples — use yours from the Home page. `she`
in a topic is the instance name (`--name`, `she` by default).

---

## Window open → heating down, per room

While any window or door of a room is open for two minutes, its thermostats go to frost protection; when everything
is closed again, they go back to what they were set to. It uses the room aggregate `open`, so a room with three
windows needs no `or` of its own.

```js
const SHE = 'she'; // the instance name
const FROST = 7; // °C
const WAIT = 2 * 60 * 1000;

for (const room of she.home.rooms()) {
    // only rooms that have both: something to open and something to heat
    if (!she.home.entities({ room: room.id, function: 'openings' }).length) continue;
    if (!she.home.entities({ room: room.id, function: 'heating' }).length) continue;

    const saved = new Map(); // thermostat id → its setpoint before
    const lower = she.timeout(WAIT, () => {
        for (const e of she.home.entities({ room: room.id, function: 'heating' })) {
            const thermostat = she.home.entity(e.id);
            const setpoint = thermostat.state().temperature;
            if (setpoint === undefined || setpoint <= FROST) continue;
            saved.set(e.id, setpoint);
            thermostat.setTemperature(FROST);
        }
        she.log(`${room.name}: open for 2 minutes, heating down`);
    }, { name: `window ${room.id}` });

    she.mqtt.sub(`${SHE}/status/room/${room.id}/open`, { change: true }, (topic, open) => {
        if (open) {
            lower.restart();
            return;
        }
        lower.cancel();
        for (const [id, setpoint] of saved) she.home.entity(id)?.setTemperature(setpoint);
        if (saved.size) she.log(`${room.name}: closed, heating back`);
        saved.clear();
    });
}
```

---

## Leaving home

When the house becomes empty: every light off, and one message that says what is still open and which lock is not
locked, by room. The trigger here is an mqtt-smarthome presence topic; use what your presence detection publishes.

```js
const PRESENCE = 'presence/status/home'; // true while somebody is home — an example

function roomNames(entity) {
    const names = new Map(she.home.rooms().map((r) => [r.id, r.name]));
    return entity.rooms.length ? entity.rooms.map((id) => names.get(id) ?? id).join(', ') : 'no room';
}

she.mqtt.sub(PRESENCE, { change: true }, (topic, home) => {
    if (home) return;

    for (const e of she.home.entities({ function: 'lighting' })) {
        const light = she.home.entity(e.id);
        if (light.state().state === 'ON') light.turnOff();
    }

    const open = she.home
        .entities({ function: 'openings' })
        .filter((e) => {
            const s = she.home.entity(e.id).state();
            return s.state === 'ON' || s.state === 'open'; // a contact is ON when open; a cover is "open"
        })
        .map((e) => `${roomNames(e)}: ${e.name} open`);

    const unlocked = she.home
        .entities({ component: 'lock' })
        .filter((e) => she.home.entity(e.id).state().state !== 'LOCKED')
        .map((e) => `${roomNames(e)}: ${e.name} not locked`);

    const report = [...open, ...unlocked];
    she.log(report.length ? 'Left home — ' + report.join('; ') : 'Left home — everything closed');
    // send it: she.http.fetch('https://ntfy.example.org/home', { method: 'POST', body: report.join('\n') });
});
```

---

## Weekly battery report

Every Sunday evening, the battery levels of all devices in one message, by room and from low to high. A device whose
battery never reported is listed under "unknown". It reads the standard view `she/entities/battery`, which also lists
the hidden (diagnostic) battery sensors.

```js
she.schedule('0 19 * * 0', () => {
    const batteries = she.db.getView('she/entities/battery') ?? [];
    const rooms = new Map(she.home.rooms().map((r) => [r.id, r.name]));
    const known = [];
    const unknown = [];

    for (const b of batteries) {
        const entity = she.home.entity(b.id);
        const s = entity?.state() ?? {};
        // a battery sensor tells a level in %, a binary battery sensor ON for "low"
        const level = b.component === 'sensor' ? s.value : s.state === 'ON' ? 'low' : s.state === 'OFF' ? 'ok' : undefined;
        const where = b.rooms.length ? b.rooms.map((r) => rooms.get(r) ?? r).join(', ') : 'no room';
        const line = { where, name: b.device_name ?? b.name, level };
        if (level === undefined) unknown.push(line);
        else known.push(line);
    }

    const numeric = (x) => (typeof x.level === 'number' ? x.level : x.level === 'low' ? 0 : 100);
    known.sort((a, b) => a.where.localeCompare(b.where) || numeric(a) - numeric(b));

    const lines = known.map((x) => `${x.where} · ${x.name}: ${typeof x.level === 'number' ? x.level + ' %' : x.level}`);
    if (unknown.length) lines.push('unknown: ' + unknown.map((x) => `${x.where} · ${x.name}`).join(', '));
    she.log('Batteries this week:\n' + lines.join('\n'));
});
```

---

## A readable event log

The reverse index `she/topics` tells, for any message, which entity it is about. This script turns
`zigbee2mqtt/0x00124b… {"contact":false}` into `Bathroom · Window left · contact: ON`, and could write the same with
room, function and device as fields to Elasticsearch or InfluxDB.

```js
const rooms = () => new Map(she.home.rooms().map((r) => [r.id, r.name]));

// zigbee2mqtt here; every other adapter's prefix works the same way
she.mqtt.sub('zigbee2mqtt/#', { change: true }, (topic) => {
    const entities = she.db.getView('she/topics')?.[topic];
    if (!entities) return;
    const names = rooms();
    for (const e of entities) {
        if (!e.functions.includes('openings') && !e.functions.includes('security')) continue;
        const state = she.home.entity(e.id)?.state() ?? {};
        const where = e.rooms.map((r) => names.get(r) ?? r).join(', ') || 'no room';
        she.log(`${where} · ${e.name} · ${state.state ?? JSON.stringify(state)}`);
        // she.elastic.index('events', { room: e.rooms, functions: e.functions, device: e.device, entity: e.id, state, ts: Date.now() });
    }
});
```

A device topic of zigbee2mqtt carries many entities (contact, battery, link quality); the filter on the functions
keeps the log to what matters, and `change: true` leaves out repeated reports.

---

## Motion light per room

An occupancy or motion sensor switches the lights of its own room that carry the label `motion`; at night only those
labelled `night`, dimmed. A new sensor or lamp only needs a room and a label on the Home page. The light goes off three
minutes after the last motion.

```js
const OFF_AFTER = 3 * 60 * 1000;
const NIGHT_BRIGHTNESS = 30; // of 255

const sensors = she.home
    .entities({ component: 'binary_sensor', function: 'security' })
    .filter((e) => ['motion', 'occupancy'].includes(e.device_class));

for (const sensor of sensors) {
    for (const room of sensor.rooms) {
        const off = she.timeout(OFF_AFTER, () => {
            for (const e of she.home.entities({ room, label: 'motion' })) she.home.entity(e.id).turnOff();
        }, { name: `motion off ${room}` });

        she.home.entity(sensor.id).sub((now, before) => {
            const seen = now.state.state === 'ON';
            if (seen === (before.state.state === 'ON')) return;
            if (!seen) {
                off.restart();
                return;
            }
            off.cancel();
            const night = !she.time.between('06:30', '22:30');
            const lights = she.home.entities({ room, label: night ? 'night' : 'motion' });
            for (const e of lights) {
                const light = she.home.entity(e.id);
                if (light.state().state === 'ON') continue;
                light.turnOn(night && light.attributes.brightness?.write ? { brightness: NIGHT_BRIGHTNESS } : {});
            }
        });
    }
}
```

The lights labelled `night` should also carry `motion`, so the timer switches them off too.
