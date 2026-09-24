import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, cpSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "../db.js";
import { reindex, failInterruptedRuns } from "./indexer.js";
import { KNOWN_SLUGS, tempLibrary, testConfig } from "../test-helpers.js";

describe("reindex lifecycle", () => {
  let db: Db;
  let lib: ReturnType<typeof tempLibrary>;
  const run = () => reindex(db, testConfig({ LIBRARY_PATH: lib.path }));
  const rows = () => db.prepare("SELECT slug, content_hash, verified_repo, featured_rank, updated_at, removed_at FROM bots ORDER BY slug").all() as any[];

  beforeEach(() => { db = openDb(":memory:"); lib = tempLibrary(); });
  afterEach(() => { db.close(); lib.cleanup(); });

  it("adds, then reports unchanged", async () => {
    const first = await run();
    expect(first.status).toBe("success");
    expect(first.counts.added).toBeGreaterThanOrEqual(KNOWN_SLUGS.length);
    expect(first.counts.added).toBe(first.counts.total);
    expect(first.errors).toEqual([]);
    expect(first.commitSha).toBeNull(); // temp copy has no .git
    for (const slug of KNOWN_SLUGS) expect(rows().find((r) => r.slug === slug)).toBeTruthy();

    const second = await run();
    expect(second.counts).toMatchObject({ added: 0, updated: 0, unchanged: first.counts.total, removed: 0 });
  });

  it("updates on content change, keeps updated_at otherwise", async () => {
    await run();
    const lumieBefore = rows().find((r) => r.slug === "lumie");
    const granolaBefore = rows().find((r) => r.slug === "granola-meme-deck");
    await new Promise((res) => setTimeout(res, 5)); // so a changed updated_at is observable
    appendFileSync(join(lib.path, "bots/lumie/instructions.md"), "\nOne more rule.\n");
    const r = await run();
    expect(r.counts.updated).toBe(1);
    const lumieAfter = rows().find((r) => r.slug === "lumie");
    expect(lumieAfter.content_hash).not.toBe(lumieBefore.content_hash);
    expect(lumieAfter.updated_at).not.toBe(lumieBefore.updated_at);
    expect(rows().find((r) => r.slug === "granola-meme-deck").updated_at).toBe(granolaBefore.updated_at);
  });

  it("applies verified.json and featured.json without touching updated_at", async () => {
    await run();
    const before = rows();
    writeFileSync(join(lib.path, "verified.json"), '["lumie"]');
    writeFileSync(join(lib.path, "featured.json"), '{"featured":["granola-meme-deck","lumie","ghost"]}');
    const r = await run();
    expect(r.counts.updated).toBe(0);
    expect(r.errors).toEqual([{ slug: "ghost", message: "listed in featured.json but has no folder" }]);
    const after = rows();
    expect(after.find((x) => x.slug === "lumie")).toMatchObject({ verified_repo: 1, featured_rank: 2 });
    expect(after.find((x) => x.slug === "granola-meme-deck")).toMatchObject({ verified_repo: 0, featured_rank: 1 });
    for (const b of before) expect(after.find((x) => x.slug === b.slug).updated_at).toBe(b.updated_at);
  });

  it("skips an invalid folder and keeps its last good version", async () => {
    await run();
    writeFileSync(join(lib.path, "bots/lumie/bot.json"), "{ not json");
    const r = await run();
    expect(r.counts.skipped).toBe(1);
    expect(r.errors[0]).toMatchObject({ slug: "lumie" });
    expect(r.errors[0].message).toMatch(/not valid JSON/);
    expect(rows().find((x) => x.slug === "lumie").removed_at).toBeNull();
  });

  it("soft-removes a deleted folder and revives it when it returns", async () => {
    await run();
    const backup = join(lib.path, "..", `lumie-backup-${process.pid}`);
    cpSync(join(lib.path, "bots/lumie"), backup, { recursive: true });
    rmSync(join(lib.path, "bots/lumie"), { recursive: true });
    const removed = await run();
    expect(removed.counts.removed).toBe(1);
    expect(rows().find((x) => x.slug === "lumie").removed_at).not.toBeNull();
    expect((await run()).counts.removed).toBe(0); // already removed: not counted again

    cpSync(backup, join(lib.path, "bots/lumie"), { recursive: true });
    rmSync(backup, { recursive: true });
    const revived = await run();
    expect(revived.counts.updated).toBe(1);
    expect(rows().find((x) => x.slug === "lumie").removed_at).toBeNull();
  });

  it("rejects duplicate names and slug/folder mismatches", async () => {
    cpSync(join(lib.path, "bots/lumie"), join(lib.path, "bots/lumie-copy"), { recursive: true });
    mkdirSync(join(lib.path, "bots/other"));
    cpSync(join(lib.path, "bots/granola-meme-deck"), join(lib.path, "bots/other"), { recursive: true });
    const j = JSON.parse(readFileSync(join(lib.path, "bots/other/bot.json"), "utf8"));
    j.slug = "other";
    writeFileSync(join(lib.path, "bots/other/bot.json"), JSON.stringify(j));
    const r = await run();
    expect(r.counts.skipped).toBe(2);
    expect(r.errors.map((e) => e.slug).sort()).toEqual(["lumie-copy", "other"]);
    expect(r.errors.find((e) => e.slug === "other")!.message).toMatch(/already used/);
  });

  it("records a failed run when the source cannot be read", async () => {
    const r = await reindex(db, testConfig({ LIBRARY_PATH: "/nonexistent/path" }));
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/ENOENT/);
    const row = db.prepare("SELECT status, message FROM index_runs WHERE id = ?").get(r.runId) as any;
    expect(row).toMatchObject({ status: "failed" });
  });

  it("marks interrupted runs failed", () => {
    db.prepare("INSERT INTO index_runs (status, source, started_at) VALUES ('running', 'x', 'y')").run();
    expect(failInterruptedRuns(db)).toBe(1);
    expect(failInterruptedRuns(db)).toBe(0);
    expect(db.prepare("SELECT message FROM index_runs").pluck().get()).toBe("interrupted by restart");
  });
});
