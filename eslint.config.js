// basic eslint configuration
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "dist/**",
      "*.sqlite3",
      "eslint.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // erasableSyntaxOnly (tsconfig.json) already forbids enum/parameter
      // properties/namespaces at the type-check level; these two catch the
      // remaining non-erasable constructs tsc's flag doesn't cover.
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message:
            "enums are non-erasable syntax and won't run under native type stripping - use a string union + `as const` array instead.",
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      // strippable TS quirk: verbatimModuleSyntax requires separate type vs.
      // value imports from the same module, which this rule misreads as a
      // duplicate import.
      "no-duplicate-imports": "off",
      // strippable TS quirk: enums are banned (erasableSyntaxOnly), so the
      // enum-like replacement pattern is `const X = {...} as const; type X =
      // (typeof X)[keyof typeof X];` - the const and the type intentionally
      // share a name.
      "no-redeclare": "off",
    },
  },
  {
    files: ["**/*.d.ts"],
    rules: {
      // ambient declarations describing untyped JS internals legitimately
      // fall back to `any` where the upstream module has no useful type.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // test files intentionally use `any`/non-null assertions more freely
      // when driving fakes and asserting on fetch call bodies.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      // node:test's describe()/it()/before()/etc. return promises that are
      // never meant to be awaited at the top level - the test runner drives
      // them itself.
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  eslintConfigPrettier,
);
