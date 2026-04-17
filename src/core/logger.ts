export type StepStatus = "started" | "succeeded" | "failed";

export interface StepLog {
  timestamp: string;
  step: string;
  status: StepStatus;
  details?: Record<string, unknown>;
}

const ALLOWED_DETAIL_KEYS = new Set([
  "request_id",
  "job_id",
  "idempotency_key",
  "status",
  "tenant_id",
  "job_name",
  "date_from",
  "date_to",
  "discipline_count",
  "report_profile_id",
  "selector_profile_id",
  "selector_version",
  "selector",
  "url",
  "artifact_path",
  "filename",
  "bytes",
  "error_category"
]);

function sanitizeDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!ALLOWED_DETAIL_KEYS.has(key)) {
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      output[key] = value.length;
    }
  }

  return Object.keys(output).length ? output : undefined;
}

export class StructuredStepLogger {
  private logs: StepLog[] = [];
  private _lastStep = "init";

  get lastStep(): string {
    return this._lastStep;
  }

  get steps(): StepLog[] {
    return this.logs;
  }

  push(step: string, status: StepStatus, details?: Record<string, unknown>): void {
    this._lastStep = step;
    this.logs.push({
      timestamp: new Date().toISOString(),
      step,
      status,
      details: sanitizeDetails(details)
    });
  }
}
