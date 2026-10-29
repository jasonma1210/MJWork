# MJ Nexus

> A local-first AI agent workbench for the desktop. Your files, credentials and shell execution stay on
> your machine — only inference leaves it, going to the model provider you configure.

**English** · [简体中文](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [Releases](https://github.com/jasonma1210/MJWork/releases)

---

## What this repo contains

| Path | Role |
|---|---|
| `desktop/` | The Electron app. `main/` = main process (windows, IPC, tools, sandbox, approvals), `agent-core/` = headless agent engine (tool loop, model adapters, context budgeting), `renderer/` = React UI |
| `desktop/shared/`, `shared-ipc/` | Single source of truth for the IPC contract (channel names + payload guards) |
| `ecosystem/` | Product assets shipped with the app: 136 skills, 78 MCP connectors, 51 digital-employee role templates — role templates = 265 ecosystem assets in total. A separate 214-entry WorkBuddy import list is shipped as reference only and is **not counted** in that total, sharing zero id overlap with the curated connectors. A digital employee is applied through the `rolePreset` chain (catalog preset → session → attached to every agent run → clamped by the host), which is **not** multi-employee orchestration: a preset can only tighten permissions, never widen them. |
| `server/` | Optional self-hosted backend (Express + PostgreSQL): accounts, device sync, cloud delegation |
| `chrome-extension/` | Browser takeover bridge (CDP), authorized per-connection from inside the app |
| `miniprogram/` | WeChat mini program (companion surface) |
| `docs/` | The documents the CI gates read and that release work needs: technical design doc, packaging & install guide, release rollback and signing/update runbooks |

## What it does

- **Conversational agent with real tools** — multi-round tool calling over read/write files, shell, patch, web fetch/search and git, with streaming output and cancellable runs.
- **Guardrails by default** — four approval tiers with a hard floor on dangerous commands, plus a per-platform sandbox (macOS `sandbox-exec`, Linux bubblewrap, Windows restricted) that fails closed instead of silently degrading.
- **Teams of digital employees** — dispatch one goal, get a task group executed by role agents, with per-project sliding quota and an auditable token ledger.
- **Usage workbench** — token spend by model, by session and by task, plus a ledger view of every consumption record.
- **Local knowledge base** — import PDFs/DOCX (OCR for scans), chunk and index locally, cite in answers.
- **Artifacts** — generate `.docx` / `.xlsx` / `.pptx` straight from a conversation.
- **Scheduled tasks** — cron-style runs with archived outputs, no window needed.
- **MCP + skills** — connect MCP servers or use the 136 bundled skills; both are workspace-scoped.
- **Local-first storage** — conversations, credentials and settings live in a local SQLite database under the OS app-data directory.

## Tech stack

| Layer | Choice |
|---|---|
| Desktop shell | Electron 45 (main process CommonJS, engine ESM) |
| UI | React 18 + Vite 5 + TypeScript 5 + Tailwind CSS 3 |
| Agent engine | `agent-core` — own tool loop, model adapters, token/context accounting |
| Storage | SQLite (`sql.js`), Yjs for collaborative buffers |
| Optional backend | Express 4 + PostgreSQL + JWT |
| Quality gates | `node --test` (310 suites), ESLint warning ratchet, `tsc --noEmit`, doc-vs-source fact check |

## Run it (development)

Requires **Node.js 22+** and npm.

```bash
cd desktop
npm install
cd renderer && npm install && cd ..

npm run dev          # Vite dev server on :5173 + Electron window
```

On first launch open **Settings → Models** and add a provider (API base URL + key). Everything else
works offline; the backend in `server/` is optional and only needed for accounts / multi-device sync.

## Build installers

```bash
cd desktop
npm run dist:mac     # .dmg + .zip  (Apple Silicon; bundles a self-contained OCR binary)
npm run dist:win     # NSIS .exe    (x64 — build on Windows, or let CI do it)
npm run dist:linux   # .AppImage    (x64 — build on Linux, or let CI do it)
```

Artifacts land in `desktop/release/`. `dist:mac` expects `tesseract` installed locally
(`brew install tesseract tesseract-lang`) because it bundles the OCR engine; Windows and Linux
artifacts are produced by CI, which is the supported path for release builds.

## Verify

```bash
cd desktop
npm test                          # full suite
npm run lint                      # 0 errors + warning ratchet
npm run typecheck                 # renderer tsc --noEmit
node scripts/doc-fact-check.mjs    # every number in the design doc must match source
```

Tagging `v*` runs the three-platform matrix in `.github/workflows/ci.yml` and publishes the release.

## Known limitations

- **Windows sandbox** — the OS-level backend ships with the app but needs a one-time administrator setup.
  Until that setup has been run, OS-level isolation is not yet wired, and command execution falls back to
  the command-level blocklist.
- **Code signing** — the `.app` inside is signed with an Apple Development identity but not notarized,
  and the `.dmg` container itself carries no signature; on other people's Macs Gatekeeper may still block
  the first launch (right-click → Open). Windows and Linux artifacts come from CI and are unsigned while
  no signing secrets are configured, so SmartScreen will warn too.

## MCP tools profile

MCP servers may advertise an `outputSchema`. That schema is **consumed for validation only**: a result
that fails validation is returned to the model with the offending path, and the structured payload is **not** fed into the context
— only its text rendering is. Programmatic consumption (piping structured
results straight into downstream tools or tables) is still not implemented, so structured data never
competes for context budget.

## License

[MIT](./LICENSE)
