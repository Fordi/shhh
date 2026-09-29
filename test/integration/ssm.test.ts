import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Knex } from "knex";
import {
  AddTagsToResourceCommand,
  DeleteParameterCommand,
  DeleteParametersCommand,
  DescribeParametersCommand,
  GetParameterCommand,
  GetParameterHistoryCommand,
  GetParametersByPathCommand,
  GetParametersCommand,
  LabelParameterVersionCommand,
  ListTagsForResourceCommand,
  PutParameterCommand,
  RemoveTagsFromResourceCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import { createTestDb } from "./helpers/testDb.ts";
import { clientsFor, startTestServer } from "./helpers/testApp.ts";

describe("SSM Parameter Store", () => {
  let knex: Knex;
  let server: Awaited<ReturnType<typeof startTestServer>>;
  let client: SSMClient;

  before(async () => {
    knex = await createTestDb();
    server = await startTestServer(knex);
    client = clientsFor(server.endpoint).ssm;
  });

  after(async () => {
    await server.close();
    await knex.destroy();
  });

  it("puts, gets, and versions a String parameter", async () => {
    const put = await client.send(
      new PutParameterCommand({
        Name: "/app/url",
        Value: "http://a",
        Type: "String",
      }),
    );
    assert.equal(put.Version, 1);
    assert.equal(put.Tier, "Standard");

    await assert.rejects(
      client.send(
        new PutParameterCommand({
          Name: "/app/url",
          Value: "http://b",
          Type: "String",
        }),
      ),
      { name: "ParameterAlreadyExists" },
    );
    const over = await client.send(
      new PutParameterCommand({
        Name: "/app/url",
        Value: "http://b",
        Overwrite: true,
      }),
    );
    assert.equal(over.Version, 2);

    const got = await client.send(
      new GetParameterCommand({ Name: "/app/url" }),
    );
    assert.equal(got.Parameter!.Value, "http://b");
    assert.equal(got.Parameter!.Type, "String");
    assert.equal(got.Parameter!.Version, 2);
    assert.equal(
      got.Parameter!.ARN,
      "arn:aws:ssm:us-east-1:000000000000:parameter/app/url",
    );

    const v1 = await client.send(
      new GetParameterCommand({ Name: "/app/url:1" }),
    );
    assert.equal(v1.Parameter!.Value, "http://a");
    assert.equal(v1.Parameter!.Selector, ":1");

    const byArn = await client.send(
      new GetParameterCommand({ Name: got.Parameter!.ARN }),
    );
    assert.equal(byArn.Parameter!.Value, "http://b");

    const history = await client.send(
      new GetParameterHistoryCommand({ Name: "/app/url" }),
    );
    assert.deepEqual(
      history.Parameters!.map((p) => p.Value),
      ["http://a", "http://b"],
    );
  });

  it("encrypts SecureString values and decrypts only on request", async () => {
    await client.send(
      new PutParameterCommand({
        Name: "/app/password",
        Value: "hunter2",
        Type: "SecureString",
      }),
    );
    const hidden = await client.send(
      new GetParameterCommand({ Name: "/app/password" }),
    );
    assert.notEqual(hidden.Parameter!.Value, "hunter2");
    const shown = await client.send(
      new GetParameterCommand({ Name: "/app/password", WithDecryption: true }),
    );
    assert.equal(shown.Parameter!.Value, "hunter2");

    const rows = await knex("parameter_versions").where({
      type: "SecureString",
    });
    for (const row of rows) assert.ok(!row.value.includes("hunter2"));
  });

  it("stores String values in plaintext", async () => {
    await client.send(
      new PutParameterCommand({
        Name: "plain",
        Value: "visible",
        Type: "String",
      }),
    );
    const row = await knex("parameter_versions")
      .where({ value: "visible" })
      .first();
    assert.ok(row);
  });

  it("walks paths one level or recursively, with pagination", async () => {
    for (const name of ["/tree/a", "/tree/b", "/tree/sub/c", "/treehouse/x"]) {
      await client.send(
        new PutParameterCommand({ Name: name, Value: name, Type: "String" }),
      );
    }
    const oneLevel = await client.send(
      new GetParametersByPathCommand({ Path: "/tree" }),
    );
    assert.deepEqual(
      oneLevel.Parameters!.map((p) => p.Name),
      ["/tree/a", "/tree/b"],
    );

    const page1 = await client.send(
      new GetParametersByPathCommand({
        Path: "/tree/",
        Recursive: true,
        MaxResults: 2,
      }),
    );
    assert.equal(page1.Parameters!.length, 2);
    const page2 = await client.send(
      new GetParametersByPathCommand({
        Path: "/tree/",
        Recursive: true,
        MaxResults: 2,
        NextToken: page1.NextToken,
      }),
    );
    assert.deepEqual(
      [...page1.Parameters!, ...page2.Parameters!].map((p) => p.Name),
      ["/tree/a", "/tree/b", "/tree/sub/c"],
    );
    assert.equal(page2.NextToken, undefined);
  });

  it("gets several parameters, reporting the missing ones", async () => {
    await client.send(
      new PutParameterCommand({ Name: "/multi/x", Value: "x", Type: "String" }),
    );
    const res = await client.send(
      new GetParametersCommand({ Names: ["/multi/x", "/multi/nope"] }),
    );
    assert.deepEqual(
      res.Parameters!.map((p) => p.Value),
      ["x"],
    );
    assert.deepEqual(res.InvalidParameters, ["/multi/nope"]);
  });

  it("describes parameters with filters", async () => {
    await client.send(
      new PutParameterCommand({
        Name: "/desc/one",
        Value: "1",
        Type: "StringList",
        Description: "first",
      }),
    );
    const res = await client.send(
      new DescribeParametersCommand({
        ParameterFilters: [
          { Key: "Path", Option: "Recursive", Values: ["/desc"] },
          { Key: "Type", Values: ["StringList"] },
        ],
      }),
    );
    assert.equal(res.Parameters!.length, 1);
    assert.equal(res.Parameters![0]!.Name, "/desc/one");
    assert.equal(res.Parameters![0]!.Description, "first");
    assert.match(res.Parameters![0]!.LastModifiedUser!, /:user\/test$/);
  });

  it("labels versions and resolves label selectors", async () => {
    await client.send(
      new PutParameterCommand({ Name: "/lbl", Value: "v1", Type: "String" }),
    );
    await client.send(
      new PutParameterCommand({ Name: "/lbl", Value: "v2", Overwrite: true }),
    );
    const res = await client.send(
      new LabelParameterVersionCommand({
        Name: "/lbl",
        ParameterVersion: 1,
        Labels: ["stable", "9bad"],
      }),
    );
    assert.deepEqual(res.InvalidLabels, ["9bad"]);
    const got = await client.send(
      new GetParameterCommand({ Name: "/lbl:stable" }),
    );
    assert.equal(got.Parameter!.Value, "v1");
  });

  it("validates names", async () => {
    await assert.rejects(
      client.send(
        new PutParameterCommand({
          Name: "no/leading/slash",
          Value: "v",
          Type: "String",
        }),
      ),
      { name: "ValidationException" },
    );
    await assert.rejects(
      client.send(
        new PutParameterCommand({
          Name: "/aws/reserved",
          Value: "v",
          Type: "String",
        }),
      ),
      { name: "ValidationException" },
    );
  });

  it("tags parameters", async () => {
    await client.send(
      new PutParameterCommand({ Name: "/tagme", Value: "v", Type: "String" }),
    );
    await client.send(
      new AddTagsToResourceCommand({
        ResourceType: "Parameter",
        ResourceId: "/tagme",
        Tags: [
          { Key: "a", Value: "1" },
          { Key: "b", Value: "2" },
        ],
      }),
    );
    await client.send(
      new RemoveTagsFromResourceCommand({
        ResourceType: "Parameter",
        ResourceId: "/tagme",
        TagKeys: ["a"],
      }),
    );
    const res = await client.send(
      new ListTagsForResourceCommand({
        ResourceType: "Parameter",
        ResourceId: "/tagme",
      }),
    );
    assert.deepEqual(res.TagList, [{ Key: "b", Value: "2" }]);
  });

  it("deletes parameters", async () => {
    await client.send(
      new PutParameterCommand({ Name: "/del/a", Value: "a", Type: "String" }),
    );
    await client.send(
      new PutParameterCommand({ Name: "/del/b", Value: "b", Type: "String" }),
    );
    await client.send(new DeleteParameterCommand({ Name: "/del/a" }));
    await assert.rejects(
      client.send(new GetParameterCommand({ Name: "/del/a" })),
      {
        name: "ParameterNotFound",
      },
    );
    const res = await client.send(
      new DeleteParametersCommand({ Names: ["/del/b", "/del/zzz"] }),
    );
    assert.deepEqual(res.DeletedParameters, ["/del/b"]);
    assert.deepEqual(res.InvalidParameters, ["/del/zzz"]);
  });

  it("keeps each access key id's parameters separate", async () => {
    await client.send(
      new PutParameterCommand({ Name: "/iso", Value: "mine", Type: "String" }),
    );
    const other = clientsFor(server.endpoint, "other-dev").ssm;
    await assert.rejects(
      other.send(new GetParameterCommand({ Name: "/iso" })),
      {
        name: "ParameterNotFound",
      },
    );
  });
});
