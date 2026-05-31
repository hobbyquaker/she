# sheDB

sheDB is the embedded JSON document store built into **she**. It stores JSON objects
(called *documents*), lets you query them with JavaScript map/reduce *views*, and
notifies your scripts in real time when documents change.

No separate process or install is needed — sheDB starts automatically when `she` runs.

---

## Contents

- [Documents](documents.md) — create, read, update, delete, property access
- [Views](views.md) — filter + map/reduce queries
- [Sandbox](sandbox.md) — API available inside map/reduce functions
- [View Examples](view-examples.md) — ready-to-use examples

---

## Script API (`she.db`)

Use the following methods in your scripts to interact with sheDB:

| Method | Description |
|--------|-------------|
| `she.db.get(id)` | Return the document with the given ID, or `undefined` |
| `she.db.set(id, doc)` | Create or overwrite a document |
| `she.db.extend(id, partial)` | Deep-merge `partial` into an existing document |
| `she.db.delete(id)` | Delete a document |
| `she.db.prop(id, method, prop, val)` | Mutate a single property (`method`: `'set'`, `'create'`, or `'del'`) |
| `she.db.sub(pattern, callback)` | Subscribe to document changes matching an MQTT wildcard pattern |
| `she.db.query(filter, mapFn, [reduceFn])` | Run an ad-hoc synchronous query, returns an array |

### Example

```js
// Store metadata for a device
she.db.set('hue/lights/livingroom', {
    type: 'light',
    name: 'Living Room Hue',
    room: 'living'
});

// Subscribe to changes in any device document
she.db.sub('hue/lights/#', (id, doc) => {
    she.info('device changed:', id, doc);
});

// Ad-hoc query: get all lights in the living room
const lights = she.db.query('hue/lights/#', function () {
    if (this.room === 'living') emit(this.name);
});
```

---

## Internal Document Properties

Every document automatically gets these read-only properties:

| Property | Description |
|----------|-------------|
| `_id` | The document's ID (the key used when creating it) |
| `_rev` | Revision counter — increments on every change |

---

## Data Location

By default sheDB stores its data in `~/.she/db/`. This can be configured via
the `dbPath` option in `~/.she/config/config.json` or the `--db-path` CLI flag.
Set it to an empty string to disable sheDB entirely.
