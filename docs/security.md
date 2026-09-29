# Security model

shhh is a **development stand-in** for AWS, built to be convenient and repeatable. It isn't built to resist anyone who can reach it.

## Stores

Every request carries a SigV4 `Authorization` header whose credential scope names the caller's access key id. shhh derives everything from that id:

```
key      = SHA-256(access key id)          # 32 bytes, AES-256-GCM key
store_id = hex(SHA-256(key)).slice(0, 16)  # rows in secrets / parameters
```

Every query is scoped to `store_id`, so one access key id can't see another's data. Nothing about stores is kept server-side: the same id always selects the same store, and a new id simply starts empty.

## Encryption at rest

- Secrets Manager values (`SecretString` / `SecretBinary`) and `SecureString` parameter values are encrypted with AES-256-GCM under the store's key, stored as `v1:<base64(iv | tag | ciphertext)>`.
- `String` and `StringList` parameters are stored in plaintext, as are names, descriptions, and tags.

The database alone doesn't reveal secret values unless you also know (or guess) the access key id.

## What this does _not_ protect against

- **Signatures aren't verified.** The secret access key never reaches the server - SigV4 only sends a signature made with it - so shhh has nothing to check it against. The access key id is effectively a bearer token and the secret access key is ignored.
- **Access key ids are guessable.** A store keyed by `test` is readable by anyone who tries `test`. Use a long random id if you want some privacy between developers sharing one instance.
- **The key is the id.** Anyone holding the database and the id can decrypt that store. Losing the id loses the store - there's no other copy of its key.
- **No TLS.** Serve it behind a TLS-terminating proxy (see [deployment.md](deployment.md)) if it's reachable beyond localhost.
