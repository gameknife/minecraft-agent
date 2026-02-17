import { GoogleGenAI } from "@google/genai";
import type { Chat } from "@google/genai";
import type { Blueprint, Block } from "./ws-handler.js";

const MAX_BLOCKS = 10_000;
const MAX_EXECUTED_STEPS = 50_000;
const MAX_CALL_DEPTH = 24;
const MAX_CALLS = 500;
const DEFAULT_PROMPT_BLOCK_TYPE_LIMIT = 0;

const DEFAULT_BLOCK_TYPE = "minecraft:stone";
const DEFAULT_ALLOWED_BLOCK_TYPES = [
  "minecraft:stone",
  "minecraft:cobblestone",
  "minecraft:stone_bricks",
  "minecraft:bricks",
  "minecraft:oak_planks",
  "minecraft:oak_log",
  "minecraft:oak_leaves",
  "minecraft:glass",
  "minecraft:glass_pane",
  "minecraft:oak_stairs",
  "minecraft:oak_slab",
  "minecraft:grass_block",
  "minecraft:dirt",
  "minecraft:sandstone",
  "minecraft:smooth_stone",
  "minecraft:lantern",
  "minecraft:torch",
] as const;

const BASE_SYSTEM_PROMPT = `You are a Minecraft Bedrock Edition building assistant.
Given a building description, output a JSON object in one of these formats:

Preferred compact format (use this when there is repetition):
{
  "defs": [
    {
      "name": "functionName",
      "params": ["h"],
      "steps": [
        {"op":"for","var":"y","from":0,"to":"h","steps":[
          {"op":"place","x":0,"y":"y","z":5,"blockType":"minecraft:oak_log"}
        ]}
      ]
    }
  ],
  "steps": [
    {"op":"call","name":"functionName","args":{"h":9}}
  ]
}

Legacy format (allowed):
{
  "blocks": [{"x":0,"y":0,"z":0,"blockType":"minecraft:stone"}]
}

Compact step types:
- place: { op:"place"|"block", x, y, z, blockType }
- for: { op:"for", var, from, to, step?, steps }
- call: { op:"call", name, args? }

Expression support for x/y/z/from/to/step/args values:
- integer: 5
- variable: "y"
- variable arithmetic: "y+1", "y-2", "y*2", "2+y"
- mixed-variable arithmetic: "x+i", "(x+z)/2"
- call args can also be strings (example: "minecraft:cobblestone")

Rules:
- Use ONLY valid Bedrock Edition block IDs with "minecraft:" prefix.
- y=0 is at the player's feet level. Build upward with positive y.
- x and z spread the build horizontally. Place the build roughly centered on x/z=0.
- After expansion, maximum ${MAX_BLOCKS} blocks.
- Output ONLY the JSON object. No commentary, no markdown.
- Output STRICT JSON only (RFC 8259):
  - No comments (// or /* */)
  - No trailing commas
  - No duplicate top-level keys
  - Exactly one top-level object, not multiple JSON objects
- Do NOT add helper keys like "comment", "note", "explanation", "reason", "summary".
- Every item in "steps" must be an executable op object (place/block/for/call).
- Make structures that look good and are architecturally sound.
- For a "house" or "hut", include walls, a floor, a door opening, and a roof.
- For a "platform", create a flat surface at y=0.
- Prefer defs + loops + calls instead of listing one block per line when possible.
- if blockType is minecraft:air, skip it
- If you cannot satisfy all requirements, still return valid JSON with a smaller build.`;

const MULTI_TURN_PROMPT_ADDITIONS = `

Coordinate system:
- All coordinates are relative to the session origin (the player's position when the session started).
- The player's current relative position is provided in each message.
- When the player says "here", build around their current position.
- When modifying previous builds, use the same coordinate system as before.

Multi-turn building:
- You may receive follow-up instructions referring to previous builds.
- Each response must be a complete, valid JSON blueprint.
- To remove blocks, place "minecraft:air" at those coordinates.

Player manual block edits:
- The user message may include "Player's manual block edits since last request" with coordinates and block types.
- These are only changes since the last request — earlier edits are already in conversation history.
- CRITICAL: Use manually placed blocks as positional anchors. If the player placed corner blocks forming a rectangle, build WITHIN that exact bounding box. If they placed a row of blocks, extend or build along that line.
- Analyze the pattern: corner markers define boundaries, lines define walls/edges, filled areas define floors/foundations.
- Your build coordinates MUST align with the manually placed blocks, not ignore them.
- Preserve manually placed blocks — do not replace them unless the build requires a different block type at that position.
- Respect broken blocks (openings, cleared areas) — do NOT re-place blocks the player intentionally broke.`;

