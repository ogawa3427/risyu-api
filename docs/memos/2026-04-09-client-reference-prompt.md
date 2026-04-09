# クライアントリファレンス実装プロンプト

## APIレスポンス仕様

`GET /api` のレスポンスJSON：

```ts
{
  ok: boolean
  reason: "cached" | "refreshing_in_background" | "initializing"
  preparingNext: boolean          // true = バックグラウンドでスクレイピング中 or 起動済み
  currentCollectStartedAt: string | null  // 進行中スクレイピング開始時刻(ISO8601)。null = まだ起動していない
  lastCollectAt: string           // 前回スクレイピング完了時刻(ISO8601)
  recentRefreshes: Array<{
    startedAt: string
    finishedAt: string
    durationMs: number
    success: boolean
  }>
  rowCount: number
  rows: string[][]                // TSVデータ(行×列)
  message?: string                // preparingNext=true かつ stale の場合のみ
}
```

`rows[0]` = メタデータ行 `[日付文字列, "valid" | "test"]`  
`rows[1]` = ヘッダー行（列名）  
`rows[2...]` = データ行

---

## レスポンス仕様簡解(ここだけ人間が書いた)
- 鯖代節約のためにreqが来てからデータを取りに行きます
- 1分間は同じ内容を返答します(クールダウンだね)
- とはいえ、その1分サイクルの初回を踏むとresがクソ遅くなって不快なので、その間は前回取得したデータが出てきます。
- 前回が5時間前なら5時間前のデータが表示されて、しばらくすると最新に切り替わります。
- それで困る場合は私にお金を払ったり、自分でlambdaを60秒おきにツンツンするといいです。
- kurisyushien.org/api-viewer.html にいい感じの実装と説明を用意しました

## クライアントの要件

### 1. 初回fetch

- 起動時に `/api` をfetchしてデータを表示する。
- `reason === "initializing"` なら「初期化中」表示をして後述のポーリングに移行する。

### 2. 次回更新タイミングの予測

`preparingNext === true` の場合、以下のロジックで**次回データ更新予測時刻**を計算する：

```
avgDurationMs = recentRefreshes
  .filter(r => r.success)
  .slice(0, 5)
  の durationMs の平均（データがなければ 15000ms をデフォルト）

if (currentCollectStartedAt != null) {
  // スクレイピングが既に起動している → 開始時刻 + 平均所要時間
  predictedFinishAt = new Date(currentCollectStartedAt).getTime() + avgDurationMs
} else {
  // stale直後の最初のリクエスト（Lambdaがまだinvokeを処理していない）
  // コールドスタート等の余裕を加算
  predictedFinishAt = Date.now() + avgDurationMs + 3000
}

waitMs = Math.max(predictedFinishAt - Date.now(), 1000)
```

### 3. 自動更新

- `waitMs` 後に `/api` を再fetch する。
- 再fetchしたとき `lastCollectAt` が前回と変わっていたら → データを差し替えて表示を更新する。
- 変わっていなければ（まだ終わっていない）→ 3秒後に再試行（最大10回）。
- `preparingNext === false` になったら自動更新タイマーを停止する。

### 4. 状態表示

UIに以下を表示する：

| 要素 | 内容 |
|---|---|
| データ取得日時 | `rows[0][0]` |
| 更新中インジケーター | `preparingNext === true` の間表示 |
| 予測残り時間 | カウントダウン（秒単位、1秒ごとに更新） |
| 直近更新履歴 | `recentRefreshes` の所要時間一覧 |

---

## 実装上の注意

- fetch失敗時は指数バックオフ（1s → 2s → 4s...、最大30s）でリトライする。
- `lastCollectAt` をローカルに保持しておき、差し替え判定に使う。
- タイマーは複数起動しないよう管理する（前のタイマーをクリアしてから新しいものをセットする）。

---

## `preparingNext` / `currentCollectStartedAt` の読み方

| `preparingNext` | `currentCollectStartedAt` | 意味 |
|---|---|---|
| `false` | `null` | 60秒以内。キャッシュそのまま |
| `true` | `null` | 60秒経過後の最初のリクエスト。Lambdaがinvokeを送った直後でまだスクレイピング未起動 |
| `true` | `"20xx-..."` | スクレイピング実行中 |

---

## バックエンドのステートマシン

クライアントが受け取るレスポンスがどの状態から来ているかを理解するための参考。

### 状態一覧

```
┌─────────────────┐
│   uninitiated   │  S3にもローカルにもTSVなし（初回デプロイ直後）
└────────┬────────┘
         │ /refresh が来る（初回）
         ▼
┌─────────────────┐
│  initializing   │  スクレイピング実行中・TSVはまだない
└────────┬────────┘
         │ スクレイピング成功 → S3にTSV書き込み
         ▼
┌─────────────────┐
│      fresh      │  TSVあり・前回collectから60秒以内
└────────┬────────┘
         │ 60秒経過
         ▼
┌─────────────────┐
│      stale      │  TSVあり・60秒以上経過・次のスクレイピング未着手
└────────┬────────┘
         │ /refresh が来る（stale検知）
         ▼
┌─────────────────┐
│   refreshing    │  古いTSVを返しつつバックグラウンドでスクレイピング中
└────────┬────────┘
         │ スクレイピング成功 → S3のTSV更新
         ▼
       fresh  （失敗した場合はstaleに戻る）
```

### 各状態での `/api` レスポンス

| 状態 | HTTP | `reason` | `preparingNext` | `currentCollectStartedAt` | `rows` |
|---|---|---|---|---|---|
| uninitiated | 202 | `"initializing"` | `true` | `null` | なし |
| initializing | 202 | `"initializing"` | `true` | `null` | なし |
| fresh | 200 | `"cached"` | `false` | `null` | 最新データ |
| stale（最初の1req） | 200 | `"refreshing_in_background"` | `true` | `null` | 古いデータ |
| refreshing | 200 | `"refreshing_in_background"` | `true` | `"20xx-..."` | 古いデータ |

### 状態遷移のトリガー

`/api` は**常にバックグラウンドで `/refresh` を非同期invoke**する。  
`/refresh` 内部でレート制限とロック管理を行い、実際にスクレイピングするかどうかを判断する。

```
/api リクエスト
  └─ 常に triggerBackgroundRefresh() を呼ぶ
       └─ /refresh Lambda を async invoke（fire-and-forget）
            └─ /refresh の判断ロジック:
                 ├─ S3ロックが有効（TTL内）→ skip（多重起動防止）
                 ├─ 前回collectから60秒未満 → skip（too_soon）
                 └─ それ以外 → S3ロック取得 → スクレイピング → S3更新 → ロック解放
```

### ロック（`cache/scraping-lock.json`）の役割

複数のLambdaコンテナが同時に `/refresh` を受けたとき、最初の1つだけがスクレイピングを実行する。  
ロックはスクレイピング完了後に削除される。TTL（デフォルト120秒）以内であれば後続の invoke はすべてスキップする。
