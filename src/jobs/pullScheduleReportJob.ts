import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createArtifactPaths } from "../core/artifacts.js";
import { StructuredStepLogger } from "../core/logger.js";
import { loadWellSkyCredentials } from "../core/secrets.js";
import type { PullScheduleReportFailure, PullScheduleReportInput, PullScheduleReportOutput } from "../types/jobs.js";
import { runPullScheduleReport } from "../vendors/wellsky/pullScheduleReport.js";
import { bootstrapWellSkySession, startIsolatedSession, type WellSkyWorkerConfig } from "../vendors/wellsky/session.js";

function getConfig(): WellSkyWorkerConfig {
  const baseUrl = process.env.WELLSKY_BASE_URL;
  if (!baseUrl) {
    throw new Error("WELLSKY_BASE_URL is required");
  }

  return {
    baseUrl,
    loginPath: process.env.WELLSKY_LOGIN_PATH || "/login",
    reportPath: process.env.WELLSKY_REPORT_PATH || "/reports/schedule",
    headless: (process.env.WELLSKY_HEADLESS || "true") !== "false"
  };
}

export async function executePullScheduleReportJob(
  input: PullScheduleReportInput
): Promise<PullScheduleReportOutput | PullScheduleReportFailure> {
  const runId = randomUUID();
  const artifactsRoot = resolve(process.env.ARTIFACTS_ROOT || "./artifacts");
  const logger = new StructuredStepLogger();

  logger.push("job.init", "started", {
    tenant_id: input.tenant_id,
    job_name: "pull_schedule_report",
    date_from: input.date_from,
    date_to: input.date_to,
    discipline_count: input.disciplines.length,
    report_profile_id: input.report_profile_id
  });

  const artifacts = await createArtifactPaths(artifactsRoot, input.tenant_id, "pull_schedule_report", runId);
  const config = getConfig();

  const session = await startIsolatedSession(input.tenant_id, logger, config);

  try {
    const creds = await loadWellSkyCredentials(input.tenant_id);
    await bootstrapWellSkySession(session.page, creds, logger, config);

    const result = await runPullScheduleReport({
      runId,
      page: session.page,
      logger,
      artifacts,
      input,
      config
    });

    logger.push("job.init", "succeeded", { tenant_id: input.tenant_id });
    return result;
  } finally {
    await session.close();
  }
}
