import "dotenv/config";
import { WebSocketServer } from "ws";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import minecraftData from "minecraft-data";
import { MinecraftHandler } from "./ws-handler.js";
import {
  BlueprintGenerationError,
  initGemini,
  setSupportedBlockCatalog,
  createChatSession,
  sendChatMessage,
} from "./gemini.js";
import { SessionManager } from "./session.js";

// -- Config ------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 8000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL;
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE) || 5;
const SESSION_TIMEOUT = Number(process.env.SESSION_TIMEOUT) || 30 * 60 * 1000;
const ORIGIN_DRIFT_THRESHOLD = Number(process.env.ORIGIN_DRIFT_THRESHOLD) || 100;
const LOG_DIR = join(import.meta.dirname, "..", "logs");
const FAILED_LOG_DIR = join(LOG_DIR, "failed");
const BP_MANIFEST_PATH = join(import.meta.dirname, "..", "..", "packs", "BP", "manifest.json");

if (!GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY not set in .env");
  process.exit(1);
}

initGemini(GEMINI_API_KEY, GEMINI_MODEL);

// Ensure log directories exist
await mkdir(LOG_DIR, { recursive: true });
await mkdir(FAILED_LOG_DIR, { recursive: true });

// Load block catalog from minecraft-data
await loadBlockCatalogFromMinecraftData();

const sessionManager = new SessionManager(SESSION_TIMEOUT);

// Periodically clean expired sessions
setInterval(() => sessionManager.cleanExpired(), 60_000);

// -- WebSocket Server --------------------------------------------------------

const wss = new WebSocketServer({ port: PORT });
console.log(`[Server] Listening on ws://localhost:${PORT}`);
console.log(`[Server] In Minecraft, run:  /wsserver ws://localhost:${PORT}`);

wss.on("connection", (ws) => {
  console.log("[Server] Minecraft client connected");

  const mc = new MinecraftHandler(ws);

  mc.subscribe("PlayerMessage");

  mc.on("PlayerMessage", (body: Record<string, unknown>) => {
    const message = typeof body.message === "string" ? body.message : "";
    const sender = (body.sender as string) ?? "";

    // Intercept __EDITS__: batch responses from behavior pack (pull model)
    const editsMarker = "__EDITS__:";
    const editsIdx = message.indexOf(editsMarker);
    if (editsIdx !== -1) {
      try {
        const edits = JSON.parse(message.slice(editsIdx + editsMarker.length));
        mc.resolveManualEdits(edits);
      } catch {
        // Ignore malformed __EDITS__ messages
      }
      return;
    }

    // Filter: only handle real chat messages (not tellraw echoes)
    const type = body.type as string | undefined;
    if (type !== "chat") return;

    if (!message.startsWith("!ai ")) return;

    const prompt = message.slice(4).trim();
    if (!prompt) return;

    console.log(`[Chat] ${sender}: !ai ${prompt}`);

    // Handle special commands
    if (prompt === "new") {
      // Create a new session at current position
      handleNewSession(mc, sender).catch((err) => {
        console.error("[Error]", err);
        mc.tellraw(sender, `§c[AI] Error: ${(err as Error).message}`);
      });
      return;
    }

    if (prompt === "status") {
      const info = sessionManager.getSessionInfo(sender);
      if (info) {
        mc.tellraw(sender, `§e[AI] Session: ${info}`);
      } else {
        mc.tellraw(sender, "§e[AI] No active session. Use \"!ai new\" to start one.");
      }
      return;
    }

    // Require active session
    if (!sessionManager.getSession(sender)) {
      mc.tellraw(
        sender,
        "§e[AI] No active session. Use \"!ai new\" to start a session at your current position, then build!",
      );
      return;
    }

    // Process asynchronously
    handleBuildRequest(mc, sender, prompt).catch((err) => {
      console.error("[Error]", err);
      mc.tellraw(sender, `§c[AI] Error: ${(err as Error).message}`);
    });
  });

  ws.on("close", () => {
    console.log("[Server] Minecraft client disconnected");
    sessionManager.clearAll();
  });

  ws.on("error", (err) => {
    console.error("[WS Error]", err.message);
  });
});