let client: GoogleGenAI | null = null;
let modelName = "gemini-2.0-flash";
let supportedBlockTypes = new Set<string>(DEFAULT_ALLOWED_BLOCK_TYPES);
let supportedBlockCatalogVersion = "fallback";
let supportedBlockCatalogSource = "built-in-safe-palette";
const warnedInvalidBlockTypes = new Set<string>();

export function initGemini(apiKey: string, model?: string): void {
  client = new GoogleGenAI({ apiKey });
  if (model) modelName = model;
}

export interface GeminiResult {
  blueprint: Blueprint;
  rawResponse: string;
  systemPrompt: string;
}

type BlueprintErrorPhase =
  | "api_request"
  | "empty_response"
  | "invalid_json"
  | "invalid_blueprint";

interface BlueprintGenerationErrorDetails {
  phase: BlueprintErrorPhase;
  prompt: string;
  systemPrompt: string;
  rawResponse?: string;
  cause?: unknown;
}

export class BlueprintGenerationError extends Error {
  phase: BlueprintErrorPhase;
  prompt: string;
  systemPrompt: string;
  rawResponse?: string;
  cause?: unknown;

  constructor(message: string, details: BlueprintGenerationErrorDetails) {
    super(message);
    this.name = "BlueprintGenerationError";
    this.phase = details.phase;
    this.prompt = details.prompt;
    this.systemPrompt = details.systemPrompt;
    this.rawResponse = details.rawResponse;
    this.cause = details.cause;
  }
}

export function setSupportedBlockCatalog(
  blockIds: string[],
  options?: { version?: string; source?: string },
): void {
  const normalized = normalizeBlockCatalog(blockIds);
  if (!normalized.length) {
    return;
  }

  supportedBlockTypes = new Set(normalized);
  supportedBlockCatalogVersion = options?.version ?? "unknown";
  supportedBlockCatalogSource = options?.source ?? "runtime";
  warnedInvalidBlockTypes.clear();

  const fallback = pickFallbackBlockType();
  console.log(
    `[Gemini] Loaded ${supportedBlockTypes.size} supported block types (version=${supportedBlockCatalogVersion}, source=${supportedBlockCatalogSource}, fallback=${fallback})`,
  );
}

export async function generateBlueprint(prompt: string): Promise<GeminiResult> {
  if (!client) throw new Error("Gemini not initialized – call initGemini()");
  const systemPrompt = buildSystemPrompt();
  let text: string | undefined;

  try {
    const response = await client.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        // Keep JSON output but skip strict schema here because compact program
        // steps are heterogeneous objects and Gemini rejects empty-object schemas.
      },
    });

    text = response.text;
    if (!text) {
      throw new BlueprintGenerationError("Gemini returned empty response", {
        phase: "empty_response",
        prompt,
        systemPrompt,
      });
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new BlueprintGenerationError(
        `Gemini returned invalid JSON: ${(err as Error).message}`,
        {
          phase: "invalid_json",
          prompt,
          systemPrompt,
          rawResponse: text,
          cause: err,
        },
      );
    }

    try {
      const blocks = parseBlocksFromResponse(data);
      return {
        blueprint: { blocks },
        rawResponse: text,
        systemPrompt,
      };
    } catch (err) {
      throw new BlueprintGenerationError(
        `Gemini response failed blueprint validation: ${(err as Error).message}`,
        {
          phase: "invalid_blueprint",
          prompt,
          systemPrompt,
          rawResponse: text,
          cause: err,
        },
      );
    }
  } catch (err) {
    if (err instanceof BlueprintGenerationError) {
      throw err;
    }

    throw new BlueprintGenerationError(
      `Gemini request failed: ${(err as Error).message}`,
      {
        phase: "api_request",
        prompt,
        systemPrompt,
        rawResponse: text,
        cause: err,
      },
    );
  }
}

