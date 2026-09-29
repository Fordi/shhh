// Service entrypoint
import { loadEnv, loadEnvFile, type AppConfig } from "./config/env.ts";
import { getKnex, closeKnex } from "./db/knex.ts";
import { buildRepositories } from "./db/repositories/index.ts";
import { buildServer } from "./server.ts";
import { HUP } from "./hup.ts";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import pkg from "../package.json" with { type: "json" };

export interface RunningServer {
  httpServer: HttpServer;
  env: AppConfig;
  /** Where clients reach it, e.g. http://localhost:3000/shhh */
  endpoint: string;
  terminate(): Promise<void>;
}

/**
 * The environment variables the AWS CLI and SDKs read in place of
 * --endpoint-url, as sourceable `KEY=value` lines. Entry points print this
 * - and only this - on stdout, so it can be captured into an env file.
 */
export function endpointEnv(endpoint: string): string {
  return [
    `export AWS_ENDPOINT_URL_SECRETS_MANAGER=${endpoint}`,
    `export AWS_ENDPOINT_URL_SSM=${endpoint}`,
    ``,
  ].join("\n");
}

const PROJECT_ROOT = new URL("../", import.meta.url);

/**
 * Loads the env file(s) and validates the environment, exactly as the server
 * will - so the launcher and the daemon agree on DATABASE_PATH and friends.
 */
export function projectEnv(projectRootUrl: URL = PROJECT_ROOT): AppConfig {
  loadEnvFile(projectRootUrl);
  return loadEnv();
}

/**
 * Boots the whole app - env, DB (migrated to latest), and the HTTP server -
 * and starts listening. Side-effect-free to import; nothing runs until this
 * is called, so tests can import this module without a real server starting.
 */
export async function startServer(
  projectRootUrl: URL = PROJECT_ROOT,
): Promise<RunningServer> {
  const env = projectEnv(projectRootUrl);

  const knex = getKnex(env);
  // A single-process sqlite app has nobody to race, so migrating on every
  // boot is safe - a fresh checkout or an upgrade both just work.
  await knex.migrate.latest();
  const repos = buildRepositories(knex);

  const { httpServer } = buildServer(env, repos);

  const endpoint = await new Promise<string>((resolve) => {
    httpServer.listen(env.PORT, () => {
      const { port } = httpServer.address() as AddressInfo;
      resolve(`http://localhost:${port}${env.basePath}`);
    });
  });
  console.error(
    `${pkg.name} v${pkg.version} (pid ${process.pid}) listening on ${endpoint}`,
  );

  // SIGHUP triggers a restart. Under `node --watch`, calling process.exit()
  // would just stop the process - `--watch` only restarts on a *file change*,
  // not on exit - so instead this closes the HTTP port and DB connection
  // cleanly, then rewrites hup.ts with its own contents. That write is enough
  // of a file-change event for `--watch` to pick up and restart the process,
  // even though the file's content is unchanged. The bundled build (npm run
  // build) has no hup.ts beside it, so there it exits and leaves restarting
  // to whatever supervises it.
  const onSighup = () => {
    console.error(`received SIGHUP, triggering restart: ${HUP}`);
    httpServer.close(async () => {
      await closeKnex();
      const hupFile = fileURLToPath(new URL("hup.ts", import.meta.url));
      if (!existsSync(hupFile)) process.exit(0);
      await writeFile(hupFile, await readFile(hupFile));
    });
  };
  process.on("SIGHUP", onSighup);

  async function terminate(): Promise<void> {
    process.off("SIGHUP", onSighup);
    return new Promise<void>((resolve) => {
      httpServer.close(async () => {
        await closeKnex();
        resolve();
      });
      // SDK clients hold keep-alive sockets open indefinitely; don't wait on them.
      httpServer.closeIdleConnections();
    });
  }

  return { httpServer, env, endpoint, terminate };
}
