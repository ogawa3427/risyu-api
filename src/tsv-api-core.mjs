import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand
} from "@aws-sdk/client-s3";

// ── 構造化ロガー ──────────────────────────────────────────────────────────────
function log(level, event, fields = {}) {
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

const info  = (event, fields) => log("INFO",  event, fields);
const error = (event, fields) => log("ERROR", event, fields);
// ─────────────────────────────────────────────────────────────────────────────

const workDir = process.env.RISYU_WORK_DIR
  ? path.resolve(process.env.RISYU_WORK_DIR)
  : process.env.AWS_LAMBDA_FUNCTION_NAME
    ? "/tmp/risyu-api"
    : process.cwd();
const outputPath = process.env.RISYU_TSV_PATH ?? path.join(workDir, "output.tsv");
const collectArgs = (process.env.RISYU_API_COLLECT_ARGS ?? "")
  .split(" ")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const staleSec = Number.parseInt(process.env.RISYU_STALE_SEC ?? "60", 10);
const staleMs = staleSec * 1000;

const s3Bucket = process.env.RISYU_S3_BUCKET ?? "";
const s3Key = process.env.RISYU_S3_KEY ?? "cache/output.tsv";
const historyS3Key = process.env.RISYU_S3_HISTORY_KEY ?? "cache/refresh-history.json";
const lockS3Key = process.env.RISYU_S3_LOCK_KEY ?? "cache/scraping-lock.json";
// スクレイピングが完了するまでの最大想定時間。この時間内にロックが書かれていたらスキップ。
const lockTtlMs = Number.parseInt(process.env.RISYU_LOCK_TTL_MS ?? "120000", 10);
const s3Client = s3Bucket ? new S3Client({}) : null;

const HISTORY_MAX = 10;
const HISTORY_RETURN = 5;

let inflightCollect = null;
let asyncInvokePending = false;

// ── refresh 履歴 ─────────────────────────────────────────────────────────────
// Lambda コンテナ間で共有するため S3 に保存する。
// メモリキャッシュは同一コンテナ内でのみ有効。

let historyCache = null; // null = 未ロード

async function loadHistory() {
  if (!s3Client) return [];
  try {
    const res = await s3Client.send(
      new GetObjectCommand({ Bucket: s3Bucket, Key: historyS3Key })
    );
    const raw = await res.Body.transformToString("utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return [];
    error("history_load", { result: "error", errorMessage: err.message });
    return [];
  }
}

async function saveHistory(entries) {
  if (!s3Client) return;
  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: s3Bucket,
        Key: historyS3Key,
        Body: JSON.stringify(entries),
        ContentType: "application/json"
      })
    );
  } catch (err) {
    error("history_save", { result: "error", errorMessage: err.message });
  }
}

async function appendRefreshHistory(entry) {
  const current = await loadHistory();
  const updated = [entry, ...current].slice(0, HISTORY_MAX);
  historyCache = updated;
  await saveHistory(updated);
}

async function getHistory() {
  if (historyCache !== null) return historyCache;
  historyCache = await loadHistory();
  return historyCache;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── スクレイピング多重起動防止ロック ─────────────────────────────────────────
// S3 に開始タイムスタンプを書くことで、複数コンテナが同時にスクレイピングを
// 起動するレースコンディションを防ぐ（TTL 以内のロックがあればスキップ）。

async function checkScrapingLock() {
  if (!s3Client) return false;
  try {
    const res = await s3Client.send(
      new GetObjectCommand({ Bucket: s3Bucket, Key: lockS3Key })
    );
    const raw = await res.Body.transformToString("utf8");
    const { startedAt } = JSON.parse(raw);
    const elapsed = Date.now() - new Date(startedAt).getTime();
    const locked = elapsed < lockTtlMs;
    info("scraping_lock_check", { locked, elapsedSinceStartMs: elapsed, lockTtlMs });
    return locked;
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return false;
    error("scraping_lock_check", { result: "error", errorMessage: err.message });
    return false;
  }
}

async function acquireScrapingLock() {
  if (!s3Client) return;
  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: s3Bucket,
        Key: lockS3Key,
        Body: JSON.stringify({ startedAt: new Date().toISOString() }),
        ContentType: "application/json"
      })
    );
    info("scraping_lock_acquire", { result: "ok" });
  } catch (err) {
    error("scraping_lock_acquire", { result: "error", errorMessage: err.message });
  }
}

async function releaseScrapingLock() {
  if (!s3Client) return;
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: lockS3Key }));
  } catch {
    // release 失敗は TTL で自然消滅するので無視
  }
}
// ─────────────────────────────────────────────────────────────────────────────

