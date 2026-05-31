# Views

Views are named, persistent queries. A view is defined by up to three parts:

| Part | Required | Description |
|------|----------|-------------|
| **Filter** | no | MQTT wildcard — only matching document IDs are processed |
| **Map** | yes | JavaScript function body — runs once per (filtered) document |
| **Reduce** | no | JavaScript function body — post-processes the map result array |

Views are recalculated automatically whenever any document changes.

---

## Defining a View in the Web UI

Open the **DB** tab, switch to **Views**, and click **+ View**. Then:

1. Enter a name for the view (e.g. `lights-by-room`).
2. Optionally fill in the **Filter** field with an MQTT wildcard pattern
   (e.g. `hue/lights/#`). Only documents whose IDs match will be passed to the map function.
3. Write the **Map** function body. `this` refers to the current document.
   Call `emit(value)` to include something in the result.
4. Optionally write a **Reduce** function body. It receives the `result` array
   produced by the map phase and must `return` a new value.
5. Click **Save**. The result appears at the bottom of the page.

---

## Map Function

`this` is the current document. Use `emit(value)` to push items into the result.

```js
// Emit the document's name for every light in the living room
if (this.room === 'living') {
    emit(this.name);
}
```

```js
// Emit an object
emit({ id: this._id, name: this.name, brightness: this.brightness });
```

If you don't call `emit()`, the document is excluded from the result.

---

## Filter

The filter pre-selects documents before the map function runs, using MQTT wildcard syntax:

| Pattern | Matches |
|---------|---------|
| `hue/lights/#` | `hue/lights/lamp1`, `hue/lights/kitchen/spot`, … |
| `hue/lights/+` | `hue/lights/lamp1`, but **not** `hue/lights/kitchen/spot` |
| `rooms/+` | `rooms/living`, `rooms/kitchen`, … |

Without a filter, the map function is called for **every** document in the database.

---

## Reduce Function

The reduce function receives the full result array from the map phase in the
variable `result` and must `return` a new value (array or object).

```js
// Sort alphabetically
return result.sort((a, b) => a.name.localeCompare(b.name));
```

```js
// Count by room
return result.reduce((acc, cur) => {
    acc[cur.room] = (acc[cur.room] || 0) + 1;
    return acc;
}, {});
```

---

## Ad-hoc Queries in Scripts

For one-off queries that don't need to be persisted as views, use
`she.db.query()` directly in scripts:

```js
const dimmableLights = she.db.query('hue/lights/#', function () {
    if (this.dimmable) emit({ id: this._id, name: this.name });
});
// Returns an array immediately (synchronous)
```

With reduce:
```js
const countByRoom = she.db.query(null, function () {
    emit(this.room);
}, function (result) {
    return result.reduce((acc, cur) => {
        acc[cur] = (acc[cur] || 0) + 1;
        return acc;
    }, {});
});
```

Pass `null` as the filter to process all documents.

---

## MQTT Publishing

Views can publish their result to MQTT automatically. This is configured **per view** in the Web UI (DB → Views → select a view → check **Publish to MQTT**). It is **independent** of the global `dbPublish` config option.

### Properties

| Property | Description |
|----------|-------------|
| `mqttpub` | If `true`, the view result is published to MQTT on every recalculation |
| `retain` | If `true`, the message is published as a retained MQTT message |

### Topic format

```
{dbPrefix}view/{viewId}
```

Example: a view named `hue/lights/on` with the default prefix publishes to:
```
she/db/view/hue/lights/on
```

The payload is a JSON-serialised array (the view's result). The message is published every time a document changes that falls within the view's filter.

> **Tip:** Name views like MQTT topics (slash-separated) so the resulting MQTT topics are self-descriptive and can be filtered with wildcards.

---

## View Results via HTTP API

```
GET /she/db/views/:id/result
```

Returns the current result of the named view. Useful for integrating with
external dashboards or home-automation frontends.

See [view-examples.md](view-examples.md) for practical examples.