// -- Block Catalog -----------------------------------------------------------

interface BPManifestDependency {
  module_name?: string;
  version?: string;
}

interface BPManifest {
  header?: {
    min_engine_version?: number[];
  };
  dependencies?: BPManifestDependency[];
}

interface RuntimeVersionInfo {
  scriptApiVersion: string | null;
  minEngineVersion: string | null;
}

async function loadBlockCatalogFromMinecraftData(): Promise<void> {
  const runtime = await readRuntimeVersionInfo();
  const requestedVersion = (
    process.env.MINECRAFT_DATA_VERSION?.trim() || runtime.minEngineVersion || ""
  );

  if (!requestedVersion) {
    console.warn("[Catalog] Could not detect min_engine_version and MINECRAFT_DATA_VERSION is not set; keeping fallback catalog");
    return;
  }

  const resolvedVersion = resolveBedrockDataVersion(requestedVersion);
  if (!resolvedVersion) {
    console.warn(`[Catalog] minecraft-data has no compatible Bedrock data for requested version ${requestedVersion}; keeping fallback catalog`);
    return;
  }

  try {
    const data = minecraftData(`bedrock_${resolvedVersion}`);
    const blocks = data?.blocksArray ?? [];
    const blockIds = blocks
      .map((b) => String(b?.name ?? "").trim())
      .filter((name) => name.length > 0)
      .map((name) => name.startsWith("minecraft:") ? name : `minecraft:${name}`);

    if (!blockIds.length) {
      console.warn(`[Catalog] minecraft-data returned no blocks for bedrock_${resolvedVersion}; keeping fallback catalog`);
      return;
    }

    setSupportedBlockCatalog(blockIds, {
      version: resolvedVersion,
      source: "minecraft-data",
    });

    console.log(
      `[Catalog] Loaded minecraft-data bedrock version=${resolvedVersion} blockTypes=${blockIds.length} (manifest min_engine_version=${runtime.minEngineVersion ?? "unknown"}, script_api=${runtime.scriptApiVersion ?? "unknown"})`,
    );
  } catch (err) {
    console.warn(
      `[Catalog] Failed to load minecraft-data for bedrock_${resolvedVersion}; keeping fallback catalog: ${(err as Error).message}`,
    );
  }
}

async function readRuntimeVersionInfo(): Promise<RuntimeVersionInfo> {
  try {
    const raw = await readFile(BP_MANIFEST_PATH, "utf-8");
    const manifest = JSON.parse(raw) as BPManifest;

    const dep = Array.isArray(manifest.dependencies)
      ? manifest.dependencies.find((d) => d.module_name === "@minecraft/server")
      : undefined;

    const scriptApiVersion = typeof dep?.version === "string" ? dep.version.trim() : "";
    const minEngineParts = manifest.header?.min_engine_version;
    const minEngineVersion = Array.isArray(minEngineParts) && minEngineParts.length >= 2
      ? minEngineParts.map((v) => Number(v) || 0).join(".")
      : "";

    return {
      scriptApiVersion: scriptApiVersion || null,
      minEngineVersion: minEngineVersion || null,
    };
  } catch (err) {
    console.warn(`[Catalog] Failed to read BP manifest: ${(err as Error).message}`);
    return { scriptApiVersion: null, minEngineVersion: null };
  }
}

function resolveBedrockDataVersion(requested: string): string | null {
  const supported = minecraftData.supportedVersions.bedrock;
  if (!supported.length) return null;

  if (supported.includes(requested)) {
    return requested;
  }

  const requestedPrefix = versionPrefix(requested);
  const candidates = supported.filter((v) => versionPrefix(v) === requestedPrefix);
  if (candidates.length) {
    return candidates.sort(compareVersionDesc)[0];
  }

  return null;
}

function versionPrefix(version: string): string {
  const parts = version.split(".").map((p) => Number.parseInt(p, 10)).filter((n) => Number.isFinite(n));
  if (parts.length >= 2) {
    return `${parts[0]}.${parts[1]}`;
  }
  return version;
}

function compareVersionDesc(a: string, b: string): number {
  const aa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const bb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(aa.length, bb.length);

  for (let i = 0; i < len; i += 1) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av !== bv) {
      return bv - av;
    }
  }

  return 0;
}

