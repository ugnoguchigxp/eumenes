# 画像生成をLARM接続依頼から開始する

## 目的・合意範囲

2026-10-17のユーザー依頼「LARMへの接続依頼からやる形式に変えて」に対応する。画像生成の順序を、catalogでの発見、接続依頼、接続応答のサービス確認、生成、画像取得、接続解放とする。既存の接続確保・待機・解放処理を再利用する。

ツール選択、SystemContext、生成パラメータ、DB、公開API、音楽生成の接続方式は変更しない。生成POSTの自動再送も追加しない。

## 確認した契約

- 実接続先のOpenAPIで、`POST /v1/agent-connections` は公開Profile selectorとcatalog revisionを受け取り、`services` を含む接続を返す。
- `providers` は任意だが、指定時は1件以上であり、サービス選択用のフィールドはない。実接続で、省略するとProfile全体の準備が90回の照会後もpendingのままであることを確認した。同じ画像Profileに既存のLLM接続方式である `providers: ["llm"]` を指定するとreadyになり、応答には画像サービスも返った。この測定に基づき、画像サービス名をProvider名として渡さず、画像サービスを持つProfileのselectorと `providers: ["llm"]` で接続する。音声等のProviderは事前予約しない。
- 接続応答の `services` はcapability、protocol、model、endpointを持ち、urlとdescriptionも返す。画像生成自体はControl認証の同期POSTであり、Providerのclaimは使わない。
- 現行コードはcatalogの画像サービスへ直接POSTしていた。既存のProvider接続処理には接続待機・revision照合・取消後の遅い接続IDの回収・finallyでの解放がある。

## 変更

1. catalogから発見した画像サービスのselectorとrevisionで接続を依頼する。
2. 接続ID、Profile、revision、対象サービスのname・capability・protocol・modelを照合する。画像サービスは生成POSTで起動するため、Providerのreadyを待たない。接続のpending・probing・ready応答からサービスを取得して使う。failed・expired・releasedは拒否する。Providerを実行する既存経路だけは従来どおりready・claimableを待つ。
3. 接続応答のdescriptionが空でないことを確認し、同じ応答のurlを優先、なければendpointをControl接続先に解決する。既存の同一origin検証を適用する。
4. 返されたサービスへ生成POSTを一度だけ送り、成果物を取得する。取消・失敗時も取得済み接続IDを解放する。接続失敗時には生成を呼ばない。
5. Profile名・モデル名を固定しない。既存Provider接続と音楽生成の振る舞いを維持する。

## 検証・完了条件

- 部分試験で接続→画像サービス確認→生成→画像取得→解放の順、接続応答URLの採用、失敗・取消時の解放、生成の未再送を確認する。異なるrevisionやサービス契約では生成しない。
- `bun run verify -- --domain larm --domain image --domain music` と、画像・音楽のapplication結合試験を実行する。
- 保存済み接続設定を読み、実LARMで接続依頼から画像取得まで実行して寸法・形式と解放を確認する。Eumenesサーバーを起動・停止・再起動する検証は行わない。ブラウザ検証はUI変更がないため省略する。
- 差分を点検し、依頼外の意味判断や優先順位を追加していないことを確認する。他作業中のMusicPlayer変更は編集しない。

## 初回の確認結果（09時台）

- 固定試験: larm・image・musicの188件、Webの39件が成功。接続変更後の部分・画像/音楽のapplication結合試験55件も成功（件数は重複を含む）。format・lint・DesignSystemの型検査とbuildも成功。
- 実LARM: `providers: ["llm"]` の接続依頼がHTTP201・readyとなり、生成POST1回で512×384 PNG、279,925 bytesを取得・デコードした。画像取得後の接続解放はHTTP204。全体約11.8秒。画像と記録は `verification-reports/image-connection-2026-10-17/`。
- 通し確認: 既存の `scripts/image-live.ts --run` は画像POST前の会話モデル接続で120秒後に `local_timeout`、`cloud_fallback_unconfigured` となった。会話経由の実モデル通し成功は未確認。画像の実生成成功とは区別する。
- 全体verify: 今回未変更の `api/domains/larm/service/index.ts#createLarm` のサイズ制限（346→349）で停止。残る検査を個別実行したところ、今回未変更の `api/domains/larm/test/catalog-selectors.test.ts:70` に `string` と `TestKind` の型不一致1件が残った。両ファイルは着手前commitと同一であり、この依頼では変更しない。
- サーバーの起動・停止・再起動およびブラウザE2Eは行っていない。最終差分には意味判断・ツールの優先順位変更を含まない。


## 13時台の障害の再調査・修正方針

- 実環境では13:53:11に画像生成のjobが開始し、13:54:35に次の音声発話が会話runとして受理された。13:54:36に既存の音声割込みから前のturnのcancel APIが呼ばれ、画像制作がcancelledになった。音声取消の仕様は変更しない。
- 同じ実モデルの担当選択・計画を含む隔離実行で、画像用接続がpending、phase=waiting-capacity、llm=waitingのまま生成POST0回で失敗することを再現した。
- この状態でも応答には画像サービスのURLと「POSTで起動し、画像保存後に停止」のdescriptionがあった。別の所有接続で同じpending / waiting-capacityを確認した直後、その応答の画像サービスへ一度だけPOSTするとHTTP200、512×384 PNG、275,101 bytesを取得でき、解放もHTTP204だった。
- 前の修正でProviderのready条件を画像サービスにも適用したことが誤りだった。画像サービスは接続応答のサービス契約を検証して生成POSTで起動する。Providerのready待ちはProvider経路だけに残す。新たな再試行・代替経路・語句判断は追加しない。
- pending・probing・readyで生成できること、失敗・失効状態と不正なサービスでは生成しないことを固定試験で確認し、実モデルの担当選択→計画→画像生成→取得→回答を通して確認する。サーバーは操作しない。

## 再修正後の確認結果（14:00）

- 固定試験はlarm・image・musicと画像削除・画像/音楽のapplication結合試験を合わせて213件成功。Provider待機を残したまま、画像サービスのpending・probing・readyからの生成、失敗・失効・解放の拒否、取消・解放・未再送を確認した。format・lint・SystemContext検査も成功。
- 実モデルの担当選択→制作計画→接続依頼HTTP202→画像生成POST1回・HTTP200→画像取得→接続解放HTTP204→完了回答を通して成功。受付から約30.5秒で会話runと画像がcompleted。512×384 PNG、263,678 bytesを取得し、画像decoderで形式・寸法を確認した。LARM一覧の取得もHTTP200だった。
- runIdは `976eadb4-8eb4-4d35-a102-60fd7de439a5`。記録と画像は `verification-reports/image-toolchain/2026-10-17T04-59-45.935Z/`。修正前の実モデル通し失敗では画像POST0回、修正後は1回で完了した。
- 全体verifyは前記の未変更ファイルのサイズ制限で停止。選択型検査も前記の未変更試験の型不一致1件が残る。これらを検証成功とは扱わない。サーバーは起動・停止・再起動していない。
