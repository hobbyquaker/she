# Scenes

A **scene** is a stored state of entities of the [home model](home-model.md) — the floor lamp on at 40 %, the blind
at 30 %, the amplifier on — and at the same time a **datapoint of its own**: `true` while every member is in that
state, whoever brought it there, `false` as soon as one is not.

- Somebody dims the lamp by hand: the scene is `false`.
- The lamp is dimmed back, or the scene is recalled: `true` again.
- Setting the scene `true` recalls it; what setting it `false` does is the scene's choice.

Because a scene is a datapoint, Home Assistant, a dashboard, a Matter controller and your scripts all see the same
thing: "is the movie scene on?". Scenes need sheDB and the home model.

- [A scene and its members](#a-scene-and-its-members)
- [When a scene is true](#when-a-scene-is-true)
- [Recall](#recall)
- [Deactivate](#deactivate)
- [Scene groups](#scene-groups)
- [Locks and alarm panels](#locks-and-alarm-panels)
- [On MQTT](#on-mqtt)
- [Home Assistant and Matter](#home-assistant-and-matter)
- [Scenes per room](#scenes-per-room)
- [In scripts](#in-scripts)
- [The AI assistant](#the-ai-assistant)
- [The Scenes page](#the-scenes-page)

---

## A scene and its members

A scene is a sheDB document `she/scene/<id>`:

```json
{
    "name": "Movie",
    "area": "living-room",
    "deactivate": "restore",
    "settle": 10,
    "members": [
        { "entity": "she/entity/floor_lamp_light", "attributes": { "state": "ON", "brightness": 102 } },
        { "entity": "she/entity/blind_living_cover", "attributes": { "position": 30 }, "order": 1 },
        { "entity": "she/entity/tv_power", "attributes": { "state": "ON" }, "role": "match" }
    ]
}
```

| Field | Meaning |
|---|---|
| `name`, `icon` | as shown |
| `area` | the room the scene belongs to (a room id; moved along when rooms are merged) |
| `deactivate` | what `false` does: `none` (default), `restore`, `off`, `scene:<id>` — [below](#deactivate) |
| `settle` | seconds after a recall during which a member that has not answered yet does not make the scene `false` (default 10) |
| `members` | the entities and the state they should be in |

A **member** is `{ entity, attributes, tolerance?, role?, order?, delay?, off? }`:

- `attributes` are in Home Assistant's terms, whatever the device's payloads look like: `state`, `brightness`
  (0–255), `color_temp`, `position`, `temperature`, `mode`, `option`, … (the attributes per component are listed with
  [`she.home.entity()`](sandbox-api.md#shehomeentityidortopic)).
- `role`: `recall+match` (default) — commanded and compared; `match` — a condition that is never commanded ("the TV
  is on"); `recall` — commanded, but it does not decide whether the scene is on (a blind that the sun program moves
  anyway).
- `order` and `delay` (seconds): the order of the commands on a recall, and a pause before one.
- `tolerance`: per attribute, overrides the default tolerances.
- `off`: the attributes this member gets when the scene is switched off (`deactivate: off`), or `false` to leave it
  alone.

The easiest way to make a scene is to set the devices by hand and take their state:
`she.scene.snapshot('movie', [ids], { name: 'Movie', area: 'living-room' })`.

A button or a Home Assistant `scene` entity can be a member: the recall triggers it, it never decides the state.

## When a scene is true

Every member with a `match` role must be in its stored state:

- **Numbers match within a tolerance**: brightness ±2 (of 255), position ±2 %, temperature ±0.25, and the other
  defaults of [mqtt-ha-entities](https://github.com/hobbyquaker/mqtt-ha-entities); everything else must be equal. A
  light that should be off is not asked for its brightness.
- **Unknown does not match.** A member without a value yet, one whose device is offline (its availability), and one
  that is no longer announced make the scene `false`; they are listed under `unknown` with the reason (`no value`,
  `unavailable`, `missing`).
- **A change is told after a second of quiet**, so a recall whose answers arrive one by one does not flap.

A scene without a member that counts (all `recall`) is never `true`.

## Recall

Setting a scene `true` (the set topic, `she.scene.recall()`, Home Assistant's switch):

- **Only the members that differ are commanded.** The lamp that is already right gets nothing — no radio traffic, no
  flicker.
- **`force`**, and **a recall of a scene that is already `true`**, command every member. That repairs a device whose
  reported state is wrong.
- Members go out in their `order`, each after its `delay`.
- During `settle`, a member that has not answered yet does not make the scene `false`. After it, every mismatch is
  written to the log: `scene movie: Floor lamp brightness is 80, expected 102`.
- A newer recall in the same group drops what an older one has not sent yet.
- **Loop guard**: more than 5 recalls of a scene within 10 s are dropped, with a warning.

## Deactivate

What setting a scene `false` does is its `deactivate` setting. The default is to do nothing: a scene is a state,
and "not the movie scene" says nothing about what should happen instead.

| `deactivate` | `false` … |
|---|---|
| `none` (default) | is ignored; the log says so |
| `restore` | brings the members back to the state they had before the recall — **only those nobody touched since**: the lamp you dimmed during the movie stays as you set it |
| `off` | switches the scene's lights, switches and fans off (or what a member's `off` says); other members are left alone |
| `scene:<id>` | recalls that scene — only while this one is `true` |

`restore` keeps its restore point (`she/scene/<id>/restore`) across a restart of she. It also acts when the scene is
already `false` (you changed one lamp, then switch the movie off: the untouched members go back), and `off` always
acts; `none` and `scene:<id>` do nothing on a scene that is already `false`.

## Scene groups

A **scene group** (`she/scenegroup/<id>`: `{ name, area, scenes: [ids], default }`) is an ordered list of scenes,
usually the moods of one room: `off, evening, movie, reading`.

- Its value is **the scene of the list that matches now** (the first when several do), or `""`.
- Setting it to a scene id recalls that scene.
- Setting it to `none` (or `false`) recalls the group's `default` scene when it has one; without a default, the
  active scene is deactivated by its own mode.

A scene can be in several groups.

## Locks and alarm panels

A lock or an alarm panel is only commanded by a scene when its member is **confirmed** (`confirmed: true`). The
editor asks before it sets that; `she.scene.snapshot()` throws for such an entity unless `confirmSensitive: true` is
passed. The scene is then marked `sensitive`. As a condition (`role: match`, "the door is locked") a lock needs no
confirmation.

## On MQTT

`she` is the instance name (`--name`).

| Topic | | Payload |
|---|---|---|
| `she/status/scene/<id>` | retained | `{ "val": true, "ts", "lc", "matched": 4, "total": 4, "mismatch": [], "unknown": [], "recalled" }` |
| `she/set/scene/<id>` | | `true` recalls, `false` deactivates, `"toggle"`; `{ "val": true, "force": true }` commands every member |
| `she/status/scenegroup/<id>` | retained | `{ "val": "movie", "ts", "lc" }` |
| `she/set/scenegroup/<id>` | | a scene id recalls it; `"none"` or `false` is the group's deactivation |

`mismatch` is `[{ entity, name, attribute, is, want }]`; `unknown` is `[{ entity, name, attribute?, reason }]`. The
topics are cleared when a scene or group is deleted.

```sh
mosquitto_pub -t she/set/scene/movie -m true
mosquitto_pub -t she/set/scenegroup/living-room -m reading
```

## Home Assistant and Matter

Scenes announce themselves through Home Assistant discovery: one device "Scenes", every scene a `switch` (on while
the scene is `true`; switching it calls recall or deactivate), every group a `select` with its scenes and `none`.
Home Assistant, mqtt2matter and every other consumer of discovery get them without configuration.

## Scenes per room

- **The room's scene**: she publishes `she/status/room/<room>/scene` retained — `{ "val": "evening", "ts", "lc",
  "group": "lights", "groups": { "lights": "evening", "blinds": "" } }`. It comes from the scene groups whose `area` is
  the room: with several groups, `val` is the scene of the first group (by name) in which one matches, `group` is that
  group, and `groups` has each group's value; `""` when none matches. Scenes outside a group are not looked at. It can
  be switched off per room (`aggregates: { scene: false }` on the room document) and is not announced through
  discovery — the groups announce themselves. See the [room aggregates](home-model.md#room-floor-and-house-aggregates).
- **Standard views**: `she/scenes/by-room` (`{ room: [scene summary] }`, scenes without a room under `""`) for a
  room card that shows its scenes as buttons, and `she/scenes/by-entity` (`{ entity id: [scene ids] }`) for "what does
  this lamp take part in". Whether a scene is active is on its status topic, not in the view.

```js
// every scene of the living room, and which one is on
const scenes = she.db.getView('she/scenes/by-room')?.['living-room'] ?? [];
she.log(scenes.map((s) => s.name).join(', '), '— now:', she.mqtt.get('she/status/room/living-room/scene') || 'none');
```

## In scripts

[`she.scene`](sandbox-api.md#shescene----scenes): `list()`, `state(id)`, `recall(id, { force })`, `deactivate(id)`,
`toggle(id)`, `snapshot(id, entities, fields)`, `get(id)`, `remove(id)`, `sub(id, cb)`, `groups()`, `group(id)`,
`setGroup(id, sceneId)`.

```js
// the evening scene at sunset
she.schedule('sunset', () => she.scene.recall('evening'));

// why is the movie scene off?
const s = she.scene.state('movie');
if (s && !s.val) for (const m of s.mismatch) she.log(m.name, m.attribute, 'is', m.is, 'wants', m.want);

// a scene became active
she.scene.sub('movie', (id, state) => {
    if (state?.val) she.log('movie time');
});
```

## The AI assistant

The assistant's tool `list_scenes` lists the scenes with their state, or tells why one scene is on or off. To recall
or deactivate a scene it publishes to the set topic, so the chat's confirmation switch applies.

## The Scenes page

> **To be written** when the Scenes page is merged: listing scenes and groups, creating a scene from the present
> state, editing members with the entity picker, tolerances and roles, the lock confirmation, the deactivate mode,
> and testing a recall from the page.

Until then, scenes are created with `she.scene.snapshot()`, edited as documents on the DB page (`she/scene/<id>`),
or written by a script with `she.db.set()`.
