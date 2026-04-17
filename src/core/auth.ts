import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export interface CallerAuthContext {
  method: "bearer" | "hmac";
  tenant_id?: string;
}

export interface TenantResolutionResult {
  ok: boolean;
  status: number;
  error_category?: string;
  message?: string;
  tenant_id?: string;
}

export function attachRequestId(req: Request, res: Response, next: NextFunction): void {
  const headerRequestId = req.header("x-request-id")?.trim();
  const requestId = headerRequestId || randomUUID();
  (req as Request & { requestId: string }).requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
}

function isAllowedTenant(tenantId: string): boolean {
  const raw = process.env.ALLOWED_TENANTS;
  if (!raw) {
    return true;
  }

  const allowed = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  return allowed.includes(tenantId);
}

export function authorizeTenant(tenantId: string): boolean {
  return isAllowedTenant(tenantId);
}

function getAuthContext(req: Request): CallerAuthContext | undefined {
  return (req as Request & { authContext?: CallerAuthContext }).authContext;
}

function parseTenantFromQuery(req: Request): string | undefined {
  const value = req.query.tenant_id;
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseTenantFromHeader(req: Request): string | undefined {
  const value = req.header("x-tenant-id")?.trim();
  return value || undefined;
}

function verifySignedTenantHeader(req: Request, tenantId: string): boolean {
  const secret = process.env.EMR_GATEWAY_TENANT_HEADER_SECRET;
  if (!secret) {
    return false;
  }

  const signature = req.header("x-tenant-signature")?.trim();
  if (!signature) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(tenantId).digest("hex");
  return secureCompare(signature, expected);
}

export function resolveCallerTenantId(req: Request): TenantResolutionResult {
  const authTenantId = getAuthContext(req)?.tenant_id;
  const headerTenantId = parseTenantFromHeader(req);
  const queryTenantId = parseTenantFromQuery(req);

  if (headerTenantId && queryTenantId && headerTenantId !== queryTenantId) {
    return {
      ok: false,
      status: 400,
      error_category: "tenant_scope_conflict",
      message: "x-tenant-id and tenant_id query parameter must match"
    };
  }

  const requestedTenantId = headerTenantId || queryTenantId;

  if (authTenantId) {
    if (requestedTenantId && requestedTenantId !== authTenantId) {
      return {
        ok: false,
        status: 403,
        error_category: "tenant_scope_mismatch",
        message: "Caller tenant scope does not match requested tenant"
      };
    }

    return {
      ok: true,
      status: 200,
      tenant_id: authTenantId
    };
  }

  if (!requestedTenantId) {
    return {
      ok: false,
      status: 400,
      error_category: "missing_tenant_scope",
      message: "Provide tenant scope via x-tenant-id or tenant_id query parameter"
    };
  }

  if (!verifySignedTenantHeader(req, requestedTenantId)) {
    return {
      ok: false,
      status: 401,
      error_category: "invalid_tenant_signature",
      message: "Signed tenant header verification failed"
    };
  }

  return {
    ok: true,
    status: 200,
    tenant_id: requestedTenantId
  };
}

function secureCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function parseBearerTenantMap(): Record<string, string> {
  const raw = process.env.EMR_GATEWAY_BEARER_TENANT_MAP;
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed;
  } catch {
    return {};
  }
}

function verifyBearer(req: Request): CallerAuthContext | undefined {
  const expectedToken = process.env.EMR_GATEWAY_BEARER_TOKEN;
  const tenantTokenMap = parseBearerTenantMap();
  const hasMap = Object.keys(tenantTokenMap).length > 0;

  const auth = req.header("authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return undefined;
  }

  const provided = auth.slice("Bearer ".length).trim();

  if (hasMap) {
    for (const [tenantId, token] of Object.entries(tenantTokenMap)) {
      if (secureCompare(provided, token)) {
        return {
          method: "bearer",
          tenant_id: tenantId
        };
      }
    }

    return undefined;
  }

  if (!expectedToken) {
    return undefined;
  }

  if (!secureCompare(provided, expectedToken)) {
    return undefined;
  }

  return {
    method: "bearer"
  };
}

function verifyHmac(req: Request): CallerAuthContext | undefined {
  const secret = process.env.EMR_GATEWAY_HMAC_SECRET;
  if (!secret) {
    return undefined;
  }

  const signatureHeader = req.header("x-emr-signature")?.trim();
  const timestamp = req.header("x-emr-timestamp")?.trim();
  const rawBody = (req as Request & { rawBody?: string }).rawBody;

  if (!signatureHeader || !timestamp) {
    return undefined;
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return undefined;
  }

  const maxSkewSec = Number(process.env.EMR_GATEWAY_HMAC_MAX_SKEW_SEC || 300);
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > maxSkewSec) {
    return undefined;
  }

  const payload = `${timestamp}.${rawBody || ""}`;
  const digest = createHmac("sha256", secret).update(payload).digest("hex");
  if (!secureCompare(signatureHeader, digest)) {
    return undefined;
  }

  return {
    method: "hmac"
  };
}

export function requireCallerAuth(req: Request, res: Response, next: NextFunction): void {
  const bearerConfigured = Boolean(process.env.EMR_GATEWAY_BEARER_TOKEN);
  const bearerTenantMapConfigured = Boolean(process.env.EMR_GATEWAY_BEARER_TENANT_MAP);
  const hmacConfigured = Boolean(process.env.EMR_GATEWAY_HMAC_SECRET);

  if (!bearerConfigured && !hmacConfigured && !bearerTenantMapConfigured) {
    res.status(500).json({
      ok: false,
      error_category: "auth_configuration_error",
      message: "No caller authentication method configured"
    });
    return;
  }

  const context = verifyBearer(req) || verifyHmac(req);
  if (!context) {
    res.status(401).json({
      ok: false,
      error_category: "unauthorized_caller",
      message: "Caller authentication failed"
    });
    return;
  }

  (req as Request & { authContext?: CallerAuthContext }).authContext = context;

  next();
}
