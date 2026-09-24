import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { HttpError } from "./http-error.js";
import { adminRoutes } from "./routes/admin.js";
import { publicRoutes } from "./routes/public.js";

export type AppContext = { config: Config; db: Db };

export async function buildApp(ctx: AppContext, opts: { logger?: boolean | object } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? { level: ctx.config.LOG_LEVEL } });

  // The UI is served by each user's local gitbot server, so origins are unknowable.
  await app.register(cors, { origin: true, methods: ["GET", "POST", "PATCH", "OPTIONS"] });

  app.decorate("ctx", ctx);

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      reply.code(err.status).send({ error: { code: err.code, message: err.message } });
      return;
    }
    if ("validation" in err && err.validation) {
      reply.code(400).send({ error: { code: "VALIDATION", message: err.message } });
      return;
    }
    // Fastify's own client errors (bad JSON body, oversized payload, ...) carry a 4xx status.
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status < 500) {
      reply.code(status).send({ error: { code: err.code ?? "BAD_REQUEST", message: err.message } });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: { code: "INTERNAL", message: "Internal server error" } });
  });

  app.get("/health", async () => ({ ok: true }));
  await app.register(publicRoutes);
  await app.register(adminRoutes);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
