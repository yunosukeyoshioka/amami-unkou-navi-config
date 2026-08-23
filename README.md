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
- `mode`: `ferry`（船）/ `air`（航空機）/ `cargo`（貨物船・物資輸送）。アプリ側のアイコン・表示切り替えに使う
  - `cargo`はアプリ側では実装済み（ホーム画面に専用セクションあり）だが、本スクレイパーはまだ`cargo`のエントリを一件も生成していない（現状スキーマの受け皿のみ）
  - 台風などで物資不足になった際に実際に物資を運ぶのは、奄美群島向け貨物専用便を運航する[共同組海運](https://www.kyoudougumikaiun.co.jp/)（「みさきII」「つばさ」）が実例として確認できる。ただし同社の配船予定は月間PDF（カレンダー形式の2次元表）でしか公開されておらず、機械的に正確な座標ベース表構造抽出をしないと誤読のリスクが高いため、安全のため今回は自動スクレイピングを実装していない
  - 将来`cargo`を追加する場合は、`departures[].time`を時刻ではなく「便のある日」程度の粒度にする（同社PDFは日付単位の配船表で、寄港時刻までは公開されていないため）か、他の一次情報源が見つかり次第それを優先すること
- マルエーフェリー・マリックスラインは複数船舶・複数便がある場合、一番状態の悪いものを代表値として採用（安全側に倒す設計）
- 航空便は**JALの公式サイトではなく奄美空港自体の公式サイト**（`amami-airport.co.jp/flight/today`）から取得しています。JALの発着案内はAkamaiのbot対策があり、GitHub Actions・ヘッドレスブラウザのどちらからも`403`でブロックされ取得できませんでした。空港公式サイトはbot対策がなく、しかもJAL/JAC・Peach・スカイマークなど就航する全社の本日の出発便が1つの表に載っているため、より確実で網羅的です。`flights`配列に本日の全便（便名・目的地・定刻・実績時刻・状況）が入ります
- スクレイピング失敗時は前回コミット時点の内容がそのまま残る（壊れたデータで上書きしない）

手動で今すぐ更新したい場合は、GitHubの Actions タブから `Scrape transport status` ワークフローを `workflow_dispatch` で実行してください。

### `downloads/amami_typhoon_navi.apk`（手動更新）

Android版アプリの配布用APK。Google Playを経由せず、このリンクから直接インストール（サイドロード）してもらうための実機ビルドです。

- v0.1.0時点のビルド。署名はFlutterのデフォルト設定のままデバッグ鍵を使用（Play Storeで配布する場合は別途リリース署名鍵の設定が必要）
- 同じURLを更新すれば、複数人が同じリンクから常に最新版をダウンロードできる
- インストールには、Android端末で「提供元不明のアプリ」のインストールを許可する必要がある（Android 8以降はインストール元のアプリ／ブラウザ単位で許可）
- 新しいビルドを配布する際は、このファイルを上書きしてpushするだけでよい（アプリの自動更新機能はないため、既存ユーザーは再度リンクからダウンロードし直す必要がある）

## 公開URL

```
https://yunosukeyoshioka.github.io/amami-unkou-navi-config/affiliate_links.json
https://yunosukeyoshioka.github.io/amami-unkou-navi-config/transport_status.json
https://yunosukeyoshioka.github.io/amami-unkou-navi-config/downloads/amami_typhoon_navi.apk
```

## 運用ルール

- 壊れたJSON・欠けているフィールドがあるエントリはアプリ側で自動的に無視され、アプリ全体は落ちません
- スクレイピング先ページの構造が変わると `transport_status.json` の該当船会社が更新されなくなります。その場合は [scripts/scrape.mjs](scripts/scrape.mjs) のセレクタ調整が必要です
