# Examples — Scheduling

---

## Basic cron schedule

```js
// Every full hour
she.schedule('0 * * * *', () => she.log('tick'));

// Monday–Friday at 07:00
she.schedule('0 7 * * 1-5', () => {
    she.mqtt.pub('home/alarm/morning', 1);
});

// Every 15 minutes
she.schedule('*/15 * * * *', () => {
    she.info('heartbeat');
});
```

---

## Wake-up routine

```js
// Wake-up Monday–Friday: lights on gradually, radio starts
she.schedule('0 7 * * 1-5', () => {
    she.mqtt.pub('home/light/bedroom', 30);   // dim on
    she.mqtt.pub('home/radio', 'on');
    she.info('good morning');
});

// Full brightness 15 minutes later
she.schedule('15 7 * * 1-5', () => {
    she.mqtt.pub('home/light/bedroom', 255);
});

// Weekends: lie in until 09:00
she.schedule('0 9 * * 6,0', () => {
    she.mqtt.pub('home/light/bedroom', 30);
    she.mqtt.pub('home/radio', 'on');
});
```

---

## Goodnight routine

```js
she.schedule('30 23 * * *', () => {
    she.mqtt.pub('home/lights/all', 0);
    she.mqtt.pub('home/tv', 0);
    she.mqtt.pub('home/alarm/mode', 'night');
    she.info('goodnight');
});
```

---

## Weekend vs. weekday logic inside one handler

```js
she.schedule('0 7 * * *', () => {
    const day = new Date().getDay(); // 0 = Sun, 6 = Sat
    const isWeekend = day === 0 || day === 6;

    if (isWeekend) {
        she.info('weekend — skipping morning routine');
        return;
    }

    she.mqtt.pub('home/light/bedroom', 50);
    she.mqtt.pub('home/coffee', 'on');
});
```

---

## One-shot at a specific time

```js
// Christmas Eve at 18:00
she.schedule(new Date(2026, 11, 24, 18, 0, 0), () => {
    she.mqtt.pub('home/light/tree', 1);
    she.info('Merry Christmas!');
});
```

---

## Multiple patterns in one call

```js
// Same callback at 08:00 and 20:00 every day
she.schedule(['0 8 * * *', '0 20 * * *'], () => {
    she.mqtt.pub('home/routine/trigger', 1);
});

// Both dawn and dusk
she.schedule(['dawn', 'dusk'], () => {
    she.mqtt.pub('home/lights/outdoor', she.mqtt.get('home/lights/outdoor') ? 0 : 1);
});
```

---

## Solar event scheduling

Latitude and longitude are configured in Config → Solar events.

```js
// Open blinds shortly after sunrise
she.schedule('sunrise', { shift: 900 }, () => {
    she.mqtt.pub('home/blinds/living', 'up');
});

// Close blinds at sunset — randomise ±5 minutes to avoid all actuators firing at once
she.schedule('sunset', { random: 300 }, () => {
    she.mqtt.pub('home/blinds/living', 'down');
});

// Outdoor lights on at dusk, off at dawn
she.schedule('dusk',  () => she.mqtt.pub('home/lights/outdoor', 1));
she.schedule('dawn',  () => she.mqtt.pub('home/lights/outdoor', 0));
```

---

## Sunrise/sunset blinds with presence guard

Don't open the blinds if nobody is home (e.g. on holiday).

```js
she.schedule('sunrise', { shift: 1800 }, () => {
    if (she.mqtt.get('home/presence')) {
        she.mqtt.pub('home/blinds/bedroom', 'up');
    }
});

she.schedule('sunset', () => {
    she.mqtt.pub('home/blinds/bedroom', 'down');
});
```

---

## Log state age on a schedule — sensor watchdog

```js
she.schedule('*/5 * * * *', () => {
    const a = she.mqtt.age('home/sensor/outdoor/temp');
    if (a > 300) {
        she.warn('outdoor temperature sensor silent for', a, 'seconds');
    }
});
```

---

## Randomised offset to spread load

Useful when multiple scripts or rules all react at the same cron tick and you want to spread actuator commands over a short window.

```js
she.schedule('0 18 * * *', { random: 600 }, () => {
    // Fires at a random time between 18:00 and 18:10
    she.mqtt.pub('home/lights/outdoor', 1);
});
```
