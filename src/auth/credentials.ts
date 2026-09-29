// derive a caller's store and encryption key from their AWS access key id
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export type CredentialErrorCode =
  "MissingAuthenticationTokenException" | "IncompleteSignatureException";

export class CredentialError extends Error {
  code: CredentialErrorCode;
  constructor(code: CredentialErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RequestCredential {
  accessKeyId: string;
  /** Region from the SigV4 credential scope, e.g. "us-east-1". */
  region: string;
  /** Signing name from the credential scope, e.g. "secretsmanager". */
  service: string;
}

export interface Store {
  /** SHA-256(access key id) - encrypts this store's secret values. */
  key: Buffer;
  /** First 16 hex chars of SHA-256(key) - the rows' store_id. */
  id: string;
}

/**
 * Reads the credential scope out of a SigV4 Authorization header, e.g.
 * `AWS4-HMAC-SHA256 Credential=AKID/20260929/us-east-1/ssm/aws4_request, ...`.
 *
 * The signature itself is deliberately not verified: the secret access key
 * never leaves the client, so the server has nothing to check it against.
 * shhh is a development stand-in; the access key id alone selects a store.
 */
export function parseCredential(
  headers: IncomingHttpHeaders,
): RequestCredential {
  const header = headers.authorization;
  if (!header) {
    throw new CredentialError(
      "MissingAuthenticationTokenException",
      "Missing Authentication Token",
    );
  }
  const scope = header.match(/Credential=([^,\s]+)/)?.[1]?.split("/");
  if (!scope || scope.length !== 5 || !scope[0]) {
    throw new CredentialError(
      "IncompleteSignatureException",
      "Authorization header requires a Credential=<key>/<date>/<region>/<service>/aws4_request parameter",
    );
  }
  const [accessKeyId, , region, service] = scope as [
    string,
    string,
    string,
    string,
  ];
  return { accessKeyId, region, service };
}

/**
 * Deterministic: the same access key id always maps to the same store and
 * key, on any machine, with nothing stored server-side. Losing the id means
 * losing the store - there's no other copy of the key.
 */
export function storeFor(accessKeyId: string): Store {
  const key = createHash("sha256").update(accessKeyId, "utf8").digest();
  const id = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return { key, id };
}
