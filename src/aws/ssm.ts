// AWS Systems Manager Parameter Store emulation (X-Amz-Target: AmazonSSM.*)
import { z } from "zod";
import {
  PARAMETER_TIERS,
  PARAMETER_TYPES,
  type ParameterRow,
  type ParameterTier,
  type ParameterVersionRow,
} from "../db/types.ts";
import type {
  ParametersRepository,
  ParameterWithVersion,
} from "../db/repositories/parameters.ts";
import { parseJsonColumn, serializeJsonColumn } from "../db/json.ts";
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

const MAX_VERSIONS = 100;
const MAX_DEPTH = 15;
const TIER_LIMITS: Record<ParameterTier, number> = {
  Standard: 4096,
  Advanced: 8192,
};

const Name = z.string().min(1).max(2048);
const Names = z.array(Name).min(1).max(10);
const ParameterFilters = z
  .array(
    z.object({
      Key: z.string().min(1).max(132),
      Option: z.string().min(1).max(10).optional(),
      Values: z.array(z.string().min(1).max(1024)).min(1).max(50).optional(),
    }),
  )
  .optional();
type ParameterFilter = NonNullable<z.infer<typeof ParameterFilters>>[number];

function parameterNotFound(name: string): AwsError {
  return new AwsError("ParameterNotFound", `Parameter ${name} not found.`);
}

function labelsOf(v: ParameterVersionRow): string[] {
  return parseJsonColumn<string[]>(v.labels, []);
}

/** Validates a name for PutParameter, following Parameter Store's rules. */
function validateName(name: string): void {
  const fail = (why: string) => {
    throw new AwsError("ValidationException", `Parameter name: ${why}`);
  };
  if (name.length > 1011) fail("can't be longer than 1011 characters.");
  if (!/^[a-zA-Z0-9_.\-/]+$/.test(name)) {
    fail("can only contain letters, numbers, and the symbols _.-/");
  }
  if (name.includes("/") && !name.startsWith("/")) {
    fail(
      "a fully qualified parameter name must begin with a leading forward slash (/).",
    );
  }
  if (/^\/?(aws|ssm)/i.test(name)) {
    fail('can\'t be prefixed with "aws" or "ssm" (case-insensitive).');
  }
  if (name.split("/").filter(Boolean).length > MAX_DEPTH) {
    throw new AwsError(
      "HierarchyLevelLimitExceededException",
      `A hierarchy can have a maximum of ${MAX_DEPTH} levels.`,
    );
  }
}

/**
 * Accepts a plain name, a `name:version` / `name:label` selector, or a
 * parameter ARN (`arn:aws:ssm:<region>:<account>:parameter/<name>`), for
 * which a leading "/" is ambiguous - the ARN of "/a/b" is ".../parameter/a/b".
 */
function parseReference(reference: string): {
  names: string[];
  selector?: string;
} {
  let name = reference;
  let arnName: string | undefined;
  const arn = reference.match(/^arn:[^:]+:ssm:[^:]*:[^:]*:parameter\/(.*)$/);
  if (arn) arnName = name = arn[1]!;
  let selector: string | undefined;
  const sel = name.match(/^(.*):([^:/]+)$/);
  if (sel) [, name, selector] = sel as unknown as [string, string, string];
  const names = arnName !== undefined ? [`/${name}`, name] : [name];
  return { names, selector };
}

async function findParameter(
  repo: ParametersRepository,
  names: string[],
): Promise<ParameterRow | undefined> {
  for (const name of names) {
    const found = await repo.findByName(name);
    if (found) return found;
  }
  return undefined;
}

function arnFor(ctx: OperationContext, name: string): string {
  return `arn:aws:ssm:${ctx.region}:${ctx.accountId}:parameter${name.startsWith("/") ? "" : "/"}${name}`;
}

function userArn(ctx: OperationContext): string {
  return `arn:aws:iam::${ctx.accountId}:user/${ctx.accessKeyId}`;
}

/** SecureString values stay encrypted unless the caller asks WithDecryption, like AWS. */
function valueOf(
  ctx: OperationContext,
  v: ParameterVersionRow,
  withDecryption: boolean,
): string {
  if (v.type !== "SecureString") return v.value;
  return withDecryption
    ? ctx.cipher.decrypt(v.value)
    : v.value.replace(/^v1:/, "");
}

