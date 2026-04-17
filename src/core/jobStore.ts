import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PullScheduleReportFailure, PullScheduleReportOutput } from "../types/jobs.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "retry_exhausted";

export interface JobRecord {
  job_id: string;
  idempotency_key: string;
  tenant_id: string;
  job_name: "pull_schedule_report";
  status: JobStatus;
  created_at: string;
  updated_at: string;
  request_id: string;
  input_summary: {
    date_from: string;
    date_to: string;
    disciplines: string[];
    report_profile_id: string;
  };
  result?: PullScheduleReportOutput | PullScheduleReportFailure;
}

interface JobStateFile {
  records: JobRecord[];
}

function storePath(): string {
  return resolve(process.env.JOB_STORE_PATH || "./state/jobs.json");
}

async function ensureStateFile(): Promise<string> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });

  try {
    await readFile(path, "utf8");
  } catch {
    const initial: JobStateFile = { records: [] };
    await writeFile(path, JSON.stringify(initial, null, 2), "utf8");
  }

  return path;
}

async function readState(): Promise<JobStateFile> {
  const path = await ensureStateFile();
  const raw = await readFile(path, "utf8");
  try {
    const parsed = JSON.parse(raw) as JobStateFile;
    return { records: parsed.records || [] };
  } catch {
    return { records: [] };
  }
}

async function writeState(state: JobStateFile): Promise<void> {
  const path = await ensureStateFile();
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}

export async function getJobByIdempotencyKey(idempotencyKey: string): Promise<JobRecord | undefined> {
  const state = await readState();
  return state.records.find((record) => record.idempotency_key === idempotencyKey);
}

export async function getJobById(jobId: string): Promise<JobRecord | undefined> {
  const state = await readState();
  return state.records.find((record) => record.job_id === jobId);
}

export async function upsertJob(record: JobRecord): Promise<void> {
  const state = await readState();
  const index = state.records.findIndex((item) => item.job_id === record.job_id);

  if (index >= 0) {
    state.records[index] = record;
  } else {
    state.records.push(record);
  }

  await writeState(state);
}
