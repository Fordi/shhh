// Secrets Manager secrets and their versions, scoped to one store
import type { Knex } from "knex";
import type { SecretRow, SecretVersionRow } from "../types.ts";
import { extractInsertedId } from "../json.ts";

export type SecretsRepository = {
  list(): Promise<SecretRow[]>;
  findByName(name: string): Promise<SecretRow | undefined>;
  findByArn(arn: string): Promise<SecretRow | undefined>;
  create(row: Omit<SecretRow, "id" | "store_id">): Promise<number>;
  update(
    id: number,
    patch: Partial<Omit<SecretRow, "id" | "store_id">>,
  ): Promise<void>;
  delete(id: number): Promise<void>;
  purgeExpired(now: number): Promise<void>;
  versions(secretId: number): Promise<SecretVersionRow[]>;
  insertVersion(row: Omit<SecretVersionRow, "id">): Promise<void>;
  setVersionStages(id: number, stages: string): Promise<void>;
  deleteVersions(ids: number[]): Promise<void>;
  transaction<T>(fn: (repo: SecretsRepository) => Promise<T>): Promise<T>;
};

export function secretsRepository(
  knex: Knex,
  storeId: string,
): SecretsRepository {
  const secrets = () => knex<SecretRow>("secrets").where({ store_id: storeId });
  const secretVersions = () => knex<SecretVersionRow>("secret_versions");
  return {
    async list() {
      return secrets().orderBy("name", "asc");
    },

    async findByName(name) {
      return secrets().where({ name }).first();
    },

    async findByArn(arn) {
      return secrets().where({ arn }).first();
    },

    async create(row) {
      return extractInsertedId(
        await knex<SecretRow>("secrets").insert(
          { ...row, store_id: storeId },
          "id",
        ),
      );
    },

    async update(id, patch) {
      await secrets().where({ id }).update(patch);
    },

    async delete(id) {
      await secrets().where({ id }).delete();
    },
    async purgeExpired(now) {
      await secrets()
        .whereNotNull("deletion_date")
        .where("deletion_date", "<=", now)
        .delete();
    },
    async versions(secretId) {
      return secretVersions()
        .where({ secret_id: secretId })
        .orderBy([
          { column: "created_at", order: "desc" },
          { column: "id", order: "desc" },
        ]);
    },

    async insertVersion(row) {
      await secretVersions().insert(row);
    },

    async setVersionStages(id, stages) {
      await secretVersions().where({ id }).update({ stages });
    },

    async deleteVersions(ids: number[]): Promise<void> {
      if (ids.length === 0) return;
      await secretVersions().whereIn("id", ids).delete();
    },
    transaction<T>(fn: (repo: SecretsRepository) => Promise<T>): Promise<T> {
      return knex.transaction((trx) => fn(secretsRepository(trx, storeId)));
    },
  };
}

export type TransactionalSecretsRepository = ReturnType<
  typeof secretsRepository
>;
