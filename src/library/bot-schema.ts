/**
 * Validation for one bot folder, mirroring gitbot-hq/Library docs/bot-schema.md.
 * Anything that would render a blank card or break an install is a hard error.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const CATEGORIES = [
  "Code review", "Developer workflow", "Releases", "Maintenance",
  "Repository care", "Code exploration", "Testing", "Documentation",
] as const;
export const MASCOT_BODIES = [
  "bear", "belly", "birdy", "birdy-3", "bunny", "burdy2", "cat", "cloud", "doggy", "fire",
  "flower", "ghost", "heart", "moon", "rectangle", "star", "triangle", "tulip",
] as const;
export const MASCOT_COLORS = ["brand-sun", "brand-candy", "brand-ember", "brand-leaf", "brand-sky", "brand-honey"] as const;
export const MASCOT_ACTIVITIES = ["idle", "reading", "listening", "thinking", "working", "success", "error", "sleeping"] as const;
export const AGENTS = ["claude-code", "codex", "opencode"] as const;
export const PERMISSION_MODES = ["ask-permissions", "auto-approve", "plan"] as const;

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_INSTRUCTION_WORDS = 650; // the spec says "~600"

const trimmed = (max: number, min = 1) => z.string().trim().min(min).max(max);
const toolList = z.array(z.string().trim().min(1)).min(1).optional();

export const botJsonSchema = z.object({
  $schema: z.string().optional(),
  slug: z.string().regex(SLUG_RE, "lowercase words separated by single hyphens"),
  name: trimmed(24),
  description: trimmed(80),
  category: z.enum(CATEGORIES),
  about: trimmed(400, 120),
  features: z.array(trimmed(60)).length(3, "exactly 3 features"),
  examplePrompt: trimmed(200),
  author: z.object({
    github: z.string().trim().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, "GitHub handle"),
    name: trimmed(80),
  }),
  mascot: z.object({
    body: z.enum(MASCOT_BODIES).default("ghost"),
    color: z.enum(MASCOT_COLORS).default("brand-sun"),
    activity: z.enum(MASCOT_ACTIVITIES).default("idle"),
  }).default({ body: "ghost", color: "brand-sun", activity: "idle" }),
  emoji: z.string().trim().min(1).max(16),
  agent: z.enum(AGENTS),
  permissionMode: z.enum(PERMISSION_MODES),
  model: z.string().trim().min(1).optional(),
  allowedTools: toolList,
  disallowedTools: toolList,
}).refine((b) => b.agent !== "opencode" || !!b.model, { message: "model is required when agent is opencode", path: ["model"] });

export type BotJson = z.infer<typeof botJsonSchema>;

/** A bot folder, validated and ready to store. */
export type ParsedBot = {
  json: BotJson;
  instructions: string;
  setupInstructions: string | null;
  contentHash: string;
  rawJson: string;
};

export type ParseResult = { ok: true; bot: ParsedBot } | { ok: false; message: string };

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * @param folder the folder name under bots/, which must equal the slug
 * @param files  file name → content for that folder
 */
export function parseBotFolder(folder: string, files: Map<string, string>): ParseResult {
  const raw = files.get("bot.json");
  if (raw === undefined) return { ok: false, message: "bot.json is missing" };
  let data: unknown;
  try { data = JSON.parse(raw); } catch (e) { return { ok: false, message: `bot.json is not valid JSON: ${(e as Error).message}` }; }

  const parsed = botJsonSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "bot.json"}: ${i.message}`);
    return { ok: false, message: `bot.json: ${issues.join("; ")}` };
  }
  const json = parsed.data;
  if (json.slug !== folder) return { ok: false, message: `slug "${json.slug}" does not match folder name "${folder}"` };

  const instructions = files.get("instructions.md")?.trim() ?? "";
  if (!instructions) return { ok: false, message: "instructions.md is missing or empty" };
  const words = wordCount(instructions);
  if (words > MAX_INSTRUCTION_WORDS) return { ok: false, message: `instructions.md is ${words} words (max ${MAX_INSTRUCTION_WORDS})` };

  const setup = files.get("setup.md")?.trim();
  const setupInstructions = setup ? setup : null;

  const known = new Set(["bot.json", "instructions.md", "setup.md"]);
  const extras = [...files.keys()].filter((f) => !known.has(f));
  if (extras.length) return { ok: false, message: `unexpected files in folder: ${extras.join(", ")}` };

  const contentHash = createHash("sha256")
    .update(raw).update("\0").update(instructions).update("\0").update(setupInstructions ?? "")
    .digest("hex");

  return { ok: true, bot: { json, instructions, setupInstructions, contentHash, rawJson: raw } };
}

/** verified.json: `["slug", ...]` or `{ "slug": true, ... }`. Unknown shapes are ignored. */
export function parseVerified(text: string | undefined): Set<string> {
  return new Set(parseSlugList(text, "verified"));
}

/** featured.json: `["slug", ...]` (ordered) or `{ "featured": [...] }`. */
export function parseFeatured(text: string | undefined): string[] {
  return parseSlugList(text, "featured");
}

function parseSlugList(text: string | undefined, key: string): string[] {
  if (!text) return [];
  let data: unknown;
  try { data = JSON.parse(text); } catch { return []; }
  if (Array.isArray(data)) return data.filter((s): s is string => typeof s === "string");
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj[key])) return (obj[key] as unknown[]).filter((s): s is string => typeof s === "string");
    return Object.entries(obj).filter(([, v]) => v === true).map(([k]) => k);
  }
  return [];
}
