import { WebSocket } from "ws";
import { v4 as uuid } from "uuid";

// ── Types ──────────────────────────────────────────────────────────────

export interface CommandResponse {
  statusCode: number;
  statusMessage?: string;
  body: Record<string, unknown>;
}

export interface PlayerPosition {
  x: number;
  y: number;
  z: number;
  dimension: number;
}

export interface Block {
  x: number;
  y: number;
  z: number;
  blockType: string;
}

export interface Blueprint {
  blocks: Block[];
}

type EventCallback = (body: Record<string, unknown>) => void;

// ── Minecraft WS Handler ───────────────────────────────────────────────

export class MinecraftHandler {
  private ws: WebSocket;
  private pending = new Map<
    string,
    { resolve: (v: CommandResponse) => void; reject: (e: Error) => void }
  >();
  private listeners = new Map<string, EventCallback[]>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => this.handleMessage(raw.toString()));
  }

  // ── Event helpers ──

  on(event: string, fn: EventCallback): void {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }

  subscribe(eventName: string): void {
    const msg = {
      header: {
        version: 1,
        requestId: uuid(),
        messagePurpose: "subscribe",
        messageType: "commandRequest",
      },
      body: { eventName },
    };
    this.ws.send(JSON.stringify(msg));
  }

  // ── Commands ──

  /** Fire-and-forget command. Returns the requestId. */
  sendCommand(commandLine: string): string {
    const requestId = uuid();
    const msg = {
      header: {
        version: 1,
        requestId,
        messagePurpose: "commandRequest",
        messageType: "commandRequest",
      },
      body: {
        version: 1,
        commandLine,
        origin: { type: "player" },
      },
    };
    this.ws.send(JSON.stringify(msg));
    return requestId;
  }

  /** Send a command and wait for the response. */
  sendCommandAsync(
    commandLine: string,
    timeout = 10_000,
  ): Promise<CommandResponse> {
    return new Promise((resolve, reject) => {
      const requestId = this.sendCommand(commandLine);
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Command timed out: ${commandLine}`));
      }, timeout);

      this.pending.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  /** Query a player's position via /querytarget. */
  async queryPlayerPosition(playerName: string): Promise<PlayerPosition> {
    const resp = await this.sendCommandAsync(
      `/querytarget @a[name="${playerName}"]`,
    );

    // statusMessage may have a localized prefix like "目标数据：[...]"
    // Extract the JSON array portion starting from the first "["
    const raw = resp.statusMessage ?? resp.body.statusMessage;
    if (typeof raw !== "string") {
      throw new Error("querytarget returned no statusMessage");
    }

    const jsonStart = raw.indexOf("[");
    if (jsonStart === -1) {
      throw new Error(`querytarget returned unexpected format: ${raw.slice(0, 80)}`);
    }

    const targets: Array<{
      uniqueId: string;
      yRot: number;
      position: { x: number; y: number; z: number };
      dimension: number;
    }> = JSON.parse(raw.slice(jsonStart));

    if (!targets.length) {
      throw new Error(`Player "${playerName}" not found`);
    }

    const t = targets[0];
    return {
      x: Math.floor(t.position.x),
      y: Math.floor(t.position.y),
      z: Math.floor(t.position.z),
      dimension: t.dimension,
    };
  }

  /**
   * Send a blueprint to the behavior pack via /scriptevent.
   * Chunks the payload to stay under the 2048-char scriptevent limit.
   */
  async sendBuildCommand(
    origin: PlayerPosition,
    blueprint: Blueprint,
    chunkSize = 10,
  ): Promise<void> {
    const CHUNK_SIZE = chunkSize;
    const totalChunks = Math.ceil(blueprint.blocks.length / CHUNK_SIZE);

    for (let i = 0; i < blueprint.blocks.length; i += CHUNK_SIZE) {
      const chunk = blueprint.blocks.slice(i, i + CHUNK_SIZE);
      const chunkIndex = Math.floor(i / CHUNK_SIZE);

      const payload = JSON.stringify({
        origin: { x: origin.x, y: origin.y, z: origin.z },
        blocks: chunk,
        chunk: chunkIndex,
        totalChunks,
      });

      // /scriptevent <namespace:id> <data>
      this.sendCommand(`/scriptevent ai:build ${payload}`);

      // Delay between chunks to avoid overwhelming the client
      if (i + CHUNK_SIZE < blueprint.blocks.length) {
        await sleep(150);
      }
    }
  }

  /** Send a tellraw message to a player. */
  tellraw(playerName: string, text: string): void {
    const escaped = JSON.stringify({ rawtext: [{ text }] });
    this.sendCommand(`/tellraw ${playerName} ${escaped}`);
  }

  // ── Internal ──

  private handleMessage(raw: string): void {
    let msg: {
      header: { messagePurpose: string; requestId: string; eventName?: string };
      body: Record<string, unknown>;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error("[WS] Failed to parse message:", raw.slice(0, 200));
      return;
    }

    const { messagePurpose, requestId, eventName } = msg.header;

    // Command response
    if (messagePurpose === "commandResponse") {
      const entry = this.pending.get(requestId);
      if (entry) {
        this.pending.delete(requestId);
        entry.resolve({
          statusCode: (msg.body.statusCode as number) ?? -1,
          statusMessage: msg.body.statusMessage as string | undefined,
          body: msg.body,
        });
      }
      return;
    }

    // Event
    if (messagePurpose === "event" && eventName) {
      const cbs = this.listeners.get(eventName);
      if (cbs) {
        for (const cb of cbs) cb(msg.body);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
