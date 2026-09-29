import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { MIGRATIONS } from "../../src/db/migrations.ts";

describe("migrations", () => {
  it("registers every file in migrations/, in order", () => {
    const onDisk = readdirSync(resolve(import.meta.dirname, "../../migrations"))
      .filter((f) => f.endsWith(".ts"))
      .sort();
    assert.deepEqual(Object.keys(MIGRATIONS), onDisk);
  });
});
