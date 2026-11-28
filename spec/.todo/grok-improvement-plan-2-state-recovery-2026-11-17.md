# Grok向け実装計画 2　保存・権限・専門担当の復旧

> **整理判断（2026-11-28）: 今後取り組む。** 一部実施。検証記録では2-01・02の既存差分を検証し、2-04・10を修正。2-03・07〜09・11・13〜19等は未実施または未実装。 実装済みの部分をやり直す指示ではない。未合意の設計は、着手時に現行方式と照合し必要な合意を得る。

2026-11-17。前回評価の基準コミットは `204280c675cc67809ddf1cd1ab623e4243d06a5e`。専門担当の終了・再試行にはすでに未コミットの実装と結合試験があった。着手時のコミット・差分・最新の検証記録を確認し、該当する修正を引き継ぐ。

この文書を3並列のうち計画2の作業指示として使う。まず、専門担当の下書きや完了済みの子作業を守ったまま終了失敗を扱えることと、記憶移行の型検査を確かめる。次に、忘却・復元・承認の確定条件を同じwriterで確認する。専門担当側に進行中の編集がある間は、記憶移行試験・旧調査の忘却・Queueの固定試験から着手できる。

## 作業境界

| 担当 | 書き込み範囲 |
| --- | --- |
| 計画2 | 下記の保存・権限・運用コードと、この計画専用の検証記録 |
| [計画1　会話・Pipeline](grok-improvement-plan-1-dialogue-pipeline-2026-11-17.md) | Router、Pipeline、依頼の分割と意味評価、共通 `toolchain.fixture.ts` |
| [計画3　Web・音声・検証](grok-improvement-plan-3-web-voice-verification-2026-11-17.md) | Web、音声、共有の検証設定・生成索引と統合。試験登録の変更は計画3に必要な登録内容を渡す |

編集できる場所は以下。ディレクトリ指定は記載した項目に必要なファイルに限る。

```text
api/application/collaboration/**
api/application/toolchain/specialist-port.ts
api/application/toolchain/specialist-sessions.ts
api/application/backup-restore.test.ts
api/application/db-backup.ts
api/application/memory-host*.ts
api/application/memory-package-integration.test.ts
api/application/migrations.ts
api/application/pursuit/**
api/application/server-services.ts
api/application/server-lifecycles.ts
api/application/vendor.test.ts
api/application/agency/action-safety.test.ts
api/application/agency/always-on-authority.test.ts
api/application/agency/memory-ref-staleness.test.ts
api/domains/collaboration/**
api/domains/dialogue/contracts/specialist.ts
api/domains/dialogue/repository/index.ts
api/domains/dialogue/repository/specialist.ts
api/domains/dialogue/repository/work.ts
api/domains/dialogue/service/index.ts
api/domains/dialogue/service/specialist-*.ts
api/domains/dialogue/service/work-ledger.ts
api/domains/dialogue/test/specialist*.ts
api/domains/tool-runtime/contracts/adapters.ts
api/domains/agent-runtime/service/resource-access.ts
api/domains/agent-runtime/test/resource-access.test.ts
api/domains/conversation/**
api/domains/memory/**
api/domains/steward/**
api/domains/world/**
api/domains/queue/**
api/domains/pursuit/**
api/domains/shell/test/**
api/infrastructure/sqlite/**
docs/memory.md
docs/operations.md
spec/verification/grok-plan-2-state-recovery-2026-11-17.md
```

`api/domains/dialogue/service/index.ts` などで別の作業が進んでいる場合は、作業中のパスを読み取り専用にして別の項目から進める。`scripts/domains.ts` の専門担当結合試験登録は既存差分を保全し、統合時の編集は計画3に集約する。境界検査・SQL検査の設定、依存バージョン、配布物は共通のため、必要が判明した際に変更案を計画3または決定者へ渡す。

[作業規則](../../AGENTS.md)に従い、固定コピーに専用DB・鍵・偽の認証情報を生成する。製品DB、設定、ログ、鍵の複製や、旧セッションへの手動SQLは作業範囲外。サーバー操作、実接続、外部担当への実送信は利用者が許可した範囲に限る。忘却・取消の有効性は、最終の採用・保存まで追う。

## 最初の作業　既存修正と記憶移行を照合する

1. [終了失敗の設計](../.archived/specialist-close-retry-design-2026-11-16.md)と着手時の差分を照合する。既存の `collaboration-close.test.ts` があれば再利用する。端緒は `endOrMarkClosing`、`specialistExecutionSource`、作業状態の取得、定期処理・起動時復旧。期限切れの確認、停止理由の保存、ログの確定順を一つずつ追う。
2. 終了失敗の検査は、①期限切れと元発言の紐付けが確定、②一時的に作業中、③紐付けを確認できない、④停止理由保存が失敗、の条件を分ける。期限切れだけを判定できる専用の既存経路を使い、通常操作の権限を広げない。
3. `backup-restore.test.ts` のschema 8→9・巻戻しケースは実行成功と型検査失敗を別々に再現する。合成データから必須のIDが3個揃うことを確認して型を絞る。索引の整合、切替前後の忘却、旧版拒否、復元後の非復活を引き続き検査する。境界の警告は型修正と切り分ける。
4. 旧調査の削除は、`registerForgetPurge` の実行順と `dialogue_work` の公開操作を確認してから変更案を選ぶ。出典IDが先の処理で消える場合は、現行トランザクション内で必要なIDを先に取得できる設計を選ぶ。調査本文や状態をログ・別テーブルに複製しない。

