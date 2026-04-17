import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { attachRequestId, authorizeTenant, requireAdminAccess, requireCallerAuth, resolveCallerTenantId } from "./core/auth.js";
import { runArtifactRetentionSweep } from "./core/artifactRetention.js";
import { createJob, findByIdempotencyKey, findByJobId, getJobByArtifactId, type JobRecord } from "./core/jobStore.js";
import type { PullScheduleReportInput, PullScheduleReportOutput } from "./types/jobs.js";
import { PullScheduleReportWorker } from "./worker/pullScheduleReportWorker.js";

const app = express();
app.use(attachRequestId);
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buffer) => {
      (req as Request & { rawBody?: string }).rawBody = buffer.toString("utf8");
    }
  })
);

const APP_VERSION = process.env.APP_VERSION || "0.1.0";

const disciplineSchema = z.enum(["PT", "OT", "ST", "SN", "MSW", "HHA", "RT", "OTHER"]);

function isStrictIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function normalizeDisciplines(values: string[]): string[] {
  const normalized = values.map((x) => x.trim().toUpperCase());
  return [...new Set(normalized)];
}

function buildIdempotencyKey(input: PullScheduleReportInput): string {
  const stable = {
    tenant_id: input.tenant_id,
    emr_vendor: input.emr_vendor,
    date_from: input.date_from,
    date_to: input.date_to,
    disciplines: [...input.disciplines].sort(),
    report_profile_id: input.report_profile_id,
    selector_profile_id: input.selector_profile_id || "default"
  };

  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function isExpired(expiresAt: string): boolean {
  const value = Date.parse(expiresAt);
  if (Number.isNaN(value)) {
    return true;
  }
  return value <= Date.now();
}

function artifactsRootPath(): string {
  return resolve(process.env.ARTIFACTS_ROOT || "./artifacts");
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const resolvedCandidate = resolve(candidatePath);
  const resolvedRoot = resolve(rootPath);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== "..";
}

function toPublicSuccessResult(result: PullScheduleReportOutput): Record<string, unknown> {
  return {
    file: {
      filename: result.file.filename,
      bytes: result.file.bytes,
      sha256: result.file.sha256,
      mime_type: result.file.mime_type,
      created_at: result.file.created_at
    },
    artifact_metadata: {
      job_id: result.artifact_metadata.job_id,
      run_id: result.artifact_metadata.run_id,
      job_name: result.artifact_metadata.job_name,
      tenant_id: result.artifact_metadata.tenant_id,
      emr_vendor: result.artifact_metadata.emr_vendor,
      period: result.artifact_metadata.period,
      discipline_count: result.artifact_metadata.discipline_count,
      report_profile_id: result.artifact_metadata.report_profile_id,
      selector_profile_id: result.artifact_metadata.selector_profile_id,
      selector_version: result.artifact_metadata.selector_version,
      created_at: result.artifact_metadata.created_at,
      expires_at: result.artifact_metadata.expires_at,
      purged_at: result.artifact_metadata.purged_at
    },
    evidence_bundle: {
      last_step: result.evidence_bundle.last_step,
      export_filename: result.evidence_bundle.export_filename,
      screenshots_count: result.evidence_bundle.screenshots.length,
      selector_profile_id: result.evidence_bundle.selector_profile_id,
      selector_version: result.evidence_bundle.selector_version
    },
    artifact_id: result.artifact_id,
    artifact_filename: result.artifact_filename,
    artifact_sha256: result.artifact_sha256,
    artifact_bytes: result.artifact_bytes,
    artifact_mime_type: result.artifact_mime_type,
    artifact_ready: result.artifact_ready,
    created_at: result.created_at,
    expires_at: result.expires_at,
    purged_at: result.purged_at,
    artifact_download_path: `/artifacts/${result.artifact_id}/download`
  };
}

function buildJobDiagnostics(record: JobRecord): Record<string, unknown> {
  const result = record.result;
  const selectorProfileId =
    result && !("error_category" in result)
      ? result.evidence_bundle.selector_profile_id
      : result && "evidence_bundle" in result
        ? result.evidence_bundle.selector_profile_id
        : record.payload.selector_profile_id || "default";

  const selectorVersion =
    result && !("error_category" in result)
      ? result.evidence_bundle.selector_version
      : result && "evidence_bundle" in result
        ? result.evidence_bundle.selector_version
        : "unknown";

  return {
    selector_profile_id: selectorProfileId,
    selector_version: selectorVersion,
    attempt_count: record.attempt_count,
    failure_category: result && "error_category" in result ? result.error_category : undefined,
    last_step:
      result && !("error_category" in result)
        ? result.evidence_bundle.last_step
        : result && "error_category" in result
          ? result.last_step
          : undefined
  };
}

const pullScheduleReportSchema = z.object({
  job_id: z.string().min(8).max(128).optional(),
  idempotency_key: z.string().min(8).max(128).optional(),
  selector_profile_id: z.string().min(1).max(128).optional(),
  tenant_id: z.string().min(1),
  emr_vendor: z.literal("wellsky_home_health"),
  date_from: z.string().refine(isStrictIsoDate, "Invalid ISO date"),
  date_to: z.string().refine(isStrictIsoDate, "Invalid ISO date"),
  disciplines: z.array(z.string().min(1)).min(1),
  report_profile_id: z.string().min(1)
}).superRefine((data, ctx) => {
  if (data.date_from > data.date_to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "date_from must be <= date_to",
      path: ["date_from"]
    });
  }
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "therapyhub-emr-gateway", version: APP_VERSION });
});

