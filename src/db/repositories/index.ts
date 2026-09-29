// export barrel
import type { Knex } from "knex";
import { secretsRepository } from "./secrets.ts";
import { parametersRepository } from "./parameters.ts";

/** Repositories are bound per request to the caller's store (see src/auth/credentials.ts). */
export function buildRepositories(knex: Knex) {
  return {
    knex,
    secrets: (storeId: string) => secretsRepository(knex, storeId),
    parameters: (storeId: string) => parametersRepository(knex, storeId),
  };
}

export type Repositories = ReturnType<typeof buildRepositories>;