## 改善一覧

「修正」は現行契約の範囲。「再現後修正」は現行版で条件を証明した範囲。「評価」「設計」は調査結果と受入を揃える。再委任の新規操作、履歴やスキーマの新しい持ち方、再開規則、権限の拡大は設計合意の対象。

| ID・順 | 項目 | 実装または確認と合格条件 |
| --- | --- | --- |
| **2-01 P1 再現後修正** | 専門担当の終わらない再試行 | 既存差分で、確定した期限切れが停止理由付きで保存されることを確認。定期処理を2周期以上進め、起動時復旧と新規引渡しも実行。下書き、作業revision、子参照、試行数を保存時の値と比較し、停止ログは一回。 |
| **2-02 P1 再現後修正** | 一時障害と不明な条件 | 期限内の `work_busy` は障害が解消した次の試行で終了。同じ会話でも別セッションの参照や理由不明なら、期限切れと誤判定しない。書込みに失敗した場合は元の状態へ戻り、確定した停止のログを出さない。 |
| **2-03 P1 設計** | 停止後の作業の回復と再委任 | 現行案には、停止後も同じ会話で新しい専門担当を開けない条件が残る。保全した作業の閲覧・再接続・明示的な終了のために利用できる既存の公開操作を調べ、同時に二つの担当が作業を保持しない受入を定義する。新しい操作の実装は合意後。 |
| **2-04 P1 修正** | Memory移行fixtureの型エラー | 型を正しく絞り、schema 8から9へ、索引の整合、旧版の起動拒否、切替後の忘却を含む巻戻しを同じ試験で通す。型検査のTS2769四件を解消し、`any` や診断無効化、期待値緩和で処理しない。 |
| **2-05 P1 再現後修正** | 復元fixtureの公開境界 | `backup-restore.test.ts` のjournal非公開importと、旧tarballの動的import警告を確認。既存の公開ポートと合成データの準備方法を利用する。旧版の実体を使うため動的な参照が不可欠なら、どの条件に限るかを記録し、検査設定の変更は統合担当に渡す。 |
| **2-06 P1 評価** | 鍵・WAL・journalを含む復元（EUM013） | 完了済みの演習を回帰基準にする。別世代のWAL・SHMを手順どおり退避し、対応する鍵で認証情報を読め、最新の忘却記録で復元前の失効が再適用されることを専用DBで確認。鍵違い・未知のmigrationの拒否は別ケースで照合する。 |
| **2-07 P1 評価** | 復旧不能な忘却記録 | 途中で破損したjournal・欠けた記録・二回再読を既存の契約で試す。Memoryの非健全状態とWorld側の提供可否が区別でき、失効済みの記憶が復旧前の応答に使われない。独立した資料の保持も検査する。 |
| **2-08 P1 評価** | 訂正の意味と取り違え（EUM015） | 版・効力の条件・否定の範囲・日付を含む合成会話を用意。明示訂正のあとに別会話で同じ事実を聞き、旧記憶を採用しない。回答準備中の訂正、別の有効記憶への影響、情報不足時の応答を別々に観測する。意味の判定を語句ルールに移さない。 |
| **2-09 P1 評価** | 発言の撤回と派生物（EUM016・017） | 一つの元発言から派生したMemory・World・未確定の回答・作業資料を合成データで特定。忘却後にそれらの参照・新規採用が無効となり、独立した資料は残る。元会話ログの保持は現在の公開契約に従う。実画面での受入は許可済みの段階で対象を指定。 |
| **2-10 P2 再現後修正** | PursuitとDialogueのSQL所有 | `pursuit/repository/forget.ts` から `dialogue_work` を直接JOINする経路を減らす。Dialogueが出典に対応する旧調査IDを返し、既存のforget hookでPursuitへ渡す形を優先。合成データで実際のhookを通し、対象だけの失効、再呼び出しの冪等性、既存の通知撤回を確認。 |
| **2-11 P2 設計** | 旧Pursuit Coreの更新境界 | 旧Coreに適用できる公開操作・互換層があるか確認する。現状は `pursuit_pursuit` と `pursuit_operation` などを直接扱う。所有側へ寄せる案と、歴史データ専用の最小互換操作の案を比較。適用済みmigrationの内容を保ち、未関連の調査に作用しないことを要求する。 |
| **2-12 P1 評価** | 再起動時の再実行の安全性（EUM014） | Queueと対象の既存handlerを読み、未着手、再試行可能、中断、外部の成否不明を一覧化。プロセス断のfixtureで、未着手の仕事は一度実行され、外部作用が不明なものは二度実行されないことを確認。 |
| **2-13 P2 設計** | 再起動後の中断と手動継続 | [再起動をまたぐ仕事の案](../.archived/restart-continuation-design-2026-10-31.md)を現行仕様と照合。仕事・外部作用のreceipt・利用者に示す中断の状態を整理し、既存の照会と再依頼に載せる案を提示。再開可否を変える実装は合意後。 |
| **2-14 P2 評価** | 受領済み回答を履歴の長さに依存させない | 過去記録にある「直近200件の再構築」は現行の `conversation.message(id)` への直接取得と照合済み。200件より古いrunの本文・配達情報、存在しないID、失効した参照の挙動で回帰を確認し、違反が見つかった場合だけ修正する。 |
| **2-15 P2 評価** | SQLite writerの混雑と停止 | 通常書込みが混む条件で、既存の予約枠によるlease更新・完了・取消が実際に通ることを確認。待機・経過・最古の保留を計測し、ユーザーの実行中処理と背景処理の両方を観測。上限を増やす案は証拠と影響を示す。 |
| **2-16 P1 評価** | 実行前後の権限（EUM025） | 既存の偽操作受け口で、承認未取得・対象不一致・期限切れ・取消直後・権限撤回を確認。外部資料を根拠に実行権限を付けず、権限を失った結果は台帳に確定しない。正規の読み取りと承認済みの操作も対照にする。 |
| **2-17 P2 評価** | Browser・dots・コーディング担当の停止と返却（EUM020–022） | 検証専用の受け口で、既存の取消と完了受領を確認する。Browserは承認対象の範囲、dotsは同じ仕事への返信・停止、コーディングは管理実行の停止とworkspace返却の証拠を照合。実接続・実送信の可否と結果は各ケースに記す。 |
| **2-18 P2 再現後修正** | Shellのログイン環境と試験の再現性 | 前回の実PTY試験は起動プロファイルの出力が混ざり一件失敗。製品のログイン環境継承を保ち、試験専用の条件で終了コード、出力、配信の一致を再現する。通常のShell承認・期限・取消の固定試験と別記録にする。 |
| **2-19 P2 評価** | 依存の由来と公開配布（EUM026・033） | Memory/Host・Router・World・主要assetsを採用manifest、lockfile、実ファイルで照合。更新候補は公式情報で実行経路への到達性を確認し、配布候補の許諾・表示条件は同梱物ごとに記録。ライブラリを一括更新せず、結果のある候補だけを変更案にする。 |
| **2-20 P2 再現後修正** | 組み立てとドメイン依存の保守 | `buildServices` のサイズ超過と、Collaboration→Queue、Memory・Collaborationの非公開import警告を再確認。忘却登録など具体的な責務から既存ファイルの近くへ分離し、復旧・start順を維持。必要な依存宣言は理由と利用側を計画3に渡す。 |