app.get("/ready", (_req: Request, res: Response) => {
  const ready = Boolean(
    process.env.WELLSKY_BASE_URL &&
      (process.env.EMR_GATEWAY_BEARER_TOKEN || process.env.EMR_GATEWAY_HMAC_SECRET || process.env.EMR_GATEWAY_BEARER_TENANT_MAP)
  );

  if (!ready) {
    return res.status(503).json({
      ok: false,
      service: "therapyhub-emr-gateway",
      version: APP_VERSION,
      ready: false
    });
  }

  return res.json({
    ok: true,
    service: "therapyhub-emr-gateway",
    version: APP_VERSION,
    ready: true
  });
});

app.get("/version", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "therapyhub-emr-gateway", version: APP_VERSION });
});

app.post("/maintenance/purge_artifacts", requireAdminAccess, async (_req: Request, res: Response) => {
  const summary = await runArtifactRetentionSweep();
  return res.json({
    ok: true,
    summary
  });
});

app.get("/jobs/:jobId", requireCallerAuth, async (req: Request, res: Response) => {
  const tenantResolution = resolveCallerTenantId(req);
  if (!tenantResolution.ok || !tenantResolution.tenant_id) {
    return res.status(tenantResolution.status).json({
      ok: false,
      error_category: tenantResolution.error_category,
      message: tenantResolution.message
    });
  }
  const callerTenantId = tenantResolution.tenant_id;

  if (!authorizeTenant(callerTenantId)) {
    return res.status(403).json({
      ok: false,
      error_category: "tenant_forbidden",
      message: "Tenant is not authorized for this gateway"
    });
  }

  const record = await findByJobId(req.params.jobId);
  if (!record) {
    return res.status(404).json({
      ok: false,
      error_category: "job_not_found",
      message: "Job not found"
    });
  }

  if (record.tenant_id !== callerTenantId) {
    return res.status(403).json({
      ok: false,
      error_category: "job_tenant_mismatch",
      message: "Job does not belong to caller tenant"
    });
  }

  return res.json({
    ok: true,
    data: {
      job_id: record.job_id,
      idempotency_key: record.idempotency_key,
      tenant_id: record.tenant_id,
      status: record.status,
      attempt_count: record.attempt_count,
      max_attempts: record.max_attempts,
      created_at: record.created_at,
      queued_at: record.queued_at,
      started_at: record.started_at,
      completed_at: record.completed_at,
      failed_at: record.failed_at,
      claimed_at: record.claimed_at,
      heartbeat_at: record.heartbeat_at,
      lease_expires_at: record.lease_expires_at,
      updated_at: record.updated_at,
      diagnostics: buildJobDiagnostics(record),
      result:
        record.result && !("error_category" in record.result)
          ? toPublicSuccessResult(record.result)
          : record.result
            ? {
                error_category: record.result.error_category,
                message: record.result.message,
                last_step: record.result.last_step
              }
            : undefined
    }
  });
});

