/**
 * SEC-WEB-07 — interdiction des sinks DOM dangereux (flat config).
 * `fixtures/` est ignoré par `eslint .` et rejoué par scripts/check-dom-sink-lint.mjs.
 * `infra/secrets` est ignoré : ce répertoire n'est pas du code source.
 */
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const sink = (name) => `SEC-WEB-07: ${name} est interdit.`;

const computedMember = (name) =>
  `MemberExpression[property.type='Literal'][property.value='${name}']`;

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/dist-desktop/**", ".dev/**", "**/target/**", "fixtures/**", "coverage/**", "infra/secrets/**"],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      globals: {
        setTimeout: "readonly",
        setInterval: "readonly",
        setImmediate: "readonly",
        execScript: "readonly",
      },
    },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-globals": [
        "error",
        {
          name: "eval",
          message: sink("eval"),
        },
      ],
      "no-restricted-properties": [
        "error",
        { property: "innerHTML", message: sink("innerHTML") },
        { property: "outerHTML", message: sink("outerHTML") },
        { property: "insertAdjacentHTML", message: sink("insertAdjacentHTML") },
        {
          object: "document",
          property: "write",
          message: sink("document.write"),
        },
        {
          object: "document",
          property: "writeln",
          message: sink("document.writeln"),
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: sink("dangerouslySetInnerHTML"),
        },
        {
          selector: "Property[key.name='dangerouslySetInnerHTML']",
          message: sink("dangerouslySetInnerHTML"),
        },
        {
          selector:
            "Property[key.type='Literal'][key.value='dangerouslySetInnerHTML']",
          message: sink("dangerouslySetInnerHTML"),
        },
        {
          selector: computedMember("innerHTML"),
          message: sink("innerHTML"),
        },
        {
          selector: computedMember("outerHTML"),
          message: sink("outerHTML"),
        },
        {
          selector: computedMember("insertAdjacentHTML"),
          message: sink("insertAdjacentHTML"),
        },
        {
          selector: "CallExpression[callee.property.name='eval']",
          message: sink("eval"),
        },
        {
          selector:
            "CallExpression[callee.object.name='document'][callee.property.name='write']",
          message: sink("document.write"),
        },
        {
          selector:
            "CallExpression[callee.object.name='document'][callee.property.name='writeln']",
          message: sink("document.writeln"),
        },
        {
          selector:
            "CallExpression[callee.property.type='Literal'][callee.property.value='write'][callee.object.name='document']",
          message: sink("document.write"),
        },
        {
          selector:
            "CallExpression[callee.property.type='Literal'][callee.property.value='writeln'][callee.object.name='document']",
          message: sink("document.writeln"),
        },
      ],
    },
  },
);
