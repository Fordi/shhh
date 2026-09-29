import type { Knex } from "knex";

// Scoped by store_id, like secrets. `value` is plaintext for String and
// StringList parameters, and a cipher.ts ciphertext for SecureString ones.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("parameters", (t) => {
    t.increments("id").primary();
    t.string("store_id", 16).notNullable();
    t.string("name", 1011).notNullable();
    t.integer("version").notNullable();
    t.text("tags").notNullable();
    t.unique(["store_id", "name"]);
  });
  await knex.schema.createTable("parameter_versions", (t) => {
    t.increments("id").primary();
    t.integer("parameter_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("parameters")
      .onDelete("CASCADE");
    t.integer("version").notNullable();
    t.string("type", 16).notNullable();
    t.text("value").notNullable();
    t.text("description").nullable();
    t.string("key_id", 2048).nullable();
    t.string("allowed_pattern", 1024).nullable();
    t.string("tier", 16).notNullable();
    t.string("data_type", 32).notNullable();
    t.text("labels").notNullable();
    t.bigInteger("last_modified_date").notNullable();
    t.string("last_modified_user", 256).notNullable();
    t.unique(["parameter_id", "version"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("parameter_versions");
  await knex.schema.dropTableIfExists("parameters");
}
