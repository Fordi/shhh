import type { Knex } from "knex";

// Every row belongs to a store: the first 16 hex chars of SHA-256(key),
// where key = SHA-256(access key id) - see src/auth/credentials.ts.
// Timestamps are epoch milliseconds, which map straight onto the
// epoch-seconds numbers the AWS JSON protocol uses.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("secrets", (t) => {
    t.increments("id").primary();
    t.string("store_id", 16).notNullable();
    t.string("name", 512).notNullable();
    t.string("arn", 700).notNullable();
    t.text("description").nullable();
    t.string("kms_key_id", 2048).nullable();
    t.text("tags").notNullable();
    t.bigInteger("created_at").notNullable();
    t.bigInteger("last_changed_at").notNullable();
    t.bigInteger("last_accessed_at").nullable();
    t.bigInteger("deletion_date").nullable();
    t.unique(["store_id", "name"]);
    t.unique(["store_id", "arn"]);
  });
  await knex.schema.createTable("secret_versions", (t) => {
    t.increments("id").primary();
    t.integer("secret_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("secrets")
      .onDelete("CASCADE");
    t.string("version_id", 64).notNullable();
    t.string("value_kind", 8).notNullable();
    t.text("value_ciphertext").notNullable();
    t.text("stages").notNullable();
    t.bigInteger("created_at").notNullable();
    t.unique(["secret_id", "version_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("secret_versions");
  await knex.schema.dropTableIfExists("secrets");
}
