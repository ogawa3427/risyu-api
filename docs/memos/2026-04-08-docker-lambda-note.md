# Docker/Lambda 化メモ

## 追加ファイル
- `Dockerfile`: ローカルAPI実行用
- `Dockerfile.lambda`: Lambda コンテナイメージ用
- `src/lambda-handler.mjs`: Lambdaハンドラ
- `src/tsv-api-core.mjs`: HTTP/Lambda共通ロジック

## 方針
- 収集処理は既存の `src/risyu-migrated.mjs` を再利用。
- Lambdaでは `/api`（キャッシュ返却）と `/refresh`（更新実行）を分離。
- `/refresh` は EventBridge の定期実行で叩く想定。

## Lambda運用の注意
- Chromium を含むためイメージサイズは重め。
- 同時実行を上げると負荷が急増する。
- Lambda実行時の書き込み先は`/var/task`ではなく`/tmp`を使う（本実装は`/tmp/risyu-api`へ切替済み）。
