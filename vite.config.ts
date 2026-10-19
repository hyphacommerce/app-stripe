// The formatter and linter (Vite+: Oxfmt and Oxlint), configured like Hypha's own
// (`vite.config.ts` in the Hypha repository). `vp fmt`, `vp lint` and `vp check` read
// only this file; there is no Vite build here (esbuild bundles the browser modules).

import { defineConfig } from "vite-plus";

/** Written by tools, checked for staleness by their own commands. */
const generated = ["**/dist/**", "**/node_modules/**", "src/generated/**", ".wrangler/**"];

export default defineConfig({
  fmt: {
    printWidth: 100,
    ignorePatterns: [...generated, "**/*.md", "**/*.toml", "pnpm-lock.yaml"],
  },
  lint: {
    ignorePatterns: generated,
    plugins: ["typescript", "unicorn", "oxc", "import", "promise"],
    categories: {
      correctness: "error",
      suspicious: "warn",
      perf: "warn",
    },
    options: {
      typeAware: true,
    },
    rules: {
      "typescript/consistent-return": "off",
      // Sequential on purpose where it appears: trying installations' secrets in order,
      // polling a refresh lock.
      "no-await-in-loop": "off",
      "oxc/no-map-spread": "off",
    },
    overrides: [
      {
        // The core runs on Workers and Node alike: Web APIs only. The Node entry, the
        // SQLite adapter, the scripts and the tests may use Node's built-ins.
        files: ["src/**"],
        env: { browser: true },
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["node:*"],
                  message: "Web APIs only: the core runs on Workers too.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["src/entry/node.ts", "src/storage/sqlite.ts", "scripts/**", "test/**"],
        plugins: ["node"],
        env: { node: true },
        rules: { "no-restricted-imports": "off" },
      },
      {
        files: ["test/**"],
        rules: {
          "typescript/no-floating-promises": "off",
          "typescript/no-unsafe-type-assertion": "off",
        },
      },
    ],
  },
});
