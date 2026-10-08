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

The model reads the daemon through tools. Two tools change something, both behind a click:

- **Script drafts** — `propose_script` writes a draft to `<data-dir>/ai/drafts/`; the chat shows the diff with
  **Apply** (writes the file; the hot reload and the git auto-commit apply as for any save) and **Discard**. Nothing
  reaches the scripts directory without the click.
- **Publishing** — `publish_mqtt` is offered only when the **Publish** switch in the chat bar is not *off*: with
  *confirm each* every publish shows topic and payload and waits for **Publish** or **Skip** (two minutes, then it
  counts as skipped); with *allow all* it goes through at once for the session. Only command topics are accepted
  (`<name>/set/…`, `var/set/…`, `zigbee2mqtt/<device>/set`, plus the patterns in `ai.publishAllow`); a status topic
  is refused; the journal logs every publish.

| Tool | Reads |
| --- | --- |
| `search_mqtt_topics` | topics by MQTT filter (`hm/status/+/LEVEL`) or substring, with value and change-age filters |
| `get_mqtt_topic` | one topic's value, last message and last change |
| `get_topic_history` | the values of one or several topics (a list or an MQTT filter) over time from InfluxDB (she's own `influx` integration; influx4mqtt's measurements and she's schema) |
| `get_timeline` | the changes of several topics merged in time order (Influx) |
| `get_topic_messages` | the raw messages of a topic from Elasticsearch (`elastic` integration) |
| `list_scripts`, `read_script` | the loaded scripts with subscriptions, publishes and schedules; a script's content |
| `who_publishes`, `describe_device` | which script or adapter writes a topic; everything under one device, with its discovery entities |
| `get_script_logs` | the log files on disk with a time window, a level and a script filter |
| `list_timers`, `get_health`, `list_services` | pending timers and schedules, the daemon's health, the adapter instances |
| `list_matter_devices`, `get_matter_attribute` | paired Matter devices with their state; one attribute |
| `list_shedb_docs`, `get_shedb_doc` | sheDB ids and documents, paged, a dotted path into a document |
| `she_fetch` | a public web page as text |
| `remember`, `forget` | the facts about the installation the user confirmed (the 🧠 panel in the chat; stored in the data directory) |
| `propose_script` | a script draft with a diff and an Apply button |
| `publish_mqtt` | a command topic, behind the Publish switch |

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
