import http from "node:http";
import { getCachedPayload, getConfigSnapshot, refreshPayload } from "./tsv-api-core.mjs";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const config = getConfigSnapshot();

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, message: "method not allowed" }));
    return;
  }

  if (!req.url || (!req.url.startsWith("/api") && !req.url.startsWith("/refresh"))) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, message: "not found" }));
    return;
  }

  try {
    const payload = req.url.startsWith("/refresh")
      ? await refreshPayload()
      : await getCachedPayload();
    const { __status, ...body } = payload;
    res.writeHead(__status ?? 200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, message }));
  }
});

server.listen(port, () => {
  console.log(`tsv server listening on http://localhost:${port}/api`);
  console.log(`refresh endpoint on http://localhost:${port}/refresh`);
  console.log(`output source: ${config.outputPath} stale: ${config.staleSec}s`);
});
