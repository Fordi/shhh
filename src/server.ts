// Constructs the webserver
import express, { type Express } from "express";
import { createServer, type Server as HttpServer } from "node:http";
import type { AppConfig } from "./config/env.ts";
import type { Repositories } from "./db/repositories/index.ts";
import { buildApiRouter } from "./api/router.ts";
import { errorHandler } from "./api/errorHandler.ts";

export function buildServer(
  env: AppConfig,
  repos: Repositories,
): { app: Express; httpServer: HttpServer } {
  const app = express();
  app.disable("x-powered-by");
  app.use(env.basePath || "/", buildApiRouter(env, repos));
  app.use(errorHandler);

  const httpServer = createServer(app);

  return { app, httpServer };
}