app.get("/artifacts/:artifactId/download", requireCallerAuth, async (req: Request, res: Response) => {
  const requestId = (req as Request & { requestId: string }).requestId;
  const artifactId = req.params.artifactId;
  const tenantResolution = resolveCallerTenantId(req);
  if (!tenantResolution.ok || !tenantResolution.tenant_id) {
    return res.status(tenantResolution.status).json({
      ok: false,
      request_id: requestId,
      error_category: tenantResolution.error_category,
      message: tenantResolution.message
    });
  }
  const callerTenantId = tenantResolution.tenant_id;

  if (!authorizeTenant(callerTenantId)) {
    return res.status(403).json({
      ok: false,
      request_id: requestId,
      error_category: "tenant_forbidden",
      message: "Tenant is not authorized for this gateway"
    });
  }

  const record = await getJobByArtifactId(artifactId);
  if (!record || !record.result || "error_category" in record.result) {
    return res.status(404).json({
      ok: false,
      request_id: requestId,
      error_category: "artifact_not_found",
      message: "Artifact not found"
    });
  }

  if (record.tenant_id !== callerTenantId) {
    return res.status(403).json({
      ok: false,
      request_id: requestId,
      error_category: "artifact_tenant_mismatch",
      message: "Artifact does not belong to caller tenant"
    });
  }

  if (record.result.purged_at) {
    return res.status(410).json({
      ok: false,
      request_id: requestId,
      error_category: "artifact_purged",
      message: "Artifact has been purged per retention policy",
      purged_at: record.result.purged_at
    });
  }

  if (isExpired(record.result.expires_at)) {
    return res.status(410).json({
      ok: false,
      request_id: requestId,
      error_category: "artifact_expired",
      message: "Artifact has expired",
      expires_at: record.result.expires_at
    });
  }

  const filePath = record.result.file.path;
  const rootPath = artifactsRootPath();
  if (!isPathWithinRoot(filePath, rootPath)) {
    return res.status(400).json({
      ok: false,
      request_id: requestId,
      error_category: "artifact_path_invalid",
      message: "Artifact path is invalid"
    });
  }

  try {
    await access(filePath);
  } catch {
    return res.status(404).json({
      ok: false,
      request_id: requestId,
      error_category: "artifact_missing",
      message: "Artifact file is missing"
    });
  }

  res.setHeader("content-type", record.result.artifact_mime_type);
  res.setHeader("x-artifact-id", record.result.artifact_id);
  res.setHeader("x-artifact-sha256", record.result.artifact_sha256);
  res.setHeader("x-artifact-expires-at", record.result.expires_at);
  return res.download(filePath, record.result.artifact_filename);
});

