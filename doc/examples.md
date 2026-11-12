# Script Examples

Examples are organised by topic. Each file contains self-contained, copy-paste-ready scripts with comments.

| Topic | Description |
|---|---|
| [Lights & switches](examples/lights-and-switches.md) | Toggle, dim, motion-triggered, scenes, presence-conditioned |
| [Presence & security](examples/presence-and-security.md) | Presence detection, heating, alarms, watchdogs |
| [Scheduling](examples/scheduling.md) | Cron, solar events, one-shots, weekend logic |
| [HTTP & webhooks](examples/http-and-webhooks.md) | Fetch external APIs, expose endpoints, receive webhooks, push notifications |
| [Cross-script patterns](examples/cross-script.md) | Shared state, event bus, library scripts |
| [sheDB](examples/shedb.md) | Device registry, config, counters, reactive queries |
| [Matter](examples/matter.md) | Buttons, plugs, sensors and groups on the built-in Matter controller, with and without MQTT |

---

## Quick reference

### React to a button press and toggle a light

```js
she.mqtt.sub('home/remote/button1', { change: true }, (topic, val) => {
    if (val) {
        const current = she.mqtt.get('home/light/kitchen');
        she.mqtt.pub('home/light/kitchen', current ? 0 : 1);
    }
});
```

---

## A Matter button switches an MQTT light

A device paired on the Matter page is addressed by its name. Buttons report presses as events — see the
[Matter guide](matter.md) for pairing and the [Matter examples](examples/matter.md) for more.

```js
she.matter.sub('hallway-button', 1, 'switch', 'multiPressComplete', (ev) => {
    if (ev.totalNumberOfPressesCounted === 1) {
        she.mqtt.pub('home/set/hallway-light', !she.mqtt.get('home/status/hallway-light'));
    }
});
she.matter.sub('hallway-button', 1, 'switch', 'longPress', () => {
    she.mqtt.pub('home/set/hallway-light', false);
});
```

---

## Control a Hue lamp with a Homematic BidCoS remote (Dimming via Long-Press)

```js
she.mqtt.link('hm//RC4:1/PRESS_CONT', 'hue//lights/Hobbyraum/bri_inc', -16);
she.mqtt.sub('hm//RC4:2/PRESS_CONT', () => {
    if (!she.mqtt.get('hue//lights/Hobbyraum')) {
        she.mqtt.pub('hue//lights/Hobbyraum', 1);
    } else {
        she.mqtt.pub('hue//lights/Hobbyraum/bri_inc', 16);
    }
});
she.mqtt.link('hm//RC4:3/PRESS_CONT', 'hue//lights/Hobbyraum/ct_inc', -16);
she.mqtt.link('hm//RC4:4/PRESS_CONT', 'hue//lights/Hobbyraum/ct_inc', 16);

she.mqtt.link('hm//RC4:1/PRESS_SHORT', 'hue//lights/Hobbyraum', 0);
she.mqtt.link('hm//RC4:2/PRESS_SHORT', 'hue//lights/Hobbyraum', 254);
she.mqtt.link('hm//RC4:3/PRESS_SHORT', 'hue//lights/Hobbyraum/ct', 153);
she.mqtt.link('hm//RC4:4/PRESS_SHORT', 'hue//lights/Hobbyraum/ct', 500);

```

---

## Motion-triggered light with auto-off

```js
// Turn on immediately when motion is detected
she.mqtt.sub('home/motion/hall', { change: true }, (_, val) => {
    if (val) she.mqtt.pub('home/light/hall', val);
});

```

Or let `she.mqtt.timer` do both — on with the motion, off again five minutes after the last one:

```js
she.mqtt.timer('home/motion/hall', 5 * 60 * 1000, 'home/light/hall');
```

---

## Commands that must arrive

`she.mqtt.pub` sends and forgets. For a command whose effect matters, `she.mqtt.command` waits until the device's status confirms it, and retries:

