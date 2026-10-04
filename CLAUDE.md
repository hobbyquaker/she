# CLAUDE.md

Guidance for AI agents working in this repository.

## Roadmap management

The roadmap — open items, finished items, notes, the state for a cold start — is kept outside this
repository, in `../she-agent/roadmap-items/she/` (the maintainer's agents repository, checked out
next to this one). Read its `HANDOFF.md` and `overview.md` before working on an item, and follow the
roadmap rules of `../she-agent/AGENTS.md`.

Item IDs stay what they were: a category letter plus a number (`S4`, `U2`, `B8`; **B** Bugs ·
**S** Script Engine · **U** Web UI & Editor · **M** MQTT, Matter & Broker · **I** Integrations ·
**A** Architecture, Operations & Security · **T** Testing · **D** Documentation). Source comments
and commit messages may cite them ("roadmap S4"); they never cite paths of the agents repository.

## Working notes

- Also follow [.github/copilot-instructions.md](.github/copilot-instructions.md) — in particular the **versioning policy**: keep the root `package.json` and `web/package.json` versions in sync (bump both, plus the lockfiles), and create a `v<version>` git tag after every bump.
- Shell commands: use WSL (`wsl -e bash -c '…'`), not PowerShell — PowerShell causes problems with binary npm dependencies and CRLF line endings.
- The daemon serves the prebuilt frontend from `dist/web` (untracked). After frontend changes, rebuild with `cd web && npm run build` so a locally running daemon picks them up.
- Run `npm test` (unit tests) and `npm run lint` before committing; for frontend changes also `cd web && npx svelte-check --threshold error` (compare against the pre-existing error count — do not introduce new errors).
