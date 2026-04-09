# Selenium移植メモ（Playwright版）

## 目的
- Python + Seleniumで実装されていた履修監視処理を、Node.js + Playwrightへ移植。

## 実装上の差分
- Seleniumの`Select`はPlaywrightの`selectOption`で置換。
- BeautifulSoupでのHTML解析は、ページDOMから直接ヘッダーと行データを抽出して置換。
- ウィンドウ切替は`context.waitForEvent("page")`でポップアップ捕捉して置換。

## 出力仕様
- `output.tsv`（メタデータ + ヘッダー + 本文）

## 注意点
- Acanthus側の文言やDOMが変わるとリンク選択が壊れる。
- 監視ループは`--watch`を明示しない限り単発実行にしてある。
