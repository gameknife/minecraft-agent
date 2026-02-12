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

world.sendMessage("§a[AI Build] Behavior pack loaded.");
