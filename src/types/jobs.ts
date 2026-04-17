export type EmrVendor = "wellsky_home_health";

export interface PullScheduleReportInput {
  job_id?: string;
  idempotency_key?: string;
  tenant_id: string;
  emr_vendor: EmrVendor;
  date_from: string;
  date_to: string;
  disciplines: string[];
  report_profile_id: string;
}

export interface DownloadedFileMetadata {
  path: string;
  filename: string;
  bytes: number;
  sha256: string;
  mime_type: string;
  created_at: string;
}

export interface NormalizedArtifactMetadata {
  job_id: string;
  run_id: string;
  job_name: "pull_schedule_report";
  tenant_id: string;
  emr_vendor: EmrVendor;
  period: {
    date_from: string;
    date_to: string;
  };
  discipline_count: number;
  report_profile_id: string;
  artifact_root: string;
}

export interface ExecutionEvidenceBundle {
  step_log_path: string;
  dom_markers_path: string;
  timestamps_path: string;
  screenshots: string[];
  export_filename: string;
  last_step: string;
}

export interface PullScheduleReportOutput {
  file: DownloadedFileMetadata;
  artifact_metadata: NormalizedArtifactMetadata;
  evidence_bundle: ExecutionEvidenceBundle;
}

export interface PullScheduleReportFailure {
  run_id: string;
  tenant_id: string;
  job_name: "pull_schedule_report";
  error_category: string;
  message: string;
  last_step: string;
  failure_screenshot: string;
  evidence_bundle: Omit<ExecutionEvidenceBundle, "export_filename"> & {
    export_filename?: string;
  };
}
