import { unlink } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { listAllJobs, patchJob } from "./jobStore.js";
import type { PullScheduleReportFailure, PullScheduleReportOutput } from "../types/jobs.js";

export interface RetentionSweepResult {
  scanned_jobs: number;
  downloads_purged: number;
  screenshots_purged: number;
  records_updated: number;
}

function asPositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

function artifactsRootPath(): string {
  return resolve(process.env.ARTIFACTS_ROOT || "./artifacts");
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  if (!candidatePath) {
    return false;
  }

  const resolvedCandidate = resolve(candidatePath);
  const resolvedRoot = resolve(rootPath);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== "..";
}

async function deleteIfSafe(path: string, rootPath: string): Promise<boolean> {
  if (!isPathWithinRoot(path, rootPath)) {
    return false;
  }

  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

function isExpiredByDays(createdAtIso: string, days: number): boolean {
  const createdMs = Date.parse(createdAtIso);
  if (Number.isNaN(createdMs)) {
    return true;
  }

  const expiresMs = createdMs + days * 24 * 60 * 60 * 1000;
  return Date.now() >= expiresMs;
}

function isExpiredByTimestamp(expiresAtIso: string): boolean {
  const expiresMs = Date.parse(expiresAtIso);
  if (Number.isNaN(expiresMs)) {
    return true;
  }
  return Date.now() >= expiresMs;
}

function isSuccessResult(result: unknown): result is PullScheduleReportOutput {
  if (!result || typeof result !== "object") {
    return false;
  }

  return "artifact_id" in result && "file" in result;
}

export async function runArtifactRetentionSweep(): Promise<RetentionSweepResult> {
  const jobs = await listAllJobs();
  const rootPath = artifactsRootPath();
  const screenshotRetentionDays = asPositiveInt(process.env.SCREENSHOT_RETENTION_DAYS, 7);
  const keepFailureScreenshots = (process.env.KEEP_FAILURE_SCREENSHOTS || "true").toLowerCase() === "true";

  let downloadsPurged = 0;
  let screenshotsPurged = 0;
  let recordsUpdated = 0;

  for (const job of jobs) {
    const result = job.result;
    if (!isSuccessResult(result)) {
      if (!keepFailureScreenshots && result && typeof result === "object" && "evidence_bundle" in result) {
        const failureScreens = (result as { evidence_bundle?: { screenshots?: string[] } }).evidence_bundle?.screenshots || [];
        let failureChanged = false;
        for (const shot of failureScreens) {
          const deleted = await deleteIfSafe(shot, rootPath);
          if (deleted) {
            screenshotsPurged += 1;
            failureChanged = true;
          }
        }

        if (failureChanged) {
          const mutable = result as PullScheduleReportFailure;
          if (mutable.evidence_bundle) {
            mutable.evidence_bundle.screenshots = [];
          }
          mutable.failure_screenshot = "";

          await patchJob(job.job_id, {
            result: mutable
          });
          recordsUpdated += 1;
        }
      }
      continue;
    }

    let changed = false;
    const nowIso = new Date().toISOString();

    if (!result.purged_at && isExpiredByTimestamp(result.expires_at)) {
      const deleted = await deleteIfSafe(result.file.path, rootPath);
      if (deleted) {
        downloadsPurged += 1;
      }

      result.file.path = "";
      result.evidence_bundle.step_log_path = "";
      result.evidence_bundle.dom_markers_path = "";
      result.evidence_bundle.timestamps_path = "";
      result.purged_at = nowIso;
      result.artifact_metadata.purged_at = nowIso;
      changed = true;
    }

    const screenshotsExpired = isExpiredByDays(result.created_at || result.file.created_at, screenshotRetentionDays);
    if (screenshotsExpired && result.evidence_bundle.screenshots.length > 0) {
      for (const shot of result.evidence_bundle.screenshots) {
        const deleted = await deleteIfSafe(shot, rootPath);
        if (deleted) {
          screenshotsPurged += 1;
        }
      }

      result.evidence_bundle.screenshots = [];
      changed = true;
    }

    if (changed) {
      await patchJob(job.job_id, {
        result
      });
      recordsUpdated += 1;
    }
  }

  return {
    scanned_jobs: jobs.length,
    downloads_purged: downloadsPurged,
    screenshots_purged: screenshotsPurged,
    records_updated: recordsUpdated
  };
}