参照先は[データ保全と復元](../../docs/operations.md#バックアップからの復元)、[記憶と忘却](../../docs/memory.md)、[全体課題](../project-issues-2026-11-06.md)。停止中の専門担当の修正が取り込み済みなら、1〜2は残る回帰の確認で閉じられる。利用者の再委任に関わる3は独立した設計項目として残す。

## 検証と引渡し

部分 → 結合 → 対象domainの順。まずサーバー相当のプロセスを起動しない固定試験を実行する。最新版で追加済みの `collaboration-close.test.ts` はファイルが存在する状態で実行する。

```sh
bun test ./api/domains/dialogue/test/specialist-lifecycle.test.ts ./api/domains/memory/test/forget-contract.test.ts ./api/domains/queue/test/recovery.test.ts
bun test ./api/application/collaboration/collaboration-close.test.ts ./api/application/backup-restore.test.ts ./api/application/pursuit/upgrade.test.ts
bun test ./api/application/agency/action-safety.test.ts ./api/application/agency/always-on-authority.test.ts ./api/domains/agent-runtime/test/resource-access.test.ts
bun run verify -- --domain dialogue --domain collaboration
bun run verify -- --domain memory --domain conversation --domain world --domain queue --domain pursuit
```

プロセス断の試験は専用子プロセスだけを対象とする。標準verifyのMemoryには待受を作るホスト結合試験も含まれるため、事前に許可と該当する試験の範囲を照合する。許可の範囲内で個別の固定試験、型、SQL所有を先行し、未実施の工程は結果に明記する。反映後の稼働確認が許可された場合は、既存のrun・session IDで警告件数、下書き、作業参照を読み取り専用で照合する。

引渡しでは、変更した所有側、観測した旧DBの条件、停止・取消の境界、成功した復旧と未確認の復旧、必要な共有登録、残る設計合意をIDごとに記す。検証中のバックアップ・診断に会話本文、秘密、製品の設定値を含めない。型・境界警告は範囲内と範囲外を明示し、実行した試験が通ったことと混ぜない。
