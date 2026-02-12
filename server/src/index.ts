import "dotenv/config";
import { WebSocketServer } from "ws";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MinecraftHandler } from "./ws-handler.js";
import { initGemini, generateBlueprint } from "./gemini.js";

// ── Config ─────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 8000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL;
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE) || 5;
const LOG_DIR = join(import.meta.dirname, "..", "logs");

if (!GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY not set in .env");
  process.exit(1);
}

initGemini(GEMINI_API_KEY, GEMINI_MODEL);

// Ensure logs directory exists
await mkdir(LOG_DIR, { recursive: true });

// ── WebSocket Server ───────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });
console.log(`[Server] Listening on ws://localhost:${PORT}`);
console.log(`[Server] In Minecraft, run:  /wsserver ws://localhost:${PORT}`);

wss.on("connection", (ws) => {
  console.log("[Server] Minecraft client connected");

  const mc = new MinecraftHandler(ws);

  // Subscribe to chat messages
  mc.subscribe("PlayerMessage");

  mc.on("PlayerMessage", (body: Record<string, unknown>) => {
    // Filter: only handle real chat messages (not tellraw echoes)
    const type = body.type as string | undefined;
    if (type !== "chat") return;

    const message = (body.message as string) ?? "";
    const sender = (body.sender as string) ?? "";

    if (!message.startsWith("!ai ")) return;

    const prompt = message.slice(4).trim();
    if (!prompt) return;

    console.log(`[Chat] ${sender}: !ai ${prompt}`);

    // Process asynchronously
    handleBuildRequest(mc, sender, prompt).catch((err) => {
      console.error("[Error]", err);
      mc.tellraw(sender, `§c[AI] Error: ${(err as Error).message}`);
    });
  });

  ws.on("close", () => {
    console.log("[Server] Minecraft client disconnected");
  });

  ws.on("error", (err) => {
    console.error("[WS Error]", err.message);
  });
});

// ── Build Request Handler ──────────────────────────────────────────────

async function handleBuildRequest(
  mc: MinecraftHandler,
  playerName: string,
  prompt: string,
): Promise<void> {
  mc.tellraw(playerName, `§e[AI] Thinking about: "${prompt}" ...`);

  // 1. Query player position
  const pos = await mc.queryPlayerPosition(playerName);
  console.log(`[Pos] ${playerName} at (${pos.x}, ${pos.y}, ${pos.z})`);

  // 2. Generate blueprint via Gemini
  mc.tellraw(playerName, "§e[AI] Generating blueprint...");
  const result = await generateBlueprint(prompt);
  const { blueprint, rawResponse, systemPrompt } = result;
  console.log(`[Gemini] Generated ${blueprint.blocks.length} blocks`);

  // 3. Write round log
  await writeRoundLog({ playerName, prompt, pos, systemPrompt, rawResponse, blueprint });

  // 4. Send build command(s) to behavior pack via scriptevent
  mc.tellraw(
    playerName,
    `§a[AI] Building ${blueprint.blocks.length} blocks...`,
  );
  await mc.sendBuildCommand(pos, blueprint, CHUNK_SIZE);

  console.log("[Build] scriptevent(s) sent");
}

// ── Round Logging ──────────────────────────────────────────────────────

interface RoundLog {
  playerName: string;
  prompt: string;
  pos: { x: number; y: number; z: number };
  systemPrompt: string;
  rawResponse: string;
  blueprint: { blocks: Array<{ x: number; y: number; z: number; blockType: string }> };
}

async function writeRoundLog(log: RoundLog): Promise<void> {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const filename = `${ts}_${log.playerName}.md`;
  const filepath = join(LOG_DIR, filename);

  const md = `# Build Round — ${now.toLocaleString()}

## Player
- **Name:** ${log.playerName}
- **Position:** x=${log.pos.x}, y=${log.pos.y}, z=${log.pos.z}

## User Prompt
\`\`\`
${log.prompt}
\`\`\`

## System Prompt
\`\`\`
${log.systemPrompt}
\`\`\`

## Gemini Raw Response
\`\`\`json
${log.rawResponse}
\`\`\`

## Parsed Blueprint (${log.blueprint.blocks.length} blocks)
| # | x | y | z | blockType |
|---|---|---|---|-----------|
${log.blueprint.blocks.map((b, i) => `| ${i + 1} | ${b.x} | ${b.y} | ${b.z} | ${b.blockType} |`).join("\n")}
`;

  await writeFile(filepath, md, "utf-8");
  console.log(`[Log] Saved ${filepath}`);
}