// -- Chat API (multi-turn) ---------------------------------------------------

export interface ChatSessionResult {
  chat: Chat;
  systemPrompt: string;
}

export function createChatSession(): ChatSessionResult {
  if (!client) throw new Error("Gemini not initialized – call initGemini()");

  const systemPrompt = buildSystemPrompt();
  const chat = client.chats.create({
    model: modelName,
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
    },
  });
  return { chat, systemPrompt };
}

export async function sendChatMessage(
  chat: Chat,
  userMessage: string,
  systemPrompt: string,
): Promise<GeminiResult> {
  let text: string | undefined;

  try {
    // Do NOT pass per-message config here — it would replace the session
    // config entirely, losing systemInstruction. The chat was already
    // created with responseMimeType: "application/json".
    const response = await chat.sendMessage({ message: userMessage });

    text = response.text;
    if (!text) {
      throw new BlueprintGenerationError("Gemini returned empty response", {
        phase: "empty_response",
        prompt: userMessage,
        systemPrompt,
      });
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new BlueprintGenerationError(
        `Gemini returned invalid JSON: ${(err as Error).message}`,
        {
          phase: "invalid_json",
          prompt: userMessage,
          systemPrompt,
          rawResponse: text,
          cause: err,
        },
      );
    }

    try {
      const blocks = parseBlocksFromResponse(data);
      return {
        blueprint: { blocks },
        rawResponse: text,
        systemPrompt,
      };
    } catch (err) {
      throw new BlueprintGenerationError(
        `Gemini response failed blueprint validation: ${(err as Error).message}`,
        {
          phase: "invalid_blueprint",
          prompt: userMessage,
          systemPrompt,
          rawResponse: text,
          cause: err,
        },
      );
    }
  } catch (err) {
    if (err instanceof BlueprintGenerationError) throw err;

    throw new BlueprintGenerationError(
      `Gemini chat request failed: ${(err as Error).message}`,
      {
        phase: "api_request",
        prompt: userMessage,
        systemPrompt,
        rawResponse: text,
        cause: err,
      },
    );
  }
}

// -- DSL Interpreter ---------------------------------------------------------

type ScopeValue = number | string;
type Scope = Record<string, ScopeValue>;

interface ExecBudget {
  executedSteps: number;
  calls: number;
}

function parseBlocksFromResponse(raw: unknown): Block[] {
  if (!isRecord(raw)) {
    throw new Error("Gemini response must be a JSON object");
  }

  const hasCompactProgram =
    Array.isArray(raw.steps) || Array.isArray(raw.defs);

  if (hasCompactProgram) {
    try {
      return expandCompactProgram(raw).slice(0, MAX_BLOCKS);
    } catch (err) {
      if (Array.isArray(raw.blocks)) {
        console.warn(
          `[Gemini] Compact program parse failed, falling back to legacy blocks: ${(err as Error).message}`,
        );
        return normalizeLegacyBlocks(raw.blocks).slice(0, MAX_BLOCKS);
      }
      throw err;
    }
  }

  if (Array.isArray(raw.blocks)) {
    return normalizeLegacyBlocks(raw.blocks).slice(0, MAX_BLOCKS);
  }

  throw new Error("Gemini response missing steps/defs or blocks");
}

function expandCompactProgram(program: Record<string, unknown>): Block[] {
  const defs = new Map<string, Record<string, unknown>>();

  if (Array.isArray(program.defs)) {
    for (const rawDef of program.defs) {
      if (!isRecord(rawDef)) {
        throw new Error("Definition entry must be an object");
      }

      const name = String(rawDef.name ?? "").trim();
      if (!name) {
        throw new Error("Definition missing name");
      }
      if (!Array.isArray(rawDef.steps)) {
        throw new Error(`Definition "${name}" missing steps array`);
      }
      defs.set(name, rawDef);
    }
  }

  if (!Array.isArray(program.steps)) {
    throw new Error("Compact format missing top-level steps array");
  }

  const blocks: Block[] = [];
  const budget: ExecBudget = { executedSteps: 0, calls: 0 };

  executeSteps(program.steps, {}, defs, blocks, budget, 0);
  return blocks;
}

