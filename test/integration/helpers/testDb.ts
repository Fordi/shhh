import knexFactory, { type Knex } from "knex";
import { buildSqliteConnection } from "../../../src/db/connection.ts";
import { migrationSource } from "../../../src/db/migrations.ts";

export async function createTestDb(): Promise<Knex> {
  const knex = knexFactory({
    ...buildSqliteConnection(":memory:"),
    migrations: { migrationSource },
  });
  await knex.migrate.latest();
  return knex;
}
