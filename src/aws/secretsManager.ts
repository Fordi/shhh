// AWS Secrets Manager emulation (X-Amz-Target: secretsmanager.*)
import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SecretRow, SecretVersionRow } from "../db/types.ts";
import type { SecretsRepository } from "../db/repositories/secrets.ts";
import { serializeJsonColumn } from "../db/json.ts";
import {
  AwsError,
  epoch,
  operation,
  type OperationContext,
  type Service,
} from "./protocol.ts";
import {
  mergeTags,
  paginate,
  parseTags,
  removeTags,
  TagSchema,
} from "./common.ts";

const CURRENT = "AWSCURRENT";
const PREVIOUS = "AWSPREVIOUS";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Versions with no staging label are pruned beyond this many. */
const MAX_VERSIONS = 100;

const SecretId = z.string().min(1).max(2048);
const ClientRequestToken = z.string().min(32).max(64).optional();
const SecretString = z.string().max(65536).optional();
const SecretBinary = z.string().optional();
const Name = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^[A-Za-z0-9/_+=.@-]+$/,
    "must contain only alphanumerics and /_+=.@-",
  );
const FILTER_KEYS = [
  "description",
  "name",
  "tag-key",
  "tag-value",
  "primary-region",
  "owning-service",
  "all",
] as const;
const Filters = z
  .array(
    z.object({
      Key: z.enum(FILTER_KEYS),
      Values: z.array(z.string().min(1).max(512)).max(10).optional(),
    }),
  )
  .max(10)
  .optional();
type Filter = NonNullable<z.infer<typeof Filters>>[number];

function notFound(): AwsError {
  return new AwsError(
    "ResourceNotFoundException",
    "Secrets Manager can't find the specified secret.",
  );
}

/**
 * SecretId may be a name, a full ARN, or a partial ARN (a full one without
 * its random 6-character suffix).
 */
async function resolveSecret(
  repo: SecretsRepository,
  secretId: string,
  { allowDeleted = false } = {},
): Promise<SecretRow> {
  let secret: SecretRow | undefined;
  if (secretId.startsWith("arn:")) {
    secret = await repo.findByArn(secretId);
    const partialName = secretId.match(/:secret:(.+)$/)?.[1];
    if (!secret && partialName) secret = await repo.findByName(partialName);
  } else {
    secret = await repo.findByName(secretId);
  }
  if (!secret) throw notFound();
  if (secret.deletion_date !== null && !allowDeleted) {
    throw new AwsError(
      "InvalidRequestException",
      "You can't perform this operation on the secret because it was marked for deletion.",
    );
  }
  return secret;
}

function arnFor(ctx: OperationContext, name: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const suffix = Array.from(
    { length: 6 },
    () => alphabet[randomInt(alphabet.length)],
  ).join("");
  return `arn:aws:secretsmanager:${ctx.region}:${ctx.accountId}:secret:${name}-${suffix}`;
}

interface StagedVersion {
  row: SecretVersionRow;
  stages: string[];
}

function staged(rows: SecretVersionRow[]): StagedVersion[] {
  return rows.map((row) => ({
    row,
    stages: JSON.parse(row.stages) as string[],
  }));
}

/**
 * Moves `stage` onto `to` (or just removes it, when `to` is undefined).
 * Moving AWSCURRENT demotes its previous holder to AWSPREVIOUS, exactly as
 * Secrets Manager does - that's what makes a rollback one call.
 */
export function moveStage(
  versions: StagedVersion[],
  stage: string,
  to: StagedVersion | undefined,
): void {
  const from = versions.find((v) => v.stages.includes(stage));
  if (from === to) return;
  if (from) from.stages = from.stages.filter((s) => s !== stage);
  to?.stages.push(stage);
  if (stage === CURRENT && from) moveStage(versions, PREVIOUS, from);
}

async function saveStages(
  repo: SecretsRepository,
  versions: StagedVersion[],
): Promise<void> {
  for (const v of versions) {
    const stages = serializeJsonColumn(v.stages);
    if (stages !== v.row.stages) await repo.setVersionStages(v.row.id, stages);
  }
}

type SecretValue = { SecretString: string } | { SecretBinary: string };

