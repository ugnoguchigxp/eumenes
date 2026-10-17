# 画像生成をLARM接続依頼から開始する

## 目的・合意範囲

2026-10-17のユーザー依頼「LARMへの接続依頼からやる形式に変えて」に対応する。画像生成の順序を、catalogでの発見、接続依頼、接続応答のサービス確認、生成、画像取得、接続解放とする。既存の接続確保・待機・解放処理を再利用する。

ツール選択、SystemContext、生成パラメータ、DB、公開API、音楽生成の接続方式は変更しない。生成POSTの自動再送も追加しない。

## 確認した契約

- 実接続先のOpenAPIで、`POST /v1/agent-connections` は公開Profile selectorとcatalog revisionを受け取り、`services` を含む接続を返す。
- `providers` は任意だが、指定時は1件以上であり、サービス選択用のフィールドはない。画像サービス名をProvider名として渡さず、画像サービスを持つProfileのselectorを指定して `providers` を省略する。この契約ではProfileのProvider全体も接続対象となる。
- 接続応答の `services` はcapability、protocol、model、endpointを持ち、urlとdescriptionも返す。画像生成自体はControl認証の同期POSTであり、Providerのclaimは使わない。
- 現行コードはcatalogの画像サービスへ直接POSTしていた。既存のProvider接続処理には接続待機・revision照合・取消後の遅い接続IDの回収・finallyでの解放がある。

## 変更

1. catalogから発見した画像サービスのselectorとrevisionで接続を依頼する。
2. 接続ID、Profile、revision、対象サービスのname・capability・protocol・modelを照合する。接続がreadyになるまで既存の上限内で待機する。
3. 接続応答のdescriptionが空でないことを確認し、同じ応答のurlを優先、なければendpointをControl接続先に解決する。既存の同一origin検証を適用する。
4. 返されたサービスへ生成POSTを一度だけ送り、成果物を取得する。取消・失敗時も取得済み接続IDを解放する。接続失敗時には生成を呼ばない。
5. Profile名・モデル名を固定しない。既存Provider接続と音楽生成の振る舞いを維持する。

## 検証・完了条件

- 部分試験で接続→ready待機→生成→画像取得→解放の順、接続応答URLの採用、失敗・取消時の解放、生成の未再送を確認する。異なるrevisionやサービス契約では生成しない。
- `bun run verify -- --domain larm --domain image --domain music` と、画像・音楽のapplication結合試験を実行する。
- 保存済み接続設定を読み、実LARMで接続依頼から画像取得まで実行して寸法・形式と解放を確認する。Eumenesサーバーを起動・停止・再起動する検証は行わない。ブラウザ検証はUI変更がないため省略する。
- 差分を点検し、依頼外の意味判断や優先順位を追加していないことを確認する。他作業中のMusicPlayer変更は編集しない。