// -- Build Request Handler ---------------------------------------------------

async function handleNewSession(
  mc: MinecraftHandler,
  playerName: string,
): Promise<void> {
  const pos = await mc.queryPlayerPosition(playerName);
  sessionManager.resetSession(playerName);
  const { chat, systemPrompt } = createChatSession();
  sessionManager.createSession(playerName, pos, chat, systemPrompt);
  console.log(`[Session] New session for ${playerName}, origin=(${pos.x}, ${pos.y}, ${pos.z})`);
  mc.tellraw(
    playerName,
    `§a[AI] New session started at (${pos.x}, ${pos.y}, ${pos.z}). ` +
    `Place blocks manually, then use "!ai <description>" to build!`,
  );
}

async function handleBuildRequest(
  mc: MinecraftHandler,
  playerName: string,
  prompt: string,
): Promise<void> {
  mc.tellraw(playerName, `§e[AI] Thinking about: "${prompt}" ...`);

  // 1. Query player position
  const currentPos = await mc.queryPlayerPosition(playerName);
  console.log(`[Pos] ${playerName} at (${currentPos.x}, ${currentPos.y}, ${currentPos.z})`);

  // 2. Get session (must exist — checked before calling)
  const session = sessionManager.getSession(playerName)!;

  // Check drift
  const dx = currentPos.x - session.origin.x;
  const dz = currentPos.z - session.origin.z;
  const drift = Math.sqrt(dx * dx + dz * dz);
  if (drift > ORIGIN_DRIFT_THRESHOLD) {
    mc.tellraw(
      playerName,
      `§6[AI] Warning: You are ${Math.floor(drift)} blocks from session origin. ` +
      `Coordinates may be inaccurate. Use "!ai new" to start a new session at your current location.`,
    );
  }

  // 3. Pull manual block edits from BP (only edits since last request)
  const rawEdits = await mc.requestManualEdits(playerName);
  if (rawEdits.length > 0) {
    console.log(`[Block] Received ${rawEdits.length} manual edits for ${playerName}`);
  }

  // 4. Build user message
  mc.tellraw(playerName, "§e[AI] Generating blueprint...");

  const relativePos = {
    x: currentPos.x - session.origin.x,
    y: currentPos.y - session.origin.y,
    z: currentPos.z - session.origin.z,
  };

  let userMessage = `Player is currently at relative position (${relativePos.x}, ${relativePos.y}, ${relativePos.z}).`;

  // Include build history summary
  if (session.builds.length > 0) {
    const historyLines = session.builds.map(
      (b, i) => `  ${i + 1}. "${b.prompt}" (${b.blockCount} blocks)`,
    );
    userMessage += `\n\nPrevious builds in this session:\n${historyLines.join("\n")}`;
  }

  // Include manual block edits (only changes since last request)
  if (rawEdits.length > 0) {
    const origin = session.origin;
    const placed: string[] = [];
    const broken: string[] = [];
    for (const e of rawEdits) {
      const rx = e.x - origin.x;
      const ry = e.y - origin.y;
      const rz = e.z - origin.z;
      if (e.action === "place") {
        placed.push(`  (${rx},${ry},${rz}) ${e.blockType}`);
      } else {
        broken.push(`  (${rx},${ry},${rz}) was ${e.blockType}`);
      }
    }
    let editsContext = "Player's manual block edits since last request (relative coordinates):";
    if (placed.length > 0) editsContext += `\nPlaced blocks:\n${placed.join("\n")}`;
    if (broken.length > 0) editsContext += `\nBroken blocks:\n${broken.join("\n")}`;
    userMessage += `\n\n${editsContext}`;
  }

  userMessage += `\n\nRequest: ${prompt}`;

  // 5. Send to Gemini via Chat API
  let result;
  try {
    result = await sendChatMessage(session.chat, userMessage, session.systemPrompt);
  } catch (err) {
    await writeFailedRoundLog({
      playerName,
      prompt,
      pos: currentPos,
      error: err,
      userMessage,
    });
    throw err;
  }

  const { blueprint, rawResponse, systemPrompt } = result;
  console.log(`[Gemini] Generated ${blueprint.blocks.length} blocks`);

  // 6. Record build in session
  session.builds.push({
    prompt,
    blockCount: blueprint.blocks.length,
    timestamp: Date.now(),
  });

  // 7. Write round log
  await writeRoundLog({
    playerName,
    prompt,
    userMessage,
    pos: currentPos,
    systemPrompt,
    rawResponse,
    blueprint,
    sessionOrigin: session.origin,
    isNewSession: false,
    buildNumber: session.builds.length,
  });

  // 8. Send build command using SESSION ORIGIN (not current pos)
  mc.tellraw(
    playerName,
    `§a[AI] Building ${blueprint.blocks.length} blocks...`,
  );
  await mc.sendBuildCommand(session.origin, blueprint, CHUNK_SIZE);

  console.log("[Build] scriptevent(s) sent");
}

