import { basename } from "node:path";

const SAFE_SEGMENT_MAX_LENGTH = 80;

export function normalizePathSegment(input: string, fallbackPrefix = "seg"): string {
  const normalized = input
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[_\.\-]+|[_\.\-]+$/g, "")
    .slice(0, SAFE_SEGMENT_MAX_LENGTH)
    .toLowerCase();

  if (normalized.length > 0) {
    return normalized;
  }

  const fallback = `${fallbackPrefix}_${Math.random().toString(16).slice(2, 10)}`;
  return fallback;
}

export function sanitizeFilename(input: string, fallback = "download.bin"): string {
  const base = basename(input || fallback);
  const cleaned = base
    .normalize("NFKD")
    .replace(/[\\/\0]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[_\.\-]+|[_\.\-]+$/g, "")
    .slice(0, 120);

  return cleaned || fallback;
}
