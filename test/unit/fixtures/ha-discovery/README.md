# Home Assistant MQTT discovery corpus

Each file is a list of `{topic, payload}` messages as a broker holds them retained under
`homeassistant/#`: a payload is the JSON object the publisher sent, or a string for the non-JSON
topics that live under the same prefix. `home-model.test.js` feeds them to the home model.

The corpus is shared with mqtt2matter (`test/fixtures/ha/` there). Part of it was captured from real
publishers (ESPHome, zigbee2mqtt, AI-on-the-edge meter digitizers, the device-based form of several
adapters) and anonymised — device names, hostnames, addresses, serial numbers and areas replaced,
`configuration_url` removed. The rest (Tasmota, Shelly, Z-Wave JS UI, OpenMQTTGateway) was written
by hand in the shape those projects document.

Nothing from a real installation goes in here without being anonymised first.
