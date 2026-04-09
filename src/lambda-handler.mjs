import { getCachedPayload, refreshPayload } from "./tsv-api-core.mjs";

function logJson(level, event, fields = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    event,
    fn: process.env.AWS_LAMBDA_FUNCTION_NAME ?? "local",
    ...fields
  };
  const out = level === "ERROR" ? process.stderr : process.stdout;
  out.write(JSON.stringify(entry) + "\n");
}

export async function handler(event = {}) {
  const t0 = Date.now();
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
  const path = event.rawPath ?? event.path ?? "/api";

  logJson("INFO", "request_received", { method, path });

  if (method !== "GET" && method !== "POST") {
    logJson("WARN", "request_rejected", { method, path, statusCode: 405, reason: "method_not_allowed" });
    return {
      statusCode: 405,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, message: "method not allowed" })
    };
  }

  if (!path.startsWith("/api") && !path.startsWith("/refresh")) {
    logJson("WARN", "request_rejected", { method, path, statusCode: 404, reason: "not_found" });
    return {
      statusCode: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, message: "not found" })
    };
  }

  try {
    const payload = path.startsWith("/refresh")
      ? await refreshPayload()
      : await getCachedPayload();
    const { __status, ...body } = payload;
    const statusCode = __status ?? 200;
    logJson("INFO", "request_done", {
      method,
      path,
      statusCode,
      reason: body.reason ?? null,
      preparingNext: body.preparingNext ?? null,
      elapsedMs: Date.now() - t0
    });
    return {
      statusCode,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body)
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    logJson("ERROR", "request_error", { method, path, errorMessage: message, elapsedMs: Date.now() - t0 });
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, message })
    };
  }
}
