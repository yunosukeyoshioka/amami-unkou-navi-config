# amami-unkou-navi-config

「奄美運航なび」アプリが参照する設定・運航状況データを配信するための静的ホスティング用リポジトリです。GitHub Pagesで公開しています。

## ファイル一覧

### `affiliate_links.json`（手動更新）

「代替手段を探す」セクションのアフィリエイトリンク設定です。編集してpushするだけで、アプリ側のストア再審査なしにリンクの内容（タイトル・URL・遷移先など）を差し替えられます。

- `category` は `hotel` か `flight` のみ対応（アプリ側で未知の値はスキップされます）
- アフィリエイトプログラムの審査が通ったら、`url` を実際のアフィリエイトリンクに差し替えてください

### `transport_status.json`（自動更新）

フェリー各社の公式運航状況ページを [scripts/scrape.mjs](scripts/scrape.mjs) が30分おきに取得し、GitHub Actions（[.github/workflows/scrape.yml](.github/workflows/scrape.yml)）が自動でコミット・pushします。

- `status`: `normal`（通常運行）/ `conditional`（条件付き運行）/ `suspended`（運行見合わせ）/ `cancelled`（欠航）/ `unknown`（取得できず）
- 複数船舶・複数便がある場合は一番状態の悪いものを代表値として採用（安全側に倒す設計）
- JAL/JACは検索フォーム形式で単純な自動取得ができないため、常に `unknown`（公式サイト誘導のみ）
- スクレイピング失敗時は前回コミット時点の内容がそのまま残る（壊れたデータで上書きしない）

手動で今すぐ更新したい場合は、GitHubの Actions タブから `Scrape transport status` ワークフローを `workflow_dispatch` で実行してください。

## 公開URL

```
https://yunosukeyoshioka.github.io/amami-unkou-navi-config/affiliate_links.json
https://yunosukeyoshioka.github.io/amami-unkou-navi-config/transport_status.json
```

## 運用ルール

- 壊れたJSON・欠けているフィールドがあるエントリはアプリ側で自動的に無視され、アプリ全体は落ちません
- スクレイピング先ページの構造が変わると `transport_status.json` の該当船会社が更新されなくなります。その場合は [scripts/scrape.mjs](scripts/scrape.mjs) のセレクタ調整が必要です
