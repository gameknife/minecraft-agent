# Repository Guidelines

## Project Structure & Module Organization
Core modules:
- `server/`: Node.js + TypeScript WebSocket service. Entry and flow control are in `server/src/index.ts`; protocol and AI integration live in `ws-handler.ts` and `gemini.ts`.
- `packs/BP/`: Behavior pack scripts and manifest (`packs/BP/scripts/main.ts`, `packs/BP/manifest.json`).
- `packs/RP/`: Resource pack placeholder.

Tooling and generated output:
- `config.json`: Regolith profile, filter, export target.
- `data/ts_compiler/`: local Regolith TS compiler filter.
- `server/logs/`: runtime build-round logs (do not treat as source files).

## Build, Test, and Development Commands
From repo root:
- `cd server && npm install`: install server dependencies.
- `regolith install-all`: install Regolith filters.
- `regolith run`: compile/export behavior pack to development target.
- `cd server && npm run dev`: run server with hot reload (`tsx watch`).
- `cd server && npm run start`: run server once.
- `cd server && npx tsc --noEmit`: strict type-check.

Quick loop: run `regolith run` -> start server -> in Minecraft use `/wsserver ws://localhost:8000` -> send `!ai <prompt>`.

## Coding Style & Naming Conventions
- Use TypeScript ES modules and keep `strict`-safe code.
- Use 2-space indentation, double quotes, and semicolons.
- Naming: `camelCase` (variables/functions), `PascalCase` (types/interfaces/classes), `UPPER_SNAKE_CASE` (env constants).
- Keep filenames descriptive and consistent with existing style (example: `ws-handler.ts`).

## Testing Guidelines
No automated test suite is committed yet. Minimum gate before merge:
- `cd server && npx tsc --noEmit` must pass.
- Manual smoke test: connect to local server, run one `!ai` build, confirm placement and no script errors.
- For protocol/chunking changes, include a short `server/logs/` excerpt in PR notes.

## Commit & Pull Request Guidelines
Git history is short and imperative (`update readme`, `more modify`). Keep messages short but specific.
- Good: `server: parse localized querytarget payload`
- Bad: `fix stuff`

PR checklist:
- What changed and why.
- Validation steps (commands + in-game verification).
- Env/config impact (for example new `server/.env` keys).
- Linked issue/task if available.

## Security & Configuration Tips
- Never commit secrets. Store `GEMINI_API_KEY` only in `server/.env`.
- Review `server/logs/` before sharing; prompts and responses may include sensitive content.
