# Examples — HTTP & Webhooks

---

## Fetch current weather from Open-Meteo

[Open-Meteo](https://open-meteo.com/) is free, no API key required. Publish the result to MQTT so other scripts can react to it.

```js
async function updateWeather() {
    const lat = she.config.latitude;
    const lon = she.config.longitude;
    try {
        const { body: data } = await she.http.fetch(
            `https://api.open-meteo.com/v1/forecast` +
            `?latitude=${lat}&longitude=${lon}` +
            `&current=temperature_2m,precipitation,wind_speed_10m,weather_code`
        );
        const c = data.current;
        she.mqtt.pub('home/weather/temperature', c.temperature_2m);
        she.mqtt.pub('home/weather/precipitation', c.precipitation);
        she.mqtt.pub('home/weather/wind_speed',    c.wind_speed_10m);
        she.mqtt.pub('home/weather/code',          c.weather_code);
    } catch (err) {
        she.warn('weather fetch failed:', err.message);
    }
}

// Update every 15 minutes
updateWeather();
she.schedule('*/15 * * * *', updateWeather);
```

---

## Expose a sensor reading via HTTP GET

```js
// GET /api/sensors/temperature?room=living → { room: "living", temp: 21.5 }
she.api.get('/temperature', (req) => {
    const room = req.query.room || 'living';
    return {
        room,
        temp: she.mqtt.get(`home/sensor/${room}/temp`),
    };
});
```

---

## Trigger a scene via HTTP POST

```js
she.api.post('/scene', (req, body) => {
    if (!body.scene) throw new Error('scene is required');
    she.mqtt.pub('home/scene/activate', body.scene);
    she.info('scene activated via HTTP:', body.scene);
    return { ok: true, scene: body.scene };
});
```

```bash
curl -X POST http://she-host:8080/api/myscript/scene \
     -H "Content-Type: application/json" \
     -d '{"scene":"movie"}'
```

---

## Receive a webhook from an external service

```js
// POST /api/myscript/webhook/doorbell  ← called by a cloud doorbell service
she.http.sub('/webhook/doorbell', (body, { headers }) => {
    she.log('doorbell webhook received:', body);
    she.mqtt.pub('home/doorbell', 1);
    // Auto-clear after 2 s
    setTimeout(() => she.mqtt.pub('home/doorbell', 0), 2000);
});
```

---

## Webhook with a shared secret

Validate an `Authorization` header to prevent unauthorized callers.

```js
const SECRET = 'my-webhook-secret'; // store this in a lib script or sheDB, not inline

she.http.sub('/webhook/sensor', (body, { headers }) => {
    if (headers['authorization'] !== `Bearer ${SECRET}`) {
        throw new Error('unauthorized');
    }
    she.mqtt.pub('home/sensor/external/value', body.value);
});
```

---

## Send a Pushover push notification

Uses `she.http.fetch` — no npm package needed.

```js
// Store credentials in sheDB under 'config/pushover'
// { "appToken": "...", "userKey": "..." }
const cfg = she.db.get('config/pushover') || {};

async function notify(title, message, opts = {}) {
    if (!cfg.appToken || !cfg.userKey) {
        she.warn('pushover not configured — skipping notification');
        return;
    }
    await she.http.fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            token:   cfg.appToken,
            user:    cfg.userKey,
            title,
            message,
            priority: opts.priority ?? 0,
        }),
    });
}

// Use from this script or share via she.global.notify (see cross-script examples)
she.global.notify = notify;

// Alert on flood
she.mqtt.sub('home/sensor/basement/flood', { change: true, retain: true }, async (topic, val) => {
    if (val) await notify('⚠️ FLOOD', 'Basement flood sensor triggered', { priority: 1 });
});
```

---

## Fetch and cache an external API, expose via MQTT and HTTP

Avoid hammering a rate-limited API by caching the result and serving it from MQTT state.

```js
let lastFetch = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function fetchPrice() {
    if (Date.now() - lastFetch < CACHE_TTL) return;
    try {
        const { body: data } = await she.http.fetch('https://api.example.com/electricity/price');
        she.mqtt.pub('home/energy/price_ct', data.price_cents);
        lastFetch = Date.now();
    } catch (err) {
        she.warn('price fetch failed:', err.message);
    }
}

she.schedule('*/10 * * * *', fetchPrice);
fetchPrice();

she.api.get('/price', () => ({
    price_ct:    she.mqtt.get('home/energy/price_ct'),
    last_update: she.mqtt.getProp('home/energy/price_ct', 'ts'),
}));
```

---

## Dynamic route parameter

```js
// GET /api/myscript/devices/hall/pir → document from sheDB
she.api.get('/devices/:path(*)', (req) => {
    const doc = she.db.get('devices/' + req.params.path);
    if (!doc) throw new Error('not found');
    return doc;
});
```