// -- Round Logging -----------------------------------------------------------

interface RoundLog {
  playerName: string;
  prompt: string;
  userMessage: string;
  pos: { x: number; y: number; z: number };
  systemPrompt: string;
  rawResponse: string;
  blueprint: { blocks: Array<{ x: number; y: number; z: number; blockType: string }> };
  sessionOrigin?: { x: number; y: number; z: number };
  isNewSession?: boolean;
  buildNumber?: number;
}

interface FailedRoundLog {
  playerName: string;
  prompt: string;
  pos: { x: number; y: number; z: number };
  error: unknown;
  userMessage?: string;
}

async function writeRoundLog(log: RoundLog): Promise<void> {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const filename = `${ts}_${log.playerName}.md`;
  const filepath = join(LOG_DIR, filename);

  const sessionInfo = log.sessionOrigin
    ? `- **Session Origin:** x=${log.sessionOrigin.x}, y=${log.sessionOrigin.y}, z=${log.sessionOrigin.z}\n- **New Session:** ${log.isNewSession ? "Yes" : "No"}\n- **Build #:** ${log.buildNumber ?? "?"}`
    : "";

  const md = `# Build Round - ${now.toLocaleString()}

## Player
- **Name:** ${log.playerName}
- **Position:** x=${log.pos.x}, y=${log.pos.y}, z=${log.pos.z}
${sessionInfo}

## User Prompt (original)
\`\`\`
${log.prompt}
\`\`\`

## Full User Message (sent to Gemini)
\`\`\`
${log.userMessage}
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

async function writeFailedRoundLog(log: FailedRoundLog): Promise<void> {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const filename = `${ts}_${log.playerName}_failed.md`;
  const filepath = join(FAILED_LOG_DIR, filename);

  let errorType = "Error";
  let errorPhase = "unknown";
  let errorMessage = "Unknown error";
  let systemPrompt = "";
  let rawResponse = "";
  let stack = "";

  if (log.error instanceof BlueprintGenerationError) {
    errorType = log.error.name;
    errorPhase = log.error.phase;
    errorMessage = log.error.message;
    systemPrompt = log.error.systemPrompt;
    rawResponse = log.error.rawResponse ?? "";
    stack = log.error.stack ?? "";
  } else if (log.error instanceof Error) {
    errorType = log.error.name;
    errorMessage = log.error.message;
    stack = log.error.stack ?? "";
  }

  const md = `# Failed Build Round - ${now.toLocaleString()}

## Player
- **Name:** ${log.playerName}
- **Position:** x=${log.pos.x}, y=${log.pos.y}, z=${log.pos.z}

## User Prompt (original)
\`\`\`
${log.prompt}
\`\`\`

## Full User Message (sent to Gemini)
\`\`\`
${log.userMessage ?? "(not available)"}
\`\`\`

## Error
- **Type:** ${errorType}
- **Phase:** ${errorPhase}
- **Message:** ${errorMessage}

## System Prompt
\`\`\`
${systemPrompt}
\`\`\`

## Gemini Raw Response (Unparsed)
\`\`\`text
${rawResponse}
\`\`\`

## Stack
\`\`\`text
${stack}
\`\`\`
`;

  await writeFile(filepath, md, "utf-8");
  console.log(`[Log] Saved failed round ${filepath}`);
}
