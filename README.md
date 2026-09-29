# @fordi-org/shhh

A self-hosted, development stand-in for **AWS Secrets Manager** and **AWS Systems Manager Parameter Store**. Point the AWS CLI (or any AWS SDK) at it with `--endpoint-url`, and `aws secretsmanager ...` / `aws ssm ...-parameter...` commands work against a local sqlite database instead of AWS.

It's API-only - no UI - and speaks the same AWS JSON 1.1 protocol as the real services, so nothing on the client side changes except the endpoint.

> **Not for production secrets.** shhh doesn't verify request signatures, and each store's encryption key is derived from its access key id alone. See [docs/security.md](docs/security.md).

## Quick start

Requires Node.js **v24.18.0+** (native TypeScript execution and `node:sqlite`, no build step). With [nvm](https://github.com/nvm-sh/nvm):

```sh
nvm install && nvm use
npm install
npm run daemon    # or, after `npm run build`: ./dist/shhh.mjs
```

That starts shhh as a background daemon and returns once it's listening. If one is already running against the same database, it's stopped and replaced. `npm stop` (or `./dist/shhh.mjs stop`) stops it; `npm start` runs it in the foreground instead, restarting on source changes.

With no configuration it listens on port `3000` and keeps its data in `./shhh.sqlite3`, with the daemon's pidfile and log beside it (`shhh.sqlite3.pid`, `shhh.sqlite3.log`) - see [docs/deployment.md](docs/deployment.md) for settings. Then:

```sh
export AWS_ACCESS_KEY_ID=my-dev-store AWS_SECRET_ACCESS_KEY=unused AWS_DEFAULT_REGION=us-east-1

aws --endpoint-url http://localhost:3000 secretsmanager create-secret \
  --name app/db --secret-string '{"user":"app","password":"hunter2"}'
aws --endpoint-url http://localhost:3000 secretsmanager get-secret-value --secret-id app/db

aws --endpoint-url http://localhost:3000 ssm put-parameter --name /app/password --value hunter2 --type SecureString
aws --endpoint-url http://localhost:3000 ssm get-parameters-by-path --path /app --with-decryption
```

To skip `--endpoint-url`, use the endpoint variables shhh prints on startup. Its stdout is exactly:

```sh
AWS_ENDPOINT_URL_SECRETS_MANAGER=http://localhost:3000
AWS_ENDPOINT_URL_SSM=http://localhost:3000
```

(Status messages go to stderr.) The AWS CLI (v2.13+ / v1.29+) and current SDKs read these in place of `--endpoint-url`, for just those two services, so other `aws` commands still reach real AWS. Save them and source them into any shell:

```sh
npm run -s daemon > shhh.env   # or: ./dist/shhh.mjs > shhh.env
set -a; . ./shhh.env; set +a
aws secretsmanager list-secrets
```

`PORT=0` picks a free port, and the printed URLs use the port actually bound.

The same can live in a profile instead:

```ini
# ~/.aws/config
[profile shhh]
region = us-east-1
services = shhh
[services shhh]
secretsmanager =
  endpoint_url = http://localhost:3000
ssm =
  endpoint_url = http://localhost:3000

# ~/.aws/credentials
[shhh]
aws_access_key_id = my-dev-store
aws_secret_access_key = unused
```

## Stores

There are no accounts to create. **Your access key id is your store**: every distinct `aws_access_key_id` gets its own isolated set of secrets and parameters, created on first use. The same access key id always reaches the same store - across restarts, machines sharing the database, or a different secret access key (which shhh never sees). A different access key id sees an empty store.

## Documentation

- [docs/aws-api.md](docs/aws-api.md) - supported operations and how they differ from AWS
- [docs/security.md](docs/security.md) - stores, encryption, and what shhh does _not_ protect against
- [docs/deployment.md](docs/deployment.md) - configuration, daemon mode, single-file build, serving under a path prefix
- [docs/development.md](docs/development.md) - running tests, adding an operation, native-TS constraints
- [docs/project-layout.md](docs/project-layout.md) - project layout
