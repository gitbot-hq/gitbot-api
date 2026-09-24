import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBotFolder, parseFeatured, parseVerified, wordCount } from "./bot-schema.js";
import { KNOWN_SLUGS, libraryPath } from "../test-helpers.js";

function folder(slug: string): Map<string, string> {
  const dir = join(libraryPath(), "bots", slug);
  return new Map(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
}

function valid(): Map<string, string> {
  return folder("lumie");
}

function withJson(files: Map<string, string>, patch: (j: Record<string, unknown>) => void): Map<string, string> {
  const j = JSON.parse(files.get("bot.json")!);
  patch(j);
  return new Map(files).set("bot.json", JSON.stringify(j));
}

describe("parseBotFolder", () => {
  it.each(KNOWN_SLUGS)("accepts the real library bot %s", (slug) => {
    const r = parseBotFolder(slug, folder(slug));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bot.json.slug).toBe(slug);
    expect(r.bot.json.features).toHaveLength(3);
    expect(r.bot.instructions.length).toBeGreaterThan(100);
    expect(r.bot.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hash is stable and changes with any file", () => {
    const a = parseBotFolder("lumie", valid());
    const b = parseBotFolder("lumie", valid());
    const c = parseBotFolder("lumie", new Map(valid()).set("setup.md", "different"));
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(a.bot.contentHash).toBe(b.bot.contentHash);
    expect(c.bot.contentHash).not.toBe(a.bot.contentHash);
  });

  it("applies mascot defaults", () => {
    const r = parseBotFolder("lumie", withJson(valid(), (j) => { delete j.mascot; }));
    expect(r.ok && r.bot.json.mascot).toEqual({ body: "ghost", color: "brand-sun", activity: "idle" });
  });

  it("treats a missing or empty setup.md as no setup", () => {
    const files = new Map(valid());
    files.delete("setup.md");
    const r = parseBotFolder("lumie", files);
    expect(r.ok && r.bot.setupInstructions).toBeNull();
    const r2 = parseBotFolder("lumie", new Map(valid()).set("setup.md", "  \n"));
    expect(r2.ok && r2.bot.setupInstructions).toBeNull();
  });

  const rejects: [string, (f: Map<string, string>) => Map<string, string>, RegExp][] = [
    ["missing bot.json", (f) => { const m = new Map(f); m.delete("bot.json"); return m; }, /bot.json is missing/],
    ["invalid JSON", (f) => new Map(f).set("bot.json", "{"), /not valid JSON/],
    ["slug/folder mismatch", (f) => withJson(f, (j) => { j.slug = "other"; }), /does not match folder/],
    ["bad slug", (f) => withJson(f, (j) => { j.slug = "Bad_Slug"; }), /slug/],
    ["two features", (f) => withJson(f, (j) => { j.features = ["a", "b"]; }), /exactly 3/],
    ["long name", (f) => withJson(f, (j) => { j.name = "x".repeat(25); }), /name/],
    ["short about", (f) => withJson(f, (j) => { j.about = "too short"; }), /about/],
    ["unknown category", (f) => withJson(f, (j) => { j.category = "Fun"; }), /category/],
    ["unknown agent", (f) => withJson(f, (j) => { j.agent = "gpt"; }), /agent/],
    ["unknown permission mode", (f) => withJson(f, (j) => { j.permissionMode = "yolo"; }), /permissionMode/],
    ["bad mascot body", (f) => withJson(f, (j) => { j.mascot = { body: "dragon" }; }), /mascot.body/],
    ["hex mascot colour", (f) => withJson(f, (j) => { j.mascot = { color: "#fff" }; }), /mascot.color/],
    ["opencode without model", (f) => withJson(f, (j) => { j.agent = "opencode"; delete j.model; }), /model is required/],
    ["bad github handle", (f) => withJson(f, (j) => { j.author = { github: "-bad-", name: "x" }; }), /author.github/],
    ["missing instructions", (f) => { const m = new Map(f); m.delete("instructions.md"); return m; }, /instructions.md is missing/],
    ["empty instructions", (f) => new Map(f).set("instructions.md", "\n"), /instructions.md is missing or empty/],
    ["too many words", (f) => new Map(f).set("instructions.md", "word ".repeat(651)), /651 words/],
    ["extra file", (f) => new Map(f).set("logo.png", "x"), /unexpected files.*logo.png/],
  ];
  it.each(rejects)("rejects %s", (_name, mutate, message) => {
    const r = parseBotFolder("lumie", mutate(valid()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(message);
  });

  it("accepts opencode with a model and tool lists", () => {
    const r = parseBotFolder("lumie", withJson(valid(), (j) => { j.agent = "opencode"; j.model = "anthropic/claude-haiku-4-5"; j.allowedTools = ["Read", "Grep"]; }));
    expect(r.ok && r.bot.json.allowedTools).toEqual(["Read", "Grep"]);
  });
});

describe("verified.json / featured.json", () => {
  it("accepts arrays, objects and garbage", () => {
    expect([...parseVerified('["a","b"]')]).toEqual(["a", "b"]);
    expect([...parseVerified('{"a":true,"b":false}')]).toEqual(["a"]);
    expect([...parseVerified("nope")]).toEqual([]);
    expect([...parseVerified(undefined)]).toEqual([]);
    expect(parseFeatured('["x","y"]')).toEqual(["x", "y"]);
    expect(parseFeatured('{"featured":["y","x"]}')).toEqual(["y", "x"]);
    expect(parseFeatured('[1, "x"]')).toEqual(["x"]);
  });
});

describe("wordCount", () => {
  it("counts whitespace-separated words", () => {
    expect(wordCount("  one two\n\nthree ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });
});
