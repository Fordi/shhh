// self-daemonizing launcher: replaces any running instance, then forks a detached server
import { fork } from "node:child_process";
import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AppConfig } from "./config/env.ts";
import { startServer, type RunningServer } from "./index.ts";
import pkg from "../package.json" with { type: "json" };

const STOP_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 2_000;

export interface InstanceFiles {
  pidFile: string;
  logFile: string;
}

interface PidFileContents {
  pid: number;
  endpoint: string;
}

interface ReadyMessage {
  type: "ready";
  endpoint: string;
}

/**
 * One instance per database - sqlite has a single writer - so the pidfile
 * and daemon log live beside it. In-memory databases have no file to sit
 * beside, so they share one well-known pair in the temp directory.
 */
export function instanceFiles(
  env: Pick<AppConfig, "DATABASE_PATH">,
): InstanceFiles {
  const base =
    env.DATABASE_PATH === ":memory:"
      ? join(tmpdir(), "shhh-memory")
      : resolve(process.cwd(), env.DATABASE_PATH);
  return { pidFile: `${base}.pid`, logFile: `${base}.log` };
}

function readPidFile(pidFile: string): PidFileContents | undefined {
  try {
    const parsed = JSON.parse(readFileSync(pidFile, "utf8")) as PidFileContents;
    return Number.isInteger(parsed.pid) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, but belongs to someone else - so it isn't ours.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Pids get recycled, so a live pid from a stale pidfile may be anything.
 * Only signal it if it answers as shhh on its recorded endpoint, or (if it's
 * too wedged to answer) its process title - set in runForeground() - says so.
 */
async function isShhh(instance: PidFileContents): Promise<boolean> {
  try {
    const res = await fetch(`${instance.endpoint}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (res.ok && ((await res.json()) as { name?: string }).name === pkg.name) {
      return true;
    }
  } catch {
    // unreachable or hung; fall through to the process title
  }
  try {
    return readFileSync(`/proc/${instance.pid}/cmdline`, "utf8").startsWith(
      pkg.name,
    );
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

/**
 * Stops the instance recorded in `pidFile`, if there is one: SIGTERM, then
 * SIGKILL if it hasn't exited within STOP_TIMEOUT_MS. A pidfile pointing at
 * a dead or foreign process is just removed. Returns the stopped pid.
 */
export async function stopInstance(
  pidFile: string,
): Promise<number | undefined> {
  const instance = readPidFile(pidFile);
  if (!instance) return undefined;
  if (!isAlive(instance.pid) || !(await isShhh(instance))) {
    removePidFile(pidFile);
    return undefined;
  }
  process.kill(instance.pid, "SIGTERM");
  if (!(await waitForExit(instance.pid, STOP_TIMEOUT_MS))) {
    process.kill(instance.pid, "SIGKILL");
    await waitForExit(instance.pid, 2_000);
  }
  removePidFile(pidFile);
  return instance.pid;
}

function removePidFile(pidFile: string, onlyIfPid?: number): void {
  try {
    if (onlyIfPid !== undefined && readPidFile(pidFile)?.pid !== onlyIfPid)
      return;
    unlinkSync(pidFile);
  } catch {
    // already gone
  }
}

/**
 * Runs the server in this process: `npm start`, supervised runs, and
 * what the daemon itself runs. Records a pidfile so a later launch can find
 * and replace it, and - when forked by daemonize() - reports readiness over
 * the IPC channel, then drops it so the parent can exit.
 */
export async function runForeground(): Promise<RunningServer> {
  process.title = pkg.name;
  const server = await startServer();
  const { pidFile } = instanceFiles(server.env);

  writeFileSync(
    pidFile,
    JSON.stringify({ pid: process.pid, endpoint: server.endpoint }),
  );
  process.on("exit", () => removePidFile(pidFile, process.pid));
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void server.terminate().finally(() => process.exit(0));
    });
  }

  if (process.send) {
    // Disconnect only once the message is flushed, or the parent may miss it.
    process.send(
      { type: "ready", endpoint: server.endpoint } satisfies ReadyMessage,
      () => process.disconnect?.(),
    );
  }
  return server;
}

/**
 * Replaces any running instance for this database, then forks this same
 * script with --foreground, detached into its own session with its output
 * appended to the log file. Resolves once the daemon is listening, with its
 * pid and endpoint; rejects (pointing at the log) if it dies or stalls first.
 */
export async function daemonize(
  env: Pick<AppConfig, "DATABASE_PATH">,
): Promise<{
  pid: number;
  endpoint: string;
  replaced?: number;
  logFile: string;
}> {
  const { pidFile, logFile } = instanceFiles(env);
  const replaced = await stopInstance(pidFile);

  const log = openSync(logFile, "a");
  const child = fork(process.argv[1]!, ["--foreground"], {
    detached: true,
    stdio: ["ignore", log, log, "ipc"],
    // --watch would tie the daemon's lifetime to this launcher.
    execArgv: process.execArgv.filter((arg) => !arg.startsWith("--watch")),
  });
  closeSync(log);

  try {
    const endpoint = await new Promise<string>((resolveReady, reject) => {
      const fail = (why: string) =>
        reject(new Error(`${pkg.name} daemon ${why}; see ${logFile}`));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(`did not start within ${READY_TIMEOUT_MS / 1000}s`);
      }, READY_TIMEOUT_MS);
      child.once("message", (message: ReadyMessage) => {
        clearTimeout(timer);
        resolveReady(message.endpoint);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        fail(`exited during startup (${signal ?? `code ${code}`})`);
      });
    });
    return { pid: child.pid!, endpoint, replaced, logFile };
  } finally {
    child.removeAllListeners();
    if (child.connected) child.disconnect();
    child.unref();
  }
}
