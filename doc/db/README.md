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

---

## MQTT Publishing

sheDB can optionally publish changes to the MQTT broker. All publishing is **opt-in** and controlled via `config.json`.

### Topic prefix

All sheDB MQTT topics share a common prefix, configurable via `dbPrefix` in `config.json` (or the Config page in the Web UI). The default is `she/db/`.

| Config key | Default | Description |
|------------|---------|-------------|
| `dbPrefix` | `she/db/` | Prefix for all sheDB MQTT topics |

### Document publishing

Enable by setting `dbPublish: true` in your config (or via the Config page in the Web UI).

When enabled, every document create/update/delete is published to:

```
{dbPrefix}doc/{id}
```

Example with defaults: a document with ID `hue/lights/livingroom` is published to:
```
she/db/doc/hue/lights/livingroom
```

- **Deleted** documents are published as an empty string (`""`)
- Retain behaviour is controlled separately by `dbRetain: true`

### View publishing

Individual views can publish their result to MQTT independently of the global `dbPublish` setting.

Set `mqttpub: true` on a view definition (via the **DB → Views** editor) to enable publishing for that view. The result is published to:

```
{dbPrefix}view/{viewId}
```

Example: a view named `hue/lights/on` publishes to `she/db/view/hue/lights/on`.

Each time the view result changes (because a document changed), the new result array is published as a JSON array. Set `retain: true` on the view to publish as a retained message.

### MQTT command topics

sheDB also listens for commands on the following topics (prefix `{dbPrefix}`):

| Topic | Payload | Action |
|-------|---------|--------|
| `{dbPrefix}set/{id}` | JSON object | Create or overwrite document |
| `{dbPrefix}extend/{id}` | JSON object | Deep-merge into document |
| `{dbPrefix}delete/{id}` | *(any)* | Delete document |
| `{dbPrefix}prop/{id}` | JSON `{method, prop, val}` | Mutate a single property |
| `{dbPrefix}get/{id}` | *(any)* | Publish document to `{dbPrefix}result/{id}` |

> **Convention:** View IDs follow the same slash-separated convention as document IDs. A view named `hue/lights/on` publishes to `she/db/view/hue/lights/on`.