async function uploadToS3(filePath) {
  if (!s3Client) return;
  const t0 = Date.now();
  try {
    const body = await fs.readFile(filePath);
    await s3Client.send(
      new PutObjectCommand({ Bucket: s3Bucket, Key: s3Key, Body: body })
    );
    info("s3_upload", { result: "ok", bucket: s3Bucket, key: s3Key, elapsedMs: Date.now() - t0 });
  } catch (err) {
    error("s3_upload", { result: "error", bucket: s3Bucket, key: s3Key, errorMessage: err.message });
  }
}

async function getS3LastModified() {
  if (!s3Client) return null;
  const t0 = Date.now();
  try {
    const res = await s3Client.send(
      new HeadObjectCommand({ Bucket: s3Bucket, Key: s3Key })
    );
    const lastModifiedMs = res.LastModified ? res.LastModified.getTime() : null;
    info("s3_head", {
      result: lastModifiedMs ? "found" : "no_date",
      lastModified: res.LastModified?.toISOString() ?? null,
      elapsedMs: Date.now() - t0
    });
    return lastModifiedMs;
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      info("s3_head", { result: "not_found", elapsedMs: Date.now() - t0 });
      return null;
    }
    error("s3_head", { result: "error", errorMessage: err.message, elapsedMs: Date.now() - t0 });
    return null;
  }
}

async function restoreFromS3(destPath) {
  if (!s3Client) return null;
  const t0 = Date.now();
  try {
    const res = await s3Client.send(
      new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key })
    );
    const s3LastModifiedMs = res.LastModified ? res.LastModified.getTime() : null;
    const body = await res.Body.transformToByteArray();
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, body);
    info("s3_restore", {
      result: "ok",
      key: s3Key,
      destPath,
      lastModified: res.LastModified?.toISOString() ?? null,
      bytes: body.byteLength,
      elapsedMs: Date.now() - t0
    });
    return s3LastModifiedMs;
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      info("s3_restore", { result: "not_found", elapsedMs: Date.now() - t0 });
      return null;
    }
    error("s3_restore", { result: "error", errorMessage: err.message, elapsedMs: Date.now() - t0 });
    return null;
  }
}

function parseTsv(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const rows = lines.map((line) => line.split("\t"));
  return { rowCount: rows.length, rows };
}

async function readCurrentParsed() {
  const raw = await fs.readFile(outputPath, "utf8");
  return parseTsv(raw);
}

async function runCollectorOnce() {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  info("collector_start", { outputPath, collectArgs });

  try {
    await new Promise((resolve, reject) => {
      const child = spawn("node", ["src/risyu-migrated.mjs", ...collectArgs], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        process.stderr.write(chunk);
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) return resolve();
        const tail = stderr.trim().split("\n").slice(-10).join("\n");
        reject(
          new Error(
            `collector failed with exit code ${code ?? "unknown"}${tail ? `: ${tail}` : ""}`
          )
        );
      });
    });

    await fs.access(outputPath);
    await uploadToS3(outputPath);

    const durationMs = Date.now() - t0;
    info("collector_done", { elapsedMs: durationMs, outputPath });
    await appendRefreshHistory({ startedAt, finishedAt: new Date().toISOString(), durationMs, success: true });
  } catch (err) {
    const durationMs = Date.now() - t0;
    await appendRefreshHistory({
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs,
      success: false,
      errorMessage: err.message.split("\n")[0]
    });
    throw err;
  }
}

async function runCollector() {
  if (inflightCollect) {
    info("collector_wait", { reason: "already_inflight" });
    await inflightCollect;
    return;
  }
  inflightCollect = runCollectorOnce().finally(() => {
    inflightCollect = null;
  });
  await inflightCollect;
}

function triggerBackgroundRefresh() {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    if (asyncInvokePending) {
      info("background_refresh", { result: "skipped", reason: "invoke_already_pending" });
      return;
    }
    asyncInvokePending = true;
    info("background_refresh", { result: "invoking", mode: "async_lambda" });
    const client = new LambdaClient({});
    client
      .send(
        new InvokeCommand({
          FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
          InvocationType: "Event",
          Payload: JSON.stringify({ rawPath: "/refresh" })
        })
      )
      .then(() => {
        info("background_refresh", { result: "invoke_sent" });
      })
      .catch((err) => {
        error("background_refresh", { result: "invoke_failed", errorMessage: err.message });
      })
      .finally(() => {
        asyncInvokePending = false;
      });
    return;
  }
  if (inflightCollect) {
    info("background_refresh", { result: "skipped", reason: "already_inflight", mode: "local" });
    return;
  }
  info("background_refresh", { result: "started", mode: "local" });
  inflightCollect = runCollectorOnce()
    .catch((err) => {
      error("background_refresh", { result: "failed", mode: "local", errorMessage: err.message });
    })
    .finally(() => {
      inflightCollect = null;
    });
}

export async function hasCachedOutput() {
  try {
    await fs.access(outputPath);
    return true;
  } catch {
    return false;
  }
}

