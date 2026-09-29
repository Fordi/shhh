// Generate markdown source tree with first-line comment and .folder info
/**
 * This file will generate a `docs/project-layout.md` document based on the current folder's project structure
 *
 * Source files will be described by a first-line comment; the following are supported:
 * ```plain
 * // description
 * # description
 * /* description * /
 * <!-- description -->
 * ```
 * The leading space is required, multiline comments must be closed on the same line and have a trailing space as well,
 * and /**...* / comments are ignored.
 *
 * Source folders will be described by a `.folder` yaml file with the schema:
 *
 * ```typescript
 * type DotFolder = {
 *   description?: string;
 *   ignore?: boolean; // if true, the folder will not appear
 *   recurse?: boolean; // if false, the folder will appear, but its contents won't
 * }
 * ```
 */
import { existsSync, globSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");

const KNOWN_DESCRIPTIONS: Record<string, string> = {
  ".nvmrc": "nvm version spec",
  ".prettierrc.json": "Prettier config",
  "package.json": "node package doc",
  "package-lock.json": "node dependency lockfile",
  "tsconfig.json": "TypeScript configuration",
  "README.md": "Main documentation",
};

const compare = (a: string, b: string) => {
  if (a.toLowerCase() > b.toLowerCase()) return 1;
  if (a.toLowerCase() < b.toLowerCase()) return -1;
  return 0;
};

type PathInfo = {
  dir: boolean;
  name: string;
  path: string;
  depth: number;
  rep?: string;
  description?: string;
  ignore?: boolean;
  recurse?: boolean;
  children?: PathInfo[];
};

async function getDescription(path: string) {
  const content = await readFile(path, "utf-8");
  const m = content
    .split(/\n/)[0]
    .match(/^(?:# (.+)|\/\/ (.+)|\/\* (.+) \*\/|<!-- (.+) -->)/);
  if (!m) {
    return undefined;
  }
  const description = m[1] ?? m[2] ?? m[3] ?? m[4];
  // rebase links
  return description.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (original, text, link) => {
      if (/^(?:\/|\w+:\/)/.test(link)) {
        return original;
      }
      const rel = relative(resolve(root, "docs"), resolve(dirname(path), link));
      return `[${text}](${rel})`;
    },
  );
}

async function sourceTree(
  root: string,
  ignored: string[],
): Promise<PathInfo[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    const skip = ignored.some(
      (ignore) => path.startsWith(ignore) || `${path}/` === ignore,
    );
    if (skip) continue;
    const dir = entry.isDirectory();
    const depth = root.split("/").length;
    const entInfo: PathInfo = {
      dir,
      path,
      name: entry.name,
      depth,
      ignore: false,
      recurse: dir ? true : undefined,
      description: KNOWN_DESCRIPTIONS[relative(root, path)] ?? undefined,
    };
    if (entry.isDirectory()) {
      if (existsSync(resolve(path, ".folder"))) {
        const metaText = await readFile(resolve(path, ".folder"), "utf8");
        const { ignore = false, description, recurse = true } = parse(metaText);
        Object.assign(entInfo, { ignore, description, recurse });
      }
      if (!entInfo.ignore) {
        if (entInfo.recurse) {
          entInfo.children = await sourceTree(path, ignored);
        }
        results.push(entInfo);
      }
    } else {
      entInfo.description = entInfo.description ?? (await getDescription(path));
      results.push(entInfo);
    }
  }
  return results.sort((a, b) => {
    if (a.dir !== b.dir) {
      return a.dir ? -1 : 1;
    }
    return compare(a.name, b.name);
  });
}

function flatten(sources: PathInfo[], root?: string): PathInfo[] {
  const results: PathInfo[] = [];
  const drop = root?.split("/").length ?? 0;
  for (const source of sources) {
    const { children, ...subentry } = source;
    subentry.depth -= drop;
    results.push(subentry);
    if (source.dir && children) {
      results.push(...flatten(children, root));
    }
  }
  return results;
}
async function sortedSources(): Promise<PathInfo[]> {
  const ignored: string[] = [`${resolve(root, ".git")}/`];
  let ignorePatterns: string[] = [];
  try {
    ignorePatterns = (await readFile(resolve(root, ".gitignore"), "utf8"))
      .split("\n")
      .map((t) => t.replace(/#.*/, ""))
      .filter((a) => !!a.trim());
  } catch {
    // No .gitignore
  }
  ignorePatterns.push("**/.folder");
  for (const pattern of ignorePatterns) {
    for (const matched of globSync(pattern, {
      cwd: root,
      withFileTypes: true,
    })) {
      ignored.push(
        resolve(matched.parentPath, matched.name) +
          (matched.isDirectory() ? "/" : ""),
      );
    }
  }
  const tree = await sourceTree(root, ignored);
  return flatten(tree, root);
}
let maxName = -1;
let maxDesc = -1;
const sources = await sortedSources();
for (const entry of sources) {
  const rel = relative(resolve(root, "docs"), entry.path) || ".";
  entry.rep = `${new Array(entry.depth).fill("·\u2000\u2000").join("")}[${entry.name}${entry.dir ? "/" : ""}](${rel})`;
  maxName = Math.max(maxName, entry.rep.length);
  maxDesc = Math.max(maxDesc, entry.description?.length ?? 0);
}
const buf = [];
buf.push(
  `| ${"Path".padEnd(maxName, " ")} | ${"Description".padEnd(maxDesc, " ")} |`,
);
buf.push(`|-${"".padEnd(maxName, "-")}-|-${"".padEnd(maxDesc, "-")}-|`);
for (const { rep, description: desc } of sources) {
  if (rep) {
    buf.push(
      `| ${rep.padEnd(maxName, " ")} | ${(desc ?? "").padEnd(maxDesc, " ")} |`,
    );
  }
}
await writeFile(
  resolve(import.meta.dirname, "../docs/project-layout.md"),
  buf.join("\n") + "\n",
  "utf8",
);
