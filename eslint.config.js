import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/", ".test-dist/", ".local/", "data/", "coverage/"] },
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { project: "tsconfig.test.json", tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Objects here are closures that never use `this`, so passing their methods around is safe.
      "@typescript-eslint/unbound-method": "off",
      // Allows a variable that a callback reads before its one assignment, as when two objects refer to each other.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    // Tests and the acceptance script assert on parsed JSON, which is untyped.
    files: ["test/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // node:test tracks the promise that test() returns.
      "@typescript-eslint/no-floating-promises": ["error", { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: "test" }] }],
    },
  },
);
