# Documents

A **document** is a plain JSON object with a string ID. Documents are stored and
retrieved by ID; slashes in IDs are allowed and encouraged (they form a
natural hierarchy that mirrors MQTT topics).

---

## Document IDs

The ID can be any string. MQTT wildcard characters (`#` and `+`) are **not** allowed.

**Convention:** structure IDs like MQTT topics — slash-separated segments that describe the entity type and identity. This makes wildcard subscriptions (`she.db.sub`) and view filters intuitive.

```
hue/lights/livingroom      → a Hue light named "livingroom"
zigbee/sensors/temp/bed    → a Zigbee temperature sensor
rooms/kitchen              → metadata about the kitchen room
```

If you enable document publishing (`dbPublish: true` in config), the MQTT topic for a document is `{dbPrefix}doc/{id}` (default prefix: `she/db/`). Following the topic-style ID convention means MQTT subscribers can use wildcards to filter by type:

```
she/db/doc/hue/lights/#          → all lights
she/db/doc/zigbee/sensors/#      → all Zigbee sensors
```

---

## Creating and Updating

```js
// Create or overwrite
she.db.set('hue/lights/livingroom', {
    type: 'light',
    name: 'Living Room',
    room: 'living',
    dimmable: true
});

// Deep-merge (only specified keys are changed)
she.db.extend('hue/lights/livingroom', { brightness: 80 });
// Result: { type: 'light', name: 'Living Room', room: 'living', dimmable: true, brightness: 80 }
```

## Reading

```js
const doc = she.db.get('hue/lights/livingroom');
// Returns the document object, or undefined if it doesn't exist
```

## Deleting

```js
she.db.delete('hue/lights/livingroom');
```

---

## Property Access

To update a single nested property without rewriting the whole document, use
`she.db.prop()`:

```js
// Set a property (creates it if it doesn't exist)
she.db.prop('hue/lights/livingroom', 'set', 'brightness', 100);

// Create a property (no-op if it already exists)
she.db.prop('hue/lights/livingroom', 'create', 'defaultBrightness', 80);

// Delete a property
she.db.prop('hue/lights/livingroom', 'del', 'brightness');
```

Dot notation works for nested properties:

```js
she.db.prop('my/doc', 'set', 'settings.theme', 'dark');
```

---

## Subscribing to Changes

```js
she.db.sub('hue/lights/#', (id, doc) => {
    // Called whenever a matching document changes
    // doc is null if the document was deleted
    she.info('light changed:', id);
});
```

The pattern follows MQTT wildcard rules: `+` matches one level, `#` matches the
rest of the topic.

---

## Internal Properties

These are set automatically on every document and cannot be changed:

| Property | Description |
|----------|-------------|
| `_id` | The document's ID |
| `_rev` | Revision counter, incremented on every change |
