// pagination and tag helpers shared by the AWS services
import { z } from "zod";
import type { Tag } from "../db/types.ts";
import { parseJsonColumn } from "../db/json.ts";
import { AwsError } from "./protocol.ts";

export const TagSchema = z.object({
  Key: z.string().min(1).max(128),
  Value: z.string().max(256),
});

/**
 * NextToken is an opaque base64url offset. Stores are small enough that
 * filtering and paging in memory beats teaching every filter to SQL.
 */
export function paginate<T>(
  items: T[],
  maxResults: number,
  nextToken: string | undefined,
  invalidTokenCode: string,
): { page: T[]; NextToken?: string } {
  let offset = 0;
  if (nextToken !== undefined) {
    try {
      offset = JSON.parse(
        Buffer.from(nextToken, "base64url").toString("utf8"),
      ).o;
    } catch {
      offset = NaN;
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new AwsError(invalidTokenCode, "The specified token is invalid.");
    }
  }
  const end = offset + maxResults;
  return {
    page: items.slice(offset, end),
    NextToken:
      end < items.length
        ? Buffer.from(JSON.stringify({ o: end })).toString("base64url")
        : undefined,
  };
}

export function parseTags(column: string): Tag[] {
  return parseJsonColumn<Tag[]>(column, []);
}

/** Adds or replaces tags by key, keeping the existing order. */
export function mergeTags(existing: Tag[], incoming: Tag[]): Tag[] {
  const merged = new Map(existing.map((t) => [t.Key, t.Value]));
  for (const tag of incoming) merged.set(tag.Key, tag.Value);
  return [...merged].map(([Key, Value]) => ({ Key, Value }));
}

export function removeTags(existing: Tag[], keys: string[]): Tag[] {
  return existing.filter((t) => !keys.includes(t.Key));
}
