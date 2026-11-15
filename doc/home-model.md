# The home model

Most adapters already describe what they offer: zigbee2mqtt, ESPHome, Tasmota, Shelly, Z-Wave JS UI and every
mqtt-smarthome adapter announce their devices through **Home Assistant MQTT discovery** — retained configs under
`homeassistant/…` that say which entities a device has, which topics carry their state and which take commands.
The home model is she's copy of those announcements in [sheDB](db/README.md), organised the way you think about
your home: **floors, rooms, functions and labels**.

With it, a script does not name topics. It asks for "the window contacts in the bathroom" or "every light on the
upper floor", and keeps working when a device is replaced, added or moved to another room.

- [Switching it on](#switching-it-on)
- [What she keeps](#what-she-keeps)
- [Rooms and floors](#rooms-and-floors)
- [Functions and labels](#functions-and-labels)
- [The Meta page](#the-meta-page)
- [In scripts](#in-scripts)
- [Standard views](#standard-views)
- [Room, floor and house aggregates](#room-floor-and-house-aggregates)
- [Scenes](#scenes)
- [Matter devices](#matter-devices)
- [Entities of your own scripts](#entities-of-your-own-scripts)
- [Limits](#limits)

---

## Switching it on

The home model needs sheDB (`--db-path`) and an MQTT broker. It is switched on in **Config → Home model**:

- **A new installation** — no config file, no sheDB file and no script at the first start — has it on from the
  start.
- **An existing installation** shows a hint and leaves it off until you switch it on: the first mirror writes one
  document per device and entity under `she/…`. Your own documents are never touched.

The first time, she asks for the **language of the default function names** (English or German). The names are
yours from then on and can be edited; the ids stay English (`lighting`, `heating`, …). Until a language is chosen,
the devices are mirrored but no function exists.

Switching the model off keeps every document; switching it on again continues where it was. The switch is stored
in sheDB (`she/home`), so it takes effect at once, without a restart.

The discovery prefix is `homeassistant`; `--ha-prefix` changes it ([CLI](cli.md)). Only the primary broker is read.

## What she keeps

One document per device and one per entity, under `she/device/…` and `she/entity/…`. Each is in three sections:

| Section | Written by | Holds |
|---|---|---|
| `ha` | she, from the discovery config | the announced name, component, device class, unit, the expanded config, the topics, the device block (manufacturer, model, `suggested_area`, …), the adapter (`origin`), `present` and `gone_since` |
| `user` | you (the Meta page, `she.home.assign()`) | your name, rooms, functions, labels, hidden, notes — never written by she |
| `eff` | she | the effective values: what you assigned, else what is inherited (from the device, from the announced area, from the function rules) |

A device or entity that is no longer announced is **not deleted**: it is marked `present: false` with
`gone_since`, so a device that comes back finds its rooms and names again. Gone devices are listed on the Meta page
(and in the view `she/devices/gone`) and can be removed there. The first check for gone devices runs 30 seconds after
the start, once the broker's retained state is complete.

What is not an entity: a device's triggers (`device_automation`, buttons and remotes) are kept on the device; `tag`
scanners are left out.

**Hidden** are an adapter's diagnostic and configuration entities (`entity_category`), entities announced as
disabled by default, and whatever you hide. Hidden entities are kept, but scripts, views and aggregates leave them
out unless they ask for them.

## Rooms and floors

- **Rooms come from the announcements.** A device's `suggested_area` (zigbee2mqtt, ESPHome and many adapters can
  set one) becomes a room the first time it appears — "Küche" becomes the room `kueche`. A device without an area is
  in no room until you put it in one.
- **Spellings are merged.** When "Kitchen" and "Küche" are the same room, merge one into the other on the Meta page:
  the other name becomes an *alias*, so a later announcement with either spelling lands in the kept room, and every
  assignment and every scene that pointed at the merged room is moved.
- **Deleting a room that came from an area** keeps a note of it, so the next announcement does not create it again;
  the Meta page lists such areas and can bring them back.
- **An entity can be in several rooms.** A hallway light that lights the stairs too belongs to both. Rooms are set
  per entity and inherited from the device: put the device in a room, and the one entity that is elsewhere gets a
  room of its own.
- **A room has one floor.** Floors have a name, a level and an order; the Meta page orders floors and rooms.

## Functions and labels

A **function** says what an entity is for, independent of the room. she creates ten:

| Id | Takes by default |
|---|---|
| `lighting` | lights |
| `shading` | covers that are shutters, blinds, awnings, curtains, shades (or have no class) |
| `heating` | thermostats (`climate`) and water heaters |
| `climate` | temperature, humidity, CO₂, particulate, VOC and pressure sensors that are not diagnostic |
| `openings` | window, door, opening and garage door contacts; garage doors, gates and windows as covers |
| `security` | locks, alarm panels; smoke, gas, water, tamper, safety, motion and occupancy sensors |
| `energy` | power and energy sensors |
| `presence` | device trackers and presence sensors |
| `media` | nothing — discovery has no media player; assign what plays media by hand |
| `maintenance` | battery sensors, problem and update sensors, update entities |

Each function has **rules** (component, device class, entity category, exceptions); the Meta page edits them with a
live preview of what they catch. An entity can have several functions; what you assign to an entity replaces the
rules for it. A smart plug that switches a lamp is a `switch` — give it `lighting` by hand, and it counts as a light.

**Labels** are your own groups across rooms and functions: `evening`, `motion`, `keep`. They are created by naming
them.

## The Meta page

**Meta** in the navigation, between Matter and DB (shown when sheDB is on):

- **Rooms** — floors with their rooms in order; create, rename, give aliases, icons and a floor; merge rooms; the
  entities of a room grouped by device, with "Add entities…" to move entities here or add the room to them.
- **Devices** — all, in no room, gone, hidden; filter by room and adapter, search; select devices and entities to
  set rooms, functions and labels in bulk; a panel edits one device or entity. Dashed chips are inherited, solid ones
  assigned.
- **Scenes** — the scenes and scene groups by room with their live state, recall and deactivate, and the scene and
  group editors; see [the Scenes page](scenes.md#the-scenes-page).
- **Functions** — the list with counts, names, icons, the rule editor and its preview.
- **Labels** — create, rename, delete.

Screenshots: [screenshots.md](screenshots.md#home). The page uses the REST routes under `/she/home`
([HTTP API](http-api.md#home-model--shehome)).

## In scripts

`she.home` reads the model and changes assignments ([reference](sandbox-api.md#shehome----home-model)):

| Call | Returns |
|---|---|
| `she.home.floors()`, `she.home.rooms()` | the floors with their rooms, the rooms with their floor and entity count |
| `she.home.entities({ room, floor, function, label, component })` | entity summaries: `id`, `name`, `rooms`, `floors`, `functions`, `labels`, `component`, `device_class`, `unit`, `state_topic`, `command_topic`, `device` |
| `she.home.sub(selection, cb)` | every message on a state topic of the selection; follows entities that are added or moved |
| `she.home.entity(idOrTopic)` | one entity with its **state in Home Assistant's terms** and commands: `state()`, `turnOn()`, `turnOff()`, `setPosition()`, `setTemperature()`, `set()`, `matches()`, `sub()` |
| `she.home.assign(id, patch)` | change rooms, functions, labels, name, hidden, notes |

`room` takes a room's id, name or alias. `she.home.entity()` reads the device's payloads through its discovery
config — `value_template`, `payload_on`, the JSON schema of lights — so a script sees `{ state: 'ON', brightness:
102 }` whatever the device puts on the wire, and `turnOn({ brightness: 128 })` becomes the publish that device
understands.

```js
// every light in the kitchen off, whatever adapter they come from
for (const e of she.home.entities({ room: 'kitchen', function: 'lighting' })) she.home.entity(e.id).turnOff();
```

Complete scripts: [Examples — home model](examples/home-model.md).

## Standard views

While the model is on, she keeps sheDB views of her own under `she/…`: floors, rooms, entities by room, floor,
function, room and function, component and label, a reverse index from every state topic to its entities
(`she/topics`), devices by adapter, unassigned and gone devices, battery entities, which entities each room's
aggregates are computed from, and the scenes by room and by entity (`she/scenes/by-room`, `she/scenes/by-entity`:
"what does this lamp take part in"). They are recreated at every start and read-only in the views editor; only *Publish to
MQTT* can be switched, so a dashboard can take them from `she/db/view/<id>` without reading sheDB. The list with the
shapes is in the [sandbox reference](sandbox-api.md#standard-views).

```js
const rooms = she.db.getView('she/entities/by-room-function');
for (const e of rooms?.bathroom?.openings ?? []) she.log(e.name, she.mqtt.get(e.state_topic));
```

## Room, floor and house aggregates

she computes what each room, each floor and the whole house are doing and publishes it retained (`she` is the
instance name, `--name`):

```
she/status/room/<room>/<aggregate>
she/status/floor/<floor>/<aggregate>
she/status/home/<aggregate>
```

| Aggregate | `val` |
|---|---|
| `light`, `lights` | is a light on; how many (lights and switches with the function `lighting`) |
| `open` | is a window, door or cover open (function `openings`) |
| `temperature`, `humidity` | the mean of the `climate` sensors, with `min`, `max` and `unit` |
| `occupied` | does an occupancy, presence or motion sensor see somebody |
| `power` | the sum of the `energy` power sensors in W |
| `scene` | rooms only: the id of the scene the room is in, `''` when none matches — from the room's scene groups |

The payload is `{val, ts, lc, members: [{id, name, val}]}`: `members` are the entities it was computed from and what
each contributed. An entity in two rooms counts in both, and once on its floor and in the house. The room's `scene`
is `{val, ts, lc, group, groups}`: from the [scene groups](scenes.md#scene-groups) whose `area` is the room, the first
group (by name) in which a scene matches gives `val`, and `groups` has each group's value; it is not announced
through discovery (the groups announce themselves). A script then works
with rooms instead of devices:

```js
she.mqtt.sub('she/status/room/bathroom/open', { change: true }, (topic, open) => she.log('bathroom', open ? 'open' : 'closed'));
```

An aggregate can be switched off or an entity left out per room (and per floor and the house), with the field
`aggregates` on the room document — see the [reference](sandbox-api.md#aggregates-what-a-room-a-floor-and-the-house-are-doing).
Rooms, floors and the house are also announced through Home Assistant discovery as devices, so Home Assistant and
mqtt2matter see them; in the home model these devices are hidden.

## Scenes

Scenes are stored states of entities of the home model, and datapoints of their own: [Scenes](scenes.md).

## Matter devices

Devices paired with she's [Matter controller](matter.md) enter the home model the same way as every other device:
switch on **Announce the devices through Home Assistant discovery** on the Matter page's MQTT tab, and the Matter ↔
MQTT bridge announces each paired device ([details](matter.md#announce-the-devices-through-home-assistant-discovery)).
They then have rooms, functions, aggregates and scenes like the rest — and Home Assistant sees them too.

## Entities of your own scripts

A script that is the adapter of something — a virtual switch, a computed value, an irrigation controller — announces
its entities with [`she.mqtt.announce()`](sandbox-api.md#shemqttannounceentity). They come into the home model like
any device, with a room from the `rooms` hint, and are cleared when the script stops.

## Limits

- Only what is announced through discovery takes part. A topic nobody announces can be announced by a script
  (above); manual entities are planned.
- Only the primary broker is mirrored.
- A config cleared while she was disconnected is noticed at the next start.
- Icons are stored (`mdi:…`) but not shown yet.
