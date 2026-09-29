import type { Knex } from "knex";
import type { AddressInfo } from "node:net";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";
import { buildRepositories } from "../../../src/db/repositories/index.ts";
import { buildServer } from "../../../src/server.ts";
import type { AppConfig } from "../../../src/config/env.ts";

export const TEST_ENV: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  DATABASE_PATH: ":memory:",
  ACCOUNT_ID: "000000000000",
  BASE_PATH: "",
  basePath: "",
};

export function buildTestApp(knex: Knex, env: AppConfig = TEST_ENV) {
  const repos = buildRepositories(knex);
  const { app, httpServer } = buildServer(env, repos);
  return { app, httpServer, repos };
}

/** Starts the app on an ephemeral port, for clients that need a real URL. */
export async function startTestServer(knex: Knex, env: AppConfig = TEST_ENV) {
  const { httpServer } = buildTestApp(knex, env);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = httpServer.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}${env.basePath}`,
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

/**
 * AWS SDK clients pointed at shhh. The secret access key is arbitrary - shhh
 * never sees it - which is exactly what the tests exercising store
 * selection rely on.
 */
export function clientsFor(
  endpoint: string,
  accessKeyId: string = "test",
  secretAccessKey: string = "test-secret",
) {
  const config = {
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
  };
  return {
    secrets: new SecretsManagerClient(config),
    ssm: new SSMClient(config),
  };
}
