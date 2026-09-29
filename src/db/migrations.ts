// migrations imported statically, so they survive bundling into one file
import type { Knex } from "knex";
import * as createSecrets from "../../migrations/20260929000001_create_secrets.ts";
import * as createParameters from "../../migrations/20260929000002_create_parameters.ts";

/**
 * Every file in migrations/, in order. The knex CLI (knexfile.ts) still
 * reads the directory itself; the app uses this list instead of scanning
 * disk, which is what lets `npm run build` produce a single self-contained
 * file. Names match the filenames so both paths share one knex_migrations
 * history. test/unit/migrations.test.ts fails if this list drifts from the
 * directory.
 */
export const MIGRATIONS: Record<string, Knex.Migration> = {
  "20260929000001_create_secrets.ts": createSecrets,
  "20260929000002_create_parameters.ts": createParameters,
};

export const migrationSource: Knex.MigrationSource<string> = {
  async getMigrations() {
    return Object.keys(MIGRATIONS);
  },
  getMigrationName(name) {
    return name;
  },
  async getMigration(name) {
    return MIGRATIONS[name]!;
  },
};
