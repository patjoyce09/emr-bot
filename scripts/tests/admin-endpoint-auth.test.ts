import express from "express";
import { requireAdminAccess } from "../../src/core/auth.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(port: number, token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/maintenance/purge_artifacts`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
}

(async () => {
  const app = express();
  app.post("/maintenance/purge_artifacts", requireAdminAccess, (_req, res) => {
    res.json({ ok: true });
  });

  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  try {
    process.env.ENABLE_ADMIN_ENDPOINTS = "false";
    process.env.EMR_GATEWAY_ADMIN_TOKEN = "admin-secret";
    const disabled = await request(port, "admin-secret");
    assert(disabled.status === 404, "Admin endpoint should be disabled by default");

    process.env.ENABLE_ADMIN_ENDPOINTS = "true";
    const unauthorized = await request(port, "wrong");
    assert(unauthorized.status === 401, "Wrong admin token should be rejected");

    const authorized = await request(port, "admin-secret");
    assert(authorized.status === 200, "Valid admin token should be accepted");

    console.log("PASS admin-endpoint-auth.test");
  } finally {
    server.close();
  }
})();
