// foreground server entrypoint, for `npm start` and process supervisors
import { runForeground } from "../src/daemon.ts";
import { endpointEnv } from "../src/index.ts";

const { endpoint } = await runForeground();
process.stdout.write(endpointEnv(endpoint));
