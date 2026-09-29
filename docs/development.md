# Development

## Native TypeScript, no build step (but you can have one)

This project runs `.ts` source directly via Node's native TypeScript support (v24.18.0+), and uses Node's built-in `node:sqlite` as its database driver (wired into knex by [src/db/NodeSqlite.ts](../src/db/NodeSqlite.ts)) - there's no compile step and no native addon. Two constraints fall out of that:

- **`erasableSyntaxOnly`** (see [tsconfig.json](../tsconfig.json)) is on, so only TypeScript syntax Node can strip at parse time is allowed - no `enum`, no parameter-property shorthand (`constructor(private x: string)`), no `namespace`.
- Imports must include the `.ts` extension (`allowImportingTsExtensions`), matching how Node resolves them at runtime.

`npm run build` is only for distribution: it bundles everything into `dist/shhh.mjs` with esbuild (see [deployment.md](deployment.md#single-file-build)). Development and tests always run the source directly.

## Running tests

```sh
npm test              # full suite (node --test)
npm run only          # only tests marked with `.only`
npm run coverage      # c8 coverage report (html + lcov) under coverage/
```

- [test/unit/](../test/unit) - pure functions, no DB.
- [test/integration/](../test/integration) - the real server on an ephemeral port with an in-memory database ([helpers/testDb.ts](../test/integration/helpers/testDb.ts)), driven by the official `@aws-sdk/client-secrets-manager` and `@aws-sdk/client-ssm` clients ([helpers/testApp.ts](../test/integration/helpers/testApp.ts)) - so they exercise the same wire protocol the AWS CLI uses.

## Adding an AWS operation

Each service is a `Service` object - [src/aws/secretsManager.ts](../src/aws/secretsManager.ts), [src/aws/ssm.ts](../src/aws/ssm.ts) - mapping operation names to `operation(zodSchema, handler)`. [src/aws/protocol.ts](../src/aws/protocol.ts) handles dispatch, credentials, validation (`ValidationException`), and error serialization; a handler just returns the response object or throws `AwsError(code, message)`. Handlers get an `OperationContext` whose repositories and cipher are already bound to the caller's store.

Add the operation to the service's `operations` map, then an SDK-driven test beside the others.

Plain REST routes (like `/health`) are built with [TrackedRouter](../src/util/trackedRouter.ts) and [typedVia](../src/util/typedVia.ts) in [src/api/router.ts](../src/api/router.ts).

## Adding a database table

1. `npm run migrate:make <name>` to scaffold a migration under [migrations/](../migrations). Store-owned tables need a `store_id` column. Register it in [src/db/migrations.ts](../src/db/migrations.ts) too - the app imports migrations statically so they survive bundling, and `test/unit/migrations.test.ts` fails until the list matches the directory.
2. Add the row type to [src/db/types.ts](../src/db/types.ts).
3. Add a store-scoped repository under [src/db/repositories/](../src/db/repositories/) and wire it into `buildRepositories` in [src/db/repositories/index.ts](../src/db/repositories/index.ts).

## Linting and formatting

```sh
npm run lint          # eslint .
npm run lint:fix      # eslint --fix, then regenerates docs/project-layout.md
npm run format        # prettier --write .
npm run format:check
npm run typecheck
```

`docs/project-layout.md` is generated from each file's first-line comment and `.folder` files - see the doc comment at the top of [build/generate-project-layout.ts](../build/generate-project-layout.ts), and re-run `npm run lint:fix` after adding, removing, or renaming files.
