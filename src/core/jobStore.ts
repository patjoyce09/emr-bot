import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PullScheduleReportFailure, PullScheduleReportOutput } from "../types/jobs.js";

export type JobStatus = "queued" | "running" | "artifact_ready" | "succeeded" | "failed" | "retry_exhausted";

export interface JobRecord {
  job_id: string;
  idempotency_key: string;
  tenant_id: string;
  job_name: "pull_schedule_report";
  status: JobStatus;
  created_at: string;
  updated_at: string;
  request_id: string;
  attempt_count: number;
  max_attempts: number;
  payload: {
    job_id?: string;
    idempotency_key?: string;
    selector_profile_id?: string;
    tenant_id: string;
    emr_vendor: "wellsky_home_health";
    date_from: string;
    date_to: string;
    disciplines: string[];
    report_profile_id: string;
  };
  input_summary: {
    date_from: string;
    date_to: string;
    disciplines: string[];
    report_profile_id: string;
    selector_profile_id?: string;
  };
  result?: PullScheduleReportOutput | PullScheduleReportFailure;
}

interface JobStateFile {
  records: JobRecord[];
}

export interface JobStoreAdapter {
  readState(): Promise<JobStateFile>;
  writeState(state: JobStateFile): Promise<void>;
}

class InProcessMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release?.();
    }
  }
}

class FileJobStoreAdapter implements JobStoreAdapter {
  constructor(private readonly path: string) {}

  async readState(): Promise<JobStateFile> {
    await this.ensureStateFile();
    const raw = await readFile(this.path, "utf8");

    try {
      const parsed = JSON.parse(raw) as JobStateFile;
      return { records: Array.isArray(parsed.records) ? parsed.records : [] };
    } catch {
      const corruptPath = `${this.path}.corrupt-${Date.now()}`;
      await rename(this.path, corruptPath).catch(() => undefined);
      const reset: JobStateFile = { records: [] };
      await this.atomicWrite(reset);
      return reset;
    }
  }

  async writeState(state: JobStateFile): Promise<void> {
    await this.ensureStateFile();
    await this.atomicWrite(state);
  }

  private async ensureStateFile(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });

    try {
      await readFile(this.path, "utf8");
    } catch {
      const initial: JobStateFile = { records: [] };
      await this.atomicWrite(initial);
    }
  }

  private async atomicWrite(state: JobStateFile): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true });

    const tempPath = join(dir, `.jobs.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const serialized = JSON.stringify(state, null, 2);

    const tempHandle = await open(tempPath, "w");
    try {
      await tempHandle.writeFile(serialized, "utf8");
      await tempHandle.sync().catch(() => undefined);
    } finally {
      await tempHandle.close();
    }

    await rename(tempPath, this.path);

    const dirHandle = await open(dir, "r").catch(() => undefined);
    if (dirHandle) {
      try {
        await dirHandle.sync().catch(() => undefined);
      } finally {
        await dirHandle.close();
      }
    }
  }
}

function storePath(): string {
  return resolve(process.env.JOB_STORE_PATH || "./state/jobs.json");
}

const adapter: JobStoreAdapter = new FileJobStoreAdapter(storePath());
const mutex = new InProcessMutex();

async function withLockedState<T>(mutator: (state: JobStateFile) => Promise<T>): Promise<T> {
  return mutex.runExclusive(async () => {
    const state = await adapter.readState();
    const result = await mutator(state);
    await adapter.writeState(state);
    return result;
  });
}

async function readOnlyState<T>(reader: (state: JobStateFile) => T): Promise<T> {
  const state = await adapter.readState();
  return reader(state);
}

export async function findByIdempotencyKey(idempotencyKey: string): Promise<JobRecord | undefined> {
  return readOnlyState((state) => state.records.find((record) => record.idempotency_key === idempotencyKey));
}

export async function findByJobId(jobId: string): Promise<JobRecord | undefined> {
  return readOnlyState((state) => state.records.find((record) => record.job_id === jobId));
}

export async function createJob(record: JobRecord): Promise<JobRecord> {
  return withLockedState(async (state) => {
    const existingByJobId = state.records.find((item) => item.job_id === record.job_id);
    if (existingByJobId) {
      throw new Error("job_id already exists");
    }

    const existingByIdempotency = state.records.find((item) => item.idempotency_key === record.idempotency_key);
    if (existingByIdempotency) {
      throw new Error("idempotency_key already exists");
    }

    state.records.push(record);
    return record;
  });
}

export async function updateJobStatus(jobId: string, status: JobStatus): Promise<JobRecord | undefined> {
  return withLockedState(async (state) => {
    const index = state.records.findIndex((item) => item.job_id === jobId);
    if (index < 0) {
      return undefined;
    }

    const updated: JobRecord = {
      ...state.records[index],
      status,
      updated_at: new Date().toISOString()
    };

    state.records[index] = updated;
    return updated;
  });
}

export async function attachJobResult(
  jobId: string,
  result: PullScheduleReportOutput | PullScheduleReportFailure
): Promise<JobRecord | undefined> {
  return withLockedState(async (state) => {
    const index = state.records.findIndex((item) => item.job_id === jobId);
    if (index < 0) {
      return undefined;
    }

    const updated: JobRecord = {
      ...state.records[index],
      result,
      updated_at: new Date().toISOString()
    };

    state.records[index] = updated;
    return updated;
  });
}

export async function listJobsByStatuses(statuses: JobStatus[]): Promise<JobRecord[]> {
  return readOnlyState((state) =>
    state.records
      .filter((record) => statuses.includes(record.status))
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  );
}

export async function listAllJobs(): Promise<JobRecord[]> {
  return readOnlyState((state) => [...state.records]);
}

export async function claimNextQueuedJob(): Promise<JobRecord | undefined> {
  return withLockedState(async (state) => {
    const queued = state.records
      .filter((record) => record.status === "queued")
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

    const next = queued[0];
    if (!next) {
      return undefined;
    }

    const index = state.records.findIndex((item) => item.job_id === next.job_id);
    if (index < 0) {
      return undefined;
    }

    const claimed: JobRecord = {
      ...state.records[index],
      status: "running",
      updated_at: new Date().toISOString(),
      attempt_count: state.records[index].attempt_count + 1
    };

    state.records[index] = claimed;
    return claimed;
  });
}

export async function patchJob(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord | undefined> {
  return withLockedState(async (state) => {
    const index = state.records.findIndex((item) => item.job_id === jobId);
    if (index < 0) {
      return undefined;
    }

    const updated: JobRecord = {
      ...state.records[index],
      ...patch,
      updated_at: patch.updated_at || new Date().toISOString()
    };

    state.records[index] = updated;
    return updated;
  });
}

export async function getJobByArtifactId(artifactId: string): Promise<JobRecord | undefined> {
  return readOnlyState((state) =>
    state.records.find((record) => {
      if ((record.status !== "artifact_ready" && record.status !== "succeeded") || !record.result || "error_category" in record.result) {
        return false;
      }

      return record.result.artifact_id === artifactId;
    })
  );
}

export async function upsertJob(record: JobRecord): Promise<void> {
  await withLockedState(async (state) => {
    const index = state.records.findIndex((item) => item.job_id === record.job_id);

    if (index >= 0) {
      state.records[index] = record;
    } else {
      state.records.push(record);
    }
  });
}

// Backward-compatible aliases
export const getJobByIdempotencyKey = findByIdempotencyKey;
export const getJobById = findByJobId;
