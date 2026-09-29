// CLI entrypoint: daemonize (replacing any running instance), `--foreground`, or `stop`
import {
  daemonize,
  instanceFiles,
  runForeground,
  stopInstance,
} from "../src/daemon.ts";
import { endpointEnv, projectEnv } from "../src/index.ts";
import pkg from "../package.json" with { type: "json" };

const [command] = process.argv.slice(2);

try {
  if (command === "--foreground") {
    // A forked daemon's stdout is its log; the launcher prints these instead.
    const forked = process.send !== undefined;
    const { endpoint } = await runForeground();
    if (!forked) process.stdout.write(endpointEnv(endpoint));
  } else if (command === "stop") {
    const stopped = await stopInstance(instanceFiles(projectEnv()).pidFile);
    console.error(
      stopped
        ? `stopped ${pkg.name} (pid ${stopped})`
        : `${pkg.name} is not running`,
    );
  } else if (command === undefined) {
    const { pid, endpoint, replaced, logFile } = await daemonize(projectEnv());
    if (replaced)
      console.error(`stopped previous ${pkg.name} (pid ${replaced})`);
    console.error(
      `${pkg.name} daemon (pid ${pid}) listening on ${endpoint}; logging to ${logFile}`,
    );
    process.stdout.write(endpointEnv(endpoint));
  } else {
    console.error(`usage: ${pkg.name} [--foreground | stop]`);
    process.exitCode = 2;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
