import { join } from "node:path";
import type { Page } from "playwright";
import { categorizeError } from "../../core/errors.js";
import type { StructuredStepLogger } from "../../core/logger.js";
import type { ArtifactPaths } from "../../core/artifacts.js";
import { getFileMetadata, writeJson } from "../../core/artifacts.js";
import { sanitizeFilename } from "../../core/pathSafety.js";
import type {
  PullScheduleReportFailure,
  PullScheduleReportInput,
  PullScheduleReportOutput
} from "../../types/jobs.js";
import { selectorForDiscipline, type WellSkySelectors } from "./selectors.js";
import type { WellSkyWorkerConfig } from "./session.js";

interface ExecutionContext {
  runId: string;
  artifactId: string;
  expiresAt: string;
  selectorProfileId: string;
  selectorVersion: string;
  selectors: WellSkySelectors;
  page: Page;
  logger: StructuredStepLogger;
  artifacts: ArtifactPaths;
  input: PullScheduleReportInput;
  config: WellSkyWorkerConfig;
}

function verifyDownloadedReport(filename: string, bytes: number): void {
  if (bytes <= 0) {
    throw new Error("Downloaded file is empty.");
  }

  const allowedExtensions = [".csv", ".xlsx", ".xls", ".pdf"];
  const lower = filename.toLowerCase();
  const validExtension = allowedExtensions.some((ext) => lower.endsWith(ext));
  if (!validExtension) {
    throw new Error("Downloaded file extension is not allowed.");
  }
}

async function screenshot(page: Page, targetPath: string): Promise<string> {
  await page.screenshot({ path: targetPath, fullPage: true });
  return targetPath;
}

async function captureDomMarkers(page: Page, selectors: WellSkySelectors): Promise<Record<string, number>> {
  const markers: Record<string, number> = {};
  const trackedSelectors = {
    report_ready: selectors.reportReadyMarker,
    date_from: selectors.dateFromInput,
    date_to: selectors.dateToInput,
    discipline_filter: selectors.disciplineDropdown,
    report_profile: selectors.reportProfileInput,
    export_button: selectors.exportButton
  };

  for (const [name, selector] of Object.entries(trackedSelectors)) {
    markers[name] = await page.locator(selector).count();
  }

  return markers;
}

async function applyDisciplines(page: Page, disciplines: string[], selectors: WellSkySelectors): Promise<void> {
  const dropdown = page.locator(selectors.disciplineDropdown).first();
  await dropdown.click();

  for (const discipline of disciplines) {
    await page.locator(selectorForDiscipline(selectors, discipline)).first().click();
  }
}

