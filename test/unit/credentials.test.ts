import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CredentialError,
  parseCredential,
  storeFor,
} from "../../src/auth/credentials.ts";

describe("credentials", () => {
  it("parses the credential scope from a SigV4 Authorization header", () => {
    const cred = parseCredential({
      authorization:
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260929/eu-west-1/secretsmanager/aws4_request, SignedHeaders=host, Signature=00",
    });
    assert.deepEqual(cred, {
      accessKeyId: "AKIDEXAMPLE",
      region: "eu-west-1",
      service: "secretsmanager",
    });
  });

  it("rejects missing or malformed credentials", () => {
    assert.throws(
      () => parseCredential({}),
      (e: unknown) =>
        e instanceof CredentialError &&
        e.code === "MissingAuthenticationTokenException",
    );
    assert.throws(
      () => parseCredential({ authorization: "Bearer x" }),
      (e: unknown) =>
        e instanceof CredentialError &&
        e.code === "IncompleteSignatureException",
    );
  });

  it("derives key = SHA-256(access key id) and id = SHA-256(key)[0:16], deterministically", () => {
    const key = createHash("sha256").update("test").digest();
    const id = createHash("sha256").update(key).digest("hex").slice(0, 16);
    assert.deepEqual(storeFor("test"), { key, id });
    assert.deepEqual(storeFor("test"), storeFor("test"));
    assert.notEqual(storeFor("test").id, storeFor("test2").id);
  });
});
