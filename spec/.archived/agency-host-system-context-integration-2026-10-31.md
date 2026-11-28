# Agency SystemContext のホスト管理への接続（2026-10-31）

状態: 実施。Agency側の承認済み設計と、利用者の「eumenes側のtgzも更新して、接続を確立してくださいSystemContextもeumenesとして適切な物にしてください」に基づく。

## 目的と範囲

Agency 0.1.1（94ad302a4ca7）の配布物を導入し、通常応答・update・select の指示全文を Eumenes が所有する。既存の s11tnext 資産、会話の人格設定、推論 route と実行機構を再利用する。新しいプロンプト管理層は作らない。

通常応答の部品は Agency の experimental helper から Eumenes の contexts/agency に移す。人格・言語・音声向けの表現・感情は Eumenes の設定と資産で決める。update/select は用途別の callback から Eumenes 所有の全文を渡す。共通の人格の構成だけ会話と共有する。公開された出力契約の説明は Eumenes が明示的に採用し、JSON Schema は既存の構造化出力経路で渡す。

背景処理は会話履歴・記憶・状態の既存の組み立てを再利用するが、通常会話の system は背景用途の system に置換する。Task に載せるのは request.prompt のデータだけとし、request.system を user メッセージに複製しない。推論層の ControlContract は system に契約を追記するため使わず、既存の CallSession.outputSchema を auxiliary の制御呼出しにも許可してネイティブの構造化出力を使う。subagent や非LLMへの制限は維持する。モデルの再試行・提供元の切替でも同じ system を維持する。呼出しごとの設定を共有変数に保存しない。

update は未解決の会話の文脈を note として更新し、自己出力を独立した根拠にしない。select は idle/turn_end/result_received と現在の観測を読んで発話の必要性を判断する。待機・割込みへの配慮・同じ話の反復防止・記憶と関心の区別を指示する。完了TODOをAgencyに渡さない現行方針を維持し、進行中の仕事の催促や完了報告を再導入しない。新しい意味分類や発話判断方式は追加しない。

人格に関する設定変更も背景の実行世代を無効化し、変更前の口調での遅延配信を防ぐ。取消・予算・権限・出力検証は現在の実装を維持する。

## 対象外

DB・短期記憶・状態モデル・ハーネス選択・発話判断方式・提供元の追加やモデルの固定は対象外。並行中のコード整理は保持する。サーバの起動・停止・再起動と実モデル試験は今回実施しない（許可が別に必要）。

## 検証と完了条件

変更前: agency、vendor、context-system の75件が成功。編集対象の開始時ソースと差分を /tmp/eumenes-agency-context-before-20261031 に保存。

1. 部分: 用途別の全文、設定ごとの分離、未指定拒否、観測・履歴がsystemへ混ざらないこと、背景userに指示が複製されないことを入力捕捉で確認する。
2. 結合: 実際のAgency runtime → Eumenes LlmPort → inference の試験接続で update/select と再試行を確認し、通常応答も最終呼出しのsystemを確認する。既存の取消・古い結果不採用・権限・予算試験を維持する。
3. 通し: bun run verify -- --domain dialogue --domain inference と application の関連試験、context:check、配布物の整合性を確認する。担当外の既知失敗と新規失敗を区別する。

配布物とコードの接続完了を、起動中プロセスへの反映や実モデルの振舞い確認と区別して報告する。

## 接続内容と移行

導入物は `vendor/agency/eumenes-agency-0.1.1-94ad302a4ca7.tgz`。Agency の確定コミット `94ad302a4ca7dfc8b70308d567ecb3f2a73eface` から pack を実行し、dirty=false を確認。SHA256 は `c4c3b31fd3e9dbefdd05a29d111a0c8e20f6401f5afcf1ac520265a6c701a4f4`。旧tgzとチェックサムを置換し、manifest・package.json・bun.lock・インストール済み版の整合性を vendor.test.ts で検証した。他の依存更新とインストールスクリプトは実行していない。

設定の追加・DB移行・モデル名の追加は不要。ホストが渡すのは従来の `general.agentName / userName / persona`、`agency.interests / emotion` と、既存の観測・状態・機会・履歴・TODO・能力一覧。時々の観測や履歴は user のデータへ置き、system の変数には昇格させない。

公開APIの変更:

- Agency runtime の必須 `systemContext.update/select` は `host.ts` で接続済み。呼出しごとの公開契約を callback で受け取り、Eumenes の全文を返す。実験用プロンプトを指定する必要はない。
- dialogue の公開関数 `conversationPersona(persona)` は `{ role, style }` を返す。既存の人格資産を通常応答と背景処理で共有するための小さい構成関数。
- `AgencyHostDeps.settings` は `get` と `inTransaction` から人格に必要な general の3項目も受け取る。実アプリの SettingsService は既にこの情報を持つ。人格の変更では実行世代を更新し、トランザクション内でもコミット済み人格と比較する。
- inference の `CallSession.outputSchema` を `auxiliary` の **control** 呼出しにも許可した。systemを追記する `ControlContract` を使わず、既存のネイティブ構造化出力と受信後のSchema検証を維持する。auxiliary answer / subagent / 非LLM の制限を広げていない。

配布物を別ホストへ接続する場合の最小例（Eumenesは実装済み）:

```ts
createAgencyRuntime({
  condition: "B1",
  systemContext: {
    update: input => agencyBackgroundSystem("update", input, persona, emotion),
    select: input => agencyBackgroundSystem("select", input, persona, emotion),
  },
  llm,
  tools: [],
});
```

指示は `api/domains/dialogue/contexts/agency/*.context.toml` と既存の system / system-prompt 資産が正本。`api/application/agency/system-context.ts` がそれを構成する。通常応答は自然な本文と、設定があるときの先頭感情記号の形式だけを説明する。モデルに不要な ReplyPort 内部の返却オブジェクトの説明は渡さない。背景update/selectではAgencyの公開出力契約の説明を明示採用する。これらを変更したら `bun run context:build` で生成物を更新する。

Agency の実験用指示はライブラリ内に残るが、Eumenes の本番接続では `respondSystemParts` / `ttsUtteranceStyle` / `experimental` を使用しない。残る固定の判断指示はすべてEumenes側の資産であり、Agency由来のものを自動追加していない。

## 検証記録

- 変更前の関連試験: 75件成功。
- 最終の接続・権限・取消・予算等の関連試験: 96件成功、失敗0。通常応答は実Dialogueの組み立てとrunRespondを、背景は実assembleAgency → Agency runtime → Eumenes LlmPort → 実inference → LARM/CloudAgentsの偽提供元まで通した。update/selectと再試行のsystem全文一致、観測・履歴の非昇格、設定間の分離、空systemでの呼出し拒否、人格変更時の遅延発話不採用、Schemaチャネルと補助sessionの権限を確認した。
- 全体の型検査: 最終確認時点で2,662ファイル、エラー0。変更箇所の oxfmt / oxlint、context:check、git diff --check 成功。
- 標準 `bun run verify -- --domain dialogue --domain inference`: boundaries / system-context / SQL / domain docs まで実行したが、今回未変更の `dialogue/repository/specialist.ts`、`service/executor-read.ts`、`service/routed-steps.ts` の整形で停止。担当外の整形や期待値を変更せず、検証を通したことにはしていない。報告: `verification-reports/runs/2026-10-31T02-08-25-431Z-5a7e760a-a7eb-4483-8ee8-54c704e7156e/report.json`。
- dialogue + inference の試験を別実行: 631件成功、14件失敗、5 errors。並行中の読取りツール追加と、従来の「道具なし」/ memory.recall の期待値などが不一致。harnessの試験用depsにstoreがないエラーも確認。今回のコンテキスト構成の試験は成功。担当外を修正していない。
- application 全体: 901件成功、19件失敗、1 error。18件はツールチェーン候補・workerの拒否/期限・history・要件報告・会話画像入力・音声controlの既存試験。残る1件は実行中に別変更で削除された `memory-history-search.test.ts` の読込みエラー。
- 回帰切り分け: `/tmp/eumenes-agency-context-baseline-current` に機密・製品DBを含まないソース比較用コピーを作成。周辺ソースと試験を固定し、旧Agency 0.0.1＋変更前のhost/llm-port/context-systemと、新Agency 0.1.1＋新接続の双方で、上記18件が同じ期待値不一致・同じ音声タイムアウトとして再現した（各18失敗、45 assertions）。比較用コピーに不足した依存・試験音声を揃えた後の結果だけを採用。現作業ツリーは切戻していない。

fixtureは実モデルの判断品質、クラウドの実API受理、音声実機の確認を代替しない。サーバ起動・停止・再起動は実施せず、起動中プロセスへの反映も確認していない。Agency単体対応済みの段階から、Eumenesの配布物・コード接続とfixture検証まで進んだ状態。

context_compile / compile_eval: 今回各1回、この会話累計各4回。
