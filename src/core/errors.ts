export type ErrorCategory =
  | "auth_failure"
  | "session_expired"
  | "mfa_required"
  | "permission_denied"
  | "navigation_timeout"
  | "selector_not_found"
  | "download_failure"
  | "export_unavailable"
  | "validation_error"
  | "unknown";

export function categorizeError(error: unknown): ErrorCategory {
  if (!(error instanceof Error)) {
    return "unknown";
  }

  const message = error.message.toLowerCase();

  if (message.includes("mfa") || message.includes("multi-factor") || message.includes("verification code")) {
    return "mfa_required";
  }
  if (message.includes("session expired")) {
    return "session_expired";
  }
  if (message.includes("permission denied") || message.includes("access denied") || message.includes("not authorized")) {
    return "permission_denied";
  }
  if (message.includes("timeout")) {
    return "navigation_timeout";
  }
  if (message.includes("selector") || message.includes("locator")) {
    return "selector_not_found";
  }
  if (message.includes("download")) {
    return "download_failure";
  }
  if (message.includes("export unavailable")) {
    return "export_unavailable";
  }
  if (message.includes("unauthorized") || message.includes("login") || message.includes("credential")) {
    return "auth_failure";
  }
  if (message.includes("validation")) {
    return "validation_error";
  }

  return "unknown";
}
