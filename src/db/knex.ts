// knex connection management
import knexFactory, { type Knex } from "knex";
import type { AppConfig } from "../config/env.ts";
import { buildSqliteConnection } from "./connection.ts";
import { migrationSource } from "./migrations.ts";

let instance: Knex | undefined;

export function getKnex(env?: AppConfig): Knex {
  if (!instance) {
    if (!env)
      throw new Error(
        "getKnex() called before initialization; pass env on first call",
      );
    instance = knexFactory({
      ...buildSqliteConnection(env.DATABASE_PATH),
      migrations: { migrationSource },
    });
  }
  return instance;
}

export function setKnexForTests(k: Knex): void {
  instance = k;
}

export async function closeKnex(): Promise<void> {
  if (instance) {
    await instance.destroy();
    instance = undefined;
  }
}
