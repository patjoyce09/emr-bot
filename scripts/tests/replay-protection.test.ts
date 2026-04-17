import { createHmac, randomUUID } from "node:crypto";
import express from "express";
import { requireCallerAuth } from "../../src/core/auth.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function sign(method: string, path: string, timestamp: string, nonce: string, body: string, secret: string): string {
  const base = [method.toUpperCase(), path, timestamp, nonce, body].join("\n");
  return createHmac("sha256", secret).update(base).digest("hex");
}

(async () => {
  process.env.EMR_GATEWAY_HMAC_SECRET = "test-secret";
  process.env.EMR_GATEWAY_NONCE_TTL_SEC = "60";
  process.env.EMR_GATEWAY_BEARER_TOKEN = "";
  process.env.EMR_GATEWAY_BEARER_TENANT_MAP = "";

  const app = express();
  app.use(express.json({
    verify: (req, _res, buffer) => {
      (req as express.Request & { rawBody?: string }).rawBody = buffer.toString("utf8");
    }
  }));
  app.post("/probe", requireCallerAuth, (_req, res) => {
    res.json({ ok: true });
  });

  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  try {
    const body = JSON.stringify({ hello: "world" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const signature = sign("POST", "/probe", timestamp, nonce, body, "test-secret");

    const first = await fetch(`http://127.0.0.1:${port}/probe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-emr-timestamp": timestamp,
        "x-emr-nonce": nonce,
        "x-emr-signature": signature
      },
      body
    });

    const second = await fetch(`http://127.0.0.1:${port}/probe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-emr-timestamp": timestamp,
        "x-emr-nonce": nonce,
        "x-emr-signature": signature
      },
      body
    });

    assert(first.status === 200, "First signed request should succeed");
    assert(second.status === 401, "Replay nonce should be rejected");

    console.log("PASS replay-protection.test");
  } finally {
    server.close();
  }
})();
