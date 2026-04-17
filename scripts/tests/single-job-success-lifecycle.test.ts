import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { PullScheduleReportOutput } from "../../src/types/jobs.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function makeSuccessResult(): PullScheduleReportOutput {
  const now = new Date().toISOString();
  return {
    file: {
      path: "",
      filename: "report.csv",
      bytes: 120,
      sha256: "abc",
      mime_type: "text/csv",
      created_at: now
    },
    artifact_metadata: {
      job_id: "job-success",
      run_id: "run-1",
      job_name: "pull_schedule_report",
      tenant_id: "tenant-a",
      emr_vendor: "wellsky_home_health",
      period: { date_from: "2026-04-01", date_to: "2026-04-02" },
      discipline_count: 1,
      report_profile_id: "standard",
      selector_profile_id: "default",
      selector_version: "wellsky-base-v1",
      created_at: now,
      expires_at: now,
      artifact_root: ""
    },
    evidence_bundle: {
      step_log_path: "",
      dom_markers_path: "",
      timestamps_path: "",
      screenshots: [],
      export_filename: "report.csv",
      selector_profile_id: "default",
      selector_version: "wellsky-base-v1",
      last_step: "done"
    },
    artifact_id: "artifact-1",
    artifact_filename: "report.csv",
    artifact_sha256: "abc",
    artifact_bytes: 120,
    artifact_mime_type: "text/csv",
    artifact_ready: true,
    created_at: now,
    expires_at: now
  };
}

(async () => {
  process.env.JOB_STORE_PATH = resolve(`./state/test-success-${randomUUID()}.json`);

  const { createJob, findByJobId } = await import("../../src/core/jobStore.js");
  const { PullScheduleReportWorker } = await import("../../src/worker/pullScheduleReportWorker.js");

  const now = new Date().toISOString();
  await createJob({
    job_id: "job-success",
    idempotency_key: "idem-success",
    tenant_id: "tenant-a",
    job_name: "pull_schedule_report",
    status: "queued",
    created_at: now,
    queued_at: now,
    updated_at: now,
    request_id: "req-1",
    attempt_count: 0,
    max_attempts: 1,
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
    async () => makeSuccessResult()
  );

  await worker.runOnce();
  const job = await findByJobId("job-success");

  assert(job?.status === "succeeded", "Job should reach succeeded");
  assert(Boolean(job?.started_at), "Job should have started_at");
  assert(Boolean(job?.completed_at), "Job should have completed_at");
  assert(job?.attempt_count === 1, "Job should have exactly one attempt");

  console.log("PASS single-job-success-lifecycle.test");
})();
