// Reduces a Playwright JSON report to acceptance-criteria IDs and pass/fail.
// blindforge calls this and hands only this output to the implementing AI. Keep it that way:
// never include test code, error messages or anything else from the report.
//
//   node scripts/summarize.mjs report.json  →  [{"id":"A1","status":"passed"}, ...]
//
// If the run itself broke (syntax error, bad config, unreadable report), it returns the ID "HARNESS".
import { readFileSync } from "node:fs";

const collect = (suite, out) => {
  for (const spec of suite.specs ?? []) {
    const id = spec.title.split(/\s+/)[0];
    const results = spec.tests.flatMap((t) => t.results.map((r) => r.status));
    const passed = results.length > 0 && spec.ok;
    out.set(id, out.get(id) === "failed" || !passed ? "failed" : "passed");
  }
  for (const child of suite.suites ?? []) collect(child, out);
  return out;
};

let result;
try {
  const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const map = new Map();
  for (const suite of report.suites ?? []) collect(suite, map);
  if (report.errors?.length) map.set("HARNESS", "failed");
  result = [...map].map(([id, status]) => ({ id, status }));
} catch {
  result = [{ id: "HARNESS", status: "failed" }];
}
console.log(JSON.stringify(result));
