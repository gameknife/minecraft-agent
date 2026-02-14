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

world.afterEvents.playerPlaceBlock.subscribe((event) => {
  try {
    const block = event.block;
    const player = event.player;
    const msg = JSON.stringify({
      player: player.name,
      action: "place",
      x: block.location.x,
      y: block.location.y,
      z: block.location.z,
      blockType: block.typeId,
    });
    // Use /tell so it triggers the WS PlayerMessage event (world.sendMessage does not)
    player.runCommand(`tell @s §8__BLOCK__:${msg}`);
  } catch {
    // Silently ignore to avoid crashing the script engine
  }
});

world.afterEvents.playerBreakBlock.subscribe((event) => {
  try {
    const player = event.player;
    const brokenType = event.brokenBlockPermutation.type.id;
    const block = event.block; // now air, but has location
    const msg = JSON.stringify({
      player: player.name,
      action: "break",
      x: block.location.x,
      y: block.location.y,
      z: block.location.z,
      blockType: brokenType,
    });
    player.runCommand(`tell @s §8__BLOCK__:${msg}`);
  } catch {
    // Silently ignore to avoid crashing the script engine
  }
});

world.sendMessage("§a[AI Build] Behavior pack loaded.");
