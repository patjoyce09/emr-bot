import { attachJobResult, claimNextQueuedJob, updateJobStatus, type JobRecord } from "../core/jobStore.js";
import { executePullScheduleReportJob } from "../jobs/pullScheduleReportJob.js";
import type { PullScheduleReportFailure } from "../types/jobs.js";

interface WorkerConfig {
  pollIntervalMs: number;
}

export class PullScheduleReportWorker {
  private timer: NodeJS.Timeout | undefined;
  private isTicking = false;

  constructor(private readonly config: WorkerConfig) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);

    void this.tick();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.isTicking) {
      return;
    }

    this.isTicking = true;

    try {
      while (true) {
        const claimed = await claimNextQueuedJob();
        if (!claimed) {
          break;
        }

        await this.processClaimedJob(claimed);
      }
    } finally {
      this.isTicking = false;
    }
  }

  private async processClaimedJob(record: JobRecord): Promise<void> {
    try {
      const result = await executePullScheduleReportJob(record.payload);

      if ("error_category" in result) {
        await this.handleFailure(record, result);
        return;
      }

      await attachJobResult(record.job_id, result);
      await updateJobStatus(record.job_id, "artifact_ready");
      await updateJobStatus(record.job_id, "succeeded");
    } catch (error) {
      await this.handleFailure(record, {
        run_id: record.job_id,
        tenant_id: record.tenant_id,
        job_name: "pull_schedule_report",
        error_category: "unknown",
        message: error instanceof Error ? error.message : "Unknown error",
        last_step: "worker.exception",
        failure_screenshot: "",
        evidence_bundle: {
          step_log_path: "",
          dom_markers_path: "",
          timestamps_path: "",
          screenshots: [],
          selector_profile_id: record.payload.selector_profile_id || "default",
          selector_version: "unknown",
          last_step: "worker.exception"
        }
      });
    }
  }

  private async handleFailure(record: JobRecord, result: PullScheduleReportFailure): Promise<void> {
    const exhausted = record.attempt_count >= record.max_attempts;

    await attachJobResult(record.job_id, result);
    await updateJobStatus(record.job_id, "failed");

    if (exhausted) {
      await updateJobStatus(record.job_id, "retry_exhausted");
      return;
    }

    await updateJobStatus(record.job_id, "queued");
  }
}