```js
// night setback: 17 °C, confirmed by the thermostat's status within 10 s, two more tries
she.schedule('0 22 * * *', async () => {
    try {
        const r = await she.mqtt.command('hm/set/living-room/thermostat/SET_TEMPERATURE', 17, { tolerance: 0.1, timeout: 10, retries: 2 });
        she.info(`setback confirmed after ${r.ms} ms`);
    } catch (err) {
        // timeout or offline: the warning is already in the log; tell someone
        she.mqtt.pub('notify/set/push', `Thermostat did not confirm the setback (${err.reason})`);
    }
});
```

The status topic is derived from the convention (`hm/set/…` → `hm/status/…`, zigbee2mqtt's `<device>/set` → `<device>`); a failed command is warned in the log with the script and topic even when the script does not catch it.

---

## Sunrise / sunset blinds

```js
// Open blinds 15 minutes after sunrise
she.schedule('sunrise', { shift: 900 }, () => {
    she.mqtt.pub('home/blinds/living', 'up');
});

// Close blinds at sunset, ± random 10 minutes
she.schedule('sunset', { random: 600 }, () => {
    she.mqtt.pub('home/blinds/living', 'down');
});
```

---

## Daily schedule

```js
// Wake-up routine Monday–Friday at 07:00
she.schedule('0 7 * * 1-5', () => {
    she.mqtt.pub('home/light/bedroom', 50);
    she.mqtt.pub('home/radio', 'on');
});

// Goodnight at 23:30 every day
she.schedule('30 23 * * *', () => {
    she.mqtt.pub('home/lights/all', 0);
    she.mqtt.pub('home/alarm/mode', 'night');
});
```

---

## Presence-based heating

```js
const AWAY_TEMP = 17;
const HOME_TEMP = 21;

she.mqtt.sub('home/presence', { change: true }, (topic, val) => {
    const target = val ? HOME_TEMP : AWAY_TEMP;
    she.mqtt.pub('home/thermostat/setpoint', target);
    she.log('presence changed — thermostat set to', target);
});
```

---

## Combine motion sensors

```js
// home/motion/any = truthy when any room has motion
she.mqtt.or(
    ['home/motion/hall', 'home/motion/kitchen', 'home/motion/living'],
    'home/motion/any'
);
```

---

## Expose a sensor value via HTTP

```js
// GET /api/sensors/temperature?room=living → { temp: 21.5 }
she.api.get('/temperature', (req) => {
    const room = req.query.room || 'living';
    return { temp: she.mqtt.get('home/sensor/' + room + '/temp') };
});
```

---

## Trigger an action via HTTP POST

```js
she.api.post('/scene', (req, body) => {
    const scene = body.scene;
    if (!scene) throw new Error('scene is required');
    she.mqtt.pub('home/scene/activate', scene);
    she.log('scene activated via HTTP:', scene);
    return { ok: true, scene };
});
```

Call it:

```bash
curl -X POST http://localhost:8080/api/myscript/scene \
     -H "Content-Type: application/json" \
     -d '{"scene":"movie"}'
```

---

## Load credentials from a local module

```js
// scripts/lib/credentials.js
module.exports = {
    pushover: { user: 'Uxxx', token: 'axxx' },
};
```

```js
const cred = require('./lib/credentials');
const pushover = require('pushover-notifications');

const push = new pushover({ user: cred.pushover.user, token: cred.pushover.token });

she.mqtt.sub('home/alarm/fire', { condition: 'val === true' }, () => {
    push.send({ title: 'ALARM', message: 'Fire detected!', priority: 2 }, (err) => {
        if (err) she.error('pushover error:', err.message);
    });
});
```

---

## Log state age on a schedule

```js
she.schedule('*/5 * * * *', () => {
    const a = she.mqtt.age('home/sensor/temp');
    if (a > 300) {
        she.warn('temperature sensor silent for', a, 'seconds');
    }
});
```
