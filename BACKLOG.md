# Backlog

Items that are intentionally deferred. Pick up when the time is right.

## Git Integration

*(nothing yet)*

## AI Chat

- **context window usage indicator** — show a circle near the chat input indicating context window usage %. Ollama exposes context length per model via `POST /api/show` → `model_info` (field name is architecture-specific, e.g. `llama.context_length`); non-Ollama providers don't have an equivalent. `Chat.svelte` already tracks `requestBytes` (prompt + input size in bytes). The indicator needs the model's max context size as the denominator.

- **per-script resource limits** — detect callbacks that take too long, log a warning
