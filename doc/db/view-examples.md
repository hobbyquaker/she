# View Examples

All examples assume documents have been created with `she.db.set()` or via
the DB tab in the web UI.

---

## List all lights in a specific room

**Filter:** `hue/lights/#`

**Map:**
```js
if (this.room === 'living') {
    emit({ id: this._id, name: this.name });
}
```

**Result:**
```json
[
  { "id": "hue/lights/lamp1", "name": "Floor Lamp" },
  { "id": "hue/lights/ceiling", "name": "Ceiling Light" }
]
```

---

## Count devices per room

**Map:**
```js
if (this.room) {
    emit(this.room);
}
```

**Reduce:**
```js
return result.reduce((acc, cur) => {
    acc[cur] = (acc[cur] || 0) + 1;
    return acc;
}, {});
```

**Result:**
```json
{ "living": 3, "kitchen": 2, "bedroom": 1 }
```

---

## All dimmable lights sorted by name

**Filter:** `hue/lights/#`

**Map:**
```js
if (this.dimmable) {
    emit({ name: this.name, id: this._id });
}
```

**Reduce:**
```js
return result.sort((a, b) => a.name.localeCompare(b.name));
```

---

## Index: find documents by type

**Map:**
```js
emit({ type: this.type, id: this._id, name: this.name });
```

**Reduce:**
```js
return result.reduce((acc, cur) => {
    if (!acc[cur.type]) acc[cur.type] = [];
    acc[cur.type].push({ id: cur.id, name: cur.name });
    return acc;
}, {});
```

**Result:**
```json
{
  "light": [{ "id": "hue/lights/lamp1", "name": "Floor Lamp" }],
  "sensor": [{ "id": "zigbee/sensors/temp", "name": "Bedroom Temp" }]
}
```

---

## Devices that haven't reported recently (using MQTT state)

This requires combining sheDB documents with live MQTT values. Because view
sandbox functions don't have access to MQTT, do this as an ad-hoc query in a
script instead:

```js
const stale = she.db.query('devices/#', function () {
    const age = she.mqtt.age(this._id + '/status');
    if (age > 3600) emit({ id: this._id, name: this.name, age });
});
she.info('stale devices:', stale);
```

---

## Cross-document lookup in reduce

**Map** (emits device ID):
```js
emit(this._id);
```

**Reduce** (enriches each result with room label from another document):
```js
return result.map(id => {
    const device = api.getDocument(id);
    const room = api.getDocument('rooms/' + device.room);
    return { id, name: device.name, roomLabel: room ? room.label : device.room };
});
```
