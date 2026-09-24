import { gunzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { Config } from "../config.js";
import { readTar } from "./tar.js";

/** The library at one point in time: only the files the indexer cares about. */
export type Snapshot = {
  source: string;
  commitSha: string | null;
  /** repo-relative posix path → utf8 content */
  files: Map<string, string>;
};

const ROOT_FILES = new Set(["verified.json", "featured.json"]);

function wanted(path: string): boolean {
  return ROOT_FILES.has(path) || /^bots\/[^/]+\/[^/]+$/.test(path);
}

export async function loadSnapshot(config: Config): Promise<Snapshot> {
  return config.LIBRARY_PATH ? loadLocal(config.LIBRARY_PATH) : loadGithub(config);
}

export function loadLocal(root: string): Snapshot {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const rel = relative(root, full).split(sep).join("/");
      if (wanted(rel)) files.set(rel, readFileSync(full, "utf8"));
    }
  };
  walk(root);
  const git = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  const commitSha = git.status === 0 ? git.stdout.trim() : null;
  return { source: `local:${root}`, commitSha, files };
}

/** Picks the wanted files out of a repo tarball, dropping its single top-level directory. */
export function filesFromTarball(tar: Buffer): { files: Map<string, string>; topDir: string | null } {
  const files = new Map<string, string>();
  let topDir: string | null = null;
  for (const entry of readTar(tar)) {
    const slash = entry.path.indexOf("/");
    if (slash === -1) continue;
    topDir ??= entry.path.slice(0, slash);
    const rel = entry.path.slice(slash + 1);
    if (wanted(rel)) files.set(rel, entry.data.toString("utf8"));
  }
  return { files, topDir };
}

export async function loadGithub(config: Config): Promise<Snapshot> {
  const headers: Record<string, string> = {
    "User-Agent": "gitbot-api",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (config.GITHUB_TOKEN) headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;
  const base = `https://api.github.com/repos/${config.LIBRARY_REPO}`;
  const ref = encodeURIComponent(config.LIBRARY_REF);

  const tarRes = await fetch(`${base}/tarball/${ref}`, { headers, redirect: "follow" });
  if (!tarRes.ok) throw new Error(`GitHub tarball ${config.LIBRARY_REPO}@${config.LIBRARY_REF}: HTTP ${tarRes.status}`);
  const { files, topDir } = filesFromTarball(gunzipSync(Buffer.from(await tarRes.arrayBuffer())));

  // The tarball's top directory ends in the abbreviated sha; the API gives the full one.
  let commitSha: string | null = topDir?.match(/-([0-9a-f]{7,40})$/)?.[1] ?? null;
  try {
    const res = await fetch(`${base}/commits/${ref}`, { headers });
    if (res.ok) {
      const body = (await res.json()) as { sha?: string };
      if (body.sha) commitSha = body.sha;
    }
  } catch { /* the short sha from the tarball is good enough */ }

  return { source: `github:${config.LIBRARY_REPO}@${config.LIBRARY_REF}`, commitSha, files };
}