function valueFromInput(input: {
  SecretString?: string;
  SecretBinary?: string;
}): SecretValue | undefined {
  if (input.SecretString !== undefined && input.SecretBinary !== undefined) {
    throw new AwsError(
      "InvalidParameterException",
      "You can't specify both a binary secret value and a string secret value in the same secret.",
    );
  }
  if (input.SecretString !== undefined)
    return { SecretString: input.SecretString };
  if (input.SecretBinary !== undefined)
    return { SecretBinary: input.SecretBinary };
  return undefined;
}

function decryptValue(
  ctx: OperationContext,
  row: SecretVersionRow,
): SecretValue {
  const value = ctx.cipher.decrypt(row.value_ciphertext);
  return row.value_kind === "binary"
    ? { SecretBinary: value }
    : { SecretString: value };
}

/**
 * Adds a version and attaches `stages` to it. Retrying with the same
 * ClientRequestToken and value is a no-op, as in AWS; reusing a token for a
 * different value is an error.
 */
async function putVersion(
  ctx: OperationContext,
  repo: SecretsRepository,
  secret: SecretRow,
  value: SecretValue,
  versionId: string = randomUUID(),
  stages: string[] = [CURRENT],
): Promise<StagedVersion> {
  const versions = staged(await repo.versions(secret.id));
  const existing = versions.find((v) => v.row.version_id === versionId);
  if (existing) {
    const same =
      JSON.stringify(decryptValue(ctx, existing.row)) === JSON.stringify(value);
    if (!same) {
      throw new AwsError(
        "ResourceExistsException",
        "You can't modify an existing version, you can only create a new version.",
      );
    }
    return existing;
  }

  const row = {
    secret_id: secret.id,
    version_id: versionId,
    value_kind:
      "SecretBinary" in value ? ("binary" as const) : ("string" as const),
    value_ciphertext: ctx.cipher.encrypt(
      "SecretBinary" in value ? value.SecretBinary : value.SecretString,
    ),
    stages: "[]",
    created_at: ctx.now,
  };
  await repo.insertVersion(row);
  const all = staged(await repo.versions(secret.id));
  const added = all.find((v) => v.row.version_id === versionId)!;
  for (const stage of stages) moveStage(all, stage, added);
  await saveStages(repo, all);

  const unstaged = all.filter((v) => v.stages.length === 0);
  const excess = all.length - MAX_VERSIONS;
  if (excess > 0) {
    await repo.deleteVersions(unstaged.slice(-excess).map((v) => v.row.id));
  }
  await repo.update(secret.id, { last_changed_at: ctx.now });
  return added;
}

function versionIdsToStages(
  versions: StagedVersion[],
): Record<string, string[]> {
  return Object.fromEntries(
    versions
      .filter((v) => v.stages.length > 0)
      .map((v) => [v.row.version_id, v.stages]),
  );
}

function describe(secret: SecretRow, versions: StagedVersion[]) {
  const tags = parseTags(secret.tags);
  return {
    ARN: secret.arn,
    Name: secret.name,
    Description: secret.description ?? undefined,
    KmsKeyId: secret.kms_key_id ?? undefined,
    RotationEnabled: false,
    LastChangedDate: epoch(secret.last_changed_at),
    LastAccessedDate: epoch(secret.last_accessed_at),
    DeletedDate: epoch(secret.deletion_date),
    Tags: tags.length > 0 ? tags : undefined,
    CreatedDate: epoch(secret.created_at),
    VersionIdsToStages: versionIdsToStages(versions),
  };
}

function matchesFilter(secret: SecretRow, filter: Filter): boolean {
  const tags = parseTags(secret.tags);
  const fields: Record<Filter["Key"], string[]> = {
    name: [secret.name],
    description: secret.description ? [secret.description] : [],
    "tag-key": tags.map((t) => t.Key),
    "tag-value": tags.map((t) => t.Value),
    "primary-region": [],
    "owning-service": [],
    all: [],
  };
  fields.all = [
    ...fields.name,
    ...fields.description,
    ...fields["tag-key"],
    ...fields["tag-value"],
  ];
  const hits = (value: string) =>
    fields[filter.Key].some((field) =>
      field.toLowerCase().startsWith(value.toLowerCase()),
    );
  const values = filter.Values ?? [];
  const positive = values.filter((v) => !v.startsWith("!"));
  const negative = values
    .filter((v) => v.startsWith("!"))
    .map((v) => v.slice(1));
  return (positive.length === 0 || positive.some(hits)) && !negative.some(hits);
}

