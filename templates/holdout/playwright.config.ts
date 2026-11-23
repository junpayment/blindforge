import { defineConfig, devices } from "@playwright/test";

// blindforge runs these tests from the holdout container against the app at BASE_URL (http://localhost:8787).
if (!process.env.BASE_URL) throw new Error("BASE_URL is required");

// Every test title must start with its acceptance-criteria ID: "<ID> description" (e.g. "A4 a wrong code shows an error").
// The implementing AI only ever gets back these IDs and pass/fail (scripts/summarize.mjs).
export default defineConfig({
  testDir: "tests",
  retries: 1,
  use: {
    baseURL: process.env.BASE_URL,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
