| Path                                                                 | Description                                                                            |
|----------------------------------------------------------------------|----------------------------------------------------------------------------------------|
| [bin/](../bin)                                                       | CLI scripts                                                                            |
| ·  [serve.ts](../bin/serve.ts)                                       | foreground server entrypoint, for `npm start` and process supervisors                  |
| ·  [start.ts](../bin/start.ts)                                       | CLI entrypoint: daemonize (replacing any running instance), `--foreground`, or `stop`  |
| [build/](../build)                                                   | CI scripts                                                                             |
| ·  [build.ts](../build/build.ts)                                     | Bundle the server into a single self-contained file, dist/shhh.mjs                     |
| ·  [generate-project-layout.ts](../build/generate-project-layout.ts) | Generate markdown source tree with first-line comment and .folder info                 |
| [docs/](.)                                                           | documentation                                                                          |
| [migrations/](../migrations)                                         | database schema and migrations                                                         |
| [src/](../src)                                                       | project source                                                                         |
| ·  [api/](../src/api)                                                | API implementations                                                                    |
| ·  ·  [errorHandler.ts](../src/api/errorHandler.ts)                  | server errors                                                                          |
| ·  ·  [router.ts](../src/api/router.ts)                              | root API router                                                                        |
| ·  [auth/](../src/auth)                                              | store selection and encryption key derivation from AWS credentials                     |
| ·  ·  [credentials.ts](../src/auth/credentials.ts)                   | derive a caller's store and encryption key from their AWS access key id                |
| ·  [aws/](../src/aws)                                                | AWS JSON 1.1 protocol and service emulations (Secrets Manager, SSM Parameter Store)    |
| ·  ·  [common.ts](../src/aws/common.ts)                              | pagination and tag helpers shared by the AWS services                                  |
| ·  ·  [protocol.ts](../src/aws/protocol.ts)                          | AWS JSON 1.1 protocol: dispatches X-Amz-Target to a service's typed operations         |
| ·  ·  [secretsManager.ts](../src/aws/secretsManager.ts)              | AWS Secrets Manager emulation (X-Amz-Target: secretsmanager.*)                         |
| ·  ·  [ssm.ts](../src/aws/ssm.ts)                                    | AWS Systems Manager Parameter Store emulation (X-Amz-Target: AmazonSSM.*)              |
| ·  [config/](../src/config)                                          | env vars and at-rest encryption                                                        |
| ·  ·  [cipher.ts](../src/config/cipher.ts)                           | AES-256-GCM encryption at rest, keyed per store                                        |
| ·  ·  [env.ts](../src/config/env.ts)                                 | configuration from the environment                                                     |
| ·  [db/](../src/db)                                                  | database connection, knex setup, and repositories                                      |
| ·  ·  [repositories/](../src/db/repositories)                        | per-table data access                                                                  |
| ·  ·  ·  [index.ts](../src/db/repositories/index.ts)                 | export barrel                                                                          |
| ·  ·  ·  [parameters.ts](../src/db/repositories/parameters.ts)       | SSM parameters and their version history, scoped to one store                          |
| ·  ·  ·  [secrets.ts](../src/db/repositories/secrets.ts)             | Secrets Manager secrets and their versions, scoped to one store                        |
| ·  ·  [connection.ts](../src/db/connection.ts)                       | build knex connection configs for the native node:sqlite driver                        |
| ·  ·  [json.ts](../src/db/json.ts)                                   | helpers for JSON-in-text columns and inserted ids                                      |
| ·  ·  [knex.ts](../src/db/knex.ts)                                   | knex connection management                                                             |
| ·  ·  [knex_sqlite3.d.ts](../src/db/knex_sqlite3.d.ts)               | types for the knex sqlite3 dialect NodeSqlite.ts extends                               |
| ·  ·  [migrations.ts](../src/db/migrations.ts)                       | migrations imported statically, so they survive bundling into one file                 |
| ·  ·  [NodeSqlite.ts](../src/db/NodeSqlite.ts)                       | knex client for Node's built-in node:sqlite                                            |
| ·  ·  [types.ts](../src/db/types.ts)                                 | Database row types                                                                     |
| ·  [util/](../src/util)                                              | shared, dependency-free helpers used across the app                                    |
| ·  ·  [errors.ts](../src/util/errors.ts)                             | HTTP and other API errors                                                              |
| ·  ·  [inspectRouter.ts](../src/util/inspectRouter.ts)               | reflection for express router                                                          |
| ·  ·  [trackedRouter.ts](../src/util/trackedRouter.ts)               | Helper to make API discoverable from router                                            |
| ·  ·  [typedVia.ts](../src/util/typedVia.ts)                         | Uses zod to make request typing explicit                                               |
| ·  ·  [via.ts](../src/util/via.ts)                                   | Helper function for express request handlers                                           |
| ·  [daemon.ts](../src/daemon.ts)                                     | self-daemonizing launcher: replaces any running instance, then forks a detached server |
| ·  [hup.ts](../src/hup.ts)                                           | Canary file for restarting the server; touch this to restart                           |
| ·  [index.ts](../src/index.ts)                                       | Service entrypoint                                                                     |
| ·  [server.ts](../src/server.ts)                                     | Constructs the webserver                                                               |
| [test/](../test)                                                     | test cases                                                                             |
| ·  [integration/](../test/integration)                               | real server + in-memory sqlite, driven by the AWS SDK                                  |
| ·  [unit/](../test/unit)                                             | pure functions, no DB                                                                  |
| [.env.example](../.env.example)                                      | Copy this file to .env (or .env.development / .env.production / .env.test)             |
| [.gitignore](../.gitignore)                                          | Files ignored by the project                                                           |
| [.npmignore](../.npmignore)                                          |                                                                                        |
| [.nvmrc](../.nvmrc)                                                  | nvm version spec                                                                       |
| [.prettierignore](../.prettierignore)                                | generated by build/generate-project-layout.ts                                          |
| [eslint.config.js](../eslint.config.js)                              | basic eslint configuration                                                             |
| [knexfile.ts](../knexfile.ts)                                        | config file for knex                                                                   |
| [package-lock.json](../package-lock.json)                            | node dependency lockfile                                                               |
| [package.json](../package.json)                                      | node package doc                                                                       |
| [README.md](../README.md)                                            | Main documentation                                                                     |
| [tsconfig.json](../tsconfig.json)                                    | TypeScript configuration                                                               |