async function getValue(
  ctx: OperationContext,
  secretId: string,
  versionId?: string,
  versionStage?: string,
) {
  const secret = await resolveSecret(ctx.secrets, secretId);
  const versions = staged(await ctx.secrets.versions(secret.id));
  const stage = versionStage ?? (versionId ? undefined : CURRENT);
  const version = versions.find(
    (v) =>
      (versionId === undefined || v.row.version_id === versionId) &&
      (stage === undefined || v.stages.includes(stage)),
  );
  if (!version) {
    throw new AwsError(
      "ResourceNotFoundException",
      versionId
        ? `Secrets Manager can't find the specified secret value for VersionId: ${versionId}`
        : `Secrets Manager can't find the specified secret value for staging label: ${stage}`,
    );
  }
  // Like AWS, last-accessed is tracked to the day, not the request.
  await ctx.secrets.update(secret.id, {
    last_accessed_at: ctx.now - (ctx.now % DAY_MS),
  });
  return {
    ARN: secret.arn,
    Name: secret.name,
    VersionId: version.row.version_id,
    ...decryptValue(ctx, version.row),
    VersionStages: version.stages,
    CreatedDate: epoch(version.row.created_at),
  };
}

const PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

function randomPassword(input: {
  PasswordLength: number;
  ExcludeCharacters?: string;
  ExcludeNumbers?: boolean;
  ExcludePunctuation?: boolean;
  ExcludeUppercase?: boolean;
  ExcludeLowercase?: boolean;
  IncludeSpace?: boolean;
  RequireEachIncludedType: boolean;
}): string {
  const exclude = new Set(input.ExcludeCharacters ?? "");
  const classes = [
    input.ExcludeLowercase ? "" : "abcdefghijklmnopqrstuvwxyz",
    input.ExcludeUppercase ? "" : "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    input.ExcludeNumbers ? "" : "0123456789",
    input.ExcludePunctuation ? "" : PUNCTUATION,
    input.IncludeSpace ? " " : "",
  ]
    .map((chars) => [...chars].filter((c) => !exclude.has(c)))
    .filter((chars) => chars.length > 0);
  const all = classes.flat();
  if (all.length === 0) {
    throw new AwsError(
      "InvalidParameterException",
      "The password parameters exclude every character.",
    );
  }
  const required = input.RequireEachIncludedType ? classes : [];
  if (required.length > input.PasswordLength) {
    throw new AwsError(
      "InvalidParameterException",
      "The password length is too short to include every required character type.",
    );
  }
  const pick = (chars: string[]) => chars[randomInt(chars.length)]!;
  const chars = [
    ...required.map(pick),
    ...Array.from({ length: input.PasswordLength - required.length }, () =>
      pick(all),
    ),
  ];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

export const secretsManager: Service = {
  targetPrefix: "secretsmanager",

  async beforeEach(ctx) {
    await ctx.secrets.purgeExpired(ctx.now);
  },

  operations: {
    CreateSecret: operation(
      z.object({
        Name,
        ClientRequestToken,
        Description: z.string().max(2048).optional(),
        KmsKeyId: z.string().max(2048).optional(),
        SecretString,
        SecretBinary,
        Tags: z.array(TagSchema).max(50).optional(),
        AddReplicaRegions: z.array(z.unknown()).optional(),
        ForceOverwriteReplicaSecret: z.boolean().optional(),
      }),
      async (input, ctx) => {
        const value = valueFromInput(input);
        return ctx.secrets.transaction(async (repo) => {
          const existing = await repo.findByName(input.Name);
          if (existing?.deletion_date) {
            throw new AwsError(
              "InvalidRequestException",
              "You can't create this secret because a secret with this name is already scheduled for deletion.",
            );
          }
          if (existing) {
            throw new AwsError(
              "ResourceExistsException",
              `The operation failed because the secret ${input.Name} already exists.`,
            );
          }
          const arn = arnFor(ctx, input.Name);
          await repo.create({
            name: input.Name,
            arn,
            description: input.Description ?? null,
            kms_key_id: input.KmsKeyId ?? null,
            tags: serializeJsonColumn(input.Tags ?? []),
            created_at: ctx.now,
            last_changed_at: ctx.now,
            last_accessed_at: null,
            deletion_date: null,
          });
          const secret = (await repo.findByName(input.Name))!;
          const version = value
            ? await putVersion(
                ctx,
                repo,
                secret,
                value,
                input.ClientRequestToken,
              )
            : undefined;
          return {
            ARN: arn,
            Name: input.Name,
            VersionId: version?.row.version_id,
          };
        });
      },
    ),

    GetSecretValue: operation(
      z.object({
        SecretId,
        VersionId: z.string().min(32).max(64).optional(),
        VersionStage: z.string().min(1).max(256).optional(),
      }),
      (input, ctx) =>
        getValue(ctx, input.SecretId, input.VersionId, input.VersionStage),
    ),

    BatchGetSecretValue: operation(
      z.object({
        SecretIdList: z.array(SecretId).min(1).max(20).optional(),
        Filters,
        MaxResults: z.number().int().min(1).max(20).default(20),
        NextToken: z.string().optional(),
      }),
      async (input, ctx) => {
        if (
          (input.SecretIdList === undefined) ===
          (input.Filters === undefined)
        ) {
          throw new AwsError(
            "InvalidParameterException",
            "Either 'SecretIdList' or 'Filters' must be provided, but not both.",
          );
        }
        let ids = input.SecretIdList ?? [];
        let NextToken: string | undefined;
        if (input.Filters) {
          const filters = input.Filters;
          const matching = (await ctx.secrets.list()).filter(
            (s) =>
              s.deletion_date === null &&
              filters.every((f) => matchesFilter(s, f)),
          );
          const page = paginate(
            matching,
            input.MaxResults,
            input.NextToken,
            "InvalidNextTokenException",
          );
          ids = page.page.map((s) => s.name);
          NextToken = page.NextToken;
        }
        const SecretValues = [];
        const Errors = [];
        for (const SecretId of ids) {
          try {
            SecretValues.push(await getValue(ctx, SecretId));
          } catch (e) {
            if (!(e instanceof AwsError)) throw e;
            Errors.push({ SecretId, ErrorCode: e.code, Message: e.message });
          }
        }
        return { SecretValues, Errors, NextToken };
      },
    ),

    PutSecretValue: operation(
      z.object({
        SecretId,
        ClientRequestToken,
        SecretString,
        SecretBinary,
        VersionStages: z
          .array(z.string().min(1).max(256))
          .min(1)
          .max(20)
          .optional(),
        RotationToken: z.string().optional(),
      }),
      async (input, ctx) => {
        const value = valueFromInput(input);
        if (!value) {
          throw new AwsError(
            "InvalidParameterException",
            "You must provide either SecretString or SecretBinary.",
          );
        }
        return ctx.secrets.transaction(async (repo) => {
          const secret = await resolveSecret(repo, input.SecretId);
          const version = await putVersion(
            ctx,
            repo,
            secret,
            value,
            input.ClientRequestToken,
            input.VersionStages,
          );
          return {
            ARN: secret.arn,
            Name: secret.name,
            VersionId: version.row.version_id,
            VersionStages: version.stages,
          };
        });
      },
    ),

    UpdateSecret: operation(
      z.object({
        SecretId,
        ClientRequestToken,
        Description: z.string().max(2048).optional(),
        KmsKeyId: z.string().max(2048).optional(),
        SecretString,
        SecretBinary,
      }),
      async (input, ctx) => {
        const value = valueFromInput(input);
        return ctx.secrets.transaction(async (repo) => {
          const secret = await resolveSecret(repo, input.SecretId);
          await repo.update(secret.id, {
            description: input.Description ?? secret.description,
            kms_key_id: input.KmsKeyId ?? secret.kms_key_id,
            last_changed_at: ctx.now,
          });
          const version = value
            ? await putVersion(
                ctx,
                repo,
                secret,
                value,
                input.ClientRequestToken,
              )
            : undefined;
          return {
            ARN: secret.arn,
            Name: secret.name,
            VersionId: version?.row.version_id,
          };
        });
      },
    ),

    UpdateSecretVersionStage: operation(
      z.object({
        SecretId,
        VersionStage: z.string().min(1).max(256),
        RemoveFromVersionId: z.string().min(32).max(64).optional(),
        MoveToVersionId: z.string().min(32).max(64).optional(),
      }),
      async (input, ctx) =>
        ctx.secrets.transaction(async (repo) => {
          const secret = await resolveSecret(repo, input.SecretId);
          const versions = staged(await repo.versions(secret.id));
          const holder = versions.find((v) =>
            v.stages.includes(input.VersionStage),
          );
          if (
            input.RemoveFromVersionId !== undefined &&
            holder?.row.version_id !== input.RemoveFromVersionId
          ) {
            throw new AwsError(
              "InvalidParameterException",
              `The staging label ${input.VersionStage} is not attached to version ${input.RemoveFromVersionId}.`,
            );
          }
          if (
            holder &&
            input.MoveToVersionId !== undefined &&
            input.RemoveFromVersionId === undefined &&
            holder.row.version_id !== input.MoveToVersionId
          ) {
            throw new AwsError(
              "InvalidParameterException",
              `The staging label ${input.VersionStage} is currently attached to version ${holder.row.version_id}, so you must explicitly reference that version in RemoveFromVersionId.`,
            );
          }
          let to: StagedVersion | undefined;
          if (input.MoveToVersionId !== undefined) {
            to = versions.find(
              (v) => v.row.version_id === input.MoveToVersionId,
            );
            if (!to) {
              throw new AwsError(
                "ResourceNotFoundException",
                `Secrets Manager can't find the specified secret version: ${input.MoveToVersionId}`,
              );
            }
          } else if (input.VersionStage === CURRENT) {
            throw new AwsError(
              "InvalidParameterException",
              "You can't remove the AWSCURRENT staging label without moving it to another version.",
            );
          }
          moveStage(versions, input.VersionStage, to);
          await saveStages(repo, versions);
          await repo.update(secret.id, { last_changed_at: ctx.now });
          return { ARN: secret.arn, Name: secret.name };
        }),
    ),

    DescribeSecret: operation(z.object({ SecretId }), async (input, ctx) => {
      const secret = await resolveSecret(ctx.secrets, input.SecretId, {
        allowDeleted: true,
      });
      return describe(secret, staged(await ctx.secrets.versions(secret.id)));
    }),

    ListSecrets: operation(
      z.object({
        IncludePlannedDeletion: z.boolean().default(false),
        MaxResults: z.number().int().min(1).max(100).default(100),
        NextToken: z.string().optional(),
        Filters,
        SortBy: z
          .enum([
            "created-date",
            "last-accessed-date",
            "last-changed-date",
            "name",
          ])
          .default("created-date"),
        SortOrder: z.enum(["asc", "desc"]).default("desc"),
      }),
      async (input, ctx) => {
        const column = {
          "created-date": "created_at",
          "last-accessed-date": "last_accessed_at",
          "last-changed-date": "last_changed_at",
          name: "name",
        } as const satisfies Record<typeof input.SortBy, keyof SecretRow>;
        const key = column[input.SortBy];
        const sign = input.SortOrder === "asc" ? 1 : -1;
        const filters = input.Filters ?? [];
        const matching = (await ctx.secrets.list())
          .filter(
            (s) => input.IncludePlannedDeletion || s.deletion_date === null,
          )
          .filter((s) => filters.every((f) => matchesFilter(s, f)))
          .sort((a, b) => {
            const [x, y] = [a[key] ?? 0, b[key] ?? 0];
            return (x < y ? -1 : x > y ? 1 : a.id - b.id) * sign;
          });
        const { page, NextToken } = paginate(
          matching,
          input.MaxResults,
          input.NextToken,
          "InvalidNextTokenException",
        );
        const SecretList = [];
        for (const secret of page) {
          const { VersionIdsToStages, ...entry } = describe(
            secret,
            staged(await ctx.secrets.versions(secret.id)),
          );
          SecretList.push({
            ...entry,
            SecretVersionsToStages: VersionIdsToStages,
          });
        }
        return { SecretList, NextToken };
      },
    ),

    ListSecretVersionIds: operation(
      z.object({
        SecretId,
        MaxResults: z.number().int().min(1).max(100).default(100),
        NextToken: z.string().optional(),
        IncludeDeprecated: z.boolean().default(false),
      }),
      async (input, ctx) => {
        const secret = await resolveSecret(ctx.secrets, input.SecretId, {
          allowDeleted: true,
        });
        const versions = staged(await ctx.secrets.versions(secret.id)).filter(
          (v) => input.IncludeDeprecated || v.stages.length > 0,
        );
        const { page, NextToken } = paginate(
          versions,
          input.MaxResults,
          input.NextToken,
          "InvalidNextTokenException",
        );
        return {
          Versions: page.map((v) => ({
            VersionId: v.row.version_id,
            VersionStages: v.stages,
            CreatedDate: epoch(v.row.created_at),
          })),
          NextToken,
          ARN: secret.arn,
          Name: secret.name,
        };
      },
    ),

    DeleteSecret: operation(
      z.object({
        SecretId,
        RecoveryWindowInDays: z.number().int().min(7).max(30).optional(),
        ForceDeleteWithoutRecovery: z.boolean().optional(),
      }),
      async (input, ctx) => {
        if (
          input.ForceDeleteWithoutRecovery &&
          input.RecoveryWindowInDays !== undefined
        ) {
          throw new AwsError(
            "InvalidParameterException",
            "You can't use ForceDeleteWithoutRecovery in conjunction with RecoveryWindowInDays.",
          );
        }
        const secret = await resolveSecret(ctx.secrets, input.SecretId, {
          allowDeleted: true,
        });
        if (input.ForceDeleteWithoutRecovery) {
          await ctx.secrets.delete(secret.id);
          return {
            ARN: secret.arn,
            Name: secret.name,
            DeletionDate: epoch(ctx.now),
          };
        }
        if (secret.deletion_date !== null) {
          throw new AwsError(
            "InvalidRequestException",
            "You can't perform this operation on the secret because it was already scheduled for deletion.",
          );
        }
        const deletionDate =
          ctx.now + (input.RecoveryWindowInDays ?? 30) * DAY_MS;
        await ctx.secrets.update(secret.id, { deletion_date: deletionDate });
        return {
          ARN: secret.arn,
          Name: secret.name,
          DeletionDate: epoch(deletionDate),
        };
      },
    ),

    RestoreSecret: operation(z.object({ SecretId }), async (input, ctx) => {
      const secret = await resolveSecret(ctx.secrets, input.SecretId, {
        allowDeleted: true,
      });
      await ctx.secrets.update(secret.id, { deletion_date: null });
      return { ARN: secret.arn, Name: secret.name };
    }),

    TagResource: operation(
      z.object({ SecretId, Tags: z.array(TagSchema).max(50) }),
      async (input, ctx) => {
        const secret = await resolveSecret(ctx.secrets, input.SecretId, {
          allowDeleted: true,
        });
        await ctx.secrets.update(secret.id, {
          tags: serializeJsonColumn(
            mergeTags(parseTags(secret.tags), input.Tags),
          ),
        });
        return {};
      },
    ),

    UntagResource: operation(
      z.object({ SecretId, TagKeys: z.array(z.string().min(1).max(128)) }),
      async (input, ctx) => {
        const secret = await resolveSecret(ctx.secrets, input.SecretId, {
          allowDeleted: true,
        });
        await ctx.secrets.update(secret.id, {
          tags: serializeJsonColumn(
            removeTags(parseTags(secret.tags), input.TagKeys),
          ),
        });
        return {};
      },
    ),

    GetRandomPassword: operation(
      z.object({
        PasswordLength: z.number().int().min(1).max(4096).default(32),
        ExcludeCharacters: z.string().max(4096).optional(),
        ExcludeNumbers: z.boolean().optional(),
        ExcludePunctuation: z.boolean().optional(),
        ExcludeUppercase: z.boolean().optional(),
        ExcludeLowercase: z.boolean().optional(),
        IncludeSpace: z.boolean().optional(),
        RequireEachIncludedType: z.boolean().default(true),
      }),
      (input) => ({ RandomPassword: randomPassword(input) }),
    ),
  },
};
