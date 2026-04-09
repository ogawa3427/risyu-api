import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand
} from "@aws-sdk/client-s3";

// ── 構造化ロガー ──────────────────────────────────────────────────────────────
// CloudWatch Logs Insights で fields / filter / stats が使える JSON 1行形式で出力する。
// 例: fields @timestamp, event, result, elapsedSec | filter event = "refresh_decision"
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
const warn  = (event, fields) => log("WARN",  event, fields);
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
const s3Client = s3Bucket ? new S3Client({}) : null;

let inflightCollect = null;
let asyncInvokePending = false;

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

// S3オブジェクトのLastModifiedだけ取得（ファイルダウンロードなし）
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
  const t0 = Date.now();
  info("collector_start", { outputPath, collectArgs });

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

  info("collector_done", { elapsedMs: Date.now() - t0, outputPath });
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

// /api から叩かれるバックグラウンドrefresh起動。
// Lambda では自分自身を rawPath: "/refresh" で非同期invoke、
// ローカルではプロセス内バックグラウンドで runCollectorOnce を起動する。
// 実際にスクレイピングするかどうかは refreshPayload が判断する。
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

/**
 * /api エンドポイント用。
 * S3/ローカルキャッシュを読んで即返す。バックグラウンドrefreshは常に起動する。
 * TSVが一切存在しない初回のみ 202 を返す。
 */
export async function getCachedPayload() {
  const t0 = Date.now();

  // /tmp のmtimeを確認
  let mtime = await fs
    .stat(outputPath)
    .then((s) => s.mtimeMs)
    .catch(() => null);
  const tmpHit = mtime !== null;

  // /tmp になければ S3 から復元（ファイルも落とす）
  if (mtime === null) {
    const s3ModifiedMs = await restoreFromS3(outputPath);
    if (s3ModifiedMs !== null) {
      mtime = s3ModifiedMs;
    }
  }

  // バックグラウンドrefreshを常に起動（refreshPayload 側がレート制限を判断する）
  triggerBackgroundRefresh();

  // 完全初回: TSVがどこにもない
  if (mtime === null) {
    info("api_response", {
      decision: "initializing",
      tmpHit: false,
      s3Hit: false,
      elapsedMs: Date.now() - t0
    });
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
  const preparingNext = isStale || inflightCollect !== null || asyncInvokePending;
  const parsed = await readCurrentParsed();

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
    ...parsed
  };
}

/**
 * /refresh エンドポイント用。
 * 実際にスクレイピングするかどうかをここで判断する。
 * - 完全初回（S3にもなし）: 即スクレイピング
 * - 前回から1分未満: 何もしない
 * - 1分以上経過: スクレイピング実行
 */
export async function refreshPayload() {
  const t0 = Date.now();

  // S3のLastModifiedを正とする（Lambda間でコンテナが異なるため）
  let lastModifiedMs = await getS3LastModified();

  // S3なし（ローカル環境など）: /tmp のmtimeで代用
  if (lastModifiedMs === null) {
    lastModifiedMs = await fs
      .stat(outputPath)
      .then((s) => s.mtimeMs)
      .catch(() => null);
  }

  // 完全初回
  if (lastModifiedMs === null) {
    info("refresh_decision", { decision: "scrape", reason: "first_time" });
    await runCollector();
    const mtime = await fs
      .stat(outputPath)
      .then((s) => s.mtimeMs)
      .catch(() => null);
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

  // 1分未満: スキップ
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

  // 1分以上経過: スクレイピング実行
  info("refresh_decision", {
    decision: "scrape",
    reason: "stale",
    elapsedSec,
    staleSec,
    lastCollectAt: new Date(lastModifiedMs).toISOString()
  });
  await runCollector();
  const mtime = await fs
    .stat(outputPath)
    .then((s) => s.mtimeMs)
    .catch(() => null);
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
