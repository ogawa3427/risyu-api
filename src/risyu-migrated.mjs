import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// ============================================================
// ターゲットURL設定
// ============================================================

// SSO ログイン必要（--acanthus モード用）
const REGIST_BASE_URL_SSO =
  "https://eduweb.sta.kanazawa-u.ac.jp/Portal/StudentApp/Regist/RegistrationStatus.aspx";

// ログイン不要の公開ページ（デフォルト）
const REGIST_BASE_URL_PUBLIC =
  "https://eduweb.sta.kanazawa-u.ac.jp/portal/Public/Regist/RegistrationStatus.aspx";

// 年度開始: 3/28
const ACADEMIC_YEAR_START_MMDD = 328;

// 学期コード (月日の大きい順に並べる)
// mmdd >= の値から判定し、最初にマッチしたものを使用
// 1/1-3/27 は前年度のQ22 (最後のfallback)
const TERM_BOUNDARIES = [
  { mmdd: 1201, termCd: "22" }, // 12/1 ~
  { mmdd: 924,  termCd: "21" }, //  9/24 ~
  { mmdd: 603,  termCd: "12" }, //  6/3 ~
  { mmdd: 328,  termCd: "11" }, //  3/28 ~
];

function getAcademicTarget(useSSO = false) {
  const now = new Date();
  const year = now.getFullYear();
  const mmdd = (now.getMonth() + 1) * 100 + now.getDate();

  const academicYear = mmdd >= ACADEMIC_YEAR_START_MMDD ? year : year - 1;
  const term = TERM_BOUNDARIES.find((b) => mmdd >= b.mmdd);
  const termCd = term ? term.termCd : "22"; // 1/1-3/27 は前年度のQ22

  const base = useSSO ? REGIST_BASE_URL_SSO : REGIST_BASE_URL_PUBLIC;
  return `${base}?year=${academicYear}&lct_term_cd=${termCd}`;
}

const TEST_TARGET = "https://ogawa3427.github.io/risyu-error_page/dummy.html";

const args = new Set(process.argv.slice(2));
const isTest = args.has("test");
const useAcanthus = args.has("--acanthus");
const watchMode = args.has("--watch");
const intervalSec = Number.parseInt(
  process.argv.find((arg) => arg.startsWith("--interval="))?.split("=")[1] ?? "250",
  10
);
const isLambdaEnv = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const acanthusIterations = Number.parseInt(
  process.argv.find((arg) => arg.startsWith("--iterations="))?.split("=")[1]
    ?? (isLambdaEnv ? "1" : "72"),
  10
);
const workDir = process.env.RISYU_WORK_DIR
  ? path.resolve(process.env.RISYU_WORK_DIR)
  : process.env.AWS_LAMBDA_FUNCTION_NAME
    ? "/tmp/risyu-api"
    : process.cwd();

const target = isTest ? TEST_TARGET : getAcademicTarget(useAcanthus);
const isLambda = isLambdaEnv;
const pageTimeoutMs = Number.parseInt(process.env.RISYU_PAGE_TIMEOUT_MS ?? "120000", 10);
const selectorTimeoutMs = Number.parseInt(process.env.RISYU_SELECTOR_TIMEOUT_MS ?? "90000", 10);

function logStep(step, extra = "") {
  const ts = new Date().toISOString();
  if (extra) {
    console.log(`[risyu:${ts}] ${step} | ${extra}`);
    return;
  }
  console.log(`[risyu:${ts}] ${step}`);
}

function browserLaunchOptions() {
  if (isLambda) {
    return {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--single-process",
        "--no-zygote"
      ]
    };
  }
  return { headless: true };
}