function toParameter(
  ctx: OperationContext,
  name: string,
  v: ParameterVersionRow,
  withDecryption: boolean,
  selector?: string,
) {
  return {
    Name: name,
    Type: v.type,
    Value: valueOf(ctx, v, withDecryption),
    Version: v.version,
    Selector: selector ? `:${selector}` : undefined,
    LastModifiedDate: epoch(v.last_modified_date),
    ARN: arnFor(ctx, name),
    DataType: v.data_type,
  };
}

function toMetadata(ctx: OperationContext, p: ParameterWithVersion) {
  const v = p.current;
  return {
    Name: p.name,
    ARN: arnFor(ctx, p.name),
    Type: v.type,
    KeyId: v.key_id ?? undefined,
    LastModifiedDate: epoch(v.last_modified_date),
    LastModifiedUser: v.last_modified_user,
    Description: v.description ?? undefined,
    AllowedPattern: v.allowed_pattern ?? undefined,
    Version: v.version,
    Tier: v.tier,
    Policies: [],
    DataType: v.data_type,
  };
}

async function getOne(
  ctx: OperationContext,
  reference: string,
  withDecryption: boolean,
) {
  const { names, selector } = parseReference(reference);
  const param = await findParameter(ctx.parameters, names);
  if (!param) throw parameterNotFound(reference);
  const versions = await ctx.parameters.versions(param.id);
  let version: ParameterVersionRow | undefined;
  if (selector === undefined) {
    version = versions.find((v) => v.version === param.version);
  } else if (/^\d+$/.test(selector)) {
    version = versions.find((v) => v.version === Number(selector));
  } else {
    version = versions.find((v) => labelsOf(v).includes(selector));
  }
  if (!version) {
    throw new AwsError(
      "ParameterVersionNotFound",
      `Systems Manager could not find version ${selector} of ${param.name}. Verify the version and try again.`,
    );
  }
  return toParameter(ctx, param.name, version, withDecryption, selector);
}

/** Names directly under `path` (OneLevel) or anywhere beneath it (Recursive). */
function underPath(name: string, path: string, recursive: boolean): boolean {
  const prefix = path.endsWith("/") ? path : `${path}/`;
  if (!name.startsWith(prefix)) return false;
  return recursive || !name.slice(prefix.length).includes("/");
}

