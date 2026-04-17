import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

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

function secureCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function verifyBearer(req: Request): boolean {
  const expectedToken = process.env.EMR_GATEWAY_BEARER_TOKEN;
  if (!expectedToken) {
    return false;
  }

  const auth = req.header("authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return false;
  }

  const provided = auth.slice("Bearer ".length).trim();
  return secureCompare(provided, expectedToken);
}

function verifyHmac(req: Request): boolean {
  const secret = process.env.EMR_GATEWAY_HMAC_SECRET;
  if (!secret) {
    return false;
  }

  const signatureHeader = req.header("x-emr-signature")?.trim();
  const timestamp = req.header("x-emr-timestamp")?.trim();
  const rawBody = (req as Request & { rawBody?: string }).rawBody;

  if (!signatureHeader || !timestamp || !rawBody) {
    return false;
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return false;
  }

  const maxSkewSec = Number(process.env.EMR_GATEWAY_HMAC_MAX_SKEW_SEC || 300);
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > maxSkewSec) {
    return false;
  }

  const payload = `${timestamp}.${rawBody}`;
  const digest = createHmac("sha256", secret).update(payload).digest("hex");
  return secureCompare(signatureHeader, digest);
}

export function requireCallerAuth(req: Request, res: Response, next: NextFunction): void {
  const bearerConfigured = Boolean(process.env.EMR_GATEWAY_BEARER_TOKEN);
  const hmacConfigured = Boolean(process.env.EMR_GATEWAY_HMAC_SECRET);

  if (!bearerConfigured && !hmacConfigured) {
    res.status(500).json({
      ok: false,
      error_category: "auth_configuration_error",
      message: "No caller authentication method configured"
    });
    return;
  }

  const valid = verifyBearer(req) || verifyHmac(req);
  if (!valid) {
    res.status(401).json({
      ok: false,
      error_category: "unauthorized_caller",
      message: "Caller authentication failed"
    });
    return;
  }

  next();
}