function executeSteps(
  steps: unknown[],
  scope: Scope,
  defs: Map<string, Record<string, unknown>>,
  out: Block[],
  budget: ExecBudget,
  callDepth: number,
): void {
  if (callDepth > MAX_CALL_DEPTH) {
    throw new Error("Exceeded max function call depth");
  }

  for (const rawStep of steps) {
    if (out.length >= MAX_BLOCKS) return;

    budget.executedSteps += 1;
    if (budget.executedSteps > MAX_EXECUTED_STEPS) {
      throw new Error("Exceeded max executed compact steps");
    }

    if (!isRecord(rawStep)) {
      throw new Error("Step must be an object");
    }

    const op = String(rawStep.op ?? "").toLowerCase();

    if (op === "place" || op === "block") {
      out.push(normalizeCompactBlock(rawStep, scope));
      continue;
    }

    if (op === "for") {
      executeForStep(rawStep, scope, defs, out, budget, callDepth);
      continue;
    }

    if (op === "call") {
      executeCallStep(rawStep, scope, defs, out, budget, callDepth);
      continue;
    }

    throw new Error(`Unsupported compact op: "${op}"`);
  }
}

function executeForStep(
  step: Record<string, unknown>,
  scope: Scope,
  defs: Map<string, Record<string, unknown>>,
  out: Block[],
  budget: ExecBudget,
  callDepth: number,
): void {
  const varName = String(step.var ?? "").trim();
  if (!varName) {
    throw new Error('for step missing "var"');
  }

  const from = evalIntExpr(step.from, scope, "for.from");
  const to = evalIntExpr(step.to, scope, "for.to");
  const stride = step.step === undefined
    ? 1
    : evalIntExpr(step.step, scope, "for.step");

  if (stride === 0) {
    throw new Error("for.step cannot be 0");
  }
  if (!Array.isArray(step.steps)) {
    throw new Error('for step missing nested "steps" array');
  }

  if (stride > 0) {
    for (let i = from; i <= to; i += stride) {
      executeSteps(
        step.steps,
        { ...scope, [varName]: i },
        defs,
        out,
        budget,
        callDepth + 1,
      );
      if (out.length >= MAX_BLOCKS) return;
    }
    return;
  }

  for (let i = from; i >= to; i += stride) {
    executeSteps(
      step.steps,
      { ...scope, [varName]: i },
      defs,
      out,
      budget,
      callDepth + 1,
    );
    if (out.length >= MAX_BLOCKS) return;
  }
}

function executeCallStep(
  step: Record<string, unknown>,
  scope: Scope,
  defs: Map<string, Record<string, unknown>>,
  out: Block[],
  budget: ExecBudget,
  callDepth: number,
): void {
  budget.calls += 1;
  if (budget.calls > MAX_CALLS) {
    throw new Error("Exceeded max function calls");
  }

  const name = String(step.name ?? "").trim();
  if (!name) {
    throw new Error('call step missing "name"');
  }

  const def = defs.get(name);
  if (!def) {
    throw new Error(`Undefined function "${name}"`);
  }
  if (!Array.isArray(def.steps)) {
    throw new Error(`Function "${name}" has invalid steps`);
  }

  const args: Scope = {};
  const rawArgs = isRecord(step.args) ? step.args : {};

  if (Array.isArray(def.params)) {
    for (const param of def.params) {
      const key = String(param ?? "").trim();
      if (!key) continue;
      if (!(key in rawArgs)) {
        throw new Error(`Missing arg "${key}" in call "${name}"`);
      }
      args[key] = evalCallArgValue(rawArgs[key], scope, `call.${name}.args.${key}`);
    }
  } else {
    for (const [key, value] of Object.entries(rawArgs)) {
      args[key] = evalCallArgValue(value, scope, `call.${name}.args.${key}`);
    }
  }

  executeSteps(
    def.steps,
    { ...scope, ...args },
    defs,
    out,
    budget,
    callDepth + 1,
  );
}

function normalizeLegacyBlocks(rawBlocks: unknown[]): Block[] {
  return rawBlocks.map((raw, idx) => {
    if (!isRecord(raw)) {
      throw new Error(`Legacy blocks[${idx}] must be an object`);
    }

    return {
      x: evalIntExpr(raw.x, {}, `blocks[${idx}].x`),
      y: evalIntExpr(raw.y, {}, `blocks[${idx}].y`),
      z: evalIntExpr(raw.z, {}, `blocks[${idx}].z`),
      blockType: normalizeBlockType(raw.blockType, {}),
    };
  });
}

