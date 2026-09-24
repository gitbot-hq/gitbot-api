/** Shared by the vitest suites. Fixtures are the real bots in the sibling gitbot-library checkout. */
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { openDb, type Db } from "./db.js";
import { buildApp } from "./app.js";

export const ADMIN_SECRET = "test-secret-0123456789";
export const KNOWN_SLUGS = ["granola-meme-deck", "lumie"];

export function libraryPath(): string {
  const path = resolve(process.env.GITBOT_LIBRARY_PATH ?? join(import.meta.dirname, "..", "..", "gitbot-library"));
  if (!existsSync(join(path, "bots"))) {
    throw new Error(`Library checkout not found at ${path}. Clone gitbot-hq/Library next to this repo or set GITBOT_LIBRARY_PATH.`);
  }
  return path;
}

/** A throwaway copy of the library that a test may mutate. */
export function tempLibrary(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "gitbot-lib-"));
  cpSync(libraryPath(), path, { recursive: true, filter: (src) => !src.includes("/.git/") && !src.endsWith("/.git") });
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function testConfig(overrides: Partial<Record<string, string>> = {}): Config {
  return loadConfig({ ADMIN_SECRET, LIBRARY_PATH: libraryPath(), ...overrides });
}

export async function testApp(config: Config, db: Db = openDb(":memory:")) {
  const app = await buildApp({ config, db }, { logger: false });
  await app.ready();
  return { app, db, close: async () => { await app.close(); db.close(); } };
}
