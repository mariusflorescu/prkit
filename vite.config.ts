import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    environment: "node",
    // Every unit test, so a new one can't be left out; e2e journeys are `*.e2e.ts`.
    include: ["packages/*/test/**/*.test.ts", "apps/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
  staged: {
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns: [
      // Prose with pseudo-TypeScript blocks; the formatter would reflow them into real TS.
      "docs/**",
      ".audit/**",
      ".e2e/**",
      ".prkit/**",
      // The brand kit is committed exactly as the designer exported it.
      "assets/brand/**",
      // The anatomy kit is vendored unchanged; see THIRD_PARTY_NOTICES.md.
      "apps/www/src/figures/kit/{iso-kit,lathe,tube,audit}.mjs",
      "apps/www/src/figures/kit/iso.css",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
    ],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: [
      ".audit/**",
      ".e2e/**",
      ".prkit/**",
      // The anatomy kit is vendored unchanged; see THIRD_PARTY_NOTICES.md.
      "apps/www/src/figures/kit/{iso-kit,lathe,tube,audit}.mjs",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["@shadcn/lint"],
    settings: {
      shadcn: { ui: "~/components/ui" },
    },
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "react-in-jsx-scope": "off",
      "eslint/no-shadow": "off",
      // Polling loops wait on purpose; each turn depends on the last.
      "eslint/no-await-in-loop": "off",
      // Effect's tagged unions are read through `_tag`.
      "eslint/no-underscore-dangle": "off",
      "typescript/no-explicit-any": "error",
      // `as const` stays allowed: typescript-eslint never reports const assertions.
      "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "typescript/no-non-null-assertion": "error",
      // `unknown` is for library boundaries only; each one is listed in an override below.
      "typescript/no-restricted-types": [
        "error",
        {
          types: {
            unknown: {
              message:
                "Parse into a schema type at the boundary instead of passing unknown around.",
            },
          },
        },
      ],
    },
    overrides: [
      {
        // components/ui exports own their look. App code picks a variant or size instead of
        // restyling with className; layout classes stay allowed because placement belongs
        // to the parent.
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: {
          "shadcn/require-static-classes": "error",
          "shadcn/no-restyle": ["error", { allow: ["layout"] }],
        },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-unknown-classes": "error" },
      },
      {
        // Local reviews have no account: nothing they run may read a pull request or GitHub.
        files: [
          "apps/server/src/reviews/localReviews.ts",
          "apps/server/src/repo/localCapture.ts",
          "apps/server/src/outside/OutsideLocal.ts",
        ],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: [
                    "**/accounts/*",
                    "**/pullRequests/*",
                    "**/github/GitHubApi*",
                    "**/github/httpClient*",
                    "**/github/budget*",
                  ],
                  message:
                    "Local reviews have no account: keep GitHub, accounts and pull requests out of them.",
                },
              ],
            },
          ],
        },
      },
      {
        // Library boundaries that must speak `unknown`: effect/sql's Connection takes
        // `ReadonlyArray<unknown>` params, and node:sqlite throws untyped errors.
        files: ["apps/server/src/persistence/NodeSqliteClient.ts"],
        rules: { "typescript/no-restricted-types": "off" },
      },
    ],
    options: {
      reportUnusedDisableDirectives: "error",
      typeAware: false,
      typeCheck: false,
    },
  },
});
