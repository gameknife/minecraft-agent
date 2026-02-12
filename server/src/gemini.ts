import { GoogleGenAI, Type } from "@google/genai";
import type { Blueprint, Block } from "./ws-handler.js";

const MAX_BLOCKS = 200;

const SYSTEM_PROMPT = `You are a Minecraft Bedrock Edition building assistant.
Given a building description, output a JSON object with a "blocks" array.
Each block has:
  - x, y, z: integer OFFSETS from the player position (player is at 0,0,0)
  - blockType: a valid Bedrock Edition block ID (e.g. "minecraft:stone")

Rules:
- Use ONLY valid Bedrock Edition block IDs with "minecraft:" prefix.
- y=0 is at the player's feet level. Build upward with positive y.
- x and z spread the build horizontally. Place the build roughly centered on x/z=0.
- Maximum ${MAX_BLOCKS} blocks per response.
- Output ONLY the JSON object. No commentary, no markdown.
- Make structures that look good and are architecturally sound.
- For a "house" or "hut", include walls, a floor, a door opening, and a roof.
- For a "platform", create a flat surface at y=0.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    blocks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          x: { type: Type.INTEGER },
          y: { type: Type.INTEGER },
          z: { type: Type.INTEGER },
          blockType: { type: Type.STRING },
        },
        required: ["x", "y", "z", "blockType"],
      },
    },
  },
  required: ["blocks"],
};

let client: GoogleGenAI | null = null;
let modelName = "gemini-2.0-flash";

export function initGemini(apiKey: string, model?: string): void {
  client = new GoogleGenAI({ apiKey });
  if (model) modelName = model;
}

export interface GeminiResult {
  blueprint: Blueprint;
  rawResponse: string;
  systemPrompt: string;
}

export async function generateBlueprint(prompt: string): Promise<GeminiResult> {
  if (!client) throw new Error("Gemini not initialized – call initGemini()");

  const response = await client.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned empty response");

  const data: { blocks: Array<Record<string, unknown>> } = JSON.parse(text);

  if (!Array.isArray(data.blocks)) {
    throw new Error("Gemini response missing blocks array");
  }

  // Validate and normalize
  const blocks: Block[] = data.blocks.slice(0, MAX_BLOCKS).map((b) => {
    let blockType = String(b.blockType ?? "minecraft:stone");
    if (!blockType.startsWith("minecraft:")) {
      blockType = `minecraft:${blockType}`;
    }
    return {
      x: Number(b.x) || 0,
      y: Number(b.y) || 0,
      z: Number(b.z) || 0,
      blockType,
    };
  });

  return { blueprint: { blocks }, rawResponse: text, systemPrompt: SYSTEM_PROMPT };
}
