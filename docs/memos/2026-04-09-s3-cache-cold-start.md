# Lambda コールドスタート時の "initializing" 問題と S3 キャッシュ対策

## 問題

Lambda がしばらく使われないと AWS が実行環境（コンテナ）をリサイクルする。
その結果 `/tmp/risyu-api/output.tsv` が消失し、次のリクエストで `getCachedPayload()` が
`mtime === null` と判定 → 202 "initializing" を返してしまう。

デプロイ直後だけでなく、**一定時間アクセスが無い場合にも毎回発生する**のが厄介なポイント。

## 原因

- Lambda の `/tmp` はコンテナのライフサイクルに紐づく揮発性ストレージ
- 通常 10〜15 分程度無アクセスだとコンテナが破棄される（AWS の裁量）
- コールドスタート時は `/tmp` が空の状態から始まる

## 対策: S3 永続キャッシュ

`tsv-api-core.mjs` に S3 キャッシュ層を追加した。

### 動作フロー

1. **collector 成功後**: `/tmp` の TSV を S3 (`s3://risyu/cache/output.tsv`) にもアップロード
2. **コールドスタート時**: `/tmp` にキャッシュが無ければ S3 から復元を試みる
3. S3 から復元できれば即座に 200 でデータを返す（古いデータだが無いよりマシ）
4. S3 にも無い場合のみ従来通り 202 "initializing"

### 環境変数

| 変数名 | デフォルト | 説明 |
|---|---|---|
| `RISYU_S3_BUCKET` | Lambda上: `risyu` / ローカル: 空（無効） | S3 バケット名 |
| `RISYU_S3_KEY` | `cache/output.tsv` | S3 オブジェクトキー |

### 必要な IAM 権限

Lambda の実行ロールに以下を追加:

```json
{
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject"],
  "Resource": "arn:aws:s3:::risyu/cache/*"
}
```
