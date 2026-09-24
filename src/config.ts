import "dotenv/config";
import { z } from "zod";

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4010),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  DB_PATH: z.string().default("./data/gitbot.db"),
  ADMIN_SECRET: z.string().min(16, "ADMIN_SECRET must be at least 16 characters"),
  LIBRARY_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "LIBRARY_REPO must be owner/name").default("gitbot-hq/Library"),
  LIBRARY_REF: z.string().default("main"),
  GITHUB_TOKEN: z.preprocess(blankToUndefined, z.string().optional()),
  LIBRARY_PATH: z.preprocess(blankToUndefined, z.string().optional()),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
