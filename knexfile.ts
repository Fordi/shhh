// config file for knex
import type { Knex } from "knex";
import { buildSqliteConnection } from "./src/db/connection.ts";

// Mirrors src/config/env.ts's default, so `npm run migrate` and the app
// agree on the database file without any configuration.
const databasePath = process.env.DATABASE_PATH ?? "./shhh.sqlite3";

const config: Record<string, Knex.Config> = {
  development: {
    ...buildSqliteConnection(databasePath),
    migrations: { directory: "./migrations" },
  },
  production: {
    ...buildSqliteConnection(databasePath),
    migrations: { directory: "./migrations" },
  },
  test: {
    ...buildSqliteConnection(":memory:"),
    migrations: { directory: "./migrations" },
  },
};

export default config;
