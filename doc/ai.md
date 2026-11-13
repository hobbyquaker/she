# AI assistant

The chat in the web UI (the **AI** panel on the Scripts and DB pages) talks to a language model with tools that read
the running daemon. Nothing about an installation is in she's code or prompt files: what the model learns about a
house comes from the running daemon at request time.

## Configuration

The `ai` section of `config.json`, edited on the Config page:

```json
{
  "ai": {
    "providers": [
      { "id": "claude", "label": "Anthropic", "provider": "anthropic", "model": "claude-opus-5-5", "apiKey": "sk-…" },
      { "id": "local",  "label": "Ollama",    "provider": "ollama",    "baseUrl": "http://ollama:11434", "model": "qwen3:30b", "profile": "compact" }
    ],
    "default": "claude",
    "toolResultChars": 6000,
    "fetchAllow": ["nas.lan"],
    "elasticIndex": "mqtt-*"
  }
}
```

| Field | Meaning |
| --- | --- |
| `providers[]` | one entry per provider: `provider` is `anthropic`, `openai` (any OpenAI-compatible endpoint: OpenAI, Groq, Gemini, LM Studio) or `ollama`; `baseUrl` for the compatible ones; `model` the default model of the entry; `apiKey` where the provider needs one. `profile` (optional) overrides the prompt profile below. `id` is what the chat remembers; `label` what it shows. |
| `default` | the entry used when the chat has not chosen one |
| `toolResultChars` | a tool result longer than this is cut with a note (default 6000); lists page with `offset`/`limit` |
| `fetchAllow` | hosts the `she_fetch` tool may reach although they are private or local; everything on 10/8, 172.16/12, 192.168/16, localhost and `.lan`/`.local`/`.home` names is refused otherwise |
| `elasticIndex` | the index pattern of the raw MQTT messages for `get_topic_messages` (default `mqtt-*`) when `elastic` is configured |
| `publishAllow` | MQTT filters (`+`/`#`) of further topics the chat may publish to, beyond the command topics |
| `promptBudgetChars` | (optional, on an entry) the prompt size the compact profile keeps to; default 24000 characters |

The old single-entry shape `{ "provider": …, "model": …, "apiKey": … }` keeps working and is read as one entry named
after the provider.

The chat has a dropdown for the provider (when more than one is configured) and one for the model; for Anthropic the
models come from the API, for Ollama and OpenAI-compatible endpoints from their model lists. A choice made in the
chat is kept in the browser and dropped when the configured default changes. The journal shows `ai chat: <entry>/<provider> <model>`
and the token usage per request.

## Tools

