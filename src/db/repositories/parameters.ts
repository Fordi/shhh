// SSM parameters and their version history, scoped to one store
import type { Knex } from "knex";
import type { ParameterRow, ParameterVersionRow } from "../types.ts";
import { extractInsertedId } from "../json.ts";

export type ParameterWithVersion = ParameterRow & {
  current: ParameterVersionRow;
};

export type ParametersRepository = {
  listWithCurrent(): Promise<ParameterWithVersion[]>;
  findByName(name: string): Promise<ParameterRow | undefined>;
  create(row: Omit<ParameterRow, "id" | "store_id">): Promise<number>;
  update(
    id: number,
    patch: Partial<Omit<ParameterRow, "id" | "store_id">>,
  ): Promise<void>;
  delete(id: number): Promise<void>;
  versions(parameterId: number): Promise<ParameterVersionRow[]>;
  insertVersion(row: Omit<ParameterVersionRow, "id">): Promise<void>;
  setVersionLabels(id: number, labels: string): Promise<void>;
  deleteVersion(id: number): Promise<void>;
  transaction<T>(fn: (repo: ParametersRepository) => Promise<T>): Promise<T>;
};

export function parametersRepository(
  knex: Knex,
  storeId: string,
): ParametersRepository {
  const parameters = () =>
    knex<ParameterRow>("parameters").where({ store_id: storeId });
  const parameterVersions = () =>
    knex<ParameterVersionRow>("parameter_versions");
  return {
    async findByName(name) {
      return parameters().where({ name }).first();
    },

    async listWithCurrent() {
      const rows = await parameters().orderBy("name", "asc");
      const current = await knex<ParameterVersionRow>("parameter_versions as v")
        .join("parameters as p", function () {
          this.on("p.id", "=", "v.parameter_id").andOn(
            "p.version",
            "=",
            "v.version",
          );
        })
        .where("p.store_id", storeId)
        .select("v.*");
      const byParam = new Map(current.map((v) => [v.parameter_id, v]));
      return rows.map((p) => ({ ...p, current: byParam.get(p.id)! }));
    },

    async create(row) {
      return extractInsertedId(
        await knex<ParameterRow>("parameters").insert(
          { ...row, store_id: storeId },
          "id",
        ),
      );
    },

    async update(id, patch) {
      await parameters().where({ id }).update(patch);
    },

    async delete(id) {
      await parameters().where({ id }).delete();
    },

    async versions(parameterId) {
      return parameterVersions()
        .where({ parameter_id: parameterId })
        .orderBy("version", "asc");
    },

    async insertVersion(row) {
      return parameterVersions().insert(row);
    },

    async setVersionLabels(id, labels) {
      return parameterVersions().where({ id }).update({ labels });
    },

    async deleteVersion(id) {
      return parameterVersions().where({ id }).delete();
    },

    transaction(fn) {
      return knex.transaction((trx) => fn(parametersRepository(trx, storeId)));
    },
  };
}
