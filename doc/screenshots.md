# Screenshots

A walkthrough of the web UI, page by page, in the order of the navigation bar. The screenshots show she 3.0 in a demo
house: every device, host, address, account and value in them is invented.

## Scripts

### The editor

![Scripts page: file tree, editor, script log, runtime panel and the AI assistant docked around the code](screenshots/scripts-editor.png)

The file tree, the editor, the log of the open script, what that script has registered (subscriptions, timers,
pending commands) and the AI assistant are panels docked around the code; each can be moved, resized or closed. Here
the assistant was asked why a light is still on: it looks at the room, the script's timers and its log, finds the
cause in the script and drafts the fix.

### The assistant proposes a change

![AI assistant with its tool calls and a script draft shown as a diff with Apply and Discard](screenshots/ai-script-change.png)

Asked for a change, the assistant reads the script and the topics it needs, then hands over a draft. The chat shows
every tool call and the draft as a diff; nothing is written until **Apply** (unless **Approve** in the chat bar is
set to apply script changes at once).

### The change as a diff in the editor

![Editor showing the proposed change inline, removed lines red and added lines green, with Accept and Discard](screenshots/ai-script-diff.png)

The applied draft opens as a diff in the editor, removed and added lines side by side with the code around them.

### A new script from a prompt

![AI assistant drafting a new script from a one-sentence request](screenshots/ai-new-script.png)

A one-sentence request becomes a new script. The assistant searched the broker for the door contact first, so the
draft uses the topic and the payload that exist in this house.

## Packages

![Packages page: installed npm packages on the left, the npm search on the right](screenshots/packages.png)

npm packages for the scripts: search, install, pin, update and remove. A script then simply calls `require()`.

## MQTT

![MQTT page: the topic tree with live values and the live message stream below](screenshots/mqtt-topics.png)

Every topic she knows as a tree with its current value and the time of the last message, a publish bar on top and the
live message stream below. A click on a branch filters the stream to it.

## Broker

she can manage a Mosquitto broker: its configuration files, its users and their rights, its listeners and bridges.

### Status

![Broker page, Status tab: Mosquitto version, uptime, clients, messages and traffic](screenshots/broker-status.png)

The broker at a glance, from its `$SYS` topics, and whether the dynamic security plugin is active.

### Directory

![Broker page, Directory tab: users with their roles and groups](screenshots/broker-directory.png)

Users, roles and groups of Mosquitto's dynamic security plugin. Changes apply at once, without a broker restart.

### Config

![Broker page, Config tab: persistence, logging and connection limits of mosquitto.conf as a form](screenshots/broker-config.png)

The global options of `mosquitto.conf` as a form, each with its explanation.

### Listeners

![Broker page, Listeners tab: an MQTT listener and a WebSocket listener](screenshots/broker-listeners.png)

Ports, protocols, bind addresses and TLS of the broker's listeners.

### Bridges

![Broker page, Bridges tab: two bridges to other brokers with their connection state and topic rules](screenshots/broker-bridges.png)

Bridges to other brokers with their live connection state and their topic rules, readable as "this topic here goes to
that topic there".

## Adapters

The adapters that connect devices and services to MQTT (the `xyz2mqtt` family), on the she host and on other hosts
over SSH.

### Instances

![Adapters page, Instances tab: eight adapter instances on two hosts with state, uptime, memory, CPU and actions](screenshots/adapters-instances.png)

One row per running instance: adapter, host, connection state, uptime, memory, CPU and event loop lag, the log level,
and restart, stop and uninstall.

### An instance's configuration

![An adapter instance's drawer with its configuration as a form](screenshots/adapters-instance-config.png)

The configuration of an instance is a form generated from the adapter's own option schema. The same drawer has the
instance's files, its journal and its details.

### Installations

![Adapters page, Installations tab: the installed adapters per host with their versions and an available update](screenshots/adapters-installations.png)

What is installed on which host, in which version, and which updates npm has.

### Hosts

![Adapters page, Hosts tab: two managed hosts with their Node.js version, and the SSH key](screenshots/adapters-hosts.png)

The managed hosts with their Node.js version, which can be updated from here, and the SSH key she uses to reach them.

## Matter

she is a Matter controller: it pairs devices, reads and writes their attributes and makes them available to scripts
and on MQTT. The [Matter guide](matter.md) walks through it.

### Devices

![Matter page, Devices tab: the paired devices and the clusters and attributes of a lamp](screenshots/matter-devices.png)

The paired devices with their health, and everything one device offers: endpoints, clusters, attributes and commands,
with buttons for the common ones.

### Bindings

![Matter page, Bindings tab: a wall switch bound to a lamp and to a group of lights](screenshots/matter-bindings.png)

Bindings let a switch drive a lamp directly, without she in between. Groups address several devices with one command.

### Thread

![Matter page, Thread tab: border routers, the stored network credentials and the mesh as a graph](screenshots/matter-thread.png)

The Thread networks on the LAN with their border routers, the credentials she keeps, and the mesh as a graph: routers,
sleepy end devices and the quality of every link.

## DB

### Documents

![DB page, Documents tab: a JSON document in the editor](screenshots/db-documents.png)

sheDB is the built-in JSON document store for what scripts need to remember: rooms, profiles, daily reports.

### Views

![DB page, Views tab: a view with its filter, map and reduce functions and the live result](screenshots/db-view.png)

A view is a saved query: a filter, a map function and an optional reduce function. Its result is recalculated
whenever a document changes.

## Secrets

![Secrets page: groups of secrets, with write-only fields for passwords and tokens](screenshots/secrets.png)

Passwords and tokens for the scripts, stored encrypted. A secret field is write-only: it is never sent back to the
browser.

## Logs

![Logs page: the daemon's log with level filter, text filter and links to the scripts](screenshots/logs.png)

The daemon's log, live, filtered by level or text. A script name is a link to that script in the editor.

## Runtime

![Runtime page: tiles for memory, CPU, event loop, MQTT, script callbacks and scripts, each with its history](screenshots/runtime.png)

How the daemon is doing: memory, CPU, event loop, MQTT traffic and script callbacks, each with its history of the
last day, and below them every handler and timer of every script.

## Config

![Config page: the settings by section, with a filter](screenshots/config.png)

Every setting of the daemon, by section, with a filter. Nothing here needs a text editor.
