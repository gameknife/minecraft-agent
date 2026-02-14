import type { Chat } from "@google/genai";
import type { PlayerPosition } from "./ws-handler.js";

export interface BuildRecord {
  prompt: string;
  blockCount: number;
  timestamp: number;
}

export interface ManualBlockEntry {
  action: "place" | "break";
  blockType: string;
  timestamp: number;
}

export interface PlayerSession {
  chat: Chat;
  systemPrompt: string;
  origin: PlayerPosition;
  builds: BuildRecord[];
  manualBlocks: Map<string, ManualBlockEntry>;
  lastActivity: number;
}

const DEFAULT_SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MANUAL_BLOCK_LIMIT = 200;

export class SessionManager {
  private sessions = new Map<string, PlayerSession>();
  private sessionTimeout: number;
  private manualBlockLimit: number;

  constructor(sessionTimeout?: number, manualBlockLimit?: number) {
    this.sessionTimeout = sessionTimeout ?? DEFAULT_SESSION_TIMEOUT;
    this.manualBlockLimit = manualBlockLimit ?? DEFAULT_MANUAL_BLOCK_LIMIT;
  }

  createSession(
    playerName: string,
    origin: PlayerPosition,
    chat: Chat,
    systemPrompt: string,
  ): PlayerSession {
    // Clear any existing session
    this.sessions.delete(playerName);

    const session: PlayerSession = {
      chat,
      systemPrompt,
      origin,
      builds: [],
      manualBlocks: new Map(),
      lastActivity: Date.now(),
    };
    this.sessions.set(playerName, session);
    return session;
  }

  getSession(playerName: string): PlayerSession | null {
    const session = this.sessions.get(playerName);
    if (!session) return null;

    // Check expiry
    if (Date.now() - session.lastActivity > this.sessionTimeout) {
      this.sessions.delete(playerName);
      return null;
    }

    session.lastActivity = Date.now();
    return session;
  }

  resetSession(playerName: string): void {
    this.sessions.delete(playerName);
  }

  clearAll(): void {
    this.sessions.clear();
  }

  cleanExpired(): void {
    const now = Date.now();
    for (const [name, session] of this.sessions) {
      if (now - session.lastActivity > this.sessionTimeout) {
        this.sessions.delete(name);
      }
    }
  }

  recordManualBlock(
    playerName: string,
    worldX: number,
    worldY: number,
    worldZ: number,
    action: "place" | "break",
    blockType: string,
  ): boolean {
    const session = this.sessions.get(playerName);
    if (!session) return false;

    const rx = worldX - session.origin.x;
    const ry = worldY - session.origin.y;
    const rz = worldZ - session.origin.z;
    const key = `${rx},${ry},${rz}`;

    session.manualBlocks.set(key, { action, blockType, timestamp: Date.now() });

    // Evict oldest entries if over limit
    if (session.manualBlocks.size > this.manualBlockLimit) {
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [k, v] of session.manualBlocks) {
        if (v.timestamp < oldestTs) {
          oldestTs = v.timestamp;
          oldestKey = k;
        }
      }
      if (oldestKey) session.manualBlocks.delete(oldestKey);
    }

    session.lastActivity = Date.now();
    return true;
  }

  formatManualBlocks(playerName: string): string | null {
    const session = this.sessions.get(playerName);
    if (!session || session.manualBlocks.size === 0) return null;

    const placed: string[] = [];
    const broken: string[] = [];

    for (const [key, entry] of session.manualBlocks) {
      if (entry.action === "place") {
        placed.push(`  (${key}) ${entry.blockType}`);
      } else {
        broken.push(`  (${key}) was ${entry.blockType}`);
      }
    }

    let result = "Player's manual block edits (relative coordinates):";
    if (placed.length > 0) {
      result += `\nPlaced blocks:\n${placed.join("\n")}`;
    }
    if (broken.length > 0) {
      result += `\nBroken blocks:\n${broken.join("\n")}`;
    }
    return result;
  }

  getSessionInfo(playerName: string): string | null {
    const session = this.sessions.get(playerName);
    if (!session) return null;

    const elapsed = Math.floor((Date.now() - session.lastActivity) / 1000);
    const buildCount = session.builds.length;
    const totalBlocks = session.builds.reduce((sum, b) => sum + b.blockCount, 0);
    const manualEdits = session.manualBlocks.size;
    const origin = session.origin;

    return (
      `Origin: (${origin.x}, ${origin.y}, ${origin.z}) | ` +
      `Builds: ${buildCount} | ` +
      `Total blocks: ${totalBlocks} | ` +
      `Manual edits: ${manualEdits} | ` +
      `Idle: ${elapsed}s`
    );
  }
}
