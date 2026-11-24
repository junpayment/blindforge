import { readFileSync } from "node:fs";

// Per-test results of the run against the unimplemented app, for the holdout writer's review round.
// The writer may see its own tests and the app's observable behavior (error messages), never the app's source.
// Returns { text, failed, passed } for the given IDs.
export function baseRunReview(reportFile, ids) {
  const strip = (t) => String(t ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const rel = (f) => strip(f).replace(/^.*?\/(tests\/)/, "$1");
  let report;
  try { report = JSON.parse(readFileSync(reportFile, "utf8")); } catch { return { text: "(no report)", failed: 0, passed: 0 }; }
  const byId = new Map();
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const id = spec.title.split(/\s+/)[0];
      if (!ids.includes(id)) continue;
      const res = spec.tests.flatMap((t) => t.results).at(-1);
      const list = byId.get(id) ?? [];
      list.push({ title: spec.title, status: res?.status ?? "not run", error: res?.error });
      byId.set(id, list);
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);

  let failed = 0, passed = 0;
  const blocks = [];
  for (const id of ids) {
    for (const t of byId.get(id) ?? [{ title: `${id} (not run here: @prod or not found)`, status: "not run" }]) {
      if (t.status === "passed") {
        passed += 1;
        blocks.push(`### ${t.title}\n\n**Passes already**, before implementation.`);
        continue;
      }
      if (t.status !== "failed" && t.status !== "timedOut") {
        blocks.push(`### ${t.title}\n\n${t.status}`);
        continue;
      }
      failed += 1;
      const loc = t.error?.location ? `${rel(t.error.location.file)}:${t.error.location.line}` : "(unknown)";
      const msg = strip(t.error?.message).split("\n").slice(0, 14).join("\n").slice(0, 1500);
      const hints = [];
      if (/\/tests\/helpers\//.test(strip(t.error?.location?.file))) hints.push("stopped inside a shared helper");
      if (/\b(undefined|null)\b/.test(msg)) hints.push("`undefined`/`null` appears in the error");
      if (t.status === "timedOut") hints.push("timed out");
      const fence = "```";
      blocks.push(`### ${t.title}\n\nStopped at \`${loc}\`${hints.length ? ` (${hints.join("; ")})` : ""}\n\n${fence}\n${msg}\n${fence}`);
    }
  }
  return { text: blocks.join("\n\n"), failed, passed };
}
