# output.tsv を GET で返す実装メモ

## 追加内容
- `src/tsv-server.mjs` を追加。
- `GET /tsv` で `output.tsv` を読んで JSON 返却する。

## 返却形式
- `ok`: 成功フラグ
- `source`: 読み込んだTSVパス
- `rowCount`: 行数
- `rows`: TSV全行（タブ分割後の2次元配列）

## 補足
- メソッド制限: GET 以外は 405
- パス制限: `/tsv` 以外は 404
- `RISYU_API_ALLOW_RE=false` で「前回実行から60秒以内なら再実行しない」モードになる
- `RISYU_API_ALLOW_RE=true` では毎回再実行する
