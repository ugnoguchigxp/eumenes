# dotsへの作業委任：追加サーバーを置かない構成

更新: 2026-10-25。利用者の最新指示により、常設relay・結果受取箱の配備を前提とした旧計画は撤回した。[削除の範囲と記録](dots-no-relay-cleanup-2026-10-25.md)を現行方針とする。[D0〜D2の以前の実装記録](verification/dots-permanent-delegation-design-2026-10-25/implementation-d0-d2.md)と生成した画面案は、その時点の履歴である。

## 利用する流れ

1. このPCでEumenesが動いている間に、既存の認証・Events MCPでdotsへ依頼を渡す。依頼保存・通知受付・dotsによる受領・実作業開始を分けて確認する。
2. 受領した仕事は、dotsが許可された環境と元の作業期限の範囲で進める。PC停止中に使えないローカルのファイルやアプリを使えるとは扱わない。追加の受付サーバーは要求しない。
3. dotsの進行・結果・要約をChatGPTの会話に残す。Eumenesが動いている間の報告は既存MCPへ返し、元会話と仕事画面に表示する。
4. Eumenes停止中の結果はChatGPTで確認する。Eumenesへ後で要約を戻す方式は別途確認する。チャット全履歴の取得や起動時の自動回収を実装済みとは表示しない。

PC停止を、新規依頼の送信済み・結果受領・取消の証明にしない。停止中のPCへMCPで書けないことを理由に、受領済みの仕事や子Sessionを作り直さない。後から報告するときも現行の権限・期限・取消検査を通す。

[公式MCP Events](https://developers.openai.com/plugins/build/mcp-events)では、サーバーの通知をChatGPTが非同期に処理し、HTTP 2xxは通知受信の確認を表す。これを仕事の実行・完了の証拠として使わない。

## 維持する構成

- 会話LLMが登録catalogから担当を選び、標準commandサブエージェントが原文・訂正・目的・完了条件を保持して一操作を返す。不足情報は既存の確認質問を使う。
- `dots-delegation.bundle.json` と登録adapterを正本にする。共通SystemContextの別経路や、発話の語句ごとの意味判断コードを増やさない。
- tasks、dotsのcommand/lease/Events、task-reports/outboxを使う。元会話、task、接続・作業先の版、許可操作、Session数、期限、停止・重複防止を維持する。
- SQLiteは有効・無効、接続、既定作業先、Session/時間上限、会話への結果表示を保存する。画面は認証済みAPIと既存writer/CASを使う。
- 作業先のnative `local` / `cloud` 区分はそのまま保持する。これは利用者が新しい受付サーバーを配備するという意味ではない。

## 現行の登録

| 登録 | 責務 |
| --- | --- |
| `profile:dots.request@1`、`skill:dots.request@2`、`package:dots.request@2` | Eumenes側の依頼受付。開始・一覧・一件照会・質問回答・停止 |
| `toolchain:dots.delegate@5` / `delegate_project` | 受付担当の公開先 |
| `binding:dots.delegate@3`、`adapter:dots-delegation@1` | 標準commandと公開操作の接続 |
| `skill:dots.orchestrate@4`、`package:dots.orchestrate@4` | 外部担当の作業調整。独自の永続受取箱を必須にしない |
| `artifact:dots.workspace@3` | 同じアーティファクト領域で一覧・要約・成果・質問・停止を表示 |
| `artifact:settings.dots@5` | 接続・作業先と上限・担当の変更・結果表示。未実装の起動時同期を除去 |

公開済みrevisionの本文やhashは上書きしない。保存済みプロジェクトの担当も起動時に自動更新せず、画面から明示的に変更する。旧taskの履歴・照会・停止を残す。

## アーティファクト

「仕事一覧」のアイコン付きボタンから見出し・閉じる操作・状態付き行を持つ浮動一覧を開く。Selectや常設左ペインは使わない。仕事を選ぶと同じ領域の要約・成果・依頼内容、質問回答、一時停止・取消を切り替える。既存の活動履歴も合成する。

設定は既存の下書きと一括適用/破棄を使う。未実装のクラウド同期スイッチと、実行に使われない固定一択の受付担当設定は置かない。担当の版は登録したtoolchainと作業先の明示的な担当変更で管理する。

以前の生成画面案は[画像記録](verification/dots-permanent-delegation-design-2026-10-25/README.md)に残す。現行の設定項目と検証結果は[削除後の記録](verification/dots-no-relay-cleanup-2026-10-25/README.md)を参照する。

## 今回の完了条件

不要な中継用コードと参照を削除し、旧設定から不要フィールドだけを除く。通常の委任・質問回答・停止・報告表示・設定保存を検証する。追加サーバーの契約・課金・配備、自動回収や新しい遅延結果採用は今回行わない。
