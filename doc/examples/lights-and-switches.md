# Examples — Lights & Switches

---

## Toggle a light on button press

```js
she.mqtt.sub('home/remote/button1', { change: true }, (topic, val) => {
    if (val) {
        const isOn = she.mqtt.get('home/light/kitchen');
        she.mqtt.pub('home/light/kitchen', isOn ? 0 : 1);
    }
});
```

---

## Motion-triggered light with auto-off

The simplest form uses `she.mqtt.timer`: the light stays on for 5 minutes after the last motion event.

```js
she.mqtt.timer('home/motion/hall', 5 * 60 * 1000, 'home/light/hall');
```

For more control — turn on immediately, turn off 5 minutes after motion *stops*:

```js
she.mqtt.sub('home/motion/hall', { change: true }, (topic, val) => {
    if (val) she.mqtt.pub('home/light/hall', 1);
});

she.mqtt.sub('home/motion/hall', { change: true, condition: 'val === false', shift: 300 }, () => {
    // re-check: don't switch off if motion came back during the delay
    if (!she.mqtt.get('home/motion/hall')) {
        she.mqtt.pub('home/light/hall', 0);
    }
});
```

---

## Only turn on the light when it's dark

Combine motion with an ambient light sensor — no unnecessary switching during the day.

```js
she.mqtt.sub('home/motion/hall', { change: true }, (topic, val) => {
    const dark = she.mqtt.get('home/sensor/hall/lux') < 50;
    if (val && dark) she.mqtt.pub('home/light/hall', 1);
});

// Always turn off on motion-stop regardless of brightness
she.mqtt.timer('home/motion/hall', 5 * 60 * 1000, (topic, val) => {
    if (!val) she.mqtt.pub('home/light/hall', 0);
});
```

---

## Only turn on between sunset and midnight

```js
she.mqtt.sub('home/motion/hall', { change: true }, (topic, val) => {
    if (!val) return;

    const now = new Date();
    const hour = now.getHours();

    // Active between sunset (rough: 18:00) and midnight
    // For accurate solar times use she.schedule('sunset', ...) to set a flag
    if (hour >= 18 || hour < 0) {
        she.mqtt.pub('home/light/hall', 1);
    }
});
```

Or maintain a `dark` flag via solar events for accurate sunrise/sunset awareness:

```js
let dark = false;

she.schedule('sunset',  () => { dark = true; });
she.schedule('sunrise', () => { dark = false; });

she.mqtt.sub('home/motion/hall', { change: true }, (topic, val) => {
    if (val && dark) she.mqtt.pub('home/light/hall', 1);
});

she.mqtt.timer('home/motion/hall', 5 * 60 * 1000, (topic, val) => {
    if (!val) she.mqtt.pub('home/light/hall', 0);
});
```

---

## Dim a light with long-press buttons

```js
// Short press: toggle on/off
she.mqtt.sub('home/remote/button1/short', { change: true }, (topic, val) => {
    if (val) she.mqtt.pub('home/light/living', she.mqtt.get('home/light/living') ? 0 : 1);
});

// Long press hold: dim down
she.mqtt.sub('home/remote/button1/hold', { retain: true }, (topic, val) => {
    if (val) she.mqtt.pub('home/light/living/brightness_move', -40);
    else     she.mqtt.pub('home/light/living/brightness_move', 0);
});

// Long press hold: dim up
she.mqtt.sub('home/remote/button2/hold', { retain: true }, (topic, val) => {
    if (val) she.mqtt.pub('home/light/living/brightness_move', 40);
    else     she.mqtt.pub('home/light/living/brightness_move', 0);
});
```

---

## Scene activation

Activate a named scene that sets several lights at once.

```js
const SCENES = {
    movie:   { 'home/light/living': 30,  'home/light/hall': 0,  'home/light/dining': 0  },
    dinner:  { 'home/light/living': 180, 'home/light/hall': 80, 'home/light/dining': 220 },
    morning: { 'home/light/living': 255, 'home/light/hall': 255,'home/light/dining': 200 },
    off:     { 'home/light/living': 0,   'home/light/hall': 0,  'home/light/dining': 0  },
};

function activateScene(name) {
    const scene = SCENES[name];
    if (!scene) { she.warn('unknown scene:', name); return; }
    for (const [topic, val] of Object.entries(scene)) {
        she.mqtt.pub(topic, val);
    }
    she.info('scene activated:', name);
}

she.mqtt.sub('home/scene/activate', { change: true }, (topic, val) => {
    activateScene(val);
});

// Also expose via HTTP
she.api.post('/scene', (req, body) => {
    activateScene(body.scene);
    return { ok: true };
});
```

---

## Turn off all lights on departure

```js
const ALL_LIGHTS = [
    'home/light/living',
    'home/light/kitchen',
    'home/light/hall',
    'home/light/bedroom',
];

she.mqtt.sub('home/presence', { change: true }, (topic, val) => {
    if (!val) {
        ALL_LIGHTS.forEach(t => she.mqtt.pub(t, 0));
        she.info('all lights off — nobody home');
    }
});
```

---

## Blink a light when the doorbell rings

The second argument to `she.mqtt.sub` can be a condition string — a shorthand for `{ condition: '...' }`. The sandbox's `setTimeout` is tracked and automatically cancelled on script hot-reload.

```js
// Blink the bathroom deco light 3 times when the doorbell fires value "11"
she.mqtt.sub('cul/status/Klingel', 'val === "11"', (topic, val) => {
    she.mqtt.pub('zigbee2mqtt/licht_bad_deko/effect', 'blink');
    setTimeout(() => she.mqtt.pub('zigbee2mqtt/licht_bad_deko/effect', 'blink'), 1000);
    setTimeout(() => she.mqtt.pub('zigbee2mqtt/licht_bad_deko/effect', 'blink'), 2000);
});
```

---

## Control a Hue lamp with a Homematic remote

```js
she.mqtt.link('hm//RC4:1/PRESS_CONT', 'hue//lights/Hobbyraum/bri_inc', -16);
she.mqtt.link('hm//RC4:3/PRESS_CONT', 'hue//lights/Hobbyraum/ct_inc',  -16);
she.mqtt.link('hm//RC4:4/PRESS_CONT', 'hue//lights/Hobbyraum/ct_inc',   16);

she.mqtt.link('hm//RC4:1/PRESS_SHORT', 'hue//lights/Hobbyraum',      0);
she.mqtt.link('hm//RC4:2/PRESS_SHORT', 'hue//lights/Hobbyraum',    254);
she.mqtt.link('hm//RC4:3/PRESS_SHORT', 'hue//lights/Hobbyraum/ct', 153);
she.mqtt.link('hm//RC4:4/PRESS_SHORT', 'hue//lights/Hobbyraum/ct', 500);

she.mqtt.sub('hm//RC4:2/PRESS_CONT', () => {
    if (!she.mqtt.get('hue//lights/Hobbyraum')) {
        she.mqtt.pub('hue//lights/Hobbyraum', 1);
    } else {
        she.mqtt.pub('hue//lights/Hobbyraum/bri_inc', 16);
    }
});
```