export async function getCachedPayload() {
  const t0 = Date.now();

  let mtime = await fs
    .stat(outputPath)
    .then((s) => s.mtimeMs)
    .catch(() => null);
  const tmpHit = mtime !== null;

  if (mtime === null) {
    const s3ModifiedMs = await restoreFromS3(outputPath);
    if (s3ModifiedMs !== null) {
      mtime = s3ModifiedMs;
    }
  }

  triggerBackgroundRefresh();

  if (mtime === null) {
    info("api_response", { decision: "initializing", tmpHit: false, s3Hit: false, elapsedMs: Date.now() - t0 });
    return {
      __status: 202,
      ok: true,
      reason: "initializing",
      preparingNext: true,
      message: "初回スクレイピングを開始しました。数秒後にリトライしてください。"
    };
  }

  const elapsedSinceCollectMs = Date.now() - mtime;
  const isStale = elapsedSinceCollectMs > staleMs;
  const preparingNext = isStale || inflightCollect !== null;
  const [parsed, history] = await Promise.all([
    readCurrentParsed(),
    getHistory()
  ]);

  info("api_response", {
    decision: preparingNext ? "refreshing_in_background" : "cached",
    tmpHit,
    s3Hit: !tmpHit && mtime !== null,
    isStale,
    elapsedSinceCollectSec: Math.floor(elapsedSinceCollectMs / 1000),
    preparingNext,
    rowCount: parsed.rowCount,
    lastCollectAt: new Date(mtime).toISOString(),
    elapsedMs: Date.now() - t0
  });

  return {
    __status: 200,
    ok: true,
    source: outputPath,
    reason: preparingNext ? "refreshing_in_background" : "cached",
    preparingNext,
    lastCollectAt: new Date(mtime).toISOString(),
    ...(preparingNext && isStale
      ? { message: "バックグラウンドで新しいデータを取得中です。まもなく更新されます。" }
      : {}),
    recentRefreshes: history.slice(0, HISTORY_RETURN),
    ...parsed
  };
}

export async function refreshPayload() {
  const t0 = Date.now();

  let lastModifiedMs = await getS3LastModified();

  if (lastModifiedMs === null) {
    lastModifiedMs = await fs
      .stat(outputPath)
      .then((s) => s.mtimeMs)
      .catch(() => null);
  }

  if (lastModifiedMs === null) {
    if (await checkScrapingLock()) {
      info("refresh_decision", { decision: "skip", reason: "lock_held_first_time" });
      return { __status: 200, ok: true, reason: "scraping_in_progress", preparingNext: true };
    }
    info("refresh_decision", { decision: "scrape", reason: "first_time" });
    await acquireScrapingLock();
    try {
      await runCollector();
    } finally {
      await releaseScrapingLock();
    }
    const mtime = await fs.stat(outputPath).then((s) => s.mtimeMs).catch(() => null);
    info("refresh_done", { reason: "initialized", elapsedMs: Date.now() - t0 });
    return {
      __status: 200,
      ok: true,
      reason: "initialized",
      preparingNext: false,
      lastCollectAt: mtime ? new Date(mtime).toISOString() : null
    };
  }

  const elapsedMs = Date.now() - lastModifiedMs;
  const elapsedSec = Math.floor(elapsedMs / 1000);

  if (elapsedMs < staleMs) {
    const nextRefreshInSec = Math.ceil((staleMs - elapsedMs) / 1000);
    info("refresh_decision", {
      decision: "skip",
      reason: "too_soon",
      elapsedSec,
      nextRefreshInSec,
      lastCollectAt: new Date(lastModifiedMs).toISOString()
    });
    return {
      __status: 200,
      ok: true,
      reason: "too_soon",
      preparingNext: false,
      nextRefreshInSec,
      lastCollectAt: new Date(lastModifiedMs).toISOString()
    };
  }

  // 1分以上経過 → ロック確認してからスクレイピング
  if (await checkScrapingLock()) {
    info("refresh_decision", { decision: "skip", reason: "lock_held", elapsedSec });
    return { __status: 200, ok: true, reason: "scraping_in_progress", preparingNext: true };
  }

  info("refresh_decision", {
    decision: "scrape",
    reason: "stale",
    elapsedSec,
    staleSec,
    lastCollectAt: new Date(lastModifiedMs).toISOString()
  });
  await acquireScrapingLock();
  try {
    await runCollector();
  } finally {
    await releaseScrapingLock();
  }
  const mtime = await fs.stat(outputPath).then((s) => s.mtimeMs).catch(() => null);
  info("refresh_done", { reason: "refreshed", elapsedMs: Date.now() - t0 });
  return {
    __status: 200,
    ok: true,
    reason: "refreshed",
    preparingNext: false,
    lastCollectAt: mtime ? new Date(mtime).toISOString() : null
  };
}

export function getConfigSnapshot() {
  return { outputPath, staleSec };
}
