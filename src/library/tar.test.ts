import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { readTar } from "./tar.js";
import { filesFromTarball, loadLocal } from "./snapshot.js";
import { tempLibrary } from "../test-helpers.js";

describe("tarball snapshot", () => {
  it("reads a gzipped tarball the same as the directory", () => {
    const lib = tempLibrary();
    try {
      // Same shape as a GitHub tarball: one top-level directory named owner-repo-sha.
      const parent = mkdtempSync(join(tmpdir(), "gitbot-tar-"));
      cpSync(lib.path, join(parent, "gitbot-hq-Library-6784d4c"), { recursive: true });
      // COPYFILE_DISABLE stops macOS tar from adding AppleDouble "._*" entries.
      const tgz = execFileSync("tar", ["-C", parent, "-czf", "-", "gitbot-hq-Library-6784d4c"], { maxBuffer: 64 << 20, env: { ...process.env, COPYFILE_DISABLE: "1" } });
      rmSync(parent, { recursive: true, force: true });
      const { files, topDir } = filesFromTarball(gunzipSync(tgz));
      expect(topDir).toBe("gitbot-hq-Library-6784d4c");
      const local = loadLocal(lib.path).files;
      expect([...files.keys()].sort()).toEqual([...local.keys()].sort());
      for (const [k, v] of local) expect(files.get(k)).toBe(v);
    } finally {
      lib.cleanup();
    }
  });

  it("handles pax long paths", () => {
    const longDir = "d".repeat(120);
    const lib = tempLibrary();
    try {
      execFileSync("mkdir", ["-p", `${lib.path}/${longDir}`]);
      execFileSync("sh", ["-c", `printf hello > "${lib.path}/${longDir}/f.txt"`]);
      const tgz = execFileSync("tar", ["-C", lib.path, "-czf", "-", "--format=pax", "."], { maxBuffer: 64 << 20, env: { ...process.env, COPYFILE_DISABLE: "1" } });
      const entries = [...readTar(gunzipSync(tgz))];
      const long = entries.find((e) => e.path.endsWith(`${longDir}/f.txt`));
      expect(long?.data.toString()).toBe("hello");
    } finally {
      lib.cleanup();
    }
  });
});
