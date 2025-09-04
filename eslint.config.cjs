const { FlatCompat } = require("@eslint/eslintrc");
const typescriptParser = require("@typescript-eslint/parser");
const typescriptPlugin = require("@typescript-eslint/eslint-plugin");

// Create a compat instance
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: {
    rules: {}
  }
});

module.exports = [
  // ESLint recommended
  ...compat.extends("eslint:recommended"),
  ...compat.extends("plugin:@typescript-eslint/recommended"),

  // TypeScript files rules
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": typescriptPlugin,
    },
    rules: {
      "no-console": "warn",
      "@typescript-eslint/no-unused-vars": ["warn"],
    },
  },
];
