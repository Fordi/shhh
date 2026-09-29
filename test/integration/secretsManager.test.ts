import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Knex } from "knex";
import {
  BatchGetSecretValueCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetRandomPasswordCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  ListSecretVersionIdsCommand,
  PutSecretValueCommand,
  RestoreSecretCommand,
  TagResourceCommand,
  UpdateSecretCommand,
  UpdateSecretVersionStageCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { createTestDb } from "./helpers/testDb.ts";
import { clientsFor, startTestServer } from "./helpers/testApp.ts";

describe("Secrets Manager", () => {
  let knex: Knex;
  let server: Awaited<ReturnType<typeof startTestServer>>;
  let client: SecretsManagerClient;

  before(async () => {
    knex = await createTestDb();
    server = await startTestServer(knex);
    client = clientsFor(server.endpoint).secrets;
  });

  after(async () => {
    await server.close();
    await knex.destroy();
  });

  it("creates and reads back a string secret", async () => {
    const created = await client.send(
      new CreateSecretCommand({
        Name: "app/db",
        SecretString: '{"pw":"hunter2"}',
      }),
    );
    assert.match(
      created.ARN!,
      /^arn:aws:secretsmanager:us-east-1:000000000000:secret:app\/db-[A-Za-z0-9]{6}$/,
    );
    const got = await client.send(
      new GetSecretValueCommand({ SecretId: "app/db" }),
    );
    assert.equal(got.SecretString, '{"pw":"hunter2"}');
    assert.deepEqual(got.VersionStages, ["AWSCURRENT"]);
    assert.equal(got.VersionId, created.VersionId);
    assert.ok(got.CreatedDate instanceof Date);

    const byArn = await client.send(
      new GetSecretValueCommand({ SecretId: created.ARN }),
    );
    assert.equal(byArn.SecretString, '{"pw":"hunter2"}');
    const byPartialArn = await client.send(
      new GetSecretValueCommand({ SecretId: created.ARN!.slice(0, -7) }),
    );
    assert.equal(byPartialArn.Name, "app/db");
  });

  it("round-trips binary secrets", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await client.send(
      new CreateSecretCommand({ Name: "bin", SecretBinary: bytes }),
    );
    const got = await client.send(
      new GetSecretValueCommand({ SecretId: "bin" }),
    );
    assert.deepEqual([...got.SecretBinary!], [...bytes]);
    assert.equal(got.SecretString, undefined);
  });

  it("stores values encrypted", async () => {
    await client.send(
      new CreateSecretCommand({
        Name: "plain-check",
        SecretString: "correct horse",
      }),
    );
    const rows = await knex("secret_versions").select("value_ciphertext");
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.match(row.value_ciphertext, /^v1:/);
      assert.ok(!row.value_ciphertext.includes("correct horse"));
    }
  });

  it("rejects duplicate names", async () => {
    await client.send(
      new CreateSecretCommand({ Name: "dupe", SecretString: "a" }),
    );
    await assert.rejects(
      client.send(new CreateSecretCommand({ Name: "dupe", SecretString: "b" })),
      { name: "ResourceExistsException" },
    );
  });

  it("rotates AWSCURRENT to AWSPREVIOUS and rolls back", async () => {
    const v1 = await client.send(
      new CreateSecretCommand({ Name: "rot", SecretString: "one" }),
    );
    const v2 = await client.send(
      new PutSecretValueCommand({ SecretId: "rot", SecretString: "two" }),
    );
    assert.deepEqual(v2.VersionStages, ["AWSCURRENT"]);

    const previous = await client.send(
      new GetSecretValueCommand({
        SecretId: "rot",
        VersionStage: "AWSPREVIOUS",
      }),
    );
    assert.equal(previous.SecretString, "one");
    assert.equal(previous.VersionId, v1.VersionId);

    await client.send(
      new UpdateSecretVersionStageCommand({
        SecretId: "rot",
        VersionStage: "AWSCURRENT",
        MoveToVersionId: v1.VersionId,
        RemoveFromVersionId: v2.VersionId,
      }),
    );
    const current = await client.send(
      new GetSecretValueCommand({ SecretId: "rot" }),
    );
    assert.equal(current.SecretString, "one");

    const described = await client.send(
      new DescribeSecretCommand({ SecretId: "rot" }),
    );
    assert.deepEqual(described.VersionIdsToStages, {
      [v1.VersionId!]: ["AWSCURRENT"],
      [v2.VersionId!]: ["AWSPREVIOUS"],
    });

    const versions = await client.send(
      new ListSecretVersionIdsCommand({ SecretId: "rot" }),
    );
    assert.equal(versions.Versions!.length, 2);
  });

  it("treats a retried ClientRequestToken as idempotent", async () => {
    await client.send(new CreateSecretCommand({ Name: "idem" }));
    const token = "11111111-2222-3333-4444-555555555555";
    const first = await client.send(
      new PutSecretValueCommand({
        SecretId: "idem",
        SecretString: "x",
        ClientRequestToken: token,
      }),
    );
    const again = await client.send(
      new PutSecretValueCommand({
        SecretId: "idem",
        SecretString: "x",
        ClientRequestToken: token,
      }),
    );
    assert.equal(again.VersionId, first.VersionId);
    await assert.rejects(
      client.send(
        new PutSecretValueCommand({
          SecretId: "idem",
          SecretString: "y",
          ClientRequestToken: token,
        }),
      ),
      { name: "ResourceExistsException" },
    );
  });

  it("updates description and value", async () => {
    await client.send(
      new CreateSecretCommand({ Name: "upd", SecretString: "a" }),
    );
    await client.send(
      new UpdateSecretCommand({
        SecretId: "upd",
        Description: "hello",
        SecretString: "b",
      }),
    );
    const described = await client.send(
      new DescribeSecretCommand({ SecretId: "upd" }),
    );
    assert.equal(described.Description, "hello");
    const got = await client.send(
      new GetSecretValueCommand({ SecretId: "upd" }),
    );
    assert.equal(got.SecretString, "b");
  });

  it("lists with filters and pagination", async () => {
    for (const name of ["list/a", "list/b", "list/c"]) {
      await client.send(
        new CreateSecretCommand({
          Name: name,
          SecretString: "v",
          Tags: [{ Key: "team", Value: name === "list/b" ? "red" : "blue" }],
        }),
      );
    }
    const first = await client.send(
      new ListSecretsCommand({
        Filters: [{ Key: "name", Values: ["list/"] }],
        MaxResults: 2,
        SortBy: "name",
        SortOrder: "asc",
      }),
    );
    assert.deepEqual(
      first.SecretList!.map((s) => s.Name),
      ["list/a", "list/b"],
    );
    assert.ok(first.NextToken);
    const second = await client.send(
      new ListSecretsCommand({
        Filters: [{ Key: "name", Values: ["list/"] }],
        MaxResults: 2,
        SortBy: "name",
        SortOrder: "asc",
        NextToken: first.NextToken,
      }),
    );
    assert.deepEqual(
      second.SecretList!.map((s) => s.Name),
      ["list/c"],
    );
    assert.equal(second.NextToken, undefined);

    const blue = await client.send(
      new ListSecretsCommand({
        Filters: [
          { Key: "name", Values: ["list/"] },
          { Key: "tag-value", Values: ["!red"] },
        ],
      }),
    );
    assert.deepEqual(blue.SecretList!.map((s) => s.Name).sort(), [
      "list/a",
      "list/c",
    ]);
  });

  it("schedules deletion, restores, and force-deletes", async () => {
    await client.send(
      new CreateSecretCommand({ Name: "doomed", SecretString: "v" }),
    );
    const deleted = await client.send(
      new DeleteSecretCommand({ SecretId: "doomed", RecoveryWindowInDays: 7 }),
    );
    assert.ok(deleted.DeletionDate!.getTime() > Date.now() + 6 * 86400_000);
    await assert.rejects(
      client.send(new GetSecretValueCommand({ SecretId: "doomed" })),
      {
        name: "InvalidRequestException",
      },
    );
    const listed = await client.send(new ListSecretsCommand({}));
    assert.ok(!listed.SecretList!.some((s) => s.Name === "doomed"));

    await client.send(new RestoreSecretCommand({ SecretId: "doomed" }));
    const got = await client.send(
      new GetSecretValueCommand({ SecretId: "doomed" }),
    );
    assert.equal(got.SecretString, "v");

    await client.send(
      new DeleteSecretCommand({
        SecretId: "doomed",
        ForceDeleteWithoutRecovery: true,
      }),
    );
    await assert.rejects(
      client.send(new DescribeSecretCommand({ SecretId: "doomed" })),
      {
        name: "ResourceNotFoundException",
      },
    );
  });

  it("tags secrets", async () => {
    await client.send(new CreateSecretCommand({ Name: "tagged" }));
    await client.send(
      new TagResourceCommand({
        SecretId: "tagged",
        Tags: [{ Key: "env", Value: "dev" }],
      }),
    );
    const described = await client.send(
      new DescribeSecretCommand({ SecretId: "tagged" }),
    );
    assert.deepEqual(described.Tags, [{ Key: "env", Value: "dev" }]);
  });

  it("batch-gets values, reporting per-secret errors", async () => {
    await client.send(
      new CreateSecretCommand({ Name: "batch1", SecretString: "b1" }),
    );
    const res = await client.send(
      new BatchGetSecretValueCommand({ SecretIdList: ["batch1", "missing"] }),
    );
    assert.deepEqual(
      res.SecretValues!.map((v) => v.SecretString),
      ["b1"],
    );
    assert.deepEqual(
      res.Errors!.map((e) => [e.SecretId, e.ErrorCode]),
      [["missing", "ResourceNotFoundException"]],
    );
  });

  it("generates random passwords", async () => {
    const res = await client.send(
      new GetRandomPasswordCommand({
        PasswordLength: 40,
        ExcludePunctuation: true,
      }),
    );
    assert.match(res.RandomPassword!, /^[A-Za-z0-9]{40}$/);
    assert.match(res.RandomPassword!, /[a-z]/);
    assert.match(res.RandomPassword!, /[A-Z]/);
    assert.match(res.RandomPassword!, /[0-9]/);
  });

  it("gives each access key id its own store, whatever the secret key", async () => {
    await client.send(
      new CreateSecretCommand({ Name: "mine", SecretString: "only me" }),
    );

    const other = clientsFor(server.endpoint, "someone-else").secrets;
    await assert.rejects(
      other.send(new GetSecretValueCommand({ SecretId: "mine" })),
      {
        name: "ResourceNotFoundException",
      },
    );
    await other.send(
      new CreateSecretCommand({ Name: "mine", SecretString: "theirs" }),
    );

    const sameKeyNewSecret = clientsFor(
      server.endpoint,
      "test",
      "a different secret",
    ).secrets;
    const got = await sameKeyNewSecret.send(
      new GetSecretValueCommand({ SecretId: "mine" }),
    );
    assert.equal(got.SecretString, "only me");
  });
});
