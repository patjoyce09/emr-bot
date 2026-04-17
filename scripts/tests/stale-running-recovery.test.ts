import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

(async () => {
  process.env.JOB_STORE_PATH = resolve(`./state/test-stale-${randomUUID()}.json`);
  process.env.JOB_LEASE_TIMEOUT_MS = "1000";

  const { createJob, recoverStaleRunningJobs, findByJobId } = await import("../../src/core/jobStore.js");

  const now = new Date().toISOString();
  await createJob({
    job_id: "job-stale",
    idempotency_key: "idem-stale",
    tenant_id: "tenant-a",
    job_name: "pull_schedule_report",
    status: "running",
    created_at: now,
    queued_at: now,
    started_at: now,
    claimed_at: now,
    heartbeat_at: now,
    lease_expires_at: new Date(Date.now() - 30_000).toISOString(),
    updated_at: now,
    request_id: "req-1",
    attempt_count: 1,
    max_attempts: 2,
    payload: {
      tenant_id: "tenant-a",
      emr_vendor: "wellsky_home_health",
      date_from: "2026-04-01",
      date_to: "2026-04-02",
      disciplines: ["PT"],
      report_profile_id: "standard"
    },
    input_summary: {
      date_from: "2026-04-01",
      date_to: "2026-04-02",
      disciplines: ["PT"],
      report_profile_id: "standard"
    }
  });

  const sweep = await recoverStaleRunningJobs();
  assert(sweep.requeued === 1, "Expected one stale running job to be requeued");

  const recovered = await findByJobId("job-stale");
  assert(recovered?.status === "queued", "Recovered job should be queued");
  assert(!recovered?.lease_expires_at, "Recovered job lease should be cleared");

  console.log("PASS stale-running-recovery.test");
})();
