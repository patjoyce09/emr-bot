import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { normalizePathSegment } from "./pathSafety.js";

export interface ArtifactPaths {
  runRoot: string;
  screenshotsDir: string;
  downloadsDir: string;
  evidenceDir: string;
}

export async function createArtifactPaths(
  artifactsRoot: string,
  tenantId: string,
  jobName: string,
  runId: string
): Promise<ArtifactPaths> {
  const safeTenantSegment = normalizePathSegment(tenantId, "tenant");
  const safeJobSegment = normalizePathSegment(jobName, "job");
  const safeRunSegment = normalizePathSegment(runId, "run");

  const runRoot = join(artifactsRoot, safeTenantSegment, safeJobSegment, safeRunSegment);
  const screenshotsDir = join(runRoot, "screenshots");
  const downloadsDir = join(runRoot, "downloads");
  const evidenceDir = join(runRoot, "evidence");

  await mkdir(screenshotsDir, { recursive: true });
  await mkdir(downloadsDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });

  return { runRoot, screenshotsDir, downloadsDir, evidenceDir };
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}

export async function getFileMetadata(path: string): Promise<{ filename: string; bytes: number; sha256: string; mime_type: string }> {
  const info = await stat(path);
  const bytes = info.size;
  const data = await readFile(path);
  const sha256 = createHash("sha256").update(data).digest("hex");

  return {
    filename: basename(path),
    bytes,
    sha256,
    mime_type: inferMimeType(path)
  };
}

function inferMimeType(path: string): string {
  if (path.endsWith(".csv")) {
    return "text/csv";
  }
  if (path.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (path.endsWith(".xls")) {
    return "application/vnd.ms-excel";
  }
  if (path.endsWith(".pdf")) {
    return "application/pdf";
  }
  return "application/octet-stream";
}