async function ensureDirs() {
  await fs.mkdir(path.resolve("artifacts"), { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safePageContent(page, retries = 5) {
  let lastError;
  for (let i = 0; i < retries; i += 1) {
    try {
      return await page.content();
    } catch (error) {
      lastError = error;
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
      await sleep(300);
    }
  }
  throw lastError;
}

function formatDateKey(dateText) {
  const [d, t] = dateText.split(" ");
  if (!d || !t) return "";
  return `${d.replaceAll("/", "")}${t.replaceAll(":", "")}`;
}

async function writeTsv(rows, filePath) {
  const content = rows.map((row) => row.join("\t")).join("\n");
  await fs.writeFile(filePath, `${content}\n`, "utf8");
}

async function extractRegistrationTable(page) {
  logStep("extract:start");
  logStep("extract:wait_selector:start", "#ctl00_phContents_ucRegistrationStatus_ddlLns_ddl");
  await page.waitForSelector("#ctl00_phContents_ucRegistrationStatus_ddlLns_ddl", {
    timeout: selectorTimeoutMs
  });
  logStep("extract:wait_selector:done");
  logStep("extract:select_option:start", "value=0");
  await page.selectOption("#ctl00_phContents_ucRegistrationStatus_ddlLns_ddl", "0");
  logStep("extract:select_option:done");
  await page.waitForLoadState("networkidle", { timeout: selectorTimeoutMs }).catch(() => undefined);
  logStep("extract:networkidle:done_or_skipped");

  const html = await safePageContent(page);
  await fs.writeFile("raw.html", html, "utf8");
  logStep("extract:raw_saved", "raw.html");

  let dateText = "";
  const dateLocator = page.locator("#ctl00_phContents_ucRegistrationStatus_lblDate").first();
  if ((await dateLocator.count()) > 0) {
    const value = await dateLocator.textContent();
    dateText = (value ?? "").trim();
  } else {
    const now = new Date();
    const yyyy = `${now.getFullYear()}`;
    const mm = `${now.getMonth() + 1}`.padStart(2, "0");
    const dd = `${now.getDate()}`.padStart(2, "0");
    const hh = `${now.getHours()}`.padStart(2, "0");
    const mi = `${now.getMinutes()}`.padStart(2, "0");
    const ss = `${now.getSeconds()}`.padStart(2, "0");
    dateText = `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
  }

  const headerLocator = page.locator("#ctl00_phContents_ucRegistrationStatus_gv tr th");
  const rowLocator = page.locator("#ctl00_phContents_ucRegistrationStatus_gv tr");

  let headers = [];
  let rows = [];

  if ((await headerLocator.count()) > 0) {
    headers = await page.$$eval("#ctl00_phContents_ucRegistrationStatus_gv tr th", (elements) =>
      elements.map((el) => (el.textContent ?? "").trim().replace(/\s+/g, " "))
    );
  }

  if ((await rowLocator.count()) > 1) {
    rows = await page.$$eval("#ctl00_phContents_ucRegistrationStatus_gv tr", (trs) => {
      return trs.slice(1).map((tr) => {
        return Array.from(tr.querySelectorAll("td")).map((td) => {
          const text = (td.textContent ?? "").trim();
          return text.replace(/\s+/g, " ");
        });
      });
    });
  }

  logStep("extract:done", `headers=${headers.length}, rows=${rows.length}`);
  return { dateText: dateText.trim(), headers, rows };
}

async function persistOutputs(dateText, headers, rows) {
  logStep("persist:start");

  if (headers.length === 0 && rows.length === 0) {
    throw new Error("テーブルデータが空です（headers・rows ともに 0 件）。ページが正常に取得できていない可能性があります。");
  }

  const state = isTest ? "test" : "valid";
  const metadata = [dateText, state];
  const allRows = [metadata, headers, ...rows];
  const filteredRows = allRows.filter(
    (row) => row.some((cell) => (cell ?? "").trim() !== "") || row[0] === "\"\""
  );

  await writeTsv(filteredRows, "output.tsv");
  logStep("persist:output_saved", `rows=${filteredRows.length}`);

  const dateKey = formatDateKey(dateText);
  if (!dateKey) {
    throw new Error(`日付形式が想定外: ${dateText}`);
  }
  logStep("persist:done", `dateKey=${dateKey}`);
}

async function runPublicCollection() {
  logStep("public:start", `target=${target}`);
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const page = await browser.newPage();
    logStep("public:goto:start");
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: pageTimeoutMs });
    logStep("public:goto:done");
    await page.screenshot({ path: "artifacts/screenshot.png", fullPage: true });
    logStep("public:screenshot_saved", "artifacts/screenshot.png");

    const { dateText, headers, rows } = await extractRegistrationTable(page);
    await page.screenshot({ path: "artifacts/screenshot2.png", fullPage: true });
    logStep("public:screenshot_saved", "artifacts/screenshot2.png");
    await persistOutputs(dateText, headers, rows);
    logStep("public:done");
  } finally {
    await browser.close();
    logStep("public:browser_closed");
  }
}

async function clickMaybe(page, selectorOrText) {
  const locator =
    selectorOrText.startsWith("//") || selectorOrText.startsWith("xpath=")
      ? page.locator(selectorOrText.startsWith("xpath=") ? selectorOrText : `xpath=${selectorOrText}`)
      : page.locator(selectorOrText);
  if ((await locator.count()) === 0) return false;
  await locator.first().click();
  return true;
}

async function runAcanthusCollection() {
  const kuId = process.env.KU_ID;
  const kuPw = process.env.KU_PW;
  if (!kuId || !kuPw) {
    throw new Error("KU_ID と KU_PW を環境変数で設定しろ");
  }

  logStep("acanthus:start", `target=${target}`);
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const page = await browser.newPage();

    // SSO ログイン
    logStep("acanthus:sso:goto:start");
    await page.goto("https://acanthus.cis.kanazawa-u.ac.jp/?lan=j", {
      waitUntil: "domcontentloaded",
      timeout: pageTimeoutMs
    });
    logStep("acanthus:sso:goto:done");

    await clickMaybe(page, "a:has-text('ログイン')");
    await page.waitForTimeout(800);
    await page.screenshot({ path: "artifacts/sso1.png", fullPage: true });
    logStep("acanthus:sso:screenshot_saved", "artifacts/sso1.png");

    await page.fill("#kuid", kuId);
    await page.fill("#password", kuPw);
    logStep("acanthus:sso:fill:done");
    await page.screenshot({ path: "artifacts/sso2.png", fullPage: true });

    logStep("acanthus:sso:submit:start");
    await page.click("[name='_eventId_proceed']");
    await page.waitForLoadState("domcontentloaded", { timeout: pageTimeoutMs });
    logStep("acanthus:sso:submit:done", `url=${page.url()}`);
    await page.screenshot({ path: "artifacts/sso3.png", fullPage: true });

    // SSO 完了後、目的 URL に直接 goto
    logStep("acanthus:target:goto:start", `url=${target}`);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: pageTimeoutMs });
    logStep("acanthus:target:goto:done", `url=${page.url()}`);
    await page.screenshot({ path: "artifacts/sso4.png", fullPage: true });

    const { dateText, headers, rows } = await extractRegistrationTable(page);
    await page.screenshot({ path: "artifacts/sso5.png", fullPage: true });
    await persistOutputs(dateText, headers, rows);
    logStep("acanthus:done");
  } finally {
    await browser.close();
    logStep("acanthus:browser_closed");
  }
}

async function main() {
  await fs.mkdir(workDir, { recursive: true });
  process.chdir(workDir);
  await ensureDirs();

  if (useAcanthus) {
    do {
      try {
        await runAcanthusCollection();
        console.log("acanthus mode success");
      } catch (error) {
        console.error("acanthus mode error", error);
        if (!watchMode) {
          throw error;
        }
      }
      if (!watchMode) break;
      await sleep(5000);
    } while (true);
    return;
  }

  do {
    try {
      await runPublicCollection();
      console.log("public mode success");
    } catch (error) {
      console.error("public mode error", error);
      if (!watchMode) {
        throw error;
      }
    }
    if (!watchMode) break;
    await sleep(Math.max(1000, intervalSec * 1000));
  } while (true);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
