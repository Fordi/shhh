// Database row types
// sqlite has no boolean type (0/1) and returns epoch-ms columns as numbers.
export interface Tag {
  Key: string;
  Value: string;
}

export interface SecretRow {
  id: number;
  store_id: string;
  name: string;
  arn: string;
  description: string | null;
  kms_key_id: string | null;
  /** JSON-encoded Tag[] */
  tags: string;
  created_at: number;
  last_changed_at: number;
  last_accessed_at: number | null;
  deletion_date: number | null;
}

export type SecretValueKind = "string" | "binary";

export interface SecretVersionRow {
  id: number;
  version_id: string;
  secret_id: number;
  value_kind: SecretValueKind;
  value_ciphertext: string;
  /** JSON-encoded string[] of staging labels */
  stages: string;
  created_at: number;
}

export const PARAMETER_TYPES = [
  "String",
  "StringList",
  "SecureString",
] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

export const PARAMETER_TIERS = [
  "Standard",
  "Advanced",
  "Intelligent-Tiering",
] as const;
export type ParameterTier = Exclude<
  (typeof PARAMETER_TIERS)[number],
  "Intelligent-Tiering"
>;

export interface ParameterRow {
  id: number;
  store_id: string;
  name: string;
  /** current (latest) version number */
  version: number;
  /** JSON-encoded Tag[] */
  tags: string;
}

export interface ParameterVersionRow {
  id: number;
  parameter_id: number;
  version: number;
  type: ParameterType;
  /** plaintext, or a cipher.ts ciphertext when type is SecureString */
  value: string;
  description: string | null;
  key_id: string | null;
  allowed_pattern: string | null;
  tier: ParameterTier;
  data_type: string;
  /** JSON-encoded string[] */
  labels: string;
  last_modified_date: number;
  last_modified_user: string;
}
