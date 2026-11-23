// Playwright reporter that streams holdout progress for `blindforge status`.
//
// Mounted read-only into the holdout container and added next to the json reporter:
//   npx playwright test --reporter=json,/reporter/progress-reporter.cjs
// Each event is one JSON line appended to $BLINDFORGE_PROGRESS (default /out/progress.jsonl).
// It reports only acceptance-criteria IDs, titles and outcomes. Never test source or errors.
//
// CommonJS on purpose: Playwright loads it no matter how the holdout project is configured.

const { appendFileSync } = require("node:fs");

const FILE = process.env.BLINDFORGE_PROGRESS || "/out/progress.jsonl";

function write(event) {
  try {
    appendFileSync(FILE, `${JSON.stringify({ ...event, at: Date.now() })}\n`);
  } catch {
    // Progress is best effort; never fail the test run because of it
  }
}

class ProgressReporter {
  onBegin(config, suite) {
    write({ e: "begin", total: suite.allTests().length, workers: config.workers });
  }

  onTestBegin(test, result) {
    write({ e: "testBegin", title: test.title, retry: result.retry });
  }

  onTestEnd(test, result) {
    // A test is settled once it passes or is skipped, or when its last retry ends
    const settled = result.status === "passed" || result.status === "skipped" || result.retry >= test.retries;
    write({
      e: "testEnd",
      title: test.title,
      status: result.status,
      retry: result.retry,
      retries: test.retries,
      settled,
      duration: result.duration,
    });
  }

  onEnd(result) {
    write({ e: "end", status: result.status });
  }

  printsToStdio() {
    return false;
  }
}

module.exports = ProgressReporter;
