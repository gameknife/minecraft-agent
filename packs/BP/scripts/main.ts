import { world, system, Player, Entity } from "@minecraft/server";
import { ActionFormData, ModalFormData, FormCancelationReason } from "@minecraft/server-ui";

// -- Types -------------------------------------------------------------------

interface Block {
  x: number;
  y: number;
  z: number;
  blockType: string;
}

interface BuildPayload {
  origin: { x: number; y: number; z: number };
  blocks: Block[];
  chunk: number;
  totalChunks: number;
}

interface ChatMessage {
  role: "user" | "ai";
  text: string;
}

interface ChatResponsePayload {
  playerName: string;
  message: string;
  type: "chat" | "build";
  blockCount?: number;
  chunk?: number;
  totalChunks?: number;
}

interface SummonNPCPayload {
  playerName: string;
  x: number;
  y: number;
  z: number;
  name: string;
}

// -- State -------------------------------------------------------------------

const buildProgress = new Map<string, { placed: number; failed: number; total: number }>();
const chatHistories = new Map<string, ChatMessage[]>();
const MAX_CHAT_DISPLAY = 8;
const pendingPlayers = new Set<string>();

// NPC entity tracking
const NPC_TYPE_ID = "minecraft:npc";
const AI_NPC_TAG = "ai_assistant";
let aiNpcName = "AI助手";

// Buffer for multi-chunk chat responses
const chatResponseBuffer = new Map<string, { chunks: string[]; total: number; type: "chat" | "build"; blockCount?: number }>();

// -- Scriptevent Handlers ----------------------------------------------------

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id === "ai:get_edits") {
    try {
      const playerName = event.message.trim();
      const edits: ManualEdit[] = [];
      for (let i = manualEditBuffer.length - 1; i >= 0; i--) {
        if (manualEditBuffer[i].player === playerName) {
          edits.push(manualEditBuffer[i]);
          manualEditBuffer.splice(i, 1);
        }
      }
      edits.reverse();
      const players = world.getPlayers({ name: playerName });
      if (players.length > 0) {
        const response = JSON.stringify(edits);
        players[0].runCommand(`tell @s §8__EDITS__:${response}`);
      }
    } catch (e) {
      world.sendMessage(`§c[Debug] ai:get_edits error: ${e}`);
    }
    return;
  }

  if (event.id === "ai:chat_response") {
    try {
      const payload: ChatResponsePayload = JSON.parse(event.message);
      const totalChunks = payload.totalChunks ?? 1;
      const chunkIdx = payload.chunk ?? 0;

      if (totalChunks <= 1) {
        // Single-chunk response — handle directly
        handleChatResponse(payload);
      } else {
        // Multi-chunk response — buffer and reassemble
        const key = payload.playerName;
        let buf = chatResponseBuffer.get(key);
        if (chunkIdx === 0 || !buf) {
          buf = { chunks: new Array(totalChunks).fill(""), total: totalChunks, type: payload.type, blockCount: payload.blockCount };
          chatResponseBuffer.set(key, buf);
        }
        buf.chunks[chunkIdx] = payload.message;
        // Check if all chunks received
        const received = buf.chunks.filter((c) => c !== "").length;
        if (received >= buf.total) {
          chatResponseBuffer.delete(key);
          handleChatResponse({
            playerName: payload.playerName,
            message: buf.chunks.join(""),
            type: buf.type,
            blockCount: buf.blockCount,
          });
        }
      }
    } catch (e) {
      world.sendMessage(`§c[Debug] ai:chat_response error: ${e}`);
    }
    return;
  }

  if (event.id === "ai:summon_npc") {
    try {
      const payload: SummonNPCPayload = JSON.parse(event.message);
      handleSummonNPC(payload);
    } catch (e) {
      world.sendMessage(`§c[Debug] ai:summon_npc error: ${e}`);
    }
    return;
  }

  if (event.id !== "ai:build") return;

  let payload: BuildPayload;
  try {
    payload = JSON.parse(event.message);
  } catch (e) {
    world.sendMessage(`§c[AI Build] JSON parse error: ${e}`);
    return;
  }

  const { origin, blocks, chunk, totalChunks } = payload;
  const buildId = `${origin.x},${origin.y},${origin.z}`;

  if (chunk === 0) {
    buildProgress.set(buildId, { placed: 0, failed: 0, total: 0 });
  }

  system.runJob(placeBlocks(origin, blocks, chunk, totalChunks, buildId));
});

