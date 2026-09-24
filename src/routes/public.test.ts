import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { reindex } from "../library/indexer.js";
import { KNOWN_SLUGS, testApp, testConfig } from "../test-helpers.js";

describe("public routes", () => {
  let t: Awaited<ReturnType<typeof testApp>>;

  beforeAll(async () => {
    const config = testConfig();
    const db = openDb(":memory:");
    const run = await reindex(db, config);
    expect(run.status).toBe("success");
    db.prepare("UPDATE bots SET verified_override = 1 WHERE slug = 'lumie'").run();
    db.prepare("UPDATE bots SET featured_rank = 1 WHERE slug = 'granola-meme-deck'").run();
    db.prepare(`INSERT INTO bots SELECT 'old-bot', 'Old Bot', description, category, about, features, example_prompt, author_github,
      author_name, author_avatar_url, mascot_body, mascot_color, mascot_activity, emoji, agent, permission_mode, model, allowed_tools,
      disallowed_tools, instructions, setup_instructions, 0, NULL, NULL, 'x', raw_json, 0, first_seen_at, updated_at, '2026-01-01T00:00:00Z'
      FROM bots WHERE slug = 'lumie'`).run();
    t = await testApp(config, db);
  });
  afterAll(() => t.close());

  const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: "GET", url, headers });
  const slugs = async (url: string) => ((await get(url)).json().bots as { slug: string }[]).map((b) => b.slug);

  it("GET /health", async () => {
    expect((await get("/health")).json()).toEqual({ ok: true });
  });

  it("lists cards without instructions, featured first, removed hidden", async () => {
    const res = await get("/v1/bots");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ limit: 50, offset: 0 });
    expect(body.total).toBe(body.bots.length);
    const list = body.bots as any[];
    expect(list[0].slug).toBe("granola-meme-deck");
    expect(list.map((b) => b.slug)).not.toContain("old-bot");
    for (const slug of KNOWN_SLUGS) expect(list.map((b) => b.slug)).toContain(slug);
    const lumie = list.find((b) => b.slug === "lumie");
    expect(lumie).toMatchObject({
      name: "Lumie", category: "Developer workflow", agent: "claude-code", permissionMode: "auto-approve",
      verified: true, featured: false, featuredRank: null, hasSetup: true, installCount: 0,
      author: { github: "crocsarecool", avatarUrl: "https://avatars.githubusercontent.com/crocsarecool" },
      mascot: { body: "star", color: "brand-candy", cssColor: "var(--brand-candy)", activity: "working" },
    });
    expect(lumie.instructions).toBeUndefined();
    expect(lumie.about).toBeUndefined();
  });

  it("filters", async () => {
    expect(await slugs("/v1/bots?q=luma")).toEqual(["lumie"]);
    expect(await slugs("/v1/bots?q=Raunaq")).toEqual(expect.arrayContaining(KNOWN_SLUGS));
    expect(await slugs("/v1/bots?q=%25")).toEqual([]); // literal % is escaped, matches nothing
    expect(await slugs("/v1/bots?q=zzzz")).toEqual([]);
    expect(await slugs("/v1/bots?category=Testing")).toEqual([]);
    expect(await slugs("/v1/bots?category=Developer%20workflow")).toEqual(expect.arrayContaining(KNOWN_SLUGS));
    expect(await slugs("/v1/bots?agent=codex")).toEqual([]);
    expect(await slugs("/v1/bots?verified=true")).toEqual(["lumie"]);
    expect(await slugs("/v1/bots?verified=false")).not.toContain("lumie");
    expect(await slugs("/v1/bots?featured=1")).toEqual(["granola-meme-deck"]);
    expect(await slugs("/v1/bots?sort=name&limit=1")).toEqual(["granola-meme-deck"]);
    expect(await slugs("/v1/bots?sort=name&limit=1&offset=1")).toEqual(["lumie"]);
    expect((await get("/v1/bots?limit=1")).json().total).toBeGreaterThanOrEqual(2);
  });

  it.each(["category=Nope", "sort=random", "limit=0", "limit=101", "offset=-1", "verified=maybe", "agent=gpt", `q=${"a".repeat(101)}`])(
    "rejects ?%s with 400", async (qs) => {
      const res = await get(`/v1/bots?${qs}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION");
    });

  it("returns full detail with a decodable share code", async () => {
    const res = await get("/v1/bots/lumie");
    expect(res.statusCode).toBe(200);
    const bot = res.json().bot;
    expect(bot.features).toHaveLength(3);
    expect(bot.instructions).toMatch(/Luma/);
    expect(bot.setupInstructions).toMatch(/LUMA_API_KEY/);
    expect(bot).toMatchObject({ model: null, allowedTools: null, disallowedTools: null, verified: true });
    expect(bot.shareCode).toMatch(/^gitbot:v1:/);
    const payload = JSON.parse(Buffer.from(bot.shareCode.slice("gitbot:v1:".length), "base64url").toString("utf8"));
    expect(payload).toEqual({
      name: "Lumie", emoji: bot.emoji, description: bot.description, instructions: bot.instructions, agent: "claude-code",
      setupInstructions: bot.setupInstructions, permissionMode: "auto-approve",
    });
  });

  it("404 unknown, 410 removed, 400 malformed slug", async () => {
    expect((await get("/v1/bots/nope")).statusCode).toBe(404);
    expect((await get("/v1/bots/nope")).json().error.code).toBe("BOT_NOT_FOUND");
    const gone = await get("/v1/bots/old-bot");
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error.code).toBe("BOT_REMOVED");
    expect((await get("/v1/bots/Bad_Slug")).statusCode).toBe(400);
  });

  it("categories include zeros", async () => {
    const cats = (await get("/v1/categories")).json().categories as { name: string; count: number }[];
    expect(cats).toHaveLength(8);
    expect(cats.find((c) => c.name === "Developer workflow")!.count).toBeGreaterThanOrEqual(2);
    expect(cats.find((c) => c.name === "Testing")).toEqual({ name: "Testing", count: 0 });
  });

  it("index reports the last successful run", async () => {
    const { index } = (await get("/v1/index")).json();
    expect(index).toMatchObject({ runId: 1, source: expect.stringMatching(/^local:/) });
    expect(index.botCount).toBeGreaterThanOrEqual(2);
    expect(index.commitSha).toMatch(/^[0-9a-f]{40}$/); // real checkout has git
  });

  it("counts installs", async () => {
    const post = (payload?: string | object) => t.app.inject({ method: "POST", url: "/v1/bots/lumie/installs", payload });
    expect((await post()).json()).toEqual({ slug: "lumie", installCount: 1 });
    expect((await post({ agent: "codex" })).json().installCount).toBe(2);
    expect((await post({ agent: "gpt" })).statusCode).toBe(400);
    expect((await post({ agent: "codex", extra: 1 })).statusCode).toBe(400);
    const badJson = await t.app.inject({ method: "POST", url: "/v1/bots/lumie/installs", headers: { "content-type": "application/json" }, payload: "{not json" });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().error.code).toBe("FST_ERR_CTP_INVALID_JSON_BODY");
    expect((await t.app.inject({ method: "POST", url: "/v1/bots/old-bot/installs" })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "POST", url: "/v1/bots/nope/installs" })).statusCode).toBe(404);
    expect(t.db.prepare("SELECT agent FROM bot_installs ORDER BY id").pluck().all()).toEqual([null, "codex"]);
    expect((await get("/v1/bots?sort=popular")).json().bots[0].slug).toBe("lumie");
  });

  it("sets ETag and cache headers on GET 200 only, honours If-None-Match", async () => {
    const res = await get("/v1/bots");
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    const etag = res.headers.etag as string;
    expect(etag).toMatch(/^W\/"/);
    const again = await get("/v1/bots", { "if-none-match": etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    expect((await get("/v1/bots/nope")).headers.etag).toBeUndefined();
    const post = await t.app.inject({ method: "POST", url: "/v1/bots/lumie/installs" });
    expect(post.headers["cache-control"]).toBeUndefined();
  });

  it("unknown routes use the error envelope", async () => {
    const res = await get("/nope");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });
});
