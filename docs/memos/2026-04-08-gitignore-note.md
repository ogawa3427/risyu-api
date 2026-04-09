# 2026-04-08 gitignore整理メモ

ローカル生成物や機微情報が混ざってコミットされる事故を減らすため、`.gitignore`を補強した。

## 追加した主な ignore 対象

- `rcsvs`
- `output.tsv`
- `raw.html`
- `.env`, `.env.*`（ただし `!.env.example` は追跡）
- `*.pem`, `*.key`
- `*.log` と各種 package manager の debug log
- `.tmp/`, `tmp/`

## 方針

- 開発成果物（ソースやドキュメント）を隠しすぎない
- ローカル実行で生まれるデータ・一時ファイル・秘密情報を優先して除外する