// -- Build Job ---------------------------------------------------------------

function* placeBlocks(
  origin: { x: number; y: number; z: number },
  blocks: Block[],
  chunk: number,
  totalChunks: number,
  buildId: string,
): Generator<void, void, void> {
  const dimension = world.getDimension("overworld");
  let placedInChunk = 0;
  let failedInChunk = 0;

  for (const block of blocks) {
    const pos = {
      x: origin.x + block.x,
      y: origin.y + block.y,
      z: origin.z + block.z,
    };

    try {
      const target = dimension.getBlock(pos);
      if (target) {
        target.setType(block.blockType);
        placedInChunk++;
      } else {
        failedInChunk++;
      }
    } catch {
      failedInChunk++;
    }

    yield;
  }

  const progress = buildProgress.get(buildId);
  if (progress) {
    progress.placed += placedInChunk;
    progress.failed += failedInChunk;
    progress.total += blocks.length;

    if (chunk === totalChunks - 1) {
      const msg = progress.failed > 0
        ? `§a[AI Build] Done! Placed ${progress.placed}/${progress.total} blocks (${progress.failed} failed).`
        : `§a[AI Build] Done! Placed ${progress.placed}/${progress.total} blocks.`;
      world.sendMessage(msg);
      buildProgress.delete(buildId);
    }
  }
}

// -- NPC Interaction ---------------------------------------------------------

function removeOldAiNpcs(): void {
  try {
    const dimension = world.getDimension("overworld");
    const existing = dimension.getEntities({ type: NPC_TYPE_ID, tags: [AI_NPC_TAG] });
    for (const entity of existing) {
      try { entity.remove(); } catch { /* ignore */ }
    }
  } catch {
    // Dimension may not be loaded yet
  }
}

function handleSummonNPC(payload: SummonNPCPayload): void {
  try {
    // Remove ALL existing AI NPCs by tag (handles leftovers from crashes/disconnects)
    removeOldAiNpcs();

    const dimension = world.getDimension("overworld");
    const npc = dimension.spawnEntity(NPC_TYPE_ID, {
      x: payload.x,
      y: payload.y,
      z: payload.z,
    });
    aiNpcName = payload.name || "AI助手";
    npc.nameTag = aiNpcName;
    npc.addTag(AI_NPC_TAG);
    world.sendMessage(`§a[AI] ${aiNpcName} has arrived!`);
  } catch (e) {
    world.sendMessage(`§c[Debug] summon_npc error: ${e}`);
  }
}

// Cancel native NPC dialog for our AI NPC (identify by tag, not variable reference)
world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
  try {
    if (event.target.typeId === NPC_TYPE_ID && event.target.hasTag(AI_NPC_TAG)) {
      event.cancel = true;
      // Schedule UI open for next tick (can't show forms in before events)
      const playerName = event.player.name;
      system.run(() => {
        const players = world.getPlayers({ name: playerName });
        if (players.length > 0) {
          showMainMenu(players[0]);
        }
      });
    }
  } catch {
    // Silently ignore
  }
});

// -- UI Forms ----------------------------------------------------------------

function getChatHistory(playerName: string): ChatMessage[] {
  return chatHistories.get(playerName) ?? [];
}

function addChatMessage(playerName: string, role: "user" | "ai", text: string): void {
  let history = chatHistories.get(playerName);
  if (!history) {
    history = [];
    chatHistories.set(playerName, history);
  }
  history.push({ role, text });
  // Keep only recent messages
  while (history.length > MAX_CHAT_DISPLAY * 2) {
    history.shift();
  }
}

function formatChatHistory(playerName: string): string {
  const history = getChatHistory(playerName);
  if (history.length === 0) {
    return "No conversation yet. Send a message to start!";
  }

  const recent = history.slice(-MAX_CHAT_DISPLAY);
  return recent
    .map((msg) => {
      if (msg.role === "user") {
        return `§1> You: ${msg.text}`;
      }
      return `§2< AI: ${msg.text}`;
    })
    .join("\n");
}

function showMainMenu(player: Player): void {
  const form = new ActionFormData()
    .title("AI 助手")
    .body(formatChatHistory(player.name))
    .button("Send Message")
    .button("New Session")
    .button("Status");

  form.show(player).then((response) => {
    if (response.canceled) {
      if (response.cancelationReason === FormCancelationReason.UserBusy) {
        // Retry after a short delay
        system.runTimeout(() => showMainMenu(player), 20);
      }
      return;
    }

    switch (response.selection) {
      case 0:
        showChatInput(player);
        break;
      case 1:
        handleNewSessionFromUI(player);
        break;
      case 2:
        showStatus(player);
        break;
    }
  }).catch(() => {
    // Silently ignore form errors
  });
}

