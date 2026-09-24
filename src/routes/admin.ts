import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../http-error.js";
import { SLUG_RE } from "../library/bot-schema.js";
import { reindex, type IndexReport } from "../library/indexer.js";
import { getBot, toCard } from "../library/queries.js";
import { parse } from "./public.js";

export const ADMIN_HEADER = "x-admin-secret";

function secretMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const runsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
const slugParams = z.object({ slug: z.string().regex(SLUG_RE) });
const verifiedBody = z.object({ verified: z.boolean().nullable() }).strict();

type RunRow = {
  id: number; status: string; source: string; commit_sha: string | null; started_at: string; finished_at: string | null;
  bots_total: number | null; bots_added: number | null; bots_updated: number | null; bots_unchanged: number | null;
  bots_removed: number | null; bots_skipped: number | null; errors: string; message: string | null;
};

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.ctx;
  let inFlight: Promise<IndexReport> | null = null;

  app.addHook("preHandler", async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!secretMatches(req.headers[ADMIN_HEADER], config.ADMIN_SECRET)) {
      throw new HttpError(401, "UNAUTHORIZED", `Missing or invalid ${ADMIN_HEADER} header`);
    }
  });

  /** Re-reads the library's main branch into the database. One run at a time. */
  app.post("/admin/reindex", async (req, reply) => {
    if (inFlight) throw new HttpError(409, "REINDEX_IN_PROGRESS", "A reindex is already running");
    inFlight = reindex(db, config);
    try {
      const run = await inFlight;
      req.log.info({ run }, "reindex finished");
      if (run.status === "failed") reply.code(502);
      return { run };
    } finally {
      inFlight = null;
    }
  });

  app.get("/admin/runs", async (req) => {
    const { limit } = parse(runsQuery, req.query);
    const rows = db.prepare("SELECT * FROM index_runs ORDER BY id DESC LIMIT ?").all(limit) as RunRow[];
    const runs = rows.map((r) => ({
      id: r.id, status: r.status, source: r.source, commitSha: r.commit_sha, startedAt: r.started_at, finishedAt: r.finished_at,
      counts: r.status === "success"
        ? { total: r.bots_total, added: r.bots_added, updated: r.bots_updated, unchanged: r.bots_unchanged, removed: r.bots_removed, skipped: r.bots_skipped }
        : null,
      errors: JSON.parse(r.errors) as unknown[],
      message: r.message,
    }));
    return { runs, running: inFlight !== null };
  });

  /** Sets or clears the manual verified badge. `null` returns the bot to whatever verified.json says. */
  app.patch("/admin/bots/:slug", async (req) => {
    const { slug } = parse(slugParams, req.params);
    const { verified } = parse(verifiedBody, req.body);
    if (!getBot(db, slug)) throw new HttpError(404, "BOT_NOT_FOUND", `No bot with slug "${slug}"`);
    db.prepare("UPDATE bots SET verified_override = ? WHERE slug = ?").run(verified === null ? null : verified ? 1 : 0, slug);
    const row = getBot(db, slug)!;
    return { bot: { ...toCard(row), verifiedOverride: verified, verifiedRepo: row.verified_repo === 1, removedAt: row.removed_at } };
  });
}