export async function runPullScheduleReport(
  ctx: ExecutionContext
): Promise<PullScheduleReportOutput | PullScheduleReportFailure> {
  const screenshots: string[] = [];
  const domMarkersPath = join(ctx.artifacts.evidenceDir, "dom-markers.json");
  const timestampsPath = join(ctx.artifacts.evidenceDir, "timestamps.json");
  const stepLogPath = join(ctx.artifacts.evidenceDir, "steps.json");

  let exportFilename: string | undefined;

  try {
    const reportUrl = new URL(ctx.config.reportPath, ctx.config.baseUrl).toString();

    ctx.logger.push("report.goto", "started", { url: reportUrl });
    await ctx.page.goto(reportUrl, { waitUntil: "domcontentloaded" });
    await ctx.page.locator(ctx.selectors.reportReadyMarker).first().waitFor({ timeout: 45_000 });
    ctx.logger.push("report.goto", "succeeded", { url: reportUrl });

    const preFilterShot = await screenshot(
      ctx.page,
      join(ctx.artifacts.screenshotsDir, "01-report-page.png")
    );
    screenshots.push(preFilterShot);

    ctx.logger.push("report.set_dates", "started", {
      date_from: ctx.input.date_from,
      date_to: ctx.input.date_to
    });
    await ctx.page.locator(ctx.selectors.dateFromInput).first().fill(ctx.input.date_from);
    await ctx.page.locator(ctx.selectors.dateToInput).first().fill(ctx.input.date_to);
    ctx.logger.push("report.set_dates", "succeeded", {
      date_from: ctx.input.date_from,
      date_to: ctx.input.date_to
    });

    ctx.logger.push("report.set_disciplines", "started", {
      discipline_count: ctx.input.disciplines.length
    });
    await applyDisciplines(ctx.page, ctx.input.disciplines, ctx.selectors);
    ctx.logger.push("report.set_disciplines", "succeeded", {
      discipline_count: ctx.input.disciplines.length
    });

    ctx.logger.push("report.set_profile", "started", {
      report_profile_id: ctx.input.report_profile_id
    });
    const profileInput = ctx.page.locator(ctx.selectors.reportProfileInput).first();
    try {
      await profileInput.selectOption(ctx.input.report_profile_id);
    } catch {
      await profileInput.fill(ctx.input.report_profile_id);
    }
    ctx.logger.push("report.set_profile", "succeeded", {
      report_profile_id: ctx.input.report_profile_id
    });

    const postFilterShot = await screenshot(
      ctx.page,
      join(ctx.artifacts.screenshotsDir, "02-filters-applied.png")
    );
    screenshots.push(postFilterShot);

    ctx.logger.push("report.export", "started");
    const [download] = await Promise.all([
      ctx.page.waitForEvent("download", { timeout: 90_000 }),
      ctx.page.locator(ctx.selectors.exportButton).first().click()
    ]);

    exportFilename = sanitizeFilename(download.suggestedFilename());
    if (!exportFilename) {
      throw new Error("Download did not provide a filename.");
    }
    const downloadPath = join(ctx.artifacts.downloadsDir, exportFilename);
    await download.saveAs(downloadPath);
    ctx.logger.push("report.export", "succeeded", { filename: exportFilename, artifact_path: downloadPath });

    const postExportShot = await screenshot(
      ctx.page,
      join(ctx.artifacts.screenshotsDir, "03-export-complete.png")
    );
    screenshots.push(postExportShot);

    const domMarkers = await captureDomMarkers(ctx.page, ctx.selectors);
    await writeJson(domMarkersPath, domMarkers);

    await writeJson(timestampsPath, {
      started_at: ctx.logger.steps[0]?.timestamp,
      ended_at: new Date().toISOString(),
      selector_profile_id: ctx.selectorProfileId,
      selector_version: ctx.selectorVersion
    });

    await writeJson(stepLogPath, ctx.logger.steps);

    const fileMeta = await getFileMetadata(downloadPath);
    const createdAt = new Date().toISOString();
    ctx.logger.push("report.verify_download", "started", {
      filename: fileMeta.filename,
      bytes: fileMeta.bytes
    });
    verifyDownloadedReport(fileMeta.filename, fileMeta.bytes);
    ctx.logger.push("report.verify_download", "succeeded", {
      filename: fileMeta.filename,
      bytes: fileMeta.bytes
    });

    return {
      created_at: createdAt,
      file: {
        path: downloadPath,
        filename: fileMeta.filename,
        bytes: fileMeta.bytes,
        sha256: fileMeta.sha256,
        mime_type: fileMeta.mime_type,
        created_at: createdAt
      },
      artifact_metadata: {
        job_id: ctx.input.job_id || ctx.runId,
        run_id: ctx.runId,
        job_name: "pull_schedule_report",
        tenant_id: ctx.input.tenant_id,
        emr_vendor: ctx.input.emr_vendor,
        period: {
          date_from: ctx.input.date_from,
          date_to: ctx.input.date_to
        },
        discipline_count: ctx.input.disciplines.length,
        report_profile_id: ctx.input.report_profile_id,
        selector_profile_id: ctx.selectorProfileId,
        selector_version: ctx.selectorVersion,
        created_at: createdAt,
        expires_at: ctx.expiresAt,
        artifact_root: ctx.artifacts.runRoot
      },
      evidence_bundle: {
        step_log_path: stepLogPath,
        dom_markers_path: domMarkersPath,
        timestamps_path: timestampsPath,
        screenshots,
        export_filename: exportFilename,
        selector_profile_id: ctx.selectorProfileId,
        selector_version: ctx.selectorVersion,
        last_step: ctx.logger.lastStep
      },
      artifact_id: ctx.artifactId,
      artifact_filename: fileMeta.filename,
      artifact_sha256: fileMeta.sha256,
      artifact_bytes: fileMeta.bytes,
      artifact_mime_type: fileMeta.mime_type,
      artifact_ready: true,
      expires_at: ctx.expiresAt,
      purged_at: undefined
    };
  } catch (error) {
    const category = categorizeError(error);
    ctx.logger.push("report.failure", "failed", {
      error_category: category
    });

    const failureScreenshot = await screenshot(
      ctx.page,
      join(ctx.artifacts.screenshotsDir, "99-failure.png")
    );
    screenshots.push(failureScreenshot);

    const domMarkers = await captureDomMarkers(ctx.page, ctx.selectors).catch(() => ({}));

    await Promise.all([
      writeJson(domMarkersPath, domMarkers),
      writeJson(timestampsPath, {
        started_at: ctx.logger.steps[0]?.timestamp,
        failed_at: new Date().toISOString(),
        selector_profile_id: ctx.selectorProfileId,
        selector_version: ctx.selectorVersion
      }),
      writeJson(stepLogPath, ctx.logger.steps)
    ]);

    return {
      run_id: ctx.runId,
      tenant_id: ctx.input.tenant_id,
      job_name: "pull_schedule_report",
      error_category: category,
      message: error instanceof Error ? error.message : "Unknown error",
      last_step: ctx.logger.lastStep,
      failure_screenshot: failureScreenshot,
      evidence_bundle: {
        step_log_path: stepLogPath,
        dom_markers_path: domMarkersPath,
        timestamps_path: timestampsPath,
        screenshots,
        export_filename: exportFilename,
        selector_profile_id: ctx.selectorProfileId,
        selector_version: ctx.selectorVersion,
        last_step: ctx.logger.lastStep
      }
    };
  }
}
