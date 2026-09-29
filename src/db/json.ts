// helpers for JSON-in-text columns and inserted ids
export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

export function serializeJsonColumn(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * `knex("t").insert(data, "id")` yields either a bare id array ([1]) or, when
 * the driver honors the returning hint, [{id: 1}]. Normalize both shapes to
 * the numeric id.
 */
export function extractInsertedId(
  result: Array<number | { id: number }>,
): number {
  const first = result[0];
  if (first === undefined) throw new Error("insert() returned no rows");
  return typeof first === "object" ? first.id : first;
}
