# Examples — Matter

Scripts for devices paired with she's built-in Matter controller. Pairing, names and troubleshooting are in the
[Matter guide](../matter.md); the device names used here (`hallway-button`, `living-room-plug`, …) are the names the
devices carry on the Matter page — replace them with yours, or with node IDs.

Endpoint, cluster, attribute and event names are the ones the **Devices** tab and the **Matter Events** feed of the
Matter page show for your device.

---

## A Matter button switches an MQTT light

A battery button reports presses as events of the `switch` cluster. A short press toggles the light, a double press
sets full brightness, a long press switches it off.

```js
const LIGHT = 'home/set/hallway-light';
const STATUS = 'home/status/hallway-light';

she.matter.sub('hallway-button', 1, 'switch', 'multiPressComplete', (ev) => {
    if (ev.totalNumberOfPressesCounted === 1) {
        she.mqtt.pub(LIGHT, !she.mqtt.get(STATUS));
    } else if (ev.totalNumberOfPressesCounted === 2) {
        she.mqtt.pub('home/set/hallway-light/brightness', 100);
    }
});

she.matter.sub('hallway-button', 1, 'switch', 'longPress', () => {
    she.mqtt.pub(LIGHT, false);
});
```

Not every button sends `multiPressComplete`; one that only reports single presses is handled with `initialPress` or
`shortRelease` instead. Press the button and read the event names from the Matter Events feed.

---

## An MQTT topic switches a Matter plug

Anything that publishes to MQTT — a wall switch on another system, a dashboard, another script — can drive a Matter
device.

```js
she.mqtt.sub('home/set/living-room-plug', (topic, val) => {
    she.matter
        .send('living-room-plug', 1, 'onOff', val ? 'on' : 'off')
        .catch((err) => she.warn('living-room-plug:', err.message));
});

// report the plug's real state back, whoever switched it
she.matter.sub('living-room-plug', 1, 'onOff', 'onOff', (on) => {
    she.mqtt.pub('home/status/living-room-plug', on, { retain: true, status: true });
});
```

`status: true` tells she that this script publishes the status topic on purpose — it acts as the plug's adapter.

For all devices at once, without a script, switch on the Matter ↔ MQTT bridge on the Matter page's **MQTT** tab.

---

## A Matter sensor on MQTT, with a warning

A Matter temperature sensor reports `measuredValue` in hundredths of a degree Celsius. The script publishes it in
degrees and warns once when the room gets cold.

```js
const LIMIT = 16;
let warned = false;

function report(raw) {
    if (raw === null || raw === undefined) return; // the sensor has no reading
    const temp = raw / 100;
    she.mqtt.pub('home/status/bedroom/temperature', temp, { retain: true, status: true });

    if (temp < LIMIT && !warned) {
        warned = true;
        she.warn(`bedroom is at ${temp} °C`);
        she.mqtt.pub('home/set/notify', `Bedroom is at ${temp} °C`);
    } else if (temp >= LIMIT + 1) {
        warned = false; // 1 °C of hysteresis before the next warning
    }
}

// the current value once at script start, then every change
she.matter
    .get('bedroom-sensor', 1, 'temperatureMeasurement', 'measuredValue')
    .then(report)
    .catch((err) => she.error('bedroom-sensor:', err.message));
she.matter.sub('bedroom-sensor', 1, 'temperatureMeasurement', 'measuredValue', report);
```

Replace the `home/set/notify` publish with your notification of choice — see
[push notifications](http-and-webhooks.md).

---

## A Matter motion sensor and a Matter lamp

Both ends on Matter: motion switches the lamp on at 30 % brightness, and off five minutes after the last motion.

```js
let offTimer = null;

she.matter.sub('hallway-motion', 1, 'occupancySensing', 'occupancy', (occupancy) => {
    clearTimeout(offTimer);
    if (occupancy.occupied) {
        she.matter
            .send('hallway-lamp', 1, 'levelControl', 'moveToLevelWithOnOff', { level: 76, transitionTime: 5 })
            .catch((err) => she.warn('hallway-lamp:', err.message));
    } else {
        offTimer = setTimeout(
            () => {
                she.matter.send('hallway-lamp', 1, 'onOff', 'off').catch((err) => she.warn('hallway-lamp:', err.message));
            },
            5 * 60 * 1000,
        );
    }
});
```

`level` runs from 0 to 254, `transitionTime` is in tenths of a second.

---

## All lights of a room with one command

A group made on the Matter page's **Bindings** tab gets one multicast command instead of one per device.

```js
she.mqtt.sub('home/set/living-room/all-off', () => {
    she.matter.send('group:living-room', null, 'onOff', 'off').catch((err) => she.warn('living-room:', err.message));
});
```

No device answers a group command, so the promise resolves when the message is sent, not when the lights are off.