function normalizeCompactBlock(step: Record<string, unknown>, scope: Scope): Block {
  return {
    x: evalIntExpr(step.x, scope, "place.x"),
    y: evalIntExpr(step.y, scope, "place.y"),
    z: evalIntExpr(step.z, scope, "place.z"),
    blockType: normalizeBlockType(step.blockType, scope),
  };
}

function normalizeBlockType(raw: unknown, scope: Scope): string {
  const resolved = resolveScopedValue(raw, scope);
  let blockType = String(resolved ?? DEFAULT_BLOCK_TYPE).trim().toLowerCase();
  if (!blockType) blockType = DEFAULT_BLOCK_TYPE;

  blockType = blockType.replace(/\s+/g, "_").replace(/-/g, "_");
  if (!blockType.startsWith("minecraft:")) {
    blockType = `minecraft:${blockType}`;
  }

  if (!supportedBlockTypes.has(blockType)) {
    const fallback = pickFallbackBlockType();
    if (!warnedInvalidBlockTypes.has(blockType)) {
      warnedInvalidBlockTypes.add(blockType);
      console.warn(
        `[Gemini] Unsupported blockType "${blockType}" for catalog version ${supportedBlockCatalogVersion}; replaced with "${fallback}"`,
      );
    }
    return fallback;
  }

  return blockType;
}

function resolveScopedValue(raw: unknown, scope: Scope): unknown {
  if (typeof raw !== "string") return raw;

  const key = raw.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return raw;
  }

  const scoped = scope[key];
  return scoped === undefined ? raw : scoped;
}

function evalCallArgValue(raw: unknown, scope: Scope, field: string): ScopeValue {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }

  if (typeof raw !== "string") {
    throw new Error(`${field} must be a number or string`);
  }

  const text = raw.trim();
  if (!text) {
    throw new Error(`${field} cannot be empty`);
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text) && scope[text] !== undefined) {
    return scope[text];
  }

  try {
    return evaluateIntegerExpression(text, scope, field);
  } catch {
    return text;
  }
}

function evalIntExpr(raw: unknown, scope: Scope, field: string): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }

  if (typeof raw !== "string") {
    throw new Error(`${field} must be a number or expression string`);
  }

  const expr = raw.trim();
  if (!expr) {
    throw new Error(`${field} expression is empty`);
  }

  try {
    return evaluateIntegerExpression(expr, scope, field);
  } catch (err) {
    throw new Error(`Unsupported expression "${expr}" in ${field}: ${(err as Error).message}`);
  }
}

