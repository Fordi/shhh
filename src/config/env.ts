// configuration from the environment
import { z } from "zod";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default("./shhh.sqlite3"),
  ACCOUNT_ID: z
    .string()
    .regex(/^\d{12}$/, "must be a 12-digit AWS account id")
    .default("000000000000"),
  BASE_PATH: z.string().default(""),
});

export type AppConfig = z.infer<typeof schema> & {
  basePath: string;
};

/**
 * Normalizes a configured base path to either "" (no prefix) or a form with
 * a leading slash and no trailing slash, e.g. "shhh" / "/shhh/" -> "/shhh".
 * Keeping this normalization in one place means every consumer (route mounting,
 * the startup log's endpoint URL) agrees on the exact same prefix string.
 */
function normalizeBasePath(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Prefers a NODE_ENV-specific env file (e.g. .env.production) over the plain
 * .env, so different environments can keep separate config side by side;
 * falls back to .env when no NODE_ENV-specific file exists. If neither
 * exists (e.g. under most PaaS setups, where the platform injects env
 * vars directly with no .env file on disk), this is a silent no-op and
 * whatever's already in process.env is used as-is.
 *
 * `projectRootUrl` should be a `file://` URL for the project root (the
 * directory containing package.json/.env), typically built from the
 * caller's own `import.meta.url` - e.g. from src/index.ts that's
 * `new URL("../", import.meta.url)`.
 */
export function loadEnvFile(projectRootUrl: URL): void {
  for (const envFile of [
    `.env.${process.env.NODE_ENV ?? "development"}`,
    ".env",
  ]) {
    const envPath = fileURLToPath(new URL(envFile, projectRootUrl));
    if (!existsSync(envPath)) {
      continue;
    }
    try {
      process.loadEnvFile(envPath);
      break;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`Warning: ${message} while reading ${envPath}`);
    }
  }
}

let cached: AppConfig | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    console.error(
      "Invalid environment configuration:",
      parsed.error.flatten().fieldErrors,
    );
    process.exit(1);
    throw new Error("unreachable");
  }
  const data = parsed.data;
  cached = {
    ...data,
    basePath: normalizeBasePath(data.BASE_PATH),
  };
  return cached;
}

export function resetEnvCacheForTests(): void {
  cached = undefined;
}
