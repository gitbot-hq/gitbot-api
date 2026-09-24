import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_SECRET, tempLibrary, testApp, testConfig } from "../test-helpers.js";

describe("admin routes", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let lib: ReturnType<typeof tempLibrary>;
  const auth = { "x-admin-secret": ADMIN_SECRET };

  beforeEach(async () => {
    lib = tempLibrary();
    t = await testApp(testConfig({ LIBRARY_PATH: lib.path }));
  });
  afterEach(async () => { await t.close(); lib.cleanup(); });

  const reindex = (headers = auth) => t.app.inject({ method: "POST", url: "/admin/reindex", headers });
  const patch = (slug: string, payload: string | object, headers = auth) =>
    t.app.inject({ method: "PATCH", url: `/admin/bots/${slug}`, headers, payload });

  it.each([{}, { "x-admin-secret": "wrong" }, { "x-admin-secret": ADMIN_SECRET + "x" }, { "x-admin-secret": "" }])(
    "rejects %o with 401", async (headers) => {
      for (const res of [await reindex(headers as any), await t.app.inject({ method: "GET", url: "/admin/runs", headers: headers as any }), await patch("lumie", { verified: true }, headers as any)]) {
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe("UNAUTHORIZED");
      }
    });

  it("reindexes and lists runs", async () => {
    const res = await reindex();
    expect(res.statusCode).toBe(200);
    expect(res.json().run).toMatchObject({ runId: 1, status: "success" });
    expect(res.json().run.counts.added).toBeGreaterThanOrEqual(2);
    expect(res.headers.etag).toBeUndefined();

    const runs = await t.app.inject({ method: "GET", url: "/admin/runs", headers: auth });
    expect(runs.json().running).toBe(false);
    expect(runs.json().runs).toHaveLength(1);
    expect(runs.json().runs[0]).toMatchObject({ id: 1, status: "success", errors: [] });
    expect((await t.app.inject({ method: "GET", url: "/admin/runs?limit=0", headers: auth })).statusCode).toBe(400);
  });

  it("returns 409 while a reindex is in flight", async () => {
    const [a, b] = await Promise.all([reindex(), reindex()]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const conflict = a.statusCode === 409 ? a : b;
    expect(conflict.json().error.code).toBe("REINDEX_IN_PROGRESS");
    expect((await reindex()).statusCode).toBe(200); // lock released
  });

  it("returns 502 with the run when the source fails", async () => {
    await t.close();
    t = await testApp(testConfig({ LIBRARY_PATH: "/nonexistent" }));
    const res = await reindex();
    expect(res.statusCode).toBe(502);
    expect(res.json().run.status).toBe("failed");
    const runs = (await t.app.inject({ method: "GET", url: "/admin/runs", headers: auth })).json().runs;
    expect(runs[0]).toMatchObject({ status: "failed", counts: null });
    expect(runs[0].message).toMatch(/ENOENT/);
  });

  it("verified override: set, clear, survives reindex, visible publicly", async () => {
    await reindex();
    const pub = async () => (await t.app.inject({ method: "GET", url: "/v1/bots/lumie" })).json().bot.verified;
    expect(await pub()).toBe(false);

    let res = await patch("lumie", { verified: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().bot).toMatchObject({ slug: "lumie", verified: true, verifiedOverride: true, verifiedRepo: false, removedAt: null });
    expect(await pub()).toBe(true);

    await reindex();
    expect(await pub()).toBe(true);

    // repo says verified, override says not
    writeFileSync(join(lib.path, "verified.json"), '["lumie"]');
    await reindex();
    res = await patch("lumie", { verified: false });
    expect(res.json().bot).toMatchObject({ verified: false, verifiedOverride: false, verifiedRepo: true });
    expect(await pub()).toBe(false);

    res = await patch("lumie", { verified: null });
    expect(res.json().bot).toMatchObject({ verified: true, verifiedOverride: null, verifiedRepo: true });
  });

  it("validates PATCH input", async () => {
    await reindex();
    for (const body of [{ verified: "yes" }, { verified: true, x: 1 }, {}, []]) {
      const res = await patch("lumie", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION");
    }
    const raw = await t.app.inject({ method: "PATCH", url: "/admin/bots/lumie", headers: auth, payload: "nope" });
    expect(raw.statusCode).toBe(415); // no content-type: Fastify refuses the body
    const badJson = await t.app.inject({ method: "PATCH", url: "/admin/bots/lumie", headers: { ...auth, "content-type": "application/json" }, payload: "{nope" });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().error.code).toBe("FST_ERR_CTP_INVALID_JSON_BODY");
    expect((await patch("nope", { verified: true })).statusCode).toBe(404);
    expect((await patch("Nope", { verified: true })).statusCode).toBe(400);
  });
});
