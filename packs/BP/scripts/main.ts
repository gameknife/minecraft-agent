import { world, system } from "@minecraft/server";

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

// Track build progress across chunks
const buildProgress = new Map<string, { placed: number; failed: number; total: number }>();

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id === "ai:get_edits") {
    try {
      const playerName = event.message.trim();
      // Collect edits for this player
      const edits: ManualEdit[] = [];
      for (let i = manualEditBuffer.length - 1; i >= 0; i--) {
        if (manualEditBuffer[i].player === playerName) {
          edits.push(manualEditBuffer[i]);
          manualEditBuffer.splice(i, 1);
        }
      }
      edits.reverse(); // restore chronological order
      // Send response via /tell (one message per !ai request)
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

  // Update progress
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

// -- Track player manual block edits ------------------------------------------

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
    manualEditBuffer.shift(); // drop oldest
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

world.sendMessage("§a[AI Build] Behavior pack loaded.");
