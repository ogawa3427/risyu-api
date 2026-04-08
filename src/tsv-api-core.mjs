import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";

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

// S3 永続キャッシュ (RISYU_S3_BUCKET が未設定なら無効)
const s3Bucket =
  process.env.RISYU_S3_BUCKET ??
  (process.env.AWS_LAMBDA_FUNCTION_NAME ? "risyu" : "");
const s3Key = process.env.RISYU_S3_KEY ?? "cache/output.tsv";
const s3Client = s3Bucket ? new S3Client({}) : null;

let lastCollectAtMs = 0;
let inflightCollect = null;
let asyncInvokePending = false;

async function uploadToS3(filePath) {
  if (!s3Client) return;
  try {
    const body = await fs.readFile(filePath);
    await s3Client.send(
      new PutObjectCommand({ Bucket: s3Bucket, Key: s3Key, Body: body })
    );
    console.log(`[s3] uploaded ${s3Key} to s3://${s3Bucket}`);
  } catch (err) {
    console.error("[s3] upload failed:", err.message);
  }
}

async function restoreFromS3(destPath) {
  if (!s3Client) return null;
  try {
    const res = await s3Client.send(
      new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key })
    );
    const s3LastModifiedMs = res.LastModified ? res.LastModified.getTime() : null;
    const body = await res.Body.transformToByteArray();
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, body);
    console.log(`[s3] restored ${s3Key} → ${destPath} (s3 LastModified: ${res.LastModified?.toISOString()})`);
    return s3LastModifiedMs;
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      console.log("[s3] no cached object in S3 yet");
      return null;
    }
    console.error("[s3] restore failed:", err.message);
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

async function runCollectorOnce() {
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
  lastCollectAtMs = Date.now();
  await fs.access(outputPath);
  await uploadToS3(outputPath);
}

async function runCollector() {
  if (inflightCollect) {
    await inflightCollect;
    return;
  }
  inflightCollect = runCollectorOnce().finally(() => {
    inflightCollect = null;
  });
  await inflightCollect;
}

async function readCurrentParsed() {
  const raw = await fs.readFile(outputPath, "utf8");
  return parseTsv(raw);
}

export async function hasCachedOutput() {
  try {
    await fs.access(outputPath);
    return true;
  } catch {
    return false;
  }
}

function startRefreshIfIdle() {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    // Lambda: 別invocationで非同期refresh（inflightCollectには触らない）
    if (asyncInvokePending) return;
    asyncInvokePending = true;
    const client = new LambdaClient({});
    client
      .send(
        new InvokeCommand({
          FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
          InvocationType: "Event",
          Payload: JSON.stringify({ source: "aws.events" })
        })
      )
      .catch((error) => {
        console.error("async invoke failed", error);
      })
      .finally(() => {
        asyncInvokePending = false;
      });
    return;
  }
  // ローカル: プロセス内でバックグラウンド実行
  if (inflightCollect) return;
  inflightCollect = runCollectorOnce()
    .catch((error) => {
      console.error("background refresh failed", error);
    })
    .finally(() => {
      inflightCollect = null;
    });
}

export async function startRefreshInBackground() {
  startRefreshIfIdle();
}

export async function getCachedPayload() {
  let mtime = await fs
    .stat(outputPath)
    .then((s) => s.mtimeMs)
    .catch(() => null);

  // /tmp にキャッシュが無い → S3から復元を試みる
  if (mtime === null) {
    const s3LastModifiedMs = await restoreFromS3(outputPath);
    if (s3LastModifiedMs !== null) {
      // ローカルmtimeではなくS3の実際の更新時刻でstale判定する
      mtime = s3LastModifiedMs;
    }
  }

  // S3にも無ければ従来通り initializing
  if (mtime === null) {
    startRefreshIfIdle();
    return {
      __status: 202,
      ok: true,
      reason: "initializing",
      preparingNext: true,
      message: "initial refresh started; retry after a few seconds"
    };
  }

  const isStale = Date.now() - mtime > staleMs;
  if (isStale) {
    // 60秒超かつ稼働中でなければrefresh起動
    startRefreshIfIdle();
  }

  const parsed = await readCurrentParsed();
  const preparingNext = inflightCollect !== null || asyncInvokePending;

  return {
    __status: 200,
    ok: true,
    source: outputPath,
    refreshed: false,
    reason: preparingNext ? "refreshing_in_background" : "cached_only",
    preparingNext,
    lastCollectAt: new Date(mtime).toISOString(),
    ...parsed
  };
}

export async function refreshPayload() {
  await runCollector();
  const mtime = await fs
    .stat(outputPath)
    .then((s) => s.mtimeMs)
    .catch(() => null);
  const parsed = await readCurrentParsed();
  return {
    __status: 200,
    ok: true,
    source: outputPath,
    refreshed: true,
    reason: "refreshed",
    preparingNext: false,
    lastCollectAt: mtime ? new Date(mtime).toISOString() : null,
    ...parsed
  };
}

export function getConfigSnapshot() {
  return {
    outputPath,
    staleSec
  };
}
