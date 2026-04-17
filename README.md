# therapyhub-emr-gateway

Node service with a Playwright-based WellSky worker for EMR jobs.

## Implemented job

- `pull_schedule_report`

Execution model: asynchronous queue + in-process worker.

### Inputs

- `tenant_id`
- `emr_vendor` = `wellsky_home_health`
- `date_from`
- `date_to`
- `disciplines[]`
- `report_profile_id`
- `selector_profile_id` (optional, defaults to `default`)

### Outputs

- Downloaded report file in local artifact folder
- Normalized artifact metadata
- Execution evidence bundle (screenshots, timestamps, DOM markers, export filename)
- Secure artifact handoff metadata for remote retrieval (`artifact_id`, hash, bytes, mime, expiry)

## Why this design

- Isolated Playwright browser context per tenant/job run.
- Reusable session/bootstrap layer for future WellSky jobs.
- Secrets loaded from environment or pluggable secret manager chain.
- Structured logs avoid PHI text.
- On failure captures screenshot + last step + categorized error.
- Caller authentication (Bearer and/or HMAC) protects worker boundary.
- Idempotency + persisted job state reduce duplicate report pulls.

## Quick start

1. Install dependencies:
   - `npm install`
2. Copy env:
   - `cp .env.example .env`
3. Set real WellSky URLs/selectors and credentials.
4. Run:
   - `npm run dev`

## API

### `GET /health`

Basic liveness check.

### `GET /ready`

Readiness check (requires critical env and caller-auth config).

### `GET /version`

Returns service version.

### `GET /jobs/:jobId`

Returns persisted status for a known job id.

Tenant scope is required and enforced. Provide one of:

- Bearer tenant claim via `EMR_GATEWAY_BEARER_TENANT_MAP`
- `x-tenant-id` (or `tenant_id` query) + `x-tenant-signature` where
   `x-tenant-signature = hex(hmac_sha256(EMR_GATEWAY_TENANT_HEADER_SECRET, tenant_id))`

Statuses:

- `queued`
- `running`
- `artifact_ready`
- `succeeded`
- `failed`
- `retry_exhausted`

### `GET /artifacts/:artifactId/download`

Downloads a completed artifact for the caller tenant.

Requirements:

- Caller auth (`Authorization` Bearer or HMAC headers)
- Tenant scope (same model as job lookup: bearer tenant claim OR signed tenant header/query)

Responses:

- `404 artifact_not_found` when id is unknown
- `410 artifact_expired` when retention window has passed
- `410 artifact_purged` when retention cleanup already purged file
- `403 artifact_tenant_mismatch` when caller tenant does not own artifact

### `POST /maintenance/purge_artifacts`

Runs retention cleanup immediately (also runs on schedule).

### `POST /jobs/pull_schedule_report`

Body:

```json
{
   "job_id": "optional-client-job-id",
   "idempotency_key": "optional-client-key",
  "tenant_id": "tenant-a",
  "emr_vendor": "wellsky_home_health",
  "date_from": "2026-04-01",
  "date_to": "2026-04-17",
  "disciplines": ["PT", "OT"],
  "report_profile_id": "standard"
}
```

Response: `202 Accepted` (job is queued and processed asynchronously).

Example enqueue response:

```json
{
   "ok": true,
   "job_id": "...",
   "idempotency_key": "...",
   "status": "queued"
}
```

Success response includes artifact handoff contract:

- `artifact_id`
- `artifact_filename`
- `artifact_sha256`
- `artifact_bytes`
- `artifact_mime_type`
- `artifact_ready` = `true`
- `expires_at`
- `artifact_download_path` (call with auth + tenant claim or signed tenant scope)
- `created_at`
- `expires_at`
- `purged_at` (set after retention cleanup)

Selector profile metadata is persisted in:

- `artifact_metadata.selector_profile_id`
- `artifact_metadata.selector_version`
- `evidence_bundle.selector_profile_id`
- `evidence_bundle.selector_version`

Note: API responses intentionally do not expose internal filesystem paths.

### Caller authentication

Configure at least one:

- Bearer: `Authorization: Bearer <EMR_GATEWAY_BEARER_TOKEN>`
- Bearer tenant mapping (recommended for multi-tenant):
   - `EMR_GATEWAY_BEARER_TENANT_MAP={"tenant-a":"token-a"}`
   - Tenant is inferred from token claim mapping.
- HMAC headers:
   - `x-emr-timestamp` (epoch seconds)
   - `x-emr-signature` where signature = `hex(hmac_sha256(secret, timestamp + "." + rawBody))`

### Tenant-auth pattern

- All job/artifact reads are tenant-scoped.
- Cross-tenant reads return `403`.
- If bearer token does not embed tenant mapping, include tenant scope explicitly with signed tenant header:
   - `x-tenant-id: <tenant>`
   - `x-tenant-signature: hex(hmac_sha256(EMR_GATEWAY_TENANT_HEADER_SECRET, tenant))`
- You may provide `tenant_id` query param, but if `x-tenant-id` is also provided they must match.

### Idempotency and job state

- If `idempotency_key` is omitted, the service derives one from tenant + report parameters.
- Persisted states: `queued`, `running`, `artifact_ready`, `succeeded`, `failed`, `retry_exhausted`.
- Store location configurable via `JOB_STORE_PATH`.
- Duplicate keys dedupe active/completed jobs and return existing job identity/state.

### Artifact retention

- Artifacts stay on local disk under `ARTIFACTS_ROOT`.
- `ARTIFACT_RETENTION_DAYS` controls expiry metadata in API responses.
- `SCREENSHOT_RETENTION_DAYS` controls screenshot purge window.
- `KEEP_FAILURE_SCREENSHOTS` controls whether failed-run screenshots are retained.
- `ARTIFACT_CLEANUP_INTERVAL_MS` controls scheduled cleanup frequency.

Security note:

- Exported downloads and screenshots may contain PHI.
- Store artifacts only in secure encrypted storage with strict access controls.
- Retention settings should be aligned to your HIPAA and operational policies.

### Worker configuration

- `WORKER_POLL_INTERVAL_MS`: queue polling interval for in-process worker.
- `JOB_MAX_ATTEMPTS`: max attempts before `retry_exhausted`.

## Selector configuration

Selector handling is profile-based and versioned:

- base profile(s) in [src/vendors/wellsky/selectors.ts](src/vendors/wellsky/selectors.ts)
- optional tenant overrides via:
   - `WELLSKY_SELECTOR_OVERRIDES_JSON`
   - `WELLSKY_SELECTOR_OVERRIDES_PATH`

Override shape:

```json
{
   "tenant-a": {
      "default": {
         "version": "tenant-a-v2",
         "selectors": {
            "reportReadyMarker": "form[data-tenant='a']"
         }
      }
   }
}
```

This allows selector drift management as data, not code branches.