app.post("/jobs/pull_schedule_report", requireCallerAuth, async (req: Request, res: Response) => {
  const requestId = (req as Request & { requestId: string }).requestId;
  const parsed = pullScheduleReportSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error_category: "validation_error",
      message: "Invalid payload",
      details: parsed.error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code }))
    });
  }

  const normalizedDisciplines = normalizeDisciplines(parsed.data.disciplines);
  const disciplineValidation = z.array(disciplineSchema).safeParse(normalizedDisciplines);
  if (!disciplineValidation.success) {
    return res.status(400).json({
      ok: false,
      error_category: "validation_error",
      message: "Invalid disciplines",
      details: disciplineValidation.error.issues.map((issue) => ({
        field: issue.path.join("."),
        code: issue.code
      }))
    });
  }

  const tenantResolution = resolveCallerTenantId(req);
  if (!tenantResolution.ok || !tenantResolution.tenant_id) {
    return res.status(tenantResolution.status).json({
      ok: false,
      request_id: requestId,
      error_category: tenantResolution.error_category,
      message: tenantResolution.message
    });
  }
  const callerTenantId = tenantResolution.tenant_id;

  if (!authorizeTenant(callerTenantId)) {
    return res.status(403).json({
      ok: false,
      error_category: "tenant_forbidden",
      message: "Tenant is not authorized for this gateway"
    });
  }

  if (callerTenantId !== parsed.data.tenant_id) {
    return res.status(403).json({
      ok: false,
      request_id: requestId,
      error_category: "tenant_scope_mismatch",
      message: "Caller tenant scope does not match payload tenant_id"
    });
  }

  const normalizedInput: PullScheduleReportInput & { job_id: string; idempotency_key: string } = {
    ...parsed.data,
    job_id: parsed.data.job_id || randomUUID(),
    idempotency_key: "",
    disciplines: disciplineValidation.data
  };

  const idempotencyKey = parsed.data.idempotency_key || buildIdempotencyKey(normalizedInput);
  normalizedInput.idempotency_key = idempotencyKey;

  const existing = await findByIdempotencyKey(idempotencyKey);
  if (existing) {
    if (existing.status === "queued" || existing.status === "running" || existing.status === "artifact_ready") {
      return res.status(202).json({
        ok: true,
        deduped: true,
        request_id: requestId,
        data: {
          job_id: existing.job_id,
          idempotency_key: existing.idempotency_key,
          status: existing.status
        }
      });
    }

    if (existing.status === "succeeded" && existing.result && !("error_category" in existing.result)) {
      return res.status(202).json({
        ok: true,
        deduped: true,
        request_id: requestId,
        data: {
          job_id: existing.job_id,
          idempotency_key: existing.idempotency_key,
          status: existing.status,
          result: toPublicSuccessResult(existing.result)
        }
      });
    }

    return res.status(409).json({
      ok: false,
      error_category: "idempotency_conflict",
      message: "Idempotency key already used for a non-successful job"
    });
  }

  const maxAttemptsRaw = Number(process.env.JOB_MAX_ATTEMPTS || 1);
  const maxAttempts = Number.isFinite(maxAttemptsRaw) && maxAttemptsRaw > 0 ? Math.floor(maxAttemptsRaw) : 1;

  const baseRecord: JobRecord = {
    job_id: normalizedInput.job_id,
    idempotency_key: idempotencyKey,
    tenant_id: normalizedInput.tenant_id,
    job_name: "pull_schedule_report",
    status: "queued",
    created_at: nowIso(),
    queued_at: nowIso(),
    updated_at: nowIso(),
    request_id: requestId,
    attempt_count: 0,
    max_attempts: maxAttempts,
    payload: normalizedInput,
    input_summary: {
      date_from: normalizedInput.date_from,
      date_to: normalizedInput.date_to,
      disciplines: normalizedInput.disciplines,
      report_profile_id: normalizedInput.report_profile_id,
      selector_profile_id: normalizedInput.selector_profile_id
    }
  };

  try {
    await createJob(baseRecord);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("idempotency_key")) {
      const deduped = await findByIdempotencyKey(idempotencyKey);
      if (deduped) {
        return res.status(202).json({
          ok: true,
          deduped: true,
          request_id: requestId,
          data: {
            job_id: deduped.job_id,
            idempotency_key: deduped.idempotency_key,
            status: deduped.status
          }
        });
      }
    }

    return res.status(500).json({
      ok: false,
      request_id: requestId,
      error_category: "job_create_failed",
      message: "Unable to persist queued job"
    });
  }

  return res.status(202).json({
    ok: true,
    request_id: requestId,
    job_id: normalizedInput.job_id,
    idempotency_key: idempotencyKey,
    status: "queued"
  });
});

const port = Number(process.env.PORT || 4000);
const workerPollIntervalMsRaw = Number(process.env.WORKER_POLL_INTERVAL_MS || 3_000);
const workerPollIntervalMs = Number.isFinite(workerPollIntervalMsRaw) && workerPollIntervalMsRaw > 0
  ? Math.floor(workerPollIntervalMsRaw)
  : 3_000;
const workerHeartbeatIntervalMsRaw = Number(process.env.JOB_HEARTBEAT_INTERVAL_MS || 20_000);
const workerHeartbeatIntervalMs = Number.isFinite(workerHeartbeatIntervalMsRaw) && workerHeartbeatIntervalMsRaw > 0
  ? Math.floor(workerHeartbeatIntervalMsRaw)
  : 20_000;

const worker = new PullScheduleReportWorker({
  pollIntervalMs: workerPollIntervalMs,
  leaseHeartbeatIntervalMs: workerHeartbeatIntervalMs
});
worker.start();

const cleanupIntervalMsRaw = Number(process.env.ARTIFACT_CLEANUP_INTERVAL_MS || 3_600_000);
const cleanupIntervalMs = Number.isFinite(cleanupIntervalMsRaw) && cleanupIntervalMsRaw > 0
  ? Math.floor(cleanupIntervalMsRaw)
  : 3_600_000;

setInterval(() => {
  void runArtifactRetentionSweep().then((summary) => {
    console.log(
      JSON.stringify({ event: "artifact_retention_sweep", summary })
    );
  }).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: "artifact_retention_sweep_failed",
        message: error instanceof Error ? error.message : "Unknown error"
      })
    );
  });
}, cleanupIntervalMs);

app.listen(port, () => {
  console.log(JSON.stringify({ event: "service_started", service: "therapyhub-emr-gateway", port }));
});
