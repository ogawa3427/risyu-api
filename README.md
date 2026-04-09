## risyu-api
kurisyushien.org/api

金沢大学の履修登録状況ページをスクレイピングして JSON API として提供する。
いつまで動くかはわからないがEC2時代より安くなるといいな

親プロジェクト ogawa3427/risyu
[ここ](2026-04-09-client-reference-prompt.md)を見るといい感じのフロントエンドの作り方の考え方が書いてあるかも

### セットアップ

```bash
npm install
npx playwright install chromium
```

### 実行

```bash
# 公開ページを1回取得
npm run collect:risyu

# テストURLで1回取得
npm run collect:risyu -- test

# 公開ページを監視ループ（250秒間隔）
npm run collect:risyu -- --watch --interval=250

# Acanthusログイン経由で取得（1回）
KU_ID="your_id" KU_PW="your_password" npm run collect:risyu -- --acanthus
```

主な出力:
- `raw.html`
- `output.tsv`
- `artifacts/*.png`

### TSVをJSONで返すローカルAPI

```bash
# サーバー起動
npm run serve:tsv

# 確認
curl "http://localhost:3000/api"

# データ更新を手動実行
curl -X POST "http://localhost:3000/refresh"
```

#### エンドポイント

| エンドポイント | 動作 |
|---|---|
| `GET /api` | S3/キャッシュから即返却。バックグラウンドでリフレッシュ起動。完全初回のみ `202` |
| `GET /refresh` | スクレイピング要否を判断して実行。前回から1分未満なら何もしない |

### Docker で動かす

```bash
# build
npm run docker:build

# run
docker run --rm -p 3000:3000 risyu-api:local

# 確認
curl "http://localhost:3000/api"
```

### Lambda コンテナ

```bash
# Lambda用イメージをビルド
npm run docker:build:lambda

# ECR ログイン
aws ecr get-login-password --region <region> | \
  docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com

# タグ付け & push
docker tag risyu-api-lambda:local <account-id>.dkr.ecr.<region>.amazonaws.com/risyu-api-lambda:latest
docker push <account-id>.dkr.ecr.<region>.amazonaws.com/risyu-api-lambda:latest
```

#### Lambda 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `RISYU_S3_BUCKET` | ◎ | TSVキャッシュ用S3バケット名 |
| `RISYU_S3_KEY` | - | S3オブジェクトキー（デフォルト: `cache/output.tsv`） |
| `RISYU_STALE_SEC` | - | キャッシュ有効期間秒数（デフォルト: `60`） |
| `KU_ID` | `--acanthus` 時のみ | 金沢大学ID |
| `KU_PW` | `--acanthus` 時のみ | 金沢大学パスワード |
| `RISYU_API_COLLECT_ARGS` | - | コレクタに渡す追加引数 |
| `RISYU_PAGE_TIMEOUT_MS` | - | ページ読み込みタイムアウト（デフォルト: `120000`） |
| `RISYU_SELECTOR_TIMEOUT_MS` | - | セレクター待機タイムアウト（デフォルト: `90000`） |
