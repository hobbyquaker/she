# View Sandbox

Map and reduce function bodies run inside a sandboxed VM. The following globals
are available. Standard Node.js globals (`require`, `process`, `console`, etc.)
are **not** available. Documents are frozen — you cannot modify database contents
from within a view.

---

## `emit(value)`

Pushes `value` into the result array. Call it from inside the **map** function.

```js
emit(this.name);          // push a string
emit({ id: this._id });   // push an object
```

---

## `this`

In the **map** function, `this` refers to the current document (including its
`_id` and `_rev` internal properties).

```js
if (this.type === 'light') {
    emit({ id: this._id, room: this.room });
}
```

---

## `api` object

### `api.getDocument(id)` → object

Returns the document with the given ID. Useful for cross-document lookups inside
the reduce function.

```js
// In reduce: enrich each result with data from another document
return result.map(item => {
    const room = api.getDocument('rooms/' + item.room);
    return { ...item, roomLabel: room?.label };
});
```

### `api.forEachDocument(callback)`

Calls `callback(id)` once for every document in the database.
`this` inside the callback is **not** set — use `api.getDocument(id)` to
retrieve the document.

> **Note:** Using `forEachDocument` inside the **map** function leads to O(n²)
> complexity. Prefer using it in the **reduce** function instead.

```js
// In reduce: build a lookup table across all documents
const rooms = {};
api.forEachDocument(id => {
    const doc = api.getDocument(id);
    if (doc.type === 'room') rooms[doc._id] = doc.label;
});
return result.map(item => ({ ...item, roomLabel: rooms[item.room] }));
```

### `api.getProp(document, property)` → value

Gets a nested property value using dot notation. Dots in property names must be
escaped with a backslash.

```js
const temp = api.getProp(api.getDocument('sensor/bedroom'), 'readings.temperature');
```

### `api.mqttWildcard(id, pattern)` → array | null

Tests whether `id` matches an MQTT wildcard `pattern`. Returns an array of
matched wildcard segments on success, or `null` if it doesn't match.

```js
if (api.mqttWildcard(this._id, 'hue/lights/+')) {
    emit(this.name);
}
```

---

## `result` (reduce only)

In the **reduce** function, `result` is the array produced by the map phase.
The function must `return` a new value.

```js
// Reduce: sort by name
return result.sort((a, b) => a.localeCompare(b));
```
