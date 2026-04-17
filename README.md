# therapyhub-emr-gateway

Node service with a Playwright-based WellSky worker for EMR jobs.

## Implemented job

- `pull_schedule_report`

### Inputs

- `tenant_id`
- `emr_vendor` = `wellsky_home_health`
- `date_from`
- `date_to`
- `disciplines[]`
- `report_profile_id`

### Outputs

- Downloaded report file in local artifact folder
- Normalized artifact metadata
- Execution evidence bundle (screenshots, timestamps, DOM markers, export filename)

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

Response (success): metadata only, no PHI logs.

### Caller authentication

Configure at least one:

- Bearer: `Authorization: Bearer <EMR_GATEWAY_BEARER_TOKEN>`
- HMAC headers:
   - `x-emr-timestamp` (epoch seconds)
   - `x-emr-signature` where signature = `hex(hmac_sha256(secret, timestamp + "." + rawBody))`

### Idempotency and job state

- If `idempotency_key` is omitted, the service derives one from tenant + report parameters.
- Persisted states: `queued`, `running`, `succeeded`, `failed`, `retry_exhausted`.
- Store location configurable via `JOB_STORE_PATH`.

## Selector configuration

Default selectors are in `src/vendors/wellsky/selectors.ts` and should be adjusted to your WellSky tenant UI.
