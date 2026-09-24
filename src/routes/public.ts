import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../http-error.js";
import { AGENTS, CATEGORIES, SLUG_RE } from "../library/bot-schema.js";
import { categoryCounts, getBot, lastIndex, listBots, recordInstall, SORTS, toDetail } from "../library/queries.js";

const CACHE_SECONDS = 60;

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.enum(CATEGORIES).optional(),
  agent: z.enum(AGENTS).optional(),
  verified: bool.optional(),
  featured: bool.optional(),
  sort: z.enum(SORTS).default("featured"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const slugParams = z.object({ slug: z.string().regex(SLUG_RE) });
const installBody = z.object({ agent: z.enum(AGENTS).optional() }).strict().optional();

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw new HttpError(400, "VALIDATION", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}

/** Weak ETag + short public cache on every successful GET in this plugin. */
async function cacheHook(req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  if (req.method !== "GET" || reply.statusCode !== 200 || typeof payload !== "string") return payload;
  const etag = `W/"${createHash("sha1").update(payload).digest("base64url")}"`;
  reply.header("ETag", etag);
  reply.header("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
  if (req.headers["if-none-match"] === etag) {
    reply.code(304);
    return "";
  }
  return payload;
}

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;
  app.addHook("onSend", cacheHook);

  app.get("/v1/bots", async (req) => {
    const params = parse(listQuery, req.query);
    const { bots, total } = listBots(db, params);
    return { bots, total, limit: params.limit, offset: params.offset };
  });

  app.get("/v1/bots/:slug", async (req) => {
    const { slug } = parse(slugParams, req.params);
    const row = getBot(db, slug);
    if (!row) throw new HttpError(404, "BOT_NOT_FOUND", `No bot with slug "${slug}"`);
    if (row.removed_at) throw new HttpError(410, "BOT_REMOVED", `Bot "${slug}" was removed from the library`);
    return { bot: toDetail(row) };
  });

  app.get("/v1/categories", async () => ({ categories: categoryCounts(db) }));

  app.get("/v1/index", async () => ({ index: lastIndex(db) }));

  app.post("/v1/bots/:slug/installs", async (req) => {
    const { slug } = parse(slugParams, req.params);
    const body = parse(installBody, req.body ?? undefined);
    const row = getBot(db, slug);
    if (!row || row.removed_at) throw new HttpError(404, "BOT_NOT_FOUND", `No bot with slug "${slug}"`);
    const installCount = recordInstall(db, slug, body?.agent ?? null, new Date().toISOString());
    return { slug, installCount };
  });
}
