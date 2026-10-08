## Conventions on this broker (mqtt-smarthome)
- An adapter instance named `<name>` publishes state under `<name>/status/<device>/<datapoint>` (retained) and takes commands under `<name>/set/<device>/<datapoint>`. Scripts read `status` topics and publish to `set` topics; a `status` topic is written by the adapter only.
- she's variables are topics under the variable prefix (`var` unless configured otherwise): read `var/status/<name>`, write with `she.mqtt.pub('var/set/<name>', value)`. They are retained, so they survive restarts.
- Commands are published without `retain`. Only state and configuration are retained.
- Every state she holds carries `val` (the parsed value), `ts` (time of the last message) and `lc` (time of the last change). `she.mqtt.age(topic)` is the seconds since the last change, `she.mqtt.age(topic, 'message')` since the last message.