function matchesParameterFilter(
  p: ParameterWithVersion,
  filter: ParameterFilter,
): boolean {
  const values = filter.Values ?? [];
  const option = filter.Option ?? "Equals";
  const compare = (field: string | null | undefined) =>
    field !== null &&
    field !== undefined &&
    values.some((value) =>
      option === "BeginsWith"
        ? field.startsWith(value)
        : option === "Contains"
          ? field.includes(value)
          : field === value,
    );
  const tags = parseTags(p.tags);
  if (filter.Key.startsWith("tag:")) {
    const tag = tags.find((t) => t.Key === filter.Key.slice(4));
    return tag !== undefined && (values.length === 0 || compare(tag.Value));
  }
  switch (filter.Key) {
    case "Name":
      return compare(p.name) || compare(p.name.replace(/^\//, ""));
    case "Type":
      return compare(p.current.type);
    case "KeyId":
      return compare(p.current.key_id);
    case "Tier":
      return compare(p.current.tier);
    case "DataType":
      return compare(p.current.data_type);
    case "Label":
      return labelsOf(p.current).some((l) => compare(l));
    case "Path":
      return values.some((path) =>
        underPath(p.name, path, option === "Recursive"),
      );
    default:
      throw new AwsError(
        "InvalidFilterKey",
        `The following filter key is not valid: ${filter.Key}`,
      );
  }
}

/** Label rules from LabelParameterVersion's documentation. */
function isValidLabel(label: string): boolean {
  return (
    label.length <= 100 &&
    /^[a-zA-Z0-9_.-]+$/.test(label) &&
    !/^\d/.test(label) &&
    !/^(aws|ssm)/i.test(label)
  );
}

async function resolveForLabels(
  repo: ParametersRepository,
  reference: string,
  versionNumber: number | undefined,
) {
  const param = await findParameter(repo, parseReference(reference).names);
  if (!param) throw parameterNotFound(reference);
  const versions = await repo.versions(param.id);
  const target = versions.find(
    (v) => v.version === (versionNumber ?? param.version),
  );
  if (!target) {
    throw new AwsError(
      "ParameterVersionNotFound",
      `Systems Manager could not find version ${versionNumber} of ${param.name}. Verify the version and try again.`,
    );
  }
  return { param, versions, target };
}

export const ssm: Service = {
  targetPrefix: "AmazonSSM",

  operations: {
    PutParameter: operation(
      z.object({
        Name,
        Description: z.string().max(1024).optional(),
        Value: z.string().min(1),
        Type: z.enum(PARAMETER_TYPES).optional(),
        KeyId: z.string().min(1).max(256).optional(),
        Overwrite: z.boolean().default(false),
        AllowedPattern: z.string().max(1024).optional(),
        Tags: z.array(TagSchema).max(1000).optional(),
        Tier: z.enum(PARAMETER_TIERS).optional(),
        Policies: z.string().optional(),
        DataType: z.string().min(0).max(128).optional(),
      }),
      async (input, ctx) => {
        validateName(input.Name);
        if (input.Overwrite && input.Tags) {
          throw new AwsError(
            "ValidationException",
            "Invalid request: tags and overwrite can't be used together. To create a parameter with tags, please remove overwrite flag. To update tags for an existing parameter, please use AddTagsToResource or RemoveTagsFromResource.",
          );
        }
        return ctx.parameters.transaction(async (repo) => {
          const existing = await repo.findByName(input.Name);
          if (existing && !input.Overwrite) {
            throw new AwsError(
              "ParameterAlreadyExists",
              "The parameter already exists. To overwrite this value, set the overwrite option in the request to true.",
            );
          }
          const versions = existing ? await repo.versions(existing.id) : [];
          const previous = versions.at(-1);
          const type = input.Type ?? previous?.type;
          if (!type) {
            throw new AwsError(
              "ValidationException",
              "A parameter type is required when you create a parameter.",
            );
          }
          if (input.KeyId && type !== "SecureString") {
            throw new AwsError(
              "ValidationException",
              "KeyId is required for SecureString type parameter only.",
            );
          }
          const allowedPattern =
            input.AllowedPattern ?? previous?.allowed_pattern ?? null;
          if (
            allowedPattern !== null &&
            !new RegExp(allowedPattern).test(input.Value)
          ) {
            throw new AwsError(
              "ParameterPatternMismatchException",
              `Parameter value failed to satisfy constraint specified: ${allowedPattern}`,
            );
          }
          const requested = input.Tier ?? previous?.tier ?? "Standard";
          const tier: ParameterTier =
            requested === "Intelligent-Tiering"
              ? input.Value.length > TIER_LIMITS.Standard
                ? "Advanced"
                : "Standard"
              : requested;
          if (input.Value.length > TIER_LIMITS[tier]) {
            throw new AwsError(
              "ValidationException",
              `${tier} tier parameters support a maximum parameter value of ${TIER_LIMITS[tier]} characters.`,
            );
          }

          const version = (existing?.version ?? 0) + 1;
          const id =
            existing?.id ??
            (await repo.create({
              name: input.Name,
              version,
              tags: serializeJsonColumn(input.Tags ?? []),
            }));
          if (existing) await repo.update(id, { version });
          await repo.insertVersion({
            parameter_id: id,
            version,
            type,
            value:
              type === "SecureString"
                ? ctx.cipher.encrypt(input.Value)
                : input.Value,
            description: input.Description ?? previous?.description ?? null,
            key_id:
              type === "SecureString"
                ? (input.KeyId ?? previous?.key_id ?? "alias/aws/ssm")
                : null,
            allowed_pattern: allowedPattern,
            tier,
            data_type: input.DataType || previous?.data_type || "text",
            labels: "[]",
            last_modified_date: ctx.now,
            last_modified_user: userArn(ctx),
          });
          if (versions.length + 1 > MAX_VERSIONS) {
            const oldest = versions.find((v) => labelsOf(v).length === 0);
            if (!oldest) {
              throw new AwsError(
                "ParameterMaxVersionLimitExceeded",
                `You attempted to create a new version of ${input.Name} but every stored version is labeled. Remove a label to allow it to be deleted.`,
              );
            }
            await repo.deleteVersion(oldest.id);
          }
          return { Version: version, Tier: tier };
        });
      },
    ),

    GetParameter: operation(
      z.object({ Name, WithDecryption: z.boolean().default(false) }),
      async (input, ctx) => ({
        Parameter: await getOne(ctx, input.Name, input.WithDecryption),
      }),
    ),

    GetParameters: operation(
      z.object({ Names, WithDecryption: z.boolean().default(false) }),
      async (input, ctx) => {
        const Parameters = [];
        const InvalidParameters = [];
        for (const name of input.Names) {
          try {
            Parameters.push(await getOne(ctx, name, input.WithDecryption));
          } catch (e) {
            if (!(e instanceof AwsError)) throw e;
            InvalidParameters.push(name);
          }
        }
        return { Parameters, InvalidParameters };
      },
    ),

    GetParametersByPath: operation(
      z.object({
        Path: z.string().min(1).max(2048),
        Recursive: z.boolean().default(false),
        ParameterFilters,
        WithDecryption: z.boolean().default(false),
        MaxResults: z.number().int().min(1).max(10).default(10),
        NextToken: z.string().optional(),
      }),
      async (input, ctx) => {
        if (!input.Path.startsWith("/")) {
          throw new AwsError(
            "ValidationException",
            'The parameter doesn\'t meet the parameter name requirements. The parameter name must begin with a forward slash "/".',
          );
        }
        const filters = input.ParameterFilters ?? [];
        for (const filter of filters) {
          if (
            !["Type", "KeyId", "Label"].includes(filter.Key) &&
            !filter.Key.startsWith("tag:")
          ) {
            throw new AwsError(
              "InvalidFilterKey",
              `The following filter key is not valid: ${filter.Key}. Valid filter keys include: [Type, KeyId, Label].`,
            );
          }
        }
        const matching = (await ctx.parameters.listWithCurrent()).filter(
          (p) =>
            underPath(p.name, input.Path, input.Recursive) &&
            filters.every((f) => matchesParameterFilter(p, f)),
        );
        const { page, NextToken } = paginate(
          matching,
          input.MaxResults,
          input.NextToken,
          "InvalidNextToken",
        );
        return {
          Parameters: page.map((p) =>
            toParameter(ctx, p.name, p.current, input.WithDecryption),
          ),
          NextToken,
        };
      },
    ),

    DescribeParameters: operation(
      z.object({
        Filters: z
          .array(
            z.object({
              Key: z.enum(["Name", "Type", "KeyId"]),
              Values: z.array(z.string().min(1).max(1024)).min(1).max(50),
            }),
          )
          .optional(),
        ParameterFilters,
        MaxResults: z.number().int().min(1).max(50).default(50),
        NextToken: z.string().optional(),
        Shared: z.boolean().optional(),
      }),
      async (input, ctx) => {
        const filters: ParameterFilter[] = [
          ...(input.Filters ?? []).map((f) => ({
            Key: f.Key,
            Values: f.Values,
          })),
          ...(input.ParameterFilters ?? []),
        ];
        const matching = (await ctx.parameters.listWithCurrent()).filter((p) =>
          filters.every((f) => matchesParameterFilter(p, f)),
        );
        const { page, NextToken } = paginate(
          matching,
          input.MaxResults,
          input.NextToken,
          "InvalidNextToken",
        );
        return { Parameters: page.map((p) => toMetadata(ctx, p)), NextToken };
      },
    ),

    GetParameterHistory: operation(
      z.object({
        Name,
        WithDecryption: z.boolean().default(false),
        MaxResults: z.number().int().min(1).max(50).default(50),
        NextToken: z.string().optional(),
      }),
      async (input, ctx) => {
        const param = await findParameter(
          ctx.parameters,
          parseReference(input.Name).names,
        );
        if (!param) throw parameterNotFound(input.Name);
        const { page, NextToken } = paginate(
          await ctx.parameters.versions(param.id),
          input.MaxResults,
          input.NextToken,
          "InvalidNextToken",
        );
        return {
          Parameters: page.map((v) => ({
            Name: param.name,
            Type: v.type,
            KeyId: v.key_id ?? undefined,
            LastModifiedDate: epoch(v.last_modified_date),
            LastModifiedUser: v.last_modified_user,
            Description: v.description ?? undefined,
            Value: valueOf(ctx, v, input.WithDecryption),
            AllowedPattern: v.allowed_pattern ?? undefined,
            Version: v.version,
            Labels: labelsOf(v),
            Tier: v.tier,
            Policies: [],
            DataType: v.data_type,
          })),
          NextToken,
        };
      },
    ),

    DeleteParameter: operation(z.object({ Name }), async (input, ctx) => {
      const param = await findParameter(
        ctx.parameters,
        parseReference(input.Name).names,
      );
      if (!param) throw parameterNotFound(input.Name);
      await ctx.parameters.delete(param.id);
      return {};
    }),

    DeleteParameters: operation(z.object({ Names }), async (input, ctx) => {
      const DeletedParameters = [];
      const InvalidParameters = [];
      for (const name of input.Names) {
        const param = await findParameter(
          ctx.parameters,
          parseReference(name).names,
        );
        if (param) {
          await ctx.parameters.delete(param.id);
          DeletedParameters.push(name);
        } else {
          InvalidParameters.push(name);
        }
      }
      return { DeletedParameters, InvalidParameters };
    }),

    LabelParameterVersion: operation(
      z.object({
        Name,
        ParameterVersion: z.number().int().optional(),
        Labels: z.array(z.string().min(1)).min(1).max(10),
      }),
      async (input, ctx) =>
        ctx.parameters.transaction(async (repo) => {
          const { versions, target } = await resolveForLabels(
            repo,
            input.Name,
            input.ParameterVersion,
          );
          const InvalidLabels = input.Labels.filter((l) => !isValidLabel(l));
          const valid = input.Labels.filter(isValidLabel);
          // A label names exactly one version, so attaching it moves it.
          for (const v of versions) {
            const before = labelsOf(v);
            const after =
              v.id === target.id
                ? [...new Set([...before, ...valid])]
                : before.filter((l) => !valid.includes(l));
            if (JSON.stringify(after) !== JSON.stringify(before)) {
              await repo.setVersionLabels(v.id, serializeJsonColumn(after));
            }
          }
          return { InvalidLabels, ParameterVersion: target.version };
        }),
    ),

    UnlabelParameterVersion: operation(
      z.object({
        Name,
        ParameterVersion: z.number().int(),
        Labels: z.array(z.string().min(1)).min(1).max(10),
      }),
      async (input, ctx) =>
        ctx.parameters.transaction(async (repo) => {
          const { target } = await resolveForLabels(
            repo,
            input.Name,
            input.ParameterVersion,
          );
          const labels = labelsOf(target);
          const RemovedLabels = input.Labels.filter((l) => labels.includes(l));
          const InvalidLabels = input.Labels.filter((l) => !labels.includes(l));
          await repo.setVersionLabels(
            target.id,
            serializeJsonColumn(
              labels.filter((l) => !RemovedLabels.includes(l)),
            ),
          );
          return { RemovedLabels, InvalidLabels };
        }),
    ),

    AddTagsToResource: operation(
      z.object({
        ResourceType: z.string(),
        ResourceId: z.string().min(1),
        Tags: z.array(TagSchema).max(1000),
      }),
      async (input, ctx) => {
        const param = await taggableParameter(
          ctx,
          input.ResourceType,
          input.ResourceId,
        );
        await ctx.parameters.update(param.id, {
          tags: serializeJsonColumn(
            mergeTags(parseTags(param.tags), input.Tags),
          ),
        });
        return {};
      },
    ),

    RemoveTagsFromResource: operation(
      z.object({
        ResourceType: z.string(),
        ResourceId: z.string().min(1),
        TagKeys: z.array(z.string().min(1).max(128)),
      }),
      async (input, ctx) => {
        const param = await taggableParameter(
          ctx,
          input.ResourceType,
          input.ResourceId,
        );
        await ctx.parameters.update(param.id, {
          tags: serializeJsonColumn(
            removeTags(parseTags(param.tags), input.TagKeys),
          ),
        });
        return {};
      },
    ),

    ListTagsForResource: operation(
      z.object({ ResourceType: z.string(), ResourceId: z.string().min(1) }),
      async (input, ctx) => {
        const param = await taggableParameter(
          ctx,
          input.ResourceType,
          input.ResourceId,
        );
        return { TagList: parseTags(param.tags) };
      },
    ),
  },
};

/** Only parameters are taggable here - every other SSM resource type is out of scope. */
async function taggableParameter(
  ctx: OperationContext,
  resourceType: string,
  resourceId: string,
): Promise<ParameterRow> {
  if (resourceType !== "Parameter") {
    throw new AwsError(
      "InvalidResourceType",
      `shhh only supports tagging resources of type Parameter, not ${resourceType}.`,
    );
  }
  const param = await findParameter(
    ctx.parameters,
    parseReference(resourceId).names,
  );
  if (!param) {
    throw new AwsError(
      "InvalidResourceId",
      "The resource ID is not valid. Verify the ID and try again.",
    );
  }
  return param;
}
