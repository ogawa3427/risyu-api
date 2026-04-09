# CloudWatch 構造化ログ設計メモ

## 概要

`tsv-api-core.mjs` と `lambda-handler.mjs` に JSON 1行形式のログを追加した。
CloudWatch Logs Insights でそのまま `fields` / `filter` / `stats` クエリが使える。

## ログフォーマット

```json
{"time":"2026-04-09T12:00:00.000Z","level":"INFO","event":"refresh_decision","fn":"risyu-api","decision":"skip","reason":"too_soon","elapsedSec":30,"nextRefreshInSec":30}
```

| フィールド | 意味 |
|---|---|
| `time` | ISO 8601 タイムスタンプ |
| `level` | INFO / WARN / ERROR |
| `event` | ログの種別（下記一覧） |
| `fn` | Lambda関数名（ローカルは "local"） |

## event 一覧

| event | 出力タイミング |
|---|---|
| `request_received` | ハンドラー受付時 |
| `request_done` | レスポンス返却時（statusCode, reason, elapsedMs 付き） |
| `request_rejected` | 405/404 時 |
| `request_error` | 500 エラー時 |
| `api_response` | `/api` の判断結果（tmpHit, s3Hit, isStale, rowCount など） |
| `refresh_decision` | `/refresh` がスクレイピングするかどうかの判断（decision: scrape/skip） |
| `refresh_done` | `/refresh` 完了時 |
| `s3_head` | S3 HeadObject の結果（found / not_found / error） |
| `s3_restore` | S3 からのファイル復元結果 |
| `s3_upload` | S3 へのアップロード結果 |
| `background_refresh` | バックグラウンドrefresh起動状況 |
| `collector_start` | risyu-migrated.mjs 子プロセス起動 |
| `collector_done` | 子プロセス正常終了（elapsedMs 付き） |
| `collector_wait` | 多重起動を抑制してinflight待機 |

## Logs Insights クエリ例

```
# /refresh の判断一覧
fields @timestamp, decision, reason, elapsedSec, nextRefreshInSec, lastCollectAt
| filter event = "refresh_decision"
| sort @timestamp desc
| limit 50
```

```
# /api のキャッシュ状況
fields @timestamp, decision, tmpHit, s3Hit, isStale, elapsedSinceCollectSec, rowCount
| filter event = "api_response"
| sort @timestamp desc
| limit 50
```

```
# エラーのみ
fields @timestamp, event, errorMessage, path
| filter level = "ERROR"
| sort @timestamp desc
```

```
# スクレイピング所要時間の統計
stats avg(elapsedMs), max(elapsedMs), count() by bin(5m)
| filter event = "collector_done"
```

```
# リクエスト全体のレスポンスタイム
fields @timestamp, path, statusCode, reason, elapsedMs
| filter event = "request_done"
| sort @timestamp desc
```
