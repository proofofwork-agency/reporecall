import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "website/**",
      ".memory/**",
      "test/.test-*/**",
    ],
  },
  {
    files: ["src/**/*.ts", "bin/**/*.ts"],
    extends: [
      js.configs.recommended,
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
          disallowTypeAnnotations: false,
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false } },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
      "no-control-regex": "off",
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
);
