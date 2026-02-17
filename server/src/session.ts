import type { Chat } from "@google/genai";
import type { PlayerPosition } from "./ws-handler.js";

export interface BuildRecord {
  prompt: string;
  blockCount: number;
  timestamp: number;
}

export interface PlayerSession {
  chat: Chat;
  systemPrompt: string;
  origin: PlayerPosition;
  builds: BuildRecord[];
  lastActivity: number;
}

const DEFAULT_SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

export class SessionManager {
  private sessions = new Map<string, PlayerSession>();
  private sessionTimeout: number;

  constructor(sessionTimeout?: number) {
    this.sessionTimeout = sessionTimeout ?? DEFAULT_SESSION_TIMEOUT;
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

  getSessionInfo(playerName: string): string | null {
    const session = this.sessions.get(playerName);
    if (!session) return null;

    const elapsed = Math.floor((Date.now() - session.lastActivity) / 1000);
    const buildCount = session.builds.length;
    const totalBlocks = session.builds.reduce((sum, b) => sum + b.blockCount, 0);
    const origin = session.origin;

    return (
      `Origin: (${origin.x}, ${origin.y}, ${origin.z}) | ` +
      `Builds: ${buildCount} | ` +
      `Total blocks: ${totalBlocks} | ` +
      `Idle: ${elapsed}s`
    );
  }
}
