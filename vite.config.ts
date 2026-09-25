import { defineConfig } from "vite-plus";

const IGNORE_PATTERNS = [
  "dist",
  "node_modules",
  "pnpm-lock.yaml",
  "*.tsbuildinfo",
  "**/routeTree.gen.ts",
  "**/worker-configuration.d.ts",
  "**/.wrangler/**",
  "output/**",
  "skills-local/**",
  ".context/**",
];

export default defineConfig({
  staged: {
    // Formatter only for now: no lint or typecheck on commit.
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns: [
      ...IGNORE_PATTERNS,
      // Skill directories are copied to agents verbatim by `skills add`;
      // keep every file in them exactly as written.
      "skills/**",
      "archived/**",
    ],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: IGNORE_PATTERNS,
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/no-array-sort": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-shadow": "off",
      "oxc/no-map-spread": "off",
    },
  },
});
