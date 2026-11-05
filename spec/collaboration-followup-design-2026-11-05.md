# 新Pipeline・interactとの協働接続案

2026-11-05提案、2026-11-06更新。利用者が「新方式への共同編集とinteract接続を進める（推奨）」を選択して承認済み。この合意に基づく実装と受入状況は [導入記録](collaboration-integration-2026-11-05.md) を参照する。

## 判明した依存と判断事項

共同作業の既存sessionはUI自由制作と旧Pipeline制作に接続できる。一方、並行する [Pipeline p0-3導入](pipeline-p0-3-integration-2026-11-05.md) は、旧制作画面・再利用ひな形・公開APIを廃止し、元依頼から `request/steps/output` を作る一回の実行へ置き換える。旧制作adapterの復活はこの方針に反する。

[interact本流導入](browser-interact-integration-2026-11-05.md) は、browser domainの既存Queue・実行契約・権限を使う別作業として進行中。通常会話からの利用は初期無効の計画である。共同作業担当が子の非同期操作を起動し、その質問や結果で再開する経路は、既存協働型設計のP3で未実装と明記されている。

このため、今回の協働担当を「新形式の今回の手順を利用者と具体化・編集し、確認後に既存の実行担当へ渡す」役割として接続する案とする。再利用ひな形の公開・旧制作画面は戻さない。

## 接続案

| 層 | 既存機構と追加する最小部分 |
| --- | --- |
| 共同作業の核 | 導入済み0.2.0の4 actionと文脈構築を共用。profile/skill/toolsは登録bundleから与え、語句による担当選択は作らない |
| 新Pipelineの具体化 | 新しいsession bindingを別IDで登録。workspaceは新形式 `request/steps/output` の下書き。既存doc.edit/write/viewと現在版の検査を使う。部品一覧・入力schema・権限と検査結果は既存pipelineの公開catalog/checkから渡す |
| 元依頼と実行 | 元依頼はホスト所有の参照を正本とし、下書きからの上書きは拒否する。下書きの作成・編集だけでは実行しない。既存のimpact・承認と、対象revisionの照合を通して実行担当へ渡す。親実行・各stepの保存・結果採用は新Pipelineに残す |
| interactの道具 | 別作業で確定する公開開始/状態/回答/取消の契約を利用。実ブラウザの低水準操作や部品runner、承認台帳、モデルループを協働担当側へ複製しない。公開・可用性が無効なら道具として提示しない |
| 非同期の質問と結果 | 既存sessionに、ホストが発行した子実行ref・所有会話・元依頼ref・session epochを結び付ける。待ち時間はモデルを保持しない。保存された質問・結果からホスト起点のターンを再開し、利用者の原文に偽装しない。回答先と取消先を同じ子実行に固定する |
| 権限と競合 | 子の受付・回答・結果採用の直前に現在session/epoch/元依頼の有効性を照合。取消・忘却・期限後の遅い結果は採用しない。未確定の送出を再送しない。UI文書とPipeline下書きのwriterは既存domainに残す |
| 利用者への返却 | 既存のArtifact/OpenUI、TODO/notice、sessionの返答・保留・復帰を使う。受付を完了と表示せず、未達・部分結果・承認待ちを保存状態から示す |

公開revisionを上書きせず、新しいbundleとbindingを追加する。実装IDは collaboration.pipeline / collaboration.interact 各revision 1、Queueは collaboration.followup（workRef/childId）、migrationは collaboration/0001-works と dialogue/0035-specialist-observations とした。既存dialogueのsession単位のsource/authority/notify portと、既存agent-runtime/browserの公開操作を接続する。公開契約にない内部schemaや独立runnerへは依存しない。

## 実装順と受入

1. Pipeline/interactの本流側公開契約・版・利用可能条件を固定し、担当別の接続表を更新する。
2. 新Pipeline下書きのsession binding、domainのworkspace操作、正確なschemaと指示を追加する。作成→部分改訂→手編集保持→検査→実行確認→結果返却を固定試験する。
3. P3の子実行refとホスト起点再開を接続。登録した道具の受付→質問→利用者回答→再開→結果、および取消・古い質問/結果・重複通知・再起動を確認する。
4. 所有domainと利用側のローカル検証、対象HTTP結合、Artifact描画・操作、保存設定を使う実モデルを段階別に確認する。検証中は入力を凍結する。

CI・無許可のサーバー操作・別チャットへの送信は行わない。実APIは既存台帳の10USDを維持する。初期無効のinteractを、共同作業の都合だけで本番の通常候補へ有効化しない。

切戻しは新規session/子受付の公開を停止し、進行中の子を取消または確定状態へ照合してから既存UI経路に戻す。旧Pipelineや忘却前のDBを復元して切り戻さない。

## 合意が必要な理由

本流 [AGENTS.md](../AGENTS.md) の「大きな設計や既存の設計方針を変える改修は、必ず先に設計書にまとめ、ユーザーの合意を得てから実装する」と、協働型設計P3の未実装条件に該当する。今回の導入依頼は共同作業coreと既存sessionへの接続を許可するが、並行する新Pipelineの「旧制作撤去」との衝突を無断で解消する根拠にはしない。上記の新方式への共同編集・確認後実行、および非同期の子質問/結果との接続を合意対象とする。

## 合意後の実装範囲

下書き、確認後の正確な版の実行、子の質問・回答・結果による同一session再開、取消・世代・忘却、既存Artifactによる表示を実装した。agent.sharedToolsの一般化、通常候補へのinteract有効化、稼働サーバーでの受入はこの実装の完了扱いに含めない。固定試験・実API・描画・未完了gateを分けた結果は導入記録の表を正本とする。
