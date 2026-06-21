# Examples — Presence & Security

---

## Presence-based heating

```js
const AWAY_TEMP = 17;
const HOME_TEMP = 21;

she.mqtt.sub('home/presence', { change: true }, (topic, val) => {
    const target = val ? HOME_TEMP : AWAY_TEMP;
    she.mqtt.pub('home/thermostat/setpoint', target);
    she.info('presence changed — thermostat set to', target);
});
```

---

## Combined presence from multiple people

Track individual presence topics and derive a combined "anyone home" topic.

```js
const PEOPLE = [
    'home/presence/alice',
    'home/presence/bob',
];

she.mqtt.or(PEOPLE, 'home/presence');
```

For more explicit logic with logging:

```js
const PEOPLE = ['home/presence/alice', 'home/presence/bob'];

function updatePresence() {
    const anyoneHome = PEOPLE.some(t => she.mqtt.get(t));
    she.mqtt.pub('home/presence', anyoneHome ? 1 : 0);
    she.info('presence update:', anyoneHome ? 'home' : 'away');
}

PEOPLE.forEach(t => she.mqtt.sub(t, { change: true }, updatePresence));
```

---

## Arrival / departure actions

Run different logic depending on whether someone arrived or left.

```js
she.mqtt.sub('home/presence', { change: true }, (topic, val) => {
    if (val) {
        // Arrival
        she.mqtt.pub('home/alarm/mode', 'disarmed');
        she.mqtt.pub('home/thermostat/setpoint', 21);
        she.info('welcome home');
    } else {
        // Departure
        she.mqtt.pub('home/alarm/mode', 'armed');
        she.mqtt.pub('home/thermostat/setpoint', 17);
        she.mqtt.pub('home/lights/all', 0);
        she.info('goodbye — alarm armed, heating reduced');
    }
});
```

---

## Alarm: alert on door open when armed

```js
she.mqtt.sub('home/door/front/contact', { change: true }, (topic, val) => {
    const armed = she.mqtt.get('home/alarm/mode') === 'armed';
    if (val && armed) {
        she.mqtt.pub('home/alarm/triggered', 1);
        she.warn('front door opened while alarm is armed!');
    }
});
```

---

## Alarm: auto-arm at night

```js
// Arm at 23:00 every night
she.schedule('0 23 * * *', () => {
    if (!she.mqtt.get('home/presence')) {
        she.mqtt.pub('home/alarm/mode', 'armed');
        she.info('auto-armed at night');
    }
});

// Disarm at 07:00 if someone is home
she.schedule('0 7 * * *', () => {
    if (she.mqtt.get('home/presence')) {
        she.mqtt.pub('home/alarm/mode', 'disarmed');
    }
});
```

---

## Window open → reduce heating

Avoid heating a room with an open window. Restore the setpoint when the window closes.

```js
const NORMAL_TEMP = 21;
const FROST_TEMP  = 12;

she.mqtt.sub('home/window/living/contact', { change: true }, (topic, val) => {
    if (val) {
        // Window opened
        she.mqtt.pub('home/thermostat/living/setpoint', FROST_TEMP);
        she.info('living room window open — reducing heat');
    } else {
        // Window closed
        she.mqtt.pub('home/thermostat/living/setpoint', NORMAL_TEMP);
        she.info('living room window closed — restoring heat');
    }
});
```

---

## Watchdog: alert when a sensor goes silent

Useful for battery-powered sensors that should report regularly.

```js
const MAX_SILENCE_S = 3600; // 1 hour

she.schedule('0 * * * *', () => {
    const sensors = [
        'home/sensor/outdoor/temp',
        'home/sensor/hall/motion',
        'home/sensor/basement/flood',
    ];

    sensors.forEach(topic => {
        const age = she.mqtt.age(topic);
        if (age === null || age > MAX_SILENCE_S) {
            she.warn(topic, 'has not reported for', age ?? 'ever', 'seconds');
        }
    });
});
```

---

## Flood sensor: cut water supply immediately

```js
she.mqtt.sub('home/sensor/basement/flood', { change: true, retain: true }, (topic, val) => {
    if (val) {
        she.mqtt.pub('home/valve/water/main', 0); // close main valve
        she.warn('FLOOD DETECTED — main water valve closed');
    }
});
```

---

## Presence simulation when on holiday

Randomise lights during typical evening hours to give the impression someone is home.

```js
const HOLIDAY_TOPIC = 'var/holiday';

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

she.on('var::holiday', (val) => {
    she.info('holiday mode:', val ? 'on' : 'off');
});

she.schedule('0 18 * * *', () => {
    if (!she.mqtt.get(HOLIDAY_TOPIC)) return;

    // Turn lights on at a random time between 18:00 and 20:00
    const delayMin = randomBetween(0, 120);
    setTimeout(() => {
        she.mqtt.pub('home/light/living', 180);
        she.mqtt.pub('home/light/hall', 100);
    }, delayMin * 60 * 1000);
});

she.schedule('0 22 * * *', () => {
    if (!she.mqtt.get(HOLIDAY_TOPIC)) return;

    // Turn lights off between 22:00 and 23:30
    const delayMin = randomBetween(0, 90);
    setTimeout(() => {
        she.mqtt.pub('home/light/living', 0);
        she.mqtt.pub('home/light/hall', 0);
    }, delayMin * 60 * 1000);
});
```
