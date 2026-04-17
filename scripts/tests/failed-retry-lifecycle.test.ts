import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { PullScheduleReportFailure } from "../../src/types/jobs.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function makeFailure(): PullScheduleReportFailure {
  return {
    run_id: "run-fail",
    tenant_id: "tenant-a",
    job_name: "pull_schedule_report",
    error_category: "navigation_timeout",
    message: "timed out",
    last_step: "report.goto",
    failure_screenshot: "",
    evidence_bundle: {
      step_log_path: "",
      dom_markers_path: "",
      timestamps_path: "",
      screenshots: [],
      selector_profile_id: "default",
      selector_version: "wellsky-base-v1",
      last_step: "report.goto"
    }
  };
}

(async () => {
  process.env.JOB_STORE_PATH = resolve(`./state/test-fail-${randomUUID()}.json`);

  const { createJob, findByJobId } = await import("../../src/core/jobStore.js");
  const { PullScheduleReportWorker } = await import("../../src/worker/pullScheduleReportWorker.js");

  const now = new Date().toISOString();
  await createJob({
    job_id: "job-fail",
    idempotency_key: "idem-fail",
    tenant_id: "tenant-a",
    job_name: "pull_schedule_report",
    status: "queued",
    created_at: now,
    queued_at: now,
    updated_at: now,
    request_id: "req-1",
    attempt_count: 0,
    max_attempts: 2,
    payload: {
      tenant_id: "tenant-a",
      emr_vendor: "wellsky_home_health",
      date_from: "2026-04-01",
      date_to: "2026-04-02",
      disciplines: ["PT"],
      report_profile_id: "standard",
      selector_profile_id: "default"
    },
    input_summary: {
      date_from: "2026-04-01",
      date_to: "2026-04-02",
      disciplines: ["PT"],
      report_profile_id: "standard",
      selector_profile_id: "default"
    }
  });

  const worker = new PullScheduleReportWorker(
    { pollIntervalMs: 10_000, leaseHeartbeatIntervalMs: 2_000, maxJobsPerTick: 1 },
    async () => makeFailure()
  );

  await worker.runOnce();
  const first = await findByJobId("job-fail");
  assert(first?.status === "queued", "First failure should requeue");
  assert(first?.attempt_count === 1, "Attempt count should increment after first run");
  assert(Boolean(first?.failed_at), "First failure should set failed_at");

  await worker.runOnce();
  const second = await findByJobId("job-fail");
  assert(second?.status === "retry_exhausted", "Second failure should exhaust retries");
  assert(second?.attempt_count === 2, "Attempt count should be two after second run");

  console.log("PASS failed-retry-lifecycle.test");
})();
