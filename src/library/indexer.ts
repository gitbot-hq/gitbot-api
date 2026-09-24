import type { Db } from "../db.js";
import type { Config } from "../config.js";
import { loadSnapshot, type Snapshot } from "./snapshot.js";
import { parseBotFolder, parseFeatured, parseVerified, type ParsedBot } from "./bot-schema.js";

export type IndexError = { slug: string; message: string };
export type IndexCounts = { total: number; added: number; updated: number; unchanged: number; removed: number; skipped: number };
export type IndexReport = {
  runId: number;
  status: "success" | "failed";
  source: string;
  commitSha: string | null;
  startedAt: string;
  finishedAt: string;
  counts: IndexCounts;
  errors: IndexError[];
  message?: string;
};

export function avatarUrl(github: string): string {
  return `https://avatars.githubusercontent.com/${github}`;
}

/** Call at boot: a run still marked running belongs to a process that died mid-index. */
export function failInterruptedRuns(db: Db, nowIso = new Date().toISOString()): number {
  return db.prepare("UPDATE index_runs SET status = 'failed', finished_at = ?, message = 'interrupted by restart' WHERE status = 'running'")
    .run(nowIso).changes;
}

/** Full reindex: load the library, apply it, record the run. Never throws; failures land in the run row. */
export async function reindex(db: Db, config: Config, now: () => Date = () => new Date()): Promise<IndexReport> {
  const startedAt = now().toISOString();
  const source = config.LIBRARY_PATH ? `local:${config.LIBRARY_PATH}` : `github:${config.LIBRARY_REPO}@${config.LIBRARY_REF}`;
  const runId = Number(db.prepare(
    "INSERT INTO index_runs (status, source, started_at) VALUES ('running', ?, ?)",
  ).run(source, startedAt).lastInsertRowid);

  try {
    const snapshot = await loadSnapshot(config);
    const { counts, errors } = applySnapshot(db, snapshot, now().toISOString());
    const finishedAt = now().toISOString();
    db.prepare(`UPDATE index_runs SET status = 'success', commit_sha = ?, finished_at = ?, bots_total = ?, bots_added = ?,
      bots_updated = ?, bots_unchanged = ?, bots_removed = ?, bots_skipped = ?, errors = ? WHERE id = ?`)
      .run(snapshot.commitSha, finishedAt, counts.total, counts.added, counts.updated, counts.unchanged, counts.removed,
        counts.skipped, JSON.stringify(errors), runId);
    return { runId, status: "success", source: snapshot.source, commitSha: snapshot.commitSha, startedAt, finishedAt, counts, errors };
  } catch (err) {
    const finishedAt = now().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE index_runs SET status = 'failed', finished_at = ?, message = ? WHERE id = ?").run(finishedAt, message, runId);
    return {
      runId, status: "failed", source, commitSha: null, startedAt, finishedAt, message,
      counts: { total: 0, added: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0 }, errors: [],
    };
  }
}

/** Groups snapshot files into bots/<slug>/ folders. */
export function botFolders(snapshot: Snapshot): Map<string, Map<string, string>> {
  const folders = new Map<string, Map<string, string>>();
  for (const [path, content] of snapshot.files) {
    const m = path.match(/^bots\/([^/]+)\/([^/]+)$/);
    if (!m) continue;
    let folder = folders.get(m[1]);
    if (!folder) folders.set(m[1], (folder = new Map()));
    folder.set(m[2], content);
  }
  return folders;
}

