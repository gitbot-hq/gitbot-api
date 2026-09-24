/** Read side of the bots table: SQL + row → API shape. Shared by public and admin routes. */
import type { Db } from "../db.js";
import { AGENTS, CATEGORIES, PERMISSION_MODES } from "./bot-schema.js";

export type BotRow = {
  slug: string; name: string; description: string; category: string; about: string; features: string;
  example_prompt: string; author_github: string; author_name: string; author_avatar_url: string;
  mascot_body: string; mascot_color: string; mascot_activity: string; emoji: string; agent: string;
  permission_mode: string; model: string | null; allowed_tools: string | null; disallowed_tools: string | null;
  instructions: string; setup_instructions: string | null; verified_repo: number; verified_override: number | null;
  featured_rank: number | null; content_hash: string; raw_json: string; install_count: number;
  first_seen_at: string; updated_at: string; removed_at: string | null;
};

/** What a marketplace card needs. Never carries instructions. */
export type BotCard = {
  slug: string; name: string; description: string; category: string; emoji: string;
  author: { github: string; name: string; avatarUrl: string };
  mascot: { body: string; color: string; cssColor: string; activity: string };
  agent: string; permissionMode: string;
  verified: boolean; featured: boolean; featuredRank: number | null;
  hasSetup: boolean; installCount: number; createdAt: string; updatedAt: string;
};

/** The detail page and the install payload. */
export type BotDetail = BotCard & {
  about: string; features: string[]; examplePrompt: string; model: string | null;
  allowedTools: string[] | null; disallowedTools: string[] | null;
  instructions: string; setupInstructions: string | null; shareCode: string;
};

export const SORTS = ["featured", "newest", "updated", "popular", "name"] as const;
export type Sort = (typeof SORTS)[number];

export type ListParams = {
  q?: string; category?: string; agent?: string; verified?: boolean; featured?: boolean;
  sort: Sort; limit: number; offset: number;
};

export function isVerified(row: Pick<BotRow, "verified_repo" | "verified_override">): boolean {
  return row.verified_override === null || row.verified_override === undefined
    ? row.verified_repo === 1
    : row.verified_override === 1;
}

export function toCard(row: BotRow): BotCard {
  return {
    slug: row.slug, name: row.name, description: row.description, category: row.category, emoji: row.emoji,
    author: { github: row.author_github, name: row.author_name, avatarUrl: row.author_avatar_url },
    mascot: { body: row.mascot_body, color: row.mascot_color, cssColor: `var(--${row.mascot_color})`, activity: row.mascot_activity },
    agent: row.agent, permissionMode: row.permission_mode,
    verified: isVerified(row), featured: row.featured_rank !== null, featuredRank: row.featured_rank,
    hasSetup: row.setup_instructions !== null, installCount: row.install_count,
    createdAt: row.first_seen_at, updatedAt: row.updated_at,
  };
}

export function toDetail(row: BotRow): BotDetail {
  const allowedTools = row.allowed_tools ? (JSON.parse(row.allowed_tools) as string[]) : null;
  const disallowedTools = row.disallowed_tools ? (JSON.parse(row.disallowed_tools) as string[]) : null;
  return {
    ...toCard(row),
    about: row.about, features: JSON.parse(row.features) as string[], examplePrompt: row.example_prompt,
    model: row.model, allowedTools, disallowedTools,
    instructions: row.instructions, setupInstructions: row.setup_instructions,
    shareCode: shareCode(row, allowedTools, disallowedTools),
  };
}

