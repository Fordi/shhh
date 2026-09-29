// AWS JSON 1.1 protocol: dispatches X-Amz-Target to a service's typed operations
import type { Request, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import type { z, ZodType } from "zod";
import { via, type MiddlewareResponse } from "../util/via.ts";
import {
  CredentialError,
  parseCredential,
  storeFor,
} from "../auth/credentials.ts";
import { buildCipher, type Cipher } from "../config/cipher.ts";
import type { AppConfig } from "../config/env.ts";
import type { Repositories } from "../db/repositories/index.ts";
import type { TransactionalSecretsRepository } from "../db/repositories/secrets.ts";
import type { ParametersRepository } from "../db/repositories/parameters.ts";

export const AMZ_JSON = "application/x-amz-json-1.1";

/**
 * An error in AWS's wire shape: `{"__type": code, "message": ...}` plus an
 * `x-amzn-ErrorType` header - the SDKs and the CLI key off `code` to raise
 * the matching typed exception (e.g. `ResourceNotFoundException`).
 */
export class AwsError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface OperationContext {
  /** Region from the request's SigV4 credential scope. */
  region: string;
  accountId: string;
  accessKeyId: string;
  /** Encrypts/decrypts values for the caller's store only. */
  cipher: Cipher;
  secrets: TransactionalSecretsRepository;
  parameters: ParametersRepository;
  /** One timestamp per request, so every row it touches agrees. */
  now: number;
}

export interface Operation<S extends ZodType = ZodType> {
  input: S;
  handler(input: z.infer<S>, ctx: OperationContext): Promise<object> | object;
}

/** Declares an operation, inferring the handler's input type from its schema. */
export function operation<S extends ZodType>(
  input: S,
  handler: Operation<S>["handler"],
): Operation<S> {
  return { input, handler };
}

export interface Service {
  /** The X-Amz-Target prefix, e.g. "secretsmanager" or "AmazonSSM". */
  targetPrefix: string;
  operations: Record<string, Operation<any>>;
  /** Runs before every operation, e.g. to purge expired rows. */
  beforeEach?(ctx: OperationContext): Promise<void>;
}

/** AWS JSON timestamps are epoch seconds (fractional allowed). */
export function epoch(ms: number): number;
export function epoch(ms: number | null | undefined): number | undefined;
export function epoch(ms: number | null | undefined): number | undefined {
  return ms === null || ms === undefined ? undefined : Number(ms) / 1000;
}

function validationError(error: z.ZodError): AwsError {
  const count = error.issues.length;
  const details = error.issues
    .map(
      (issue) =>
        `Value at '${issue.path.join(".") || "(root)"}' failed to satisfy constraint: ${issue.message}`,
    )
    .join("; ");
  return new AwsError(
    "ValidationException",
    `${count} validation error${count === 1 ? "" : "s"} detected: ${details}`,
  );
}

function parseBody(req: Request): unknown {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AwsError(
      "SerializationException",
      "Request body is not valid JSON",
    );
  }
}

function respond(
  status: number,
  body: object,
  requestId: string,
  res: Parameters<RequestHandler>[1],
): MiddlewareResponse {
  res.set("x-amzn-RequestId", requestId);
  return { status, type: AMZ_JSON, content: JSON.stringify(body) };
}

/**
 * The whole AWS surface is one route: `POST /` with the operation named by
 * `X-Amz-Target: <prefix>.<Operation>`. Requests without that header fall
 * through (to a 404), so other routes can share the mount point.
 *
 * Expects the body as a raw Buffer (mount behind express.raw()) since the
 * protocol's content type isn't one express.json() recognizes.
 */
export function buildAwsHandler(
  services: Service[],
  env: AppConfig,
  repos: Repositories,
): RequestHandler {
  const byPrefix = new Map(services.map((s) => [s.targetPrefix, s]));

  return via(async (req, res) => {
    const target = req.header("x-amz-target");
    if (!target) return undefined;
    const requestId = randomUUID();

    try {
      const dot = target.lastIndexOf(".");
      const service = byPrefix.get(target.slice(0, dot));
      const op = service?.operations[target.slice(dot + 1)];
      if (!service || !op) {
        throw new AwsError(
          "UnknownOperationException",
          `Operation ${target} is not supported by shhh`,
        );
      }

      let credential;
      try {
        credential = parseCredential(req.headers);
      } catch (e) {
        if (e instanceof CredentialError)
          throw new AwsError(e.code, e.message, 403);
        throw e;
      }
      const store = storeFor(credential.accessKeyId);

      const parsed = op.input.safeParse(parseBody(req));
      if (!parsed.success) throw validationError(parsed.error);

      const ctx: OperationContext = {
        region: credential.region,
        accountId: env.ACCOUNT_ID,
        accessKeyId: credential.accessKeyId,
        cipher: buildCipher(store.key),
        secrets: repos.secrets(store.id),
        parameters: repos.parameters(store.id),
        now: Date.now(),
      };
      await service.beforeEach?.(ctx);
      return respond(200, await op.handler(parsed.data, ctx), requestId, res);
    } catch (e) {
      const error =
        e instanceof AwsError
          ? e
          : (console.error(e),
            new AwsError(
              "InternalFailure",
              "The request processing has failed.",
              500,
            ));
      res.set("x-amzn-ErrorType", `${error.code}:`);
      return respond(
        error.status,
        { __type: error.code, message: error.message },
        requestId,
        res,
      );
    }
  });
}
