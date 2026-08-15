# CLAUDE.md

Guidance for AI agents working in this repository.

## Roadmap management

Planned work lives in [ROADMAP.md](ROADMAP.md); completed and closed items live in [doc/roadmap-archive/](doc/roadmap-archive/README.md) — one file per item, named after its ID. The system mirrors the feezal project's roadmap conventions.

**Item IDs.** Every item has a stable ID: category letter + number (`S4`, `U2`, …). Categories: **B** Bugs · **S** Script Engine · **U** Web UI & Editor · **M** MQTT, Matter & Broker · **I** Integrations · **A** Architecture, Operations & Security · **T** Testing · **D** Documentation. **Never reuse an ID** — if `doc/roadmap-archive/<ID>.md` exists or the ID appears in ROADMAP.md, that number is taken; pick the next free number in the category, even if it leaves gaps.

**Adding an item.** Add a `### <ID> — <Title>` section under the matching `##` category section (sorted by number) and a link line in the grouped Table of Contents. Keep headings plain (no emoji — they break anchor links); status markers (🔨 partially done / in progress · ⚠️ needs discussion · 💡 idea · 🚧 blocked/deferred) go after the TOC link and in the body, not in the heading.

**Archiving an item (when it is done or rejected):**

1. Move the full section content to `doc/roadmap-archive/<ID>.md`, heading promoted to `# <ID> — <Title> ✅ implemented` (or `✅ fixed` / `✅ done` / `❌ rejected`).
2. Second line, italic: `*Archived roadmap item — <Category>. Open items: [../../ROADMAP.md](../../ROADMAP.md) · Index: [README.md](README.md)*`
3. Start the body with a short "what actually shipped" summary (files touched, decisions made, deviations from the plan); keep the original item text below it when it adds context.
4. Add an index line in `doc/roadmap-archive/README.md` under the matching category section, sorted by number.
5. Remove the section and its TOC line from ROADMAP.md entirely. **Never leave a ✅-done section in ROADMAP.md.**

**Partially done items** stay in ROADMAP.md, marked 🔨 in the TOC and with ✅ marks on the finished sub-parts inline — archive only when the whole item is closed.

**Empty categories** are dropped from ROADMAP.md's TOC and body (the intro line documents all category letters); re-add the section when the first item arrives.

## Working notes

- Shell commands: use WSL (`wsl -e bash -c '…'`), not PowerShell — PowerShell causes problems with binary npm dependencies and CRLF line endings.
- The daemon serves the prebuilt frontend from `dist/web` (untracked). After frontend changes, rebuild with `cd web && npm run build` so a locally running daemon picks them up.
- Run `npm test` (unit tests) and `npm run lint` before committing; for frontend changes also `cd web && npx svelte-check --threshold error` (compare against the pre-existing error count — do not introduce new errors).
