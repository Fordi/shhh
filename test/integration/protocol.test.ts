import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Knex } from "knex";
import { createTestDb } from "./helpers/testDb.ts";
import { buildTestApp, TEST_ENV } from "./helpers/testApp.ts";

const AUTH =
  "AWS4-HMAC-SHA256 Credential=test/20260929/us-east-1/ssm/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc";

describe("AWS JSON protocol", () => {
  let knex: Knex;

  before(async () => {
    knex = await createTestDb();
  });

  after(async () => {
    await knex.destroy();
  });

  it("rejects requests without credentials", async () => {
    const { app } = buildTestApp(knex);
    const res = await request(app)
      .post("/")
      .set("X-Amz-Target", "AmazonSSM.GetParameter")
      .set("Content-Type", "application/x-amz-json-1.1")
      .send('{"Name":"/x"}');
    assert.equal(res.status, 403);
    assert.equal(
      res.headers["x-amzn-errortype"],
      "MissingAuthenticationTokenException:",
    );
    assert.equal(
      JSON.parse(res.text).__type,
      "MissingAuthenticationTokenException",
    );
  });

  it("reports unknown operations", async () => {
    const { app } = buildTestApp(knex);
    const res = await request(app)
      .post("/")
      .set("X-Amz-Target", "AmazonSSM.SendCommand")
      .set("Authorization", AUTH)
      .send("{}");
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.text).__type, "UnknownOperationException");
  });

  it("reports validation errors", async () => {
    const { app } = buildTestApp(knex);
    const res = await request(app)
      .post("/")
      .set("X-Amz-Target", "AmazonSSM.GetParameter")
      .set("Content-Type", "application/x-amz-json-1.1")
      .set("Authorization", AUTH)
      .send("{}");
    assert.equal(res.status, 400);
    const body = JSON.parse(res.text);
    assert.equal(body.__type, "ValidationException");
    assert.match(body.message, /'Name'/);
  });

  it("serves a health check", async () => {
    const { app } = buildTestApp(knex);
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.name, "@fordi-org/shhh");
    assert.deepEqual(res.body.services, ["secretsmanager", "AmazonSSM"]);
  });

  it("mounts under BASE_PATH and 404s outside it", async () => {
    const { app } = buildTestApp(knex, { ...TEST_ENV, basePath: "/shhh" });
    assert.equal((await request(app).get("/health")).status, 404);
    assert.equal((await request(app).get("/shhh/health")).status, 200);
  });
});
