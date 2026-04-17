import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { attachRequestId, authorizeTenant, requireCallerAuth } from "./core/auth.js";
import { getJobById, getJobByIdempotencyKey, upsertJob, type JobRecord } from "./core/jobStore.js";
import { executePullScheduleReportJob } from "./jobs/pullScheduleReportJob.js";
import type { PullScheduleReportInput } from "./types/jobs.js";

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
    report_profile_id: input.report_profile_id
  };

  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

const pullScheduleReportSchema = z.object({
  job_id: z.string().min(8).max(128).optional(),
  idempotency_key: z.string().min(8).max(128).optional(),
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
      (process.env.EMR_GATEWAY_BEARER_TOKEN || process.env.EMR_GATEWAY_HMAC_SECRET)
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

app.get("/jobs/:jobId", requireCallerAuth, async (req: Request, res: Response) => {
  const record = await getJobById(req.params.jobId);
  if (!record) {
    return res.status(404).json({
      ok: false,
      error_category: "job_not_found",
      message: "Job not found"
    });
  }

  return res.json({
    ok: true,
    data: {
      job_id: record.job_id,
      idempotency_key: record.idempotency_key,
      tenant_id: record.tenant_id,
      status: record.status,
      created_at: record.created_at,
      updated_at: record.updated_at
    }
  });
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

  if (!authorizeTenant(parsed.data.tenant_id)) {
    return res.status(403).json({
      ok: false,
      error_category: "tenant_forbidden",
      message: "Tenant is not authorized for this gateway"
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

  const existing = await getJobByIdempotencyKey(idempotencyKey);
  if (existing) {
    if (existing.status === "queued" || existing.status === "running") {
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
      return res.json({
        ok: true,
        deduped: true,
        request_id: requestId,
        data: existing.result
      });
    }

    return res.status(409).json({
      ok: false,
      error_category: "idempotency_conflict",
      message: "Idempotency key already used for a non-successful job"
    });
  }

  const baseRecord: JobRecord = {
    job_id: normalizedInput.job_id,
    idempotency_key: idempotencyKey,
    tenant_id: normalizedInput.tenant_id,
    job_name: "pull_schedule_report",
    status: "queued",
    created_at: nowIso(),
    updated_at: nowIso(),
    request_id: requestId,
    input_summary: {
      date_from: normalizedInput.date_from,
      date_to: normalizedInput.date_to,
      disciplines: normalizedInput.disciplines,
      report_profile_id: normalizedInput.report_profile_id
    }
  };

  await upsertJob(baseRecord);
  await upsertJob({ ...baseRecord, status: "running", updated_at: nowIso() });

  try {
    const result = await executePullScheduleReportJob(normalizedInput);

    if ("error_category" in result) {
      await upsertJob({
        ...baseRecord,
        status: "failed",
        updated_at: nowIso(),
        result
      });

      return res.status(500).json({
        ok: false,
        request_id: requestId,
        job_id: normalizedInput.job_id,
        idempotency_key: idempotencyKey,
        run_id: result.run_id,
        tenant_id: result.tenant_id,
        job_name: result.job_name,
        error_category: result.error_category,
        message: result.message,
        last_step: result.last_step,
        failure_screenshot: result.failure_screenshot,
        evidence_bundle: result.evidence_bundle
      });
    }

    await upsertJob({
      ...baseRecord,
      status: "succeeded",
      updated_at: nowIso(),
      result
    });

    return res.json({
      ok: true,
      request_id: requestId,
      job_id: normalizedInput.job_id,
      idempotency_key: idempotencyKey,
      data: result
    });
  } catch (error) {
    await upsertJob({
      ...baseRecord,
      status: "failed",
      updated_at: nowIso(),
      result: {
        run_id: normalizedInput.job_id || "unknown",
        tenant_id: normalizedInput.tenant_id,
        job_name: "pull_schedule_report",
        error_category: "unknown",
        message: error instanceof Error ? error.message : "Unknown error",
        last_step: "job.exception",
        failure_screenshot: "",
        evidence_bundle: {
          step_log_path: "",
          dom_markers_path: "",
          timestamps_path: "",
          screenshots: [],
          last_step: "job.exception"
        }
      }
    });

    return res.status(500).json({
      ok: false,
      request_id: requestId,
      job_id: normalizedInput.job_id,
      idempotency_key: idempotencyKey,
      error_category: "unknown",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(JSON.stringify({ event: "service_started", service: "therapyhub-emr-gateway", port }));
});
