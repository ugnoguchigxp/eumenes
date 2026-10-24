# LARM改修後の受入前確認

2026-10-24。状態: **本番の新版反映を確認できず、新版の受入は保留**。

追記: その後、新版の反映を確認して再検証した。[新版での検証結果](larm-revalidation-retry-2026-10-24.md)を参照。以下は切替前の記録として保持する。

利用者から改修完了の連絡を受け、保存済みLARM接続をsettings domainの読取り専用操作で取得して確認した。製品サーバー・LARM・Providerの停止・起動・再起動、設定変更、他consumerの接続解放、別チャットへの送信は行っていない。

## 配備の確認

検証先の`GET /health`はHTTP 200、status=okだが、以下の旧版を返した。

- releaseCommit: `bc74d0bc90cbaae9bd3e0ac0b9a414f79c2c8864`
- bootEpoch: `epoch-57d28afd-d0af-4c43-b136-23716279e80c`
- configRevision: `e1dfdbf6bd5ddf632f04c2ca56c7385b8dd47ee153dcbca49253e4855f13934c`

関連チャット「修正 LARM の KV prefix 再利用」を読み取り専用で確認したところ、本番反映作業は進行中だった。利用中の接続・生成処理がなくなるのを待つ方針が示され、その後の本番用ビルド（対象`3d25912a7c0b9f20898a8e8f7fae5e0886bfbcf1`）にはexit 1が記録されていた。LARM側で修復作業を継続中であり、こちらから指示やメッセージは送っていない。

このため、以下は**切替前の観測**であり、LARM改修版の合否や改善量として扱わない。検証用接続はfinallyで解放済み。切替を妨げないよう追加の推論は停止した。

## 切替前の観測

`scripts/response-decision/visibility.ts`を保存済み接続へ実行した。資料・回答本文は保存せず、読取り成否・role・文字数・正式計数を記録した。

| 同じ8,421文字の合成資料の位置 | 正式入力token数 | 値の読取り |
| --- | ---: | --- |
| 先頭systemに統合 | 4,279 | 成功 |
| 会話履歴の後ろのsystem | 66 | 失敗 |
| 先頭に連続する2個目のsystem | 4,279 | 成功 |
| 先頭に連続する3個のsystemの2個目 | 4,279 | 成功 |
| 会話履歴の後ろのuser | 4,283 | 成功 |

4/5成功、runnerの終了コードは1。後方systemは実送信JSONには存在するが、正式計数と読取りでは欠落する。以前の互換性問題は、この稼働版では再現する。

`scripts/response-decision/cache.ts`も通常のS/P/H/W/V/R配置で実行した。推定約14,000 tokenに対し、正式入力は2,682 tokenだった。即時再送と補助4件後はともにcache 2,678 token、prefillはそれぞれ27.895 ms・27.799 ms（初回3,257.427 ms）。これは短い入力での再利用であり、約14,000正式tokenの保持受入としては無効。背景の追加も正式計数に反映されなかった。

9要求中、auxiliary_3が`chat_stream_incomplete`で失敗した。残り8要求は成功。試験の出力上限は128 tokensであり、原因や新版への影響は未判定とする。bootEpoch/configRevisionは全要求で同じ旧版だった。

記録: `verification-reports/larm-revalidation-2026-10-24/`（git対象外）の`health-before.json`、`visibility/`、`cache-product-layout/`、`manifest.json`。前回の修正を含むEumenes commitは`0fa17b5b`。既存のTODO Artifact等の作業差分には手を加えていない。

## 再開条件と残作業

1. 配備担当の反映完了と、保存済み接続先のhealthが返すreleaseCommitの一致を確認する。以後のbootEpoch/configRevisionを固定して記録する。
2. 同じvisibility試験を再実行する。キャッシュ保持とrole互換性を別々に判定する。
3. 通常配置のcache試験に加え、全資料が先頭systemに入る合成2メッセージの対照試験を行う。正式計数で約14,000 tokenへ校正し、同一再送、user差分、背景更新、補助4件後を確認する。対照試験の成功を通常配置の修正と扱わない。対照runnerは同記録ディレクトリの`visible-cache.ts`に準備し、構文確認だけ実施した。
4. 受け付ける入力と配備revisionを確定してからR1の品質・時間比較を行う。通常動作への採用やlive速度改善は今回まだ判定していない。

今回の停止理由は測定の遅さではなく、受入対象の本番配備が未確認であること。旧版への再試行や、未反映のままの品質比較は行わない。