/** Applies one snapshot to the bots table in a single transaction. */
export function applySnapshot(db: Db, snapshot: Snapshot, nowIso: string): { counts: IndexCounts; errors: IndexError[] } {
  const errors: IndexError[] = [];
  const valid = new Map<string, ParsedBot>();
  const present = new Set<string>(); // every folder in the snapshot, valid or not

  const folders = [...botFolders(snapshot).entries()].sort(([a], [b]) => a.localeCompare(b));
  const namesSeen = new Map<string, string>();
  for (const [folder, files] of folders) {
    present.add(folder);
    const result = parseBotFolder(folder, files);
    if (!result.ok) { errors.push({ slug: folder, message: result.message }); continue; }
    const name = result.bot.json.name.toLowerCase();
    const dupe = namesSeen.get(name);
    if (dupe) { errors.push({ slug: folder, message: `name "${result.bot.json.name}" is already used by "${dupe}"` }); continue; }
    namesSeen.set(name, folder);
    valid.set(folder, result.bot);
  }

  const verified = parseVerified(snapshot.files.get("verified.json"));
  const featured = parseFeatured(snapshot.files.get("featured.json"));
  const featuredRank = new Map(featured.map((slug, i) => [slug, i + 1]));
  for (const slug of new Set([...verified, ...featured])) {
    if (present.has(slug)) continue;
    const lists = [verified.has(slug) && "verified.json", featuredRank.has(slug) && "featured.json"].filter(Boolean);
    errors.push({ slug, message: `listed in ${lists.join(" and ")} but has no folder` });
  }

  const counts: IndexCounts = { total: valid.size, added: 0, updated: 0, unchanged: 0, removed: 0, skipped: errors.length };

  const existing = db.prepare("SELECT slug, content_hash, removed_at FROM bots");
  const insert = db.prepare(`INSERT INTO bots (slug, name, description, category, about, features, example_prompt,
    author_github, author_name, author_avatar_url, mascot_body, mascot_color, mascot_activity, emoji, agent, permission_mode,
    model, allowed_tools, disallowed_tools, instructions, setup_instructions, verified_repo, featured_rank, content_hash, raw_json,
    first_seen_at, updated_at)
    VALUES (@slug, @name, @description, @category, @about, @features, @example_prompt, @author_github, @author_name,
    @author_avatar_url, @mascot_body, @mascot_color, @mascot_activity, @emoji, @agent, @permission_mode, @model, @allowed_tools,
    @disallowed_tools, @instructions, @setup_instructions, @verified_repo, @featured_rank, @content_hash, @raw_json, @now, @now)`);
  const update = db.prepare(`UPDATE bots SET name = @name, description = @description, category = @category, about = @about,
    features = @features, example_prompt = @example_prompt, author_github = @author_github, author_name = @author_name,
    author_avatar_url = @author_avatar_url, mascot_body = @mascot_body, mascot_color = @mascot_color, mascot_activity = @mascot_activity,
    emoji = @emoji, agent = @agent, permission_mode = @permission_mode, model = @model, allowed_tools = @allowed_tools,
    disallowed_tools = @disallowed_tools, instructions = @instructions, setup_instructions = @setup_instructions,
    verified_repo = @verified_repo, featured_rank = @featured_rank, content_hash = @content_hash, raw_json = @raw_json,
    updated_at = @now, removed_at = NULL WHERE slug = @slug`);
  const touch = db.prepare("UPDATE bots SET verified_repo = ?, featured_rank = ?, removed_at = NULL WHERE slug = ?");
  const remove = db.prepare("UPDATE bots SET removed_at = ? WHERE slug = ?");

  db.transaction(() => {
    const rows = new Map((existing.all() as { slug: string; content_hash: string; removed_at: string | null }[]).map((r) => [r.slug, r]));
    for (const [slug, bot] of valid) {
      const row = rows.get(slug);
      const params = toRow(slug, bot, verified.has(slug), featuredRank.get(slug) ?? null, nowIso);
      if (!row) { insert.run(params); counts.added++; }
      else if (row.content_hash !== bot.contentHash || row.removed_at) { update.run(params); counts.updated++; }
      else { touch.run(params.verified_repo, params.featured_rank, slug); counts.unchanged++; }
    }
    for (const [slug, row] of rows) {
      // A folder that failed validation keeps its last good version; only folders gone from main are removed.
      if (!present.has(slug) && !row.removed_at) { remove.run(nowIso, slug); counts.removed++; }
    }
  })();

  return { counts, errors };
}

function toRow(slug: string, bot: ParsedBot, verified: boolean, featuredRank: number | null, now: string) {
  const j = bot.json;
  return {
    slug, name: j.name, description: j.description, category: j.category, about: j.about,
    features: JSON.stringify(j.features), example_prompt: j.examplePrompt,
    author_github: j.author.github, author_name: j.author.name, author_avatar_url: avatarUrl(j.author.github),
    mascot_body: j.mascot.body, mascot_color: j.mascot.color, mascot_activity: j.mascot.activity,
    emoji: j.emoji, agent: j.agent, permission_mode: j.permissionMode, model: j.model ?? null,
    allowed_tools: j.allowedTools ? JSON.stringify(j.allowedTools) : null,
    disallowed_tools: j.disallowedTools ? JSON.stringify(j.disallowedTools) : null,
    instructions: bot.instructions, setup_instructions: bot.setupInstructions,
    verified_repo: verified ? 1 : 0, featured_rank: featuredRank, content_hash: bot.contentHash, raw_json: bot.rawJson, now,
  };
}
