# Primary and additional brokers

she talks to **one primary MQTT broker** — the `url` in the config, with everything that builds on it:
the state store the scripts read, the variables (`var/…`), the Services inventory, the history
integrations, the Matter bridge and the Broker page. That does not change.

Since 3.0 the daemon can hold connections to **additional brokers** next to it: a second Mosquitto in
the shed, a cloud broker, the installation of a neighbour you help with. Scripts reach them with
`she.mqtt('<name>')`, and **mirror rules** copy chosen topics into the primary broker and back. An
additional broker is never waited for and never makes the daemon unhealthy: it connects in the
background, reconnects by itself, and shows as a warning while it is down.

## Configuration

Additional brokers live under `brokers` in the config file (there is no command-line flag; the Config
page has a card per broker below the MQTT section):

```json
{
  "url": "mqtt://127.0.0.1",
  "brokers": {
    "shed": {
      "url": "mqtt://192.168.2.10",
      "username": "she",
      "password": "…",
      "mirror": [
        { "dir": "in", "from": "tele/#", "to": "shed/tele/#" },
        { "dir": "out", "from": "shed/set/#", "to": "set/#" }
      ]
    },
    "cloud": {
      "url": "mqtts://broker.example.com:8883",
      "ca": "-----BEGIN CERTIFICATE-----\n…",
      "mqttVersion": "5"
    }
  }
}
```

| Key | Description |
|---|---|
| `<name>` | The broker's name: letters, digits, `-` and `_`. It is what scripts call (`she.mqtt('shed')`), what the MQTT page's switcher shows, and the namespace of its topics in the state store (`mqtt@shed::<topic>`). |
| `url` | `mqtt://`, `mqtts://`, `ws://` or `wss://` host and port. |
| `username`, `password` | Credentials, when the broker asks for them. |
| `ca`, `cert`, `key` | PEM strings for TLS: the CA to trust, and a client certificate and key for mutual TLS. |
| `mqttVersion` | `"3"`, `"4"` or `"5"` to force a protocol version; omitted: MQTT 3.1.1. |
| `mirror` | The mirror rules, see below. Empty by default — nothing is copied unless you say so. |

A change under `brokers` needs a daemon restart, like the primary's settings.

## Scripts: `she.mqtt('<name>')`

`she.mqtt` is the primary broker, as it always was. Called with a name it returns the **same API for
an additional broker** — `sub`, `pub`, `get`, `getProp`, `age`, `link`, `or`, `and`, `max`, `min`,
`timer`, `command`, with the same options:

```js
const shed = she.mqtt('shed');

shed.sub('tele/temp', { change: true }, (topic, val) => {
    if (val < 3) she.mqtt.pub('home/set/alarm/frost', 1); // on the primary
});
shed.pub('set/heater', 1);
she.log(shed.get('tele/temp'), shed.age('tele/temp'));

await shed.command('dev/set/lamp/STATE', 1); // rejects with reason 'offline' while the broker is down
```

The helpers work within one broker — `shed.link(a, b)` links two topics of the shed. To move values
between brokers, use a mirror rule, or a subscription on one side and a publish on the other.

A name that is not configured throws at load (`she.mqtt("x"): no such broker — configured: shed,
cloud`), so a typo is a visible script error, not a silent nothing. `she.on('mqtt@shed::tele/temp',
cb)` is the state-store form of the same subscription. Details and the full option lists are in the
[Sandbox API](sandbox-api.md#shemqttname----additional-brokers).

## Mirror rules

A rule copies messages one way between an additional broker and the primary:

- **in** — `from` is a topic filter on the additional broker, `to` the topic it appears under on the
  primary. `{ "dir": "in", "from": "tele/#", "to": "shed/tele/#" }` makes the shed's `tele/temp`
  appear as `shed/tele/temp` on the primary.
- **out** — `from` is a filter on the primary, `to` the topic on the additional broker.
  `{ "dir": "out", "from": "shed/set/#", "to": "set/#" }` sends the primary's `shed/set/heater` to the
  shed as `set/heater`.

`to` is written with the same wildcards as `from`, and the matched segments are carried over
(`+/status/#` → `remote/+/status/#`). Without `to` the topic stays the same on both sides. A rule
without wildcards maps one topic to one topic. Per broker and direction, the first matching rule wins.

QoS and the retain flag are kept **as the broker delivers them**: the retained values the daemon
receives when it connects (or reconnects) are published retained on the other side, so a retained
value on the shed is a retained value on the primary. A message published *while* the daemon is
connected arrives without the retain flag — MQTT 3.1.1 brokers clear it for established
subscriptions — and is mirrored as a live message; the broker's retained copy follows with the next
reconnect burst.

Mirrored topics are **ordinary topics of the primary broker**: the MQTT page, the history, the
Services inventory, the Matter bridge and every script see them like any other topic.

**Loop protection.** The daemon subscribes to `#` on every broker, so each mirrored publish comes back
to it as a message. Every publish a rule makes is remembered until that echo arrives; the echo is
stored like any message but is never mirrored on. What came in by a rule is therefore never sent back
out — also when two rules form a cycle (`in` `#` → `shed/#` together with `out` `shed/#` → `#`): the
cycle could only continue through the echo, and the echo is consumed. A retained message that
arrives again unchanged (the burst after a reconnect) is not sent a second time.

**Presets** (one click on the Config page):

- *everything in under `<name>/`* — `{ "dir": "in", "from": "#", "to": "<name>/#" }`: the whole
  additional broker appears under one prefix on the primary.
- *mqtt-smarthome adapter* — for an adapter instance `<inst>` running on the additional broker:
  `<inst>/status/#` and `<inst>/connected` in, `<inst>/set/#` out. Scripts, the Services page and
  `she.mqtt.command` then treat the adapter as if it were on the primary.

## Offline behaviour

- The daemon's start waits for the primary broker's retained state as before; additional brokers
  connect in parallel and are not waited for. Scripts run whether they are reachable or not.
- A subscription made through `she.mqtt('<name>')` receives the broker's retained values once it
  connects — at start or after an outage — when it asked for them (`{ retain: true }`).
- `pub` to an offline additional broker is **queued briefly** (up to 1000 messages, at most a minute)
  and sent when the connection is back; `command` fails at once with reason `offline` and the broker's
  name in the message.
- `/she/health` reports the primary only; an additional broker that is down does not make the daemon
  `degraded`. The status payload (`GET /she/status`, field `brokers`), the Runtime page, the Config
  page's cards and the MQTT page's switcher show it, the MQTT nav dot turns yellow (red is reserved for
  the primary), and the log says `mqtt@<name> not connected (…) — retrying in the background`, at most
  once a minute per error.

## Mirror rules or a Mosquitto bridge?

Mosquitto can join two brokers itself (a *bridge* in its config), and that is often the better tool.
Rule of thumb:

- **A Mosquitto bridge** when the two brokers should be joined permanently and independently of
  she — the bridge keeps running when she is stopped, and other clients of both brokers see the same
  topics.
- **she's mirror rules** when she owns the connection: a cloud broker whose credentials she keeps, a
  neighbour's broker you do not administer, a broker you only want to read from, or topics that have
  to be renamed on the way. Scripts can then also talk to the broker directly with `she.mqtt('<name>')`,
  which a bridge cannot give you.
