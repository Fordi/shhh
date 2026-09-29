# Deployment

## Configuration

On startup, `src/index.ts` loads the first env file that exists - `.env.${NODE_ENV}` (e.g. `.env.production`), then `.env` - via Node's `process.loadEnvFile`. With neither present (normal under most PaaS setups) it reads `process.env` as-is. Variables already in `process.env` always win over anything in a file.

| Variable        | Default              | Notes                                                               |
| --------------- | -------------------- | ------------------------------------------------------------------- |
| `NODE_ENV`      | `development`        | `development \| test \| production`                                 |
| `PORT`          | `3000`               | `0` picks a free port; stdout reports the one bound.                |
| `DATABASE_PATH` | `./shhh.sqlite3`     | sqlite file, relative to the working directory. Created if missing. |
| `ACCOUNT_ID`    | `000000000000`       | 12-digit account id used in ARNs.                                   |
| `BASE_PATH`     | _(empty, no prefix)_ | Serves the endpoint under a path prefix. See below.                 |

Nothing is required. The database is migrated to the latest schema on every boot; `npm run migrate` does the same thing without starting the server.

## Running it

| Command                                       | What it does                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `npm run daemon` / `shhh` / `./dist/shhh.mjs` | Replaces any running instance, starts a detached daemon, prints the endpoint variables once it's listening, and exits. |
| `npm stop` / `shhh stop`                      | Stops the running instance.                                                                                            |
| `npm start`                                   | Foreground, under `node --watch` (restarts on source changes).                                                         |
| `node bin/serve.ts` / `shhh --foreground`     | Foreground, for process supervisors (systemd, containers, ...) - `package.json`'s `main`.                              |

"Already running" means _against the same database_: each instance records `{pid, endpoint}` in `<DATABASE_PATH>.pid` (or `$TMPDIR/shhh-memory.pid` for `:memory:`) and removes it on exit. Before replacing an instance, the launcher confirms the recorded pid really is shhh - via its `/health` endpoint, or failing that its process title - so a stale pidfile whose pid has been recycled never gets another process killed. It sends `SIGTERM`, escalating to `SIGKILL` after 10 seconds.

The daemon is `fork()`ed from the launcher, detached into its own session (so closing the terminal doesn't stop it), with stdout/stderr appended to `<DATABASE_PATH>.log`. It reports readiness back over the fork's IPC channel; if it dies or doesn't start within 15 seconds, the launcher exits non-zero and points at the log.

Foreground instances write the pidfile too, so a daemon launch replaces one - including one run by a supervisor, which will then restart its own. Don't mix the two against the same database.

## Single-file build

```sh
npm run build   # -> dist/shhh.mjs (+ .map, + .LEGAL.txt license notices)
```

[build/build.ts](../build/build.ts) bundles the server and everything it depends on - express, knex, zod, and the migrations - into one executable ESM file with esbuild. It needs only Node.js v24.18.0+ to run: no `node_modules`, no `migrations/` directory, no npm.

```sh
scp dist/shhh.mjs host:/opt/shhh/
ssh host 'cd /opt/shhh && PORT=3000 ./shhh.mjs'   # daemonizes and returns
```

Configuration works exactly as above; `.env` files and the default `DATABASE_PATH` resolve against the working directory, not the file's location. Sending `SIGHUP` to the bundle makes it shut down cleanly and exit (there's no `node --watch` to restart it) - rerun it to restart, or run `./shhh.mjs --foreground` under a supervisor that restarts it, such as systemd with `Restart=always`.

## Serving under a path prefix

Set `BASE_PATH` to serve under a prefix, e.g. when reverse-proxying several apps from one host:

```
BASE_PATH=/shhh
```

The endpoint URL then includes the prefix: `aws --endpoint-url https://example.com/shhh ...`. Requests outside the prefix get a `404`.

### Example nginx config

```nginx
location ^~ /shhh/ {
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto https;
  proxy_set_header Host $http_host;
  proxy_pass http://127.0.0.1:3000;
}
```

`proxy_pass` has no trailing `/`, so the prefix is forwarded unchanged and matched by the app itself.

## Health check

`GET {BASE_PATH}/health` returns `{"name", "version", "services"}` without authentication.
