// Bundle the server into a single self-contained file, dist/shhh.mjs
import { build } from "esbuild";
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

const root = resolve(import.meta.dirname, "..");
const outfile = resolve(root, "dist/shhh.mjs");

await build({
  entryPoints: [resolve(root, "bin/start.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: `node${pkg.engines.node.replace(/^[^\d]*/, "")}`,
  sourcemap: "linked",
  legalComments: "external",
  // knex's dialects require() every driver it supports, lazily; shhh only
  // ever uses its own node:sqlite client (src/db/NodeSqlite.ts), so the
  // rest never load and needn't be installed.
  external: [
    "better-sqlite3",
    "sqlite3",
    "mysql",
    "mysql2",
    "mariadb",
    "mariadb/callback",
    "oracledb",
    "pg",
    "pg-native",
    "pg-query-stream",
    "tedious",
  ],
  banner: {
    // ESM has no `require`; bundled CommonJS (knex, express) still calls it
    // for node builtins and the lazy driver loads above.
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __shhhCreateRequire } from "node:module";',
      "const require = __shhhCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

await chmod(outfile, 0o755);
console.log(`built ${outfile}`);
