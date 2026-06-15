# Backlog

Items that are intentionally deferred. Pick up when the time is right.

## Git Integration

- **per-file git history panel** — right-click a file → "Show git history" (only when `gitInfo !== null`); shows a commit list in the left aside (below the file tree, fixed height ~220 px); clicking a commit opens a read-only diff in the existing diff overlay (historic content vs. current editor content). Requires two new backend routes: `GET /she/git/log?path=&limit=` and `GET /she/git/show?hash=&path=`. Full spec in VS Code prompt `she-git-history-view`.

## AI Chat

- **context window usage indicator** — show a circle near the chat input indicating context window usage %. Ollama exposes context length per model via `POST /api/show` → `model_info` (field name is architecture-specific, e.g. `llama.context_length`); non-Ollama providers don't have an equivalent. `Chat.svelte` already tracks `requestBytes` (prompt + input size in bytes). The indicator needs the model's max context size as the denominator.

## Script Engine

- **per-script resource limits** — detect callbacks that take too long, log a warning

## Scripts Editor

- **Find & Replace entry point** — add "Find" and "Find & Replace" to Monaco's right-click context menu via `editor.addAction()` so mouse-driven users can discover the built-in widget. No custom widget needed; Monaco handles Ctrl+F / Ctrl+H natively. Full spec in VS Code prompt `she-editor-improvements`.

- **Format with Prettier** — `POST /she/scripts/format` backend route that runs Prettier server-side (already a root devDependency, not bundled to browser); frontend adds a toolbar button that calls the endpoint and replaces the editor content with the formatted result. Full spec in VS Code prompt `she-editor-improvements`.
