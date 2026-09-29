// AES-256-GCM encryption at rest, keyed per store
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface Cipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/**
 * Ciphertexts are self-describing strings, `v1:<base64(iv | tag | data)>`,
 * so they fit in an ordinary text column on every supported database and
 * leave room for a future format change to tell versions apart. `key` must
 * be 32 bytes - see storeFor() in src/auth/credentials.ts.
 */
export function buildCipher(key: Buffer): Cipher {
  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const packed = Buffer.concat([iv, cipher.getAuthTag(), data]);
      return `${VERSION}:${packed.toString("base64")}`;
    },
    decrypt(ciphertext) {
      const [version, payload] = ciphertext.split(":", 2);
      if (version !== VERSION || payload === undefined) {
        throw new Error(`unsupported ciphertext version: ${version}`);
      }
      const packed = Buffer.from(payload, "base64");
      const iv = packed.subarray(0, IV_BYTES);
      const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const data = packed.subarray(IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString(
        "utf8",
      );
    },
  };
}