/** Same encoding as gitbot's ui/app/lib/share.ts, so the UI can reuse its import path. */
export function shareCode(row: BotRow, allowedTools: string[] | null, disallowedTools: string[] | null): string {
  const payload: Record<string, unknown> = {
    name: row.name, emoji: row.emoji, description: row.description, instructions: row.instructions, agent: row.agent,
  };
  if (row.setup_instructions) payload.setupInstructions = row.setup_instructions;
  if (row.model) payload.model = row.model;
  payload.permissionMode = row.permission_mode;
  if (allowedTools?.length) payload.allowedTools = allowedTools;
  if (disallowedTools?.length) payload.disallowedTools = disallowedTools;
  return "gitbot:v1:" + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

const ORDER: Record<Sort, string> = {
  featured: "CASE WHEN featured_rank IS NULL THEN 1 ELSE 0 END, featured_rank ASC, name COLLATE NOCASE ASC",
  newest: "first_seen_at DESC, name COLLATE NOCASE ASC",
  updated: "updated_at DESC, name COLLATE NOCASE ASC",
  popular: "install_count DESC, name COLLATE NOCASE ASC",
  name: "name COLLATE NOCASE ASC",
};

const VERIFIED_SQL = "COALESCE(verified_override, verified_repo) = 1";

export function listBots(db: Db, p: ListParams): { bots: BotCard[]; total: number } {
  const where: string[] = ["removed_at IS NULL"];
  const args: unknown[] = [];
  if (p.q) {
    const like = `%${p.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR about LIKE ? ESCAPE '\\' OR author_name LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  if (p.category) { where.push("category = ?"); args.push(p.category); }
  if (p.agent) { where.push("agent = ?"); args.push(p.agent); }
  if (p.verified !== undefined) where.push(p.verified ? VERIFIED_SQL : `NOT (${VERIFIED_SQL})`);
  if (p.featured !== undefined) where.push(p.featured ? "featured_rank IS NOT NULL" : "featured_rank IS NULL");
  const sql = `FROM bots WHERE ${where.join(" AND ")}`;
  const total = db.prepare(`SELECT COUNT(*) ${sql}`).pluck().get(...args) as number;
  const rows = db.prepare(`SELECT * ${sql} ORDER BY ${ORDER[p.sort]} LIMIT ? OFFSET ?`).all(...args, p.limit, p.offset) as BotRow[];
  return { bots: rows.map(toCard), total };
}

export function getBot(db: Db, slug: string): BotRow | undefined {
  return db.prepare("SELECT * FROM bots WHERE slug = ?").get(slug) as BotRow | undefined;
}

export function categoryCounts(db: Db): { name: string; count: number }[] {
  const rows = db.prepare("SELECT category, COUNT(*) AS n FROM bots WHERE removed_at IS NULL GROUP BY category").all() as { category: string; n: number }[];
  const counts = new Map(rows.map((r) => [r.category, r.n]));
  return CATEGORIES.map((name) => ({ name, count: counts.get(name) ?? 0 }));
}

export type IndexInfo = { runId: number; source: string; commitSha: string | null; indexedAt: string; botCount: number };

export function lastIndex(db: Db): IndexInfo | null {
  const run = db.prepare("SELECT id, source, commit_sha, finished_at FROM index_runs WHERE status = 'success' ORDER BY id DESC LIMIT 1")
    .get() as { id: number; source: string; commit_sha: string | null; finished_at: string } | undefined;
  if (!run) return null;
  const botCount = db.prepare("SELECT COUNT(*) FROM bots WHERE removed_at IS NULL").pluck().get() as number;
  return { runId: run.id, source: run.source, commitSha: run.commit_sha, indexedAt: run.finished_at, botCount };
}

export function recordInstall(db: Db, slug: string, agent: string | null, nowIso: string): number {
  return db.transaction(() => {
    db.prepare("INSERT INTO bot_installs (slug, agent, installed_at) VALUES (?, ?, ?)").run(slug, agent, nowIso);
    db.prepare("UPDATE bots SET install_count = install_count + 1 WHERE slug = ?").run(slug);
    return db.prepare("SELECT install_count FROM bots WHERE slug = ?").pluck().get(slug) as number;
  })();
}

export { AGENTS, CATEGORIES, PERMISSION_MODES };