The model reads the daemon through tools. Two tools change something, both behind a click — unless you take the
click away with **Approve** in the chat bar (see [below](#approve-what-goes-through-without-a-click)):

- **Script drafts** — `propose_script` writes a draft to `<data-dir>/ai/drafts/`; the chat shows the diff with
  **Apply** (writes the file; the hot reload and the configured commit mode apply as for any save) and **Discard**.
  Nothing reaches the scripts directory without the click while **Approve** is on *ask*.
- **Publishing** — `publish_mqtt` is offered only with the **Publish** checkbox in the chat bar on (off by default,
  remembered like the other two). Every publish shows a card with the topic and the payload and waits for
  **Allow**, **Always allow** (sets **Approve** to *scripts + publish*: no more questions until the page is
  reloaded) or **Deny** (two minutes, then it counts as denied). Only command topics are accepted
  (`<name>/set/…`, `var/set/…`, `zigbee2mqtt/<device>/set`, plus the patterns in `ai.publishAllow`); a status topic
  is refused; the journal logs every publish.
- **Analyses** — `run_analysis` runs a short JavaScript the model writes in a worker sandbox with a read-only
  `data` object (the state store, Influx history, Elastic messages, the log files, script sources) and no
  `require`, network, `she` object or publishing; ten seconds and the usual result cap. The chat shows the code and
  the result, so you see what was computed.

| Tool | Reads |
| --- | --- |
| `search_mqtt_topics` | topics by MQTT filter (`hm/status/+/LEVEL`) or substring, with value and change-age filters |
| `get_mqtt_topic` | one topic's value, last message and last change |
| `get_topic_history` | the values of one or several topics (a list or an MQTT filter) over time from InfluxDB (she's own `influx` integration; influx4mqtt's measurements and she's schema) |
| `get_timeline` | the changes of several topics merged in time order (Influx) |
| `get_topic_messages` | the raw messages of a topic from Elasticsearch (`elastic` integration) |
| `list_scripts`, `read_script` | the loaded scripts with subscriptions, publishes and schedules; a script's content |
| `who_publishes`, `describe_device`, `describe_room` | which script or adapter writes a topic; everything under one device (or several names), with its discovery entities; the whole room: devices, variables, scripts, discovery |
| `get_script_logs` | the log files on disk with a time window, a level and a script filter |
| `list_timers`, `get_health`, `list_services` | pending timers and schedules, the daemon's health, the adapter instances |
| `list_matter_devices`, `get_matter_device`, `get_matter_attribute` | paired Matter devices with their state; one device in full (endpoints, clusters, attributes, the CSA ledger's vendor/product); one attribute |
| `list_matter_bindings`, `list_matter_groups`, `get_matter_fabrics` | the bindings (a switch driving a device without she) and which endpoints can bind; she's groups with members and state; which controllers a device belongs to |
| `get_thread_networks`, `get_thread_mesh`, `get_matter_health` | the Thread networks and border routers on the LAN; the mesh with roles, neighbours and link quality (`refresh: true` re-reads the tables); batteries, offline periods, Thread alerts and firmware updates |
| `list_shedb_docs`, `get_shedb_doc` | sheDB ids and documents, paged, a dotted path into a document |
| `she_fetch` | a public web page as text |
| `remember`, `forget` | the facts about the installation the user confirmed (the 🧠 panel in the chat; stored in the data directory) |
| `propose_script` | a script draft with a diff and an Apply button |
| `run_analysis` | a short JavaScript the model writes, run in a sandbox over read-only data (state store, Influx, Elastic, log files, scripts); the chat shows the code and the result |
| `publish_mqtt` | a command topic, behind the Publish switch |

### Approve: what goes through without a click

The select next to the checkboxes in the chat bar decides how much the assistant may do on its own:

| Approve | Script changes | Publishes | Kept |
| --- | --- | --- | --- |
| *ask* (default) | wait for **Apply** / **Accept** | wait for **Allow** | — |
| *scripts* | applied at once | wait for **Allow** | in the browser, across reloads |
| *scripts + publish* | applied at once | published without asking | until the page is reloaded, then *scripts* |

- With *scripts*, a draft is written the moment it arrives; its card still shows the diff and says *applied
  automatically*. A code block the assistant proposes for the open script, and the editor's diff view, are accepted
  without the click as well. The hot reload and the commit mode apply as for any save — with
  `gitCommitMode: "auto"` every change is a commit you can revert.
- Only what arrives while you watch is applied: a draft that was still open when you switched, or one in a
  conversation you load later, keeps its **Apply** button.
- *scripts + publish* is available only while **Publish** is on, and falls back to *scripts* when you switch it off.
  The topic rules above still hold, and the journal logs every publish.
- The shortcuts set the same select: **always** on a code block and *Always accept script changes* in the diff view
  choose *scripts*, **Always allow** on a publish card chooses *scripts + publish*.
- The daemon does not approve anything by itself: the setting lives in the browser tab that runs the chat.

## Commit messages

The same provider can write the git commit messages of the Scripts editor: the *Generate with AI* button in the
commit dialogs, and — with `gitCommitMode: "auto"` and `gitCommitAi: true` — the message of every automatic commit.
The model gets the staged diff only (truncated to about 12 000 characters, nothing of the house or the state store), is
asked for one imperative summary line and a few lines of detail, and its answer is capped. Best effort: when no
provider is configured, the model fails or does not answer in time (eight seconds for an automatic commit, twenty for
the button), the default message is used — the changed files and the date and time — so a save never waits for the
model. The button is disabled with a hint until a provider is configured. By default the assistant's default provider
and its model write the messages; `gitCommitAiProvider` picks another provider entry and `gitCommitAiModel` another
model (a small, fast model is enough) — both on the Config page under *Git*. A model chosen in the chat window does not
change them. See [getting-started.md](getting-started.md#commits-of-script-changes)
for the keys.

## Prompt profiles

The system prompt is assembled from sections: the role, the mqtt-smarthome conventions, the API reference, the tool
guidance, the output formats, then the derived "this installation" section (daemon name, variable prefix, the
largest topic prefixes, the adapter instances) and the current script, view or document and attachments. The static
sections are sent to Anthropic as a cached block.

Two profiles present the same facts differently:

- **capable** — Anthropic, OpenAI and other hosted models: short guidance, the full API reference, all tools.
- **compact** — Ollama, LM Studio and other local or small models: the compact API reference, numbered steps, a
  worked example of the output format, a prompt budget (optional sections are left out when it is exceeded, and the
  model is told what was left out), and the tools only when the model reports tool support (Ollama's `/api/show`).
  A thinking model's `<think>…</think>` text is removed from its answers.

The profile is chosen by provider (`ollama` and local base URLs → compact) and can be set per entry with `profile`.
