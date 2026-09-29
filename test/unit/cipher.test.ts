import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { buildCipher } from "../../src/config/cipher.ts";

describe("cipher", () => {
  it("round-trips, with a fresh IV each time", () => {
    const cipher = buildCipher(randomBytes(32));
    const a = cipher.encrypt("sekrit ✓");
    const b = cipher.encrypt("sekrit ✓");
    assert.notEqual(a, b);
    assert.equal(cipher.decrypt(a), "sekrit ✓");
  });

  it("refuses to decrypt under the wrong key", () => {
    const ciphertext = buildCipher(randomBytes(32)).encrypt("x");
    assert.throws(() => buildCipher(randomBytes(32)).decrypt(ciphertext));
  });
});