function showChatInput(player: Player): void {
  const history = getChatHistory(player.name);
  const lastAiMsg = [...history].reverse().find((m) => m.role === "ai");
  const label = lastAiMsg ? `AI: ${lastAiMsg.text.slice(0, 200)}` : "Ask me anything or tell me what to build!";

  const form = new ModalFormData()
    .title("Send Message")
    .textField(label, "Type your message...");

  form.show(player).then((response) => {
    if (response.canceled) {
      if (response.cancelationReason === FormCancelationReason.UserBusy) {
        system.runTimeout(() => showChatInput(player), 20);
      }
      return;
    }

    const text = response.formValues?.[0];
    if (typeof text !== "string" || !text.trim()) {
      showMainMenu(player);
      return;
    }

    const message = text.trim();
    addChatMessage(player.name, "user", message);
    pendingPlayers.add(player.name);

    // Send to server via tell command (intercepted by server)
    const payload = JSON.stringify({ playerName: player.name, message });
    try {
      player.runCommand(`tell @s §8__CHAT__:${payload}`);
    } catch (e) {
      world.sendMessage(`§c[Debug] Failed to send chat: ${e}`);
      pendingPlayers.delete(player.name);
    }
  }).catch(() => {
    // Silently ignore form errors
  });
}

function handleNewSessionFromUI(player: Player): void {
  try {
    // Clear local chat history
    chatHistories.delete(player.name);
    // Trigger !ai new via chat
    player.runCommand(`tell @s §8__CHAT__:${JSON.stringify({ playerName: player.name, message: "!ai_new" })}`);
    player.sendMessage("§a[AI] Requesting new session...");
  } catch (e) {
    player.sendMessage(`§c[AI] Error: ${e}`);
  }
  // Re-show menu after a short delay
  system.runTimeout(() => showMainMenu(player), 40);
}

function showStatus(player: Player): void {
  // Use !ai status via chat command
  try {
    player.runCommand("say !ai status");
  } catch {
    // Ignore
  }
  // Re-show menu after a delay
  system.runTimeout(() => showMainMenu(player), 40);
}

// -- Chat Response Handler ---------------------------------------------------

function handleChatResponse(payload: ChatResponsePayload): void {
  const { playerName, message, type, blockCount } = payload;

  // Store in chat history
  let displayMsg = message;
  if (type === "build" && blockCount !== undefined) {
    displayMsg = `[Building ${blockCount} blocks] ${message}`;
  }
  addChatMessage(playerName, "ai", displayMsg);
  pendingPlayers.delete(playerName);

  // Auto-reopen the form for the player
  const players = world.getPlayers({ name: playerName });
  if (players.length > 0) {
    system.runTimeout(() => showMainMenu(players[0]), 10);
  }
}

// -- Track player manual block edits -----------------------------------------

interface ManualEdit {
  player: string;
  action: string;
  x: number;
  y: number;
  z: number;
  blockType: string;
}

const MAX_EDIT_BUFFER = 200;
const manualEditBuffer: ManualEdit[] = [];

function pushEdit(edit: ManualEdit): void {
  if (manualEditBuffer.length >= MAX_EDIT_BUFFER) {
    manualEditBuffer.shift();
  }
  manualEditBuffer.push(edit);
}

world.afterEvents.playerPlaceBlock.subscribe((event) => {
  try {
    pushEdit({
      player: event.player.name,
      action: "place",
      x: event.block.location.x,
      y: event.block.location.y,
      z: event.block.location.z,
      blockType: event.block.typeId,
    });
  } catch {
    // Silently ignore to avoid crashing the script engine
  }
});

world.afterEvents.playerBreakBlock.subscribe((event) => {
  try {
    pushEdit({
      player: event.player.name,
      action: "break",
      x: event.block.location.x,
      y: event.block.location.y,
      z: event.block.location.z,
      blockType: event.brokenBlockPermutation.type.id,
    });
  } catch {
    // Silently ignore to avoid crashing the script engine
  }
});

// Clean up leftover AI NPCs from previous sessions on pack load
system.runTimeout(() => removeOldAiNpcs(), 20);

world.sendMessage("§a[AI Build] Behavior pack loaded.");
