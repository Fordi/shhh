// build knex connection configs for the native node:sqlite driver
import type { Knex } from "knex";
import { resolve } from "node:path";
import { NodeSQLite } from "./NodeSqlite.ts";

/**
 * Builds a knex config for a sqlite database at `path`, backed by Node's
 * built-in `node:sqlite` (see NodeSqlite.ts) - no native addon to compile.
 * Shared by the running app (src/db/knex.ts) and the knex CLI (knexfile.ts)
 * so both always point at the same file.
 *
 *   ":memory:"  -> in-memory database (tests)
 *   anything else -> a file path, resolved against the process's cwd
 */
export function buildSqliteConnection(path: string): Knex.Config {
  return {
    client: NodeSQLite as unknown as typeof Knex.Client,
    connection: {
      filename: path === ":memory:" ? path : resolve(process.cwd(), path),
      options: {},
    },
    useNullAsDefault: true,
  };
}
