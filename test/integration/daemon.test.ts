import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const START = resolve(import.meta.dirname, "../../bin/start.ts");
const run = promisify(execFile);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("daemon", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let pidFile: string;
  const shhh = (...args: string[]) =>
    run(process.execPath, [START, ...args], { env });
  const recorded = () =>
    JSON.parse(readFileSync(pidFile, "utf8")) as {
      pid: number;
      endpoint: string;
    };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "shhh-daemon-"));
    const database = join(dir, "db.sqlite3");
    pidFile = `${database}.pid`;
    env = {
      ...process.env,
      PORT: "0",
      DATABASE_PATH: database,
      NODE_ENV: "test",
    };
  });

  after(async () => {
    await shhh("stop");
    rmSync(dir, { recursive: true, force: true });
  });

  it("daemonizes, printing only the endpoint variables on stdout", async () => {
    const { stdout, stderr } = await shhh();
    const { pid, endpoint } = recorded();
    assert.equal(
      stdout,
      `export AWS_ENDPOINT_URL_SECRETS_MANAGER=${endpoint}\nexport AWS_ENDPOINT_URL_SSM=${endpoint}\n`,
    );
    assert.match(stderr, new RegExp(`daemon \\(pid ${pid}\\)`));
    const health = (await (await fetch(`${endpoint}/health`)).json()) as {
      name: string;
    };
    assert.equal(health.name, "@fordi-org/shhh");
  });

  it("replaces a running instance", async () => {
    const first = recorded();
    const { stderr } = await shhh();
    const second = recorded();
    assert.notEqual(second.pid, first.pid);
    assert.match(
      stderr,
      new RegExp(`stopped previous .* \\(pid ${first.pid}\\)`),
    );
    assert.ok(!isAlive(first.pid));
    assert.equal((await fetch(`${second.endpoint}/health`)).status, 200);
  });

  it("stops, removing the pidfile", async () => {
    const { pid } = recorded();
    await shhh("stop");
    assert.ok(!isAlive(pid));
    assert.ok(!existsSync(pidFile));
    const { stderr } = await shhh("stop");
    assert.match(stderr, /is not running/);
  });

  it("never signals an unrelated process named by a stale pidfile", async () => {
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      writeFileSync(
        pidFile,
        JSON.stringify({ pid: bystander.pid, endpoint: "http://localhost:1" }),
      );
      await shhh();
      assert.ok(isAlive(bystander.pid!));
      assert.notEqual(recorded().pid, bystander.pid);
    } finally {
      bystander.kill();
    }
  });
});
