// root API router
import express, { type Router } from "express";
import { z } from "zod";
import { TrackedRouter } from "../util/trackedRouter.ts";
import { typedVia } from "../util/typedVia.ts";
import type { AppConfig } from "../config/env.ts";
import type { Repositories } from "../db/repositories/index.ts";
import { buildAwsHandler } from "../aws/protocol.ts";
import { secretsManager } from "../aws/secretsManager.ts";
import { ssm } from "../aws/ssm.ts";
import pkg from "../../package.json" with { type: "json" };

const healthSchema = z.object({
  name: z.string(),
  version: z.string(),
  services: z.array(z.string()),
});

export function buildApiRouter(env: AppConfig, repos: Repositories): Router {
  const router = TrackedRouter();
  const services = [secretsManager, ssm];

  // The AWS CLI posts every call to the endpoint URL's path, naming the
  // operation in X-Amz-Target; the body is application/x-amz-json-1.1,
  // which express.json() wouldn't parse, so it's taken raw.
  router.post(
    "/",
    express.raw({ type: () => true, limit: "1mb" }),
    buildAwsHandler(services, env, repos),
  );

  router.get(
    "/health",
    typedVia({}, () => ({
      content: {
        name: pkg.name,
        version: pkg.version,
        services: services.map((s) => s.targetPrefix),
      },
    })).returns(healthSchema),
  );

  return router;
}
