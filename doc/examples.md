# Script Examples

## React to a button press and toggle a light

```js
subscribe('home/remote/button1', { change: true }, (topic, val) => {
    if (val) {
        const current = getValue('home/light/kitchen');
        setValue('home/light/kitchen', current ? 0 : 1);
    }
});
```

---

## Control a Hue lamp with a Homematic remote

```js
link('hm//RC4:1/PRESS_CONT', 'hue//lights/Hobbyraum/bri_inc', -16);
link('hm//RC4:3/PRESS_CONT', 'hue//lights/Hobbyraum/ct_inc', -16);
link('hm//RC4:4/PRESS_CONT', 'hue//lights/Hobbyraum/ct_inc', 16);

link('hm//RC4:1/PRESS_SHORT', 'hue//lights/Hobbyraum', 0);
link('hm//RC4:2/PRESS_SHORT', 'hue//lights/Hobbyraum', 254);
link('hm//RC4:3/PRESS_SHORT', 'hue//lights/Hobbyraum/ct', 153);
link('hm//RC4:4/PRESS_SHORT', 'hue//lights/Hobbyraum/ct', 500);

subscribe('hm//RC4:2/PRESS_CONT', () => {
    if (!getValue('hue//lights/Hobbyraum')) {
        setValue('hue//lights/Hobbyraum', 1);
    } else {
        setValue('hue//lights/Hobbyraum/bri_inc', 16);
    }
});
```

---

## Motion-triggered light with auto-off

```js
// Turn on immediately when motion is detected
subscribe('home/motion/hall', { change: true }, (topic, val) => {
    if (val) setValue('home/light/hall', 1);
});

// Turn off 5 minutes after motion stops
subscribe('home/motion/hall', { change: true, condition: 'val === false', shift: 300 }, () => {
    // only switch off if motion is still absent
    if (!getValue('home/motion/hall')) {
        setValue('home/light/hall', 0);
    }
});
```

Or use `timer` for simpler one-shot behaviour:

```js
timer('home/motion/hall', 'home/light/hall', 5 * 60 * 1000);
```

---

## Sunrise / sunset blinds

```js
// Open blinds 15 minutes after sunrise
sunSchedule('sunrise', { shift: 900 }, () => {
    setValue('home/blinds/living', 'up');
});

// Close blinds at sunset, ± random 10 minutes
sunSchedule('sunset', { random: 600 }, () => {
    setValue('home/blinds/living', 'down');
});
```

---

## Daily schedule

```js
// Wake-up routine Monday–Friday at 07:00
schedule('0 7 * * 1-5', () => {
    setValue('home/light/bedroom', 50);
    publish('home/radio', 'on');
});

// Goodnight at 23:30 every day
schedule('30 23 * * *', () => {
    setValue('home/lights/all', 0);
    setValue('home/alarm/mode', 'night');
});
```

---

## Presence-based heating

```js
const AWAY_TEMP = 17;
const HOME_TEMP = 21;

subscribe('home/presence', { change: true }, (topic, val) => {
    const target = val ? HOME_TEMP : AWAY_TEMP;
    setValue('home/thermostat/setpoint', target);
    she.log('presence changed — thermostat set to', target);
});
```

---

## Combine motion sensors

```js
// home/motion/any = 1 when any room has motion
combineBool(
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
    return { temp: getValue('home/sensor/' + room + '/temp') };
});
```

---

## Trigger an action via HTTP POST

```js
she.api.post('/scene', (req, body) => {
    const scene = body.scene;
    if (!scene) throw new Error('scene is required');
    publish('home/scene/activate', scene);
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

subscribe('home/alarm/fire', { condition: 'val === true' }, () => {
    push.send({ title: 'ALARM', message: 'Fire detected!', priority: 2 }, (err) => {
        if (err) she.error('pushover error:', err.message);
    });
});
```

---

## Log state age on a schedule

```js
schedule('*/5 * * * *', () => {
    const a = age('home/sensor/temp');
    if (a > 300) {
        she.warn('temperature sensor silent for', a, 'seconds');
    }
});
```
