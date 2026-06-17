# Script Examples

## React to a button press and toggle a light

```js
she.mqtt.sub('home/remote/button1', { change: true }, (topic, val) => {
    if (val) {
        const current = she.mqtt.get('home/light/kitchen');
        she.mqtt.set('home/light/kitchen', current ? 0 : 1);
    }
});
```

---

## Control a Hue lamp with a Homematic remote

```js
she.mqtt.link('hm//RC4:1/PRESS_CONT', 'hue//lights/Hobbyraum/bri_inc', -16);
she.mqtt.link('hm//RC4:3/PRESS_CONT', 'hue//lights/Hobbyraum/ct_inc', -16);
she.mqtt.link('hm//RC4:4/PRESS_CONT', 'hue//lights/Hobbyraum/ct_inc', 16);

she.mqtt.link('hm//RC4:1/PRESS_SHORT', 'hue//lights/Hobbyraum', 0);
she.mqtt.link('hm//RC4:2/PRESS_SHORT', 'hue//lights/Hobbyraum', 254);
she.mqtt.link('hm//RC4:3/PRESS_SHORT', 'hue//lights/Hobbyraum/ct', 153);
she.mqtt.link('hm//RC4:4/PRESS_SHORT', 'hue//lights/Hobbyraum/ct', 500);

she.mqtt.sub('hm//RC4:2/PRESS_CONT', () => {
    if (!she.mqtt.get('hue//lights/Hobbyraum')) {
        she.mqtt.set('hue//lights/Hobbyraum', 1);
    } else {
        she.mqtt.set('hue//lights/Hobbyraum/bri_inc', 16);
    }
});
```

---

## Motion-triggered light with auto-off

```js
// Turn on immediately when motion is detected
she.mqtt.sub('home/motion/hall', { change: true }, (topic, val) => {
    if (val) she.mqtt.set('home/light/hall', 1);
});

// Turn off 5 minutes after motion stops
she.mqtt.sub('home/motion/hall', { change: true, condition: 'val === false', shift: 300 }, () => {
    // only switch off if motion is still absent
    if (!she.mqtt.get('home/motion/hall')) {
        she.mqtt.set('home/light/hall', 0);
    }
});
```

Or use `she.timer` for simpler one-shot behaviour:

```js
she.timer('home/motion/hall', 'home/light/hall', 5 * 60 * 1000);
```

---

## Sunrise / sunset blinds

```js
// Open blinds 15 minutes after sunrise
she.sunSchedule('sunrise', { shift: 900 }, () => {
    she.mqtt.set('home/blinds/living', 'up');
});

// Close blinds at sunset, ± random 10 minutes
she.sunSchedule('sunset', { random: 600 }, () => {
    she.mqtt.set('home/blinds/living', 'down');
});
```

---

## Daily schedule

```js
// Wake-up routine Monday–Friday at 07:00
she.schedule('0 7 * * 1-5', () => {
    she.mqtt.set('home/light/bedroom', 50);
    she.mqtt.pub('home/radio', 'on');
});

// Goodnight at 23:30 every day
she.schedule('30 23 * * *', () => {
    she.mqtt.set('home/lights/all', 0);
    she.mqtt.set('home/alarm/mode', 'night');
});
```

---

## Presence-based heating

```js
const AWAY_TEMP = 17;
const HOME_TEMP = 21;

she.mqtt.sub('home/presence', { change: true }, (topic, val) => {
    const target = val ? HOME_TEMP : AWAY_TEMP;
    she.mqtt.set('home/thermostat/setpoint', target);
    she.log('presence changed — thermostat set to', target);
});
```

---

## Combine motion sensors

```js
// home/motion/any = 1 when any room has motion
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
