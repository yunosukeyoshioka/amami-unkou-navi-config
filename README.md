# amami-unkou-navi-config

「奄美運航なび」アプリの代替手段（アフィリエイトリンク）設定を配信するための静的ホスティング用リポジトリです。

`affiliate_links.json` を編集して push するだけで、アプリ側のストア再審査なしにリンクの内容（タイトル・URL・遷移先など）を差し替えられます。

## 公開URL

GitHub Pagesで公開後:

```
https://<GitHubユーザー名>.github.io/amami-unkou-navi-config/affiliate_links.json
```

## 運用ルール

- `category` は `hotel` か `flight` のみ対応（アプリ側で未知の値はスキップされます）
- 壊れたJSON・欠けているフィールドがあるエントリはアプリ側で自動的に無視され、アプリ全体は落ちません
- アフィリエイトプログラムの審査が通ったら、`url` を実際のアフィリエイトリンクに差し替えてください
