// Lint rules that catch the patterns that make hidden tests flaky. blindforge runs `npm run lint`
// after the holdout agent writes tests, and sends the problems back to it.
import playwright from "eslint-plugin-playwright";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["node_modules/", "test-results/", "playwright-report/"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
  },
  {
    files: ["tests/**/*.ts"],
    plugins: { playwright },
    rules: {
      // Fixed sleeps: wait for the state you check instead
      "playwright/no-wait-for-timeout": "error",
      // A missing await lets the test move on before the action or assertion finishes
      "playwright/missing-playwright-await": "error",
      // expect(await x.isVisible()).toBe(true) reads once and doesn't wait; expect(x).toBeVisible() retries
      "playwright/prefer-web-first-assertions": "error",
      // networkidle depends on background traffic, so it's timing-dependent
      "playwright/no-networkidle": "error",
      // force: true skips the actionability checks that wait for the element to be ready
      "playwright/no-force-option": "error",
      // Element handles go stale. Use locators
      "playwright/no-element-handle": "error",
      // page.pause() stops a headless run
      "playwright/no-page-pause": "error",
    },
  },
];
