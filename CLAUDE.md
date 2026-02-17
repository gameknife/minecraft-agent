# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Minecraft Bedrock Edition x LLM building assistant. Players type `!ai <description>` in chat, the server calls Gemini API to generate a block blueprint, then sends it to the behavior pack which places blocks tick-by-tick.

Architecture: `Node.js WS Server` ← `/wsserver` → `Minecraft Client` → `Behavior Pack Script API`

## Build & Run Commands

```bash
# Install server dependencies
cd server && npm install

# Start server (one-shot)
cd server && npx tsx src/index.ts

# Start server (watch mode, auto-restart on changes)
cd server && npm run dev

# Build behavior pack (compiles TS → JS, deploys to com.mojang)
regolith run

# In-game: connect then build
/wsserver ws://localhost:8000
!ai a stone hut
```

Prerequisites: Node.js >= 18, [Regolith](https://bedrock-oss.github.io/regolith/), Minecraft Bedrock (cheats enabled), Gemini API key.

## Architecture

### Data Flow

1. Player sends `!ai <prompt>` → server receives `PlayerMessage` event via WS
2. Server queries player position via `/querytarget`
3. Server gets or creates a per-player **session** (locks origin on first call)
4. Server sends `ai:scan` scriptevent → BP scans nearby blocks → BP sends results back via `world.sendMessage("__SCAN__:...")` → server intercepts and parses
5. Server formats terrain context + player relative position + build history into a **Chat API** message
6. Gemini returns either **compact program** (defs/steps with for-loops and function calls) or **legacy flat blocks array**
7. Server expands compact program into flat `Block[]`, validates block types against `minecraft-data` catalog
8. Server chunks blocks (default 5 per `/scriptevent`) and sends `ai:build` events with 150ms delays using **session origin** (not current player position)
9. Behavior pack receives chunks, uses `system.runJob` generator to place one block per tick

### Server (`server/src/`)

- **`index.ts`** — Entry point. WS server setup, `PlayerMessage` listener, build orchestration with session lifecycle, terrain scanning, Chat API integration, `!ai new/status` commands, manual block edit pull (`ai:get_edits` scriptevent), NPC chat handling (`__CHAT__:` message interception + `handleChatMessage()`), NPC auto-summon on first connection, round logging (success logs to `server/logs/`, failures to `server/logs/failed/`). Loads block catalog from `minecraft-data` using BP manifest's `min_engine_version`.
- **`ws-handler.ts`** — `MinecraftHandler` class wrapping the Minecraft WS protocol. Handles command request/response correlation via UUIDs, event subscriptions, `/querytarget` parsing, `/scriptevent` chunking, `/tellraw` messaging, terrain scan command/collection (`ai:scan` + `__SCAN__` message interception). Also provides `sendChatResponse()` and `summonNPC()` methods.
- **`gemini.ts`** — Gemini API integration. Supports both stateless `generateBlueprint()` and multi-turn `createChatSession()` + `sendChatMessage()`. Builds system prompt with compact DSL spec + block palette + terrain context. Contains `formatTerrainContext()` for scan data formatting. Full expression parser/evaluator for compact program format. Returns unified `GeminiResult` type discriminated by `type: "chat" | "build"`.
- **`session.ts`** — `SessionManager` class. Per-player sessions with locked origin, Chat object, build history, chat message history, and auto-expiry.

### Compact Blueprint DSL (in `gemini.ts`)

Gemini can return a mini-program instead of flat block lists. The server-side interpreter supports:
- `place`/`block` ops with coordinate expressions
- `for` loops with variable binding, from/to/step
- `call` to named functions defined in `defs` with parameter passing
- Arithmetic expressions: `"y+1"`, `"(x+z)/2"`, variable references
- Safety limits: MAX_BLOCKS=10000, MAX_EXECUTED_STEPS=50000, MAX_CALL_DEPTH=24, MAX_CALLS=500

### Behavior Pack (`packs/BP/scripts/main.ts`)

Single file. Uses `@minecraft/server` and `@minecraft/server-ui`. Handles scriptevents:
- `ai:build` — parses JSON payload, uses `system.runJob` generator to place blocks one-per-tick via `block.setType()`. Tracks multi-chunk build progress.
- `ai:scan` — scans a 3D region around a center point, filters air blocks, sends non-air block data back to server via `world.sendMessage("§8__SCAN__:...")` in chunks of 50 blocks.
- `ai:chat_response` — receives AI reply from server, stores in chat history, auto-reopens NPC form.
- `ai:summon_npc` — spawns an NPC entity with a given name at specified coordinates.

Also provides NPC interaction UI:
- Right-clicking the AI NPC opens an `ActionFormData` showing chat history with buttons (Send Message, New Session, Status).
- "Send Message" opens a `ModalFormData` text input; submitted messages are sent to the server via `tell @s §8__CHAT__:JSON`.
- Native NPC dialog is cancelled via `beforeEvents.playerInteractWithEntity`.

### Regolith Build (`data/ts_compiler/`)

Local esbuild filter (`runWith: "nodejs"`). Compiles `main.ts` → `main.js` (ESM, es2020 target), externalizes `@minecraft/server` and `@minecraft/server-ui`, strips `.ts` files from output.

## Critical Pitfalls

### Minecraft WS Protocol
- `/querytarget` `statusMessage` has a **localized prefix** (Chinese: `"目标数据：[...]"`). Must extract JSON from first `[` character, not parse the whole string.
- `/querytarget` position is nested: `targets[0].position.x`, NOT `targets[0].x`.
- `PlayerMessage` events must filter `type === "chat"` — `tellraw` echoes also fire this event, causing infinite loops.

### scriptevent Chunking
- `/scriptevent` has a message length limit. Large JSON payloads get truncated, causing `JSON.parse` crashes in the behavior pack.
- Keep `CHUNK_SIZE` small (default 5, ~400-500 chars per chunk). 150ms delay between chunks.

### Behavior Pack Script API
- Use `block.setType(blockType)` — NOT `BlockPermutation.resolve()` + `setPermutation()`. More robust for invalid block names.
- Generator errors inside `system.runJob` crash the script engine. Always try/catch inside generators.
- `system.afterEvents.scriptEventReceive.subscribe` — don't pass options object, filter `event.id` manually in callback.

### Regolith
- Use local `ts_compiler` filter, NOT remote `system_template_esbuild`.
- TS source lives at `packs/BP/scripts/main.ts`; compiled output replaces it in the build.

## Configuration (.env)

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | *(required)* | Gemini API key |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Gemini model name |
| `PORT` | `8000` | WS server port |
| `CHUNK_SIZE` | `5` | Blocks per scriptevent chunk |
| `PROMPT_BLOCK_TYPE_LIMIT` | `0` | Max block types in system prompt; `0` = no limit |
| `MINECRAFT_DATA_VERSION` | *(auto from manifest)* | Override minecraft-data version lookup |
| `SCAN_RADIUS` | `8` | Horizontal scan radius (blocks) |
| `SCAN_Y_BELOW` | `3` | Scan depth below player feet |
| `SCAN_Y_ABOVE` | `10` | Scan height above player feet |
| `SCAN_MAX_BLOCKS` | `500` | Max non-air blocks in terrain context |
| `SCAN_TIMEOUT` | `15000` | Scan timeout (ms) |
| `SESSION_TIMEOUT` | `1800000` | Session inactivity timeout (30min, ms) |
| `ORIGIN_DRIFT_THRESHOLD` | `100` | Distance warning threshold (blocks) |
| `NPC_NAME` | `AI助手` | Display name for the AI NPC entity |
| `NPC_AUTO_SUMMON` | `true` | Auto-summon NPC near player on connect |
| `CHAT_MAX_RESPONSE_LENGTH` | `1500` | Max chars for AI reply sent to BP UI |

## In-Game Commands

- `!ai new` — Start a new session at current position. Required before first build via chat. Clears any previous session.
- `!ai <prompt>` — Build something. Requires an active session (use `!ai new` first). Pulls manual block edits since last request.
- `!ai status` — Show session info (origin, build count, idle time).
- **Right-click AI NPC** — Opens a form UI for chatting and building. Sessions are auto-created. Supports both free-form Q&A and build requests.

## Session & Coordinate System

- **Session origin** is locked to the player's position on the first `!ai` call.
- All LLM coordinates are relative to the session origin, so follow-up builds ("add a door", "extend the wall") reference the same coordinate space.
- `sendBuildCommand` uses session origin, not the player's current position.
- If the player moves > `ORIGIN_DRIFT_THRESHOLD` blocks, they get a warning to `!ai new`.
- Sessions auto-expire after `SESSION_TIMEOUT` (default 30 min) of inactivity.
- All sessions are cleared on WS disconnect.

## Terrain Scanning

- BP scans a region around the player: `(2*SCAN_RADIUS+1) × (SCAN_Y_BELOW+SCAN_Y_ABOVE+1) × (2*SCAN_RADIUS+1)` blocks.
- Non-air blocks are sent back via `world.sendMessage()` (visible in chat as dark gray `§8` text).
- Server intercepts `__SCAN__:` prefixed messages in `handleMessage()` before they reach external listeners.
- Terrain context is included in the system prompt (new session) or prepended to user message (existing session).

## Conventions

- Server code is TypeScript, run directly via `tsx` (no separate compile step).
- Behavior pack code is TypeScript, compiled by Regolith's local esbuild filter.
- Configurable values go in `.env`, not hardcoded.
- Each build round is logged as a Markdown file in `server/logs/` for manual review.
- Communication in Chinese, code in English.