function applyIntOp(left: number, op: string, right: number, field: string): number {
  if (op === "+") return left + right;
  if (op === "-") return left - right;
  if (op === "*") return left * right;
  if (op === "/") {
    if (right === 0) {
      throw new Error(`Division by zero in ${field}`);
    }
    return Math.trunc(left / right);
  }
  throw new Error(`Unsupported operator "${op}" in ${field}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ExprToken =
  | { kind: "number"; value: number }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: "+" | "-" | "*" | "/" }
  | { kind: "lparen" }
  | { kind: "rparen" };

function evaluateIntegerExpression(expr: string, scope: Scope, field: string): number {
  const tokens = tokenizeExpression(expr);
  let index = 0;

  const parseExpression = (): number => {
    let value = parseTerm();
    while (index < tokens.length) {
      const t = tokens[index];
      if (t.kind !== "op" || (t.value !== "+" && t.value !== "-")) break;
      index += 1;
      const rhs = parseTerm();
      value = applyIntOp(value, t.value, rhs, field);
    }
    return value;
  };

  const parseTerm = (): number => {
    let value = parseFactor();
    while (index < tokens.length) {
      const t = tokens[index];
      if (t.kind !== "op" || (t.value !== "*" && t.value !== "/")) break;
      index += 1;
      const rhs = parseFactor();
      value = applyIntOp(value, t.value, rhs, field);
    }
    return value;
  };

  const parseFactor = (): number => {
    if (index >= tokens.length) {
      throw new Error("unexpected end of expression");
    }

    const t = tokens[index];
    if (t.kind === "op" && (t.value === "+" || t.value === "-")) {
      index += 1;
      const rhs = parseFactor();
      return t.value === "-" ? -rhs : rhs;
    }

    if (t.kind === "number") {
      index += 1;
      return t.value;
    }

    if (t.kind === "ident") {
      index += 1;
      const value = scope[t.value];
      if (value === undefined) {
        throw new Error(`unknown variable "${t.value}"`);
      }
      if (typeof value === "string") {
        const maybeInt = value.trim();
        if (/^-?\d+$/.test(maybeInt)) {
          return Number.parseInt(maybeInt, 10);
        }
        throw new Error(`variable "${t.value}" is non-numeric`);
      }
      return value;
    }

    if (t.kind === "lparen") {
      index += 1;
      const inner = parseExpression();
      const closing = tokens[index];
      if (!closing || closing.kind !== "rparen") {
        throw new Error("missing closing parenthesis");
      }
      index += 1;
      return inner;
    }

    throw new Error("unexpected token");
  };

  const result = parseExpression();
  if (index !== tokens.length) {
    throw new Error("trailing tokens");
  }
  return result;
}

function tokenizeExpression(expr: string): ExprToken[] {
  const tokens: ExprToken[] = [];
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      let j = i + 1;
      while (j < expr.length && expr[j] >= "0" && expr[j] <= "9") j += 1;
      tokens.push({ kind: "number", value: Number.parseInt(expr.slice(i, j), 10) });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j += 1;
      tokens.push({ kind: "ident", value: expr.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ kind: "op", value: ch });
      i += 1;
      continue;
    }

    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i += 1;
      continue;
    }

    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i += 1;
      continue;
    }

    throw new Error(`invalid character "${ch}"`);
  }

  if (!tokens.length) {
    throw new Error("empty expression");
  }
  return tokens;
}

function normalizeBlockCatalog(blockIds: string[]): string[] {
  const normalized = new Set<string>();

  for (const rawId of blockIds) {
    let id = String(rawId ?? "").trim().toLowerCase();
    if (!id) continue;
    id = id.replace(/\s+/g, "_").replace(/-/g, "_");
    if (!id.startsWith("minecraft:")) {
      id = `minecraft:${id}`;
    }
    normalized.add(id);
  }

  if (!normalized.size) {
    return [];
  }

  return [...normalized].sort();
}

function pickFallbackBlockType(): string {
  if (supportedBlockTypes.has(DEFAULT_BLOCK_TYPE)) {
    return DEFAULT_BLOCK_TYPE;
  }

  const first = supportedBlockTypes.values().next().value as string | undefined;
  return first ?? DEFAULT_BLOCK_TYPE;
}

function buildSystemPrompt(): string {
  const samplePalette = selectPaletteForPrompt();
  return `${BASE_SYSTEM_PROMPT}${MULTI_TURN_PROMPT_ADDITIONS}

Runtime block catalog constraints:
- Active block catalog version: ${supportedBlockCatalogVersion} (source: ${supportedBlockCatalogSource}).
- blockType MUST be from this runtime catalog.
- If uncertain, use "${pickFallbackBlockType()}" instead of inventing IDs.
- Preferred safe palette for this runtime: ${samplePalette.join(", ")}.`;
}

function selectPaletteForPrompt(): string[] {
  const promptBlockTypeLimit = getPromptBlockTypeLimit();
  const preferred: string[] = [];
  const preferredSet = new Set<string>();
  for (const id of DEFAULT_ALLOWED_BLOCK_TYPES) {
    if (supportedBlockTypes.has(id)) {
      preferred.push(id);
      preferredSet.add(id);
    }
  }

  const extra = [...supportedBlockTypes].filter((id) => !preferredSet.has(id));
  const palette = [...preferred, ...extra];

  if (promptBlockTypeLimit <= 0) {
    return palette;
  }

  return palette.slice(0, promptBlockTypeLimit);
}

function getPromptBlockTypeLimit(): number {
  const raw = process.env.PROMPT_BLOCK_TYPE_LIMIT?.trim();
  if (!raw) {
    return DEFAULT_PROMPT_BLOCK_TYPE_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PROMPT_BLOCK_TYPE_LIMIT;
  }

  return parsed;
}
