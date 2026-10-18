# 監視銀河採用版のSpatialへの置換

2026-10-18。利用者依頼: 採用済みの14モデルをEumenesのSpatialへ適用し、実測状態と実際のアニメーションで稼働させる。

## 範囲と再利用

- 既存のSpatialModel/SpatialItem、単一Scene・RAF・解放、useMonitoringItems、設定の共通下書きと登録adapterを使う。別Canvas、別取得経路、監視規則の変更はしない。
- 監視銀河source commit 2faaae57be7e9d78f74a0b9e2a4cba5538a0c153の14点群・光の評価器・段階拡散・表示式を移植する。点群33,460点、初期350%、上限500%。全景40%原型＋6群、近接60%＋4群。拡散操作でカメラ倍率は変えない。
- モデル内の座標・大きさ・自転は固定し、光の位相だけを進める。公転はSceneの配置として独立。health単色、活動の輝度上乗せ10%以内、速度1.15倍上限。unknown/disconnected/stale/reducedは時間変化を停止。
- backendモデルは既存APIのshape=networkへ接続する互換変換をWebの取得境界に置く。APIと監視判定は変更しない。外部連携/LARM4体は観測値がないのでunconfirmedで表示。言語・画像・楽曲サービス自体の機能やAPIは削除しない。
- 設定は新しいsettings.display revisionを追記し、500%・350%と現在の動きの説明を公開する。旧revisionを変更しない。旧自転の保存項目は互換性のため受理するが、新表示では使わない。既存の保存値はAPI経由でのみ更新する。

## 作業順と完了条件

1. 資産・registry・評価器と表示shaderを置換。既存の停止/解放/失敗表示を維持。
2. カメラの原型基準フレーム、14体の配置、監視snapshotの互換接続を変更。初期値と保存契約・表示revisionを揃える。
3. 部分試験: 14資産hash/点数、状態別発光/停止/固定座標、10%群、倍率固定、実測snapshot接続。
4. 結合: background/monitoring/settings/capabilitiesと利用側の選択verify、設定版の旧seed互換、Web build。対象外の既存失敗は証拠を報告し修正しない。
5. 通し: 許可されたfixtureサーバーでSpatial browser試験、実稼働API読取と画面確認。サーバーの停止/起動/再起動はAGENTSの明示許可条件に従う。

新しいLLM担当や意味分類、LARM計測API、外部連携のhealth判定、DB直接変更は対象外。既存の未コミット物体認識関連変更には触れない。切戻しは本作業の描画・資産・設定新版を戻し、旧登録版を保持する。

## 残作業

実装、サーバーを使わない最終チェック、Web build、差分点検を完了。ユーザーはサーバー操作を自分で行う方針を選択し、途中で再起動して実画面を確認済み。明るさ不足の指摘を受け、色空間変換と静的表示光量1.5倍を追加した。最新の明るさの実画面確認は、ユーザーによるWeb再起動後に残る。サーバー起動を伴うbrowser fixtureと、開発サーバーとDS buildを共有する通常verifyは実行していない。

## 検証記録

- Vitest 8ファイル24試験成功。14資産のhash、状態別の光・停止、10%群の拡散、拡散倍率によらないカメラ、既存Sceneの解放、実測項目との接続、設定画面から500%を保存する共通経路を確認。
- API側のSpatial契約・設定版移行2試験成功。既存9版の内容を維持し、10版の反復登録が同一状態になることを確認。bundle check成功。公開済み7〜9版の差分なし。
- 型チェック成功（2,029ファイル）、対象のlint・format成功、diff check成功。Vite Web build成功。起動中の開発サーバーと共有するDesign Systemの再ビルドは行っていない。
- 実稼働APIの読み取り成功。背景設定spatial、登録版settings.display@10、既存監視snapshotの応答を確認。外部連携とLARM4体に実測値を補完していない。
- broader workers-ai-settings試験の既存AI-connections旧版移行ケースでinvalid_capability_bundleを観測。Spatial対象ケースは成功。担当外の登録データ・期待値は変更していない。
- 最終差分を点検。既存LLMの意味判断・監視health判定への専用分岐は追加していない。APIの既存shape=networkと採用モデルbackendの接続はWeb取得境界の互換変換に限定。並行作業中の物体認識・対話・音声関連差分は本作業で修正していない。
