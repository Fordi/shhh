# Supported AWS operations

Both services speak the AWS JSON 1.1 protocol: every call is a `POST` to the endpoint URL's path, with the operation named in the `X-Amz-Target` header (`secretsmanager.<Operation>` or `AmazonSSM.<Operation>`). Errors come back in AWS's shape (`{"__type": "...", "message": "..."}` plus `x-amzn-ErrorType`), so SDKs raise the same typed exceptions as against AWS (`ResourceNotFoundException`, `ParameterNotFound`, ...).

Anything not listed returns `UnknownOperationException`.

## Secrets Manager (`aws secretsmanager`)

| Operation                      | Notes                                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `CreateSecret`                 | `SecretString` or `SecretBinary`, `Description`, `Tags`, `ClientRequestToken`. `KmsKeyId` is stored but not used.                             |
| `GetSecretValue`               | By `VersionId` and/or `VersionStage` (default `AWSCURRENT`).                                                                                  |
| `BatchGetSecretValue`          | `SecretIdList` or `Filters`.                                                                                                                  |
| `PutSecretValue`               | New version; moves `AWSCURRENT` and demotes the old one to `AWSPREVIOUS`. Retrying the same `ClientRequestToken` is a no-op.                  |
| `UpdateSecret`                 | Description/KMS key, plus a new version if a value is given.                                                                                  |
| `UpdateSecretVersionStage`     | Move or remove staging labels (e.g. roll back `AWSCURRENT`).                                                                                  |
| `DescribeSecret`               |                                                                                                                                               |
| `ListSecrets`                  | `Filters` (`name`, `description`, `tag-key`, `tag-value`, `all`; prefix match, `!` negates), `SortBy`, `SortOrder`, `IncludePlannedDeletion`. |
| `ListSecretVersionIds`         | `IncludeDeprecated` includes versions with no staging label.                                                                                  |
| `DeleteSecret`                 | `RecoveryWindowInDays` (default 30) or `ForceDeleteWithoutRecovery`. Expired secrets are purged on the next request.                          |
| `RestoreSecret`                |                                                                                                                                               |
| `TagResource`, `UntagResource` |                                                                                                                                               |
| `GetRandomPassword`            | All the `Exclude*` / `Include*` / `RequireEachIncludedType` options.                                                                          |

SecretId accepts a name, a full ARN, or a partial ARN (without the random 6-character suffix). ARNs use the region the request was signed for and `ACCOUNT_ID`.

Not supported: rotation (`RotateSecret`, `CancelRotateSecret`), resource policies, replication, and validation of `KmsKeyId`.

## Parameter Store (`aws ssm`)

| Operation                                                            | Notes                                                                                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `PutParameter`                                                       | `String`, `StringList`, `SecureString`; `Overwrite`, `Description`, `AllowedPattern`, `Tier`, `DataType`, `Tags`.     |
| `GetParameter`, `GetParameters`                                      | Name, ARN, `name:version` or `name:label` selectors; `WithDecryption`.                                                |
| `GetParametersByPath`                                                | `Recursive`; `ParameterFilters` on `Type`, `KeyId`, `Label`, `tag:<key>`.                                             |
| `DescribeParameters`                                                 | Legacy `Filters` and `ParameterFilters` on `Name`, `Type`, `KeyId`, `Path`, `Tier`, `DataType`, `Label`, `tag:<key>`. |
| `GetParameterHistory`                                                |                                                                                                                       |
| `DeleteParameter`, `DeleteParameters`                                |                                                                                                                       |
| `LabelParameterVersion`, `UnlabelParameterVersion`                   |                                                                                                                       |
| `AddTagsToResource`, `RemoveTagsFromResource`, `ListTagsForResource` | `ResourceType` must be `Parameter`.                                                                                   |

`SecureString` values read without `WithDecryption` return an opaque ciphertext, as in AWS. `LastModifiedUser` is `arn:aws:iam::<ACCOUNT_ID>:user/<access key id>`.

Not supported: parameter policies (accepted, ignored), shared parameters, and every non-Parameter-Store part of SSM.

## CLI v1 quirk: values that look like URLs

AWS CLI **v1** fetches any parameter value starting with `http://` or `https://` and sends the page contents instead. For `put-parameter --value http://...`, either use CLI v2, set `cli_follow_urlparam = false` in `~/.aws/config`, or pass the value via `--cli-input-json`.
