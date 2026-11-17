# Grok向け実装計画 3　Web・音声・検証の基盤

2026-11-17。前回評価の基準コミットは `204280c675cc67809ddf1cd1ab623e4243d06a5e`。Bun 1.4.4・macOS arm64の固定コピーでWebビルド成功、初回JSのgzip合計399,147 B、既存許容上限264,846 B。着手時の環境で先に再測定する。

この文書を3並列のうち計画3の作業指示として使う。まず、初回ロードの依存を特定し、会話・アーティファクト・音声起動を保ったまま削減する。次に、ブラウザの通知・取り直し・音声再生を計測し、正当な利用条件で評価する。共有の試験設定と全体結果の取りまとめもこの担当に集約する。初回ロードと個別のWeb固定試験は他2担当の差分を待たずに進められる。

## 作業境界

| 担当 | 書き込み範囲 |
| --- | --- |
| 計画3 | 下記のWeb・音声・検証ファイル、生成ドメイン表、専用の検証記録 |
| [計画1　会話・Pipeline](grok-improvement-plan-1-dialogue-pipeline-2026-11-17.md) | 会話の選択・引渡し、Pipeline、評価、共通の `toolchain.fixture.ts` |
| [計画2　状態・復旧](grok-improvement-plan-2-state-recovery-2026-11-17.md) | 専門担当、記憶・旧調査の忘却、権限・writer・Queue、バックエンドの会話履歴 |

編集できる場所は以下。ディレクトリ指定は記載した項目に必要なファイルに限る。

```text
vite.config.ts
web/src/main.tsx
web/src/queryKeys*.ts
web/src/workspace/useWorkspace*.ts
web/src/workspace/useCurrentViewing*.ts*
web/src/workspace/WorkspaceArtifacts.tsx
web/src/workspace/ConversationHistory.tsx
web/src/workspace/LiveMessageList*.tsx
web/src/workspace/DebugDiagnostic*.tsx
web/src/components/domains/conversation/MessageList*.tsx
web/src/domains/toolchain-artifacts/**
web/src/domains/audio/**
web/src/domains/voice-dialogue/**
web/src/domains/live-voice/**
api/domains/voice-dialogue/**
api/domains/live-voice/**
client/agency.ts
client/events.ts
client/voice-dialogue.ts
client/live-voice.ts
client/run-speech.ts
client/test/run-speech.test.ts
tests/browser/conversation-scroll*
tests/browser/conversation-stream*
tests/browser/automatic-speech*
tests/browser/run-speech*
tests/browser/voice*
tests/browser/live-voice*
scripts/bundle-budget.ts
scripts/bundle-budget.test.ts
scripts/domains.ts
scripts/domain-docs*.ts
scripts/verify.ts
scripts/test-inventory.ts
scripts/verification*.ts
docs/domains.md
docs/verification.md
docs/performance.md
docs/acceptance.md
README.md
spec/verification/grok-plan-3-web-voice-verification-2026-11-17.md
```

進行中のContextWindow閲覧やMarkdownライブラリの編集と重なるパスは、その作業を取り込んでから一人の担当に絞る。`spec/README.md` とMarkdown/DesignSystemの進行中差分は参照扱い。今の3計画に必要な仕様・パスをこの文書で追える。共有の `scripts/domains.ts` は専門担当の既存登録を保全し、追加は各担当からパス・対象domain・根拠を受け取ってから一度に行う。`bun.lock`、バージョン固定、`scripts/bundle-budget.json`、サイズ・SQL・lintの許容設定、CIワークフローは基準として保持する。

[作業規則](../AGENTS.md)に従い、3本とも基準コミットを揃えた独立の検証コピーで試験する。各コピーには別のDesignSystem `dist` と試験用DBを用意する。サーバー操作は利用者の許可の範囲。ブラウザーE2Eのfixtureサーバーも起動工程を確認してから進める。画面なしブラウザーは消音し、可聴出力の受入は利用者が開くEumenesのWeb画面で行う。

## 最初の作業　初回JavaScriptの依存を絞る

1. 固定コピーで[性能予算](../docs/performance.md)と `scripts/bundle-budget.ts` の測定範囲を確認する。`bun run build:web` の後に `bun run bundle:check`。配布版・実行環境・gzip方法を同じにして、エントリと `modulepreload` の合計・各ファイルを記録する。
2. 評価版ではエントリ単体52,092 B、画面観測名のチャンクが139,453 Bだった。チャンク名は依存の根拠の出発点として扱い、ビルドのモジュール一覧と静的importを追って、実際に画面観測処理から到達する依存を特定する。観測hookのファイル自体は小さい。Viteの分割設定だけで合計が減るとは仮定しない。
3. 初回画面で要る軽量の状態・契約と、アーティファクトを開いた操作で初めて要る描画・機器処理を既存の遅延読込へ分けられる箇所を選ぶ。ユーザーが開いた画面の状態や権限で判定し、別の状態台帳は作らない。
4. 同じ計測で264,846 B以内を確認する。初回会話入力、画面観測、初めて開く対象アーティファクト、マイク開始・音声表示を確認する。先読みの削減で初回操作の待ちが別の箇所に移る場合は、両方の時間を記録して判断する。

## 改善一覧

「修正」は現行契約の範囲。「再現後修正」は観測結果を条件とする。「評価」「設計」は測定・切り分け・合意用の案まで。通知イベントの公開仕様、音声の判断方式、検証の合否基準を変える案は設計合意を経る。

| ID・順 | 項目 | 実装または確認と合格条件 |
| --- | --- | --- |
| **3-01 P1 評価** | 初回JSの現行値（EUM010） | 固定ビルドの `index.html` と計測結果から初回利用分を記録。初回合計、エントリ、上位チャンク、適用した許容上限を示す。評価版の値と異なる場合はコミット・依存・条件を照合。 |
| **3-02 P1 再現後修正** | 初回の大きい依存 | 利用時読み込みにできる依存の経路を、上の手順で最小限切り離す。ハッシュ名のファイルや数値だけを変えず、既定画面と対象機能が両方動くことを確認。 |
| **3-03 P2 評価** | 配置と初回操作の使い勝手 | `bundle:check` の入口とpreloadの取り込みを既存試験で確認し、読み込み縮小前後で初回入力とアーティファクト初回操作を測る。技術的なgzip容量とブラウザーの操作可能時刻を両方残す。 |
| **3-04 P1 再現後修正** | 保存通知の連続再取得 | `useWorkspace.ts` の `subscribeChanges` と `changeRoots` を使い、変更通知を連続させてHTTP件数とcancel回数を測る。同じ照会を多重に開始する原因が確認できたら、現行通知の情報でできる範囲の共有・まとめ方を調整する。 |
| **3-05 P1 評価** | 再接続・取得競合 | 通知の欠落、reset、接続断の間の変更、新しい内容より遅く戻る古い取得を試す。最終表示が台帳へ追いつき、利用者の入力を上書きしない。`invalidateAllButLive` のProviderオンデマンド規則を検査する。 |
| **3-06 P2 評価** | 会話のスクロールと再描画 | [会話スクロール調整](chat-scroll-optimization-2026-11-15.md)を回帰基準にする。閲覧中の位置、末尾追従、ストリーム中の更新、会話切替を、長い履歴かつ同じ件数で比較。触れた箇所だけ変更し、既存の履歴復帰を守る。 |
| **3-07 P2 評価** | キーボード操作と状態の区別 | 入力、停止・再送、ソースリンク、診断詳細についてTab/Enter/Escape、フォーカス復帰、読上げ用ラベルを確認。進行中・取消・失敗・完了の状態を既存の契約で区別し、画面独自の正本を増やさない。 |
| **3-08 P2 修正** | デバッグ診断の描画中の時刻参照 | `DebugDiagnostic.tsx` のReact purity指摘を再現。現行の有効期限、詳細取得、期限後非表示を保ったまま時刻判定を管理し、fake clockで初回・期限到達・項目交換を検査する。進行中のContextWindow新機能は別の設計に従う。 |
| **3-09 P2 再現後修正** | Webとclientの型依存 | `MessageList.tsx` と `client/agency.ts` のAgency型の境界違反を確認。clientは公開契約を使い、下位の会話描画は上位Dialogueの型を直接importせず成立する形を優先。すでに持つ表示用propsで解けない場合は所有側に変更案を渡す。 |
| **3-10 P1 評価** | ASR遅延・切断・手修正 | [認識セッションの検証](verification/asr-input-session-2026-11-15.md)を基準に、途中通知、確定の遅延、手修正、再接続後の古い認識、マイク喪失を試す。最新入力だけが送信され、同一発話でrunは一件。 |
| **3-11 P1 評価** | 句の読み上げと受領の整合 | [句単位再生](verification/tts-async-clause-playback-2026-11-15.md)の固定データで、順序、同時再生なし、重複・逆順ack、取消、ミュート、再生成、途切れを確認。実再生した句と画面表示の結果がそれぞれの既存契約を満たす。 |
| **3-12 P2 評価** | 音声の待ちを区間で測る | 認識受付→認識表示→最初の文字→最初の再生→再生報告を、同じ `runId` と句番号で照合。合成時間・空き枠・ネットワーク・描画を区別し、回数、中央値と上位・最大の遅延を記録する。過去の最大句間8.236秒は当時一回の観測。本文・音声はログに載せない。 |
| **3-13 P1 評価** | 通常音声の実機3往復（EUM011） | 許可後、利用者のChrome系ブラウザ、マイク・ヘッドホンで3往復と再生中の割込みを確認。聞こえた本文、画面状態、停止後無音の一致を利用者が確認し、条件・時間・失敗数だけを保存する。音声MVPの受入はこの結果で更新。 |
| **3-14 P2 評価** | Live音声の受入（EUM012） | 通常音声と別に、既存の送信許可のもとで入出力、切断、停止、再接続の状態を確認。試験専用の入力を使い、利用者の実音声を送らない工程はfixtureで準備する。 |
| **3-15 P1 再現後修正** | 過去のコピーが試験棚卸しに混入（EUM029） | `sourceFiles` と `testInventory` を確認。既存のGit管理外検証コピーを混ぜた再現を隔離環境で作り、正規のBun・Web・client・DS試験は拾い、古いコピーだけを外す方法を選ぶ。誤って本物の新規ファイルを除外しない反例も検査。 |
| **3-16 P1 評価** | 検証入力・生成物の分離 | 実行用コピーが同じ基準コミットを解決し、入力と出力のhashが前後一致することを確認。各workspace依存がコピー側、出力先が独立であることを調べる。異なる入力や欠損は無効化として報告。自動コピー化は必要性を測定して設計案へ。 |
| **3-17 P2 修正** | 検証登録と生成索引（EUM005・028） | 各担当から必要な `integrationTests` の変更を受け取る。既存登録の保持、追加パスの実在、選択で一度だけ実行されることを確認。 `bun scripts/domain-docs.ts` で索引生成し `--check` を通す。 |
| **3-18 P2 修正** | 検証文書の現状との差 | `docs/verification.md` の手動起動とpush/PRに関する矛盾を、現行workflowと照合して直す。READMEのRouter・受入の表は現在の根拠と対象コミットで更新。CIの導入・必須化・運用変更は既存課題の範囲外。 |
| **3-19 P1 評価** | 統合時の合否と残件（EUM031） | 3担当の検証記録が揃った後、取り込まれた1つのコミットで該当domain、Webビルドと予算を順に確認。対象外警告、失敗、スキップ、未実施を別計数。境界・型・容量の検査条件を維持し、残件を所有側別に示す。 |
| **3-20 P3 評価** | 初回導入と引継ぎ（EUM032） | Bun/Node・保存済み接続を使い、説明なしで初回の成果取得に至るまでの手順と詰まる箇所を記録。別の利用者への試験運用が決まった場合に初回時間と継続利用を測る。既存の手順に沿う範囲の文書補正を行う。 |
| **3-21 P2 再現後修正** | 音声処理の構造と検証の依存 | `voice-dialogue/service/respond.ts` のサイズと `settings-voice.fixture.ts` の依存警告を再確認。録音受付・認識結果・読み上げの既存の責務に沿って個別に扱う。テスト側は境界を尊重する公開口・fixtureに寄せ、録音開始・割込み・失敗時の順序を保つ。 |

参照先は[現行の検証手順](../docs/verification.md)、[実機器の完了条件](../docs/acceptance.md)、[再生報告の調査](tts-ack-latency-2026-11-15.md)、[全体課題](project-issues-2026-11-06.md)。会話の回答を古い履歴から取得する検証は計画2、Routerの意味・作業の結果は計画1が持つ。

## 検証と引渡し

部分 → 結合 → 対象domain・Webビルドの順。ファイル指定を基本にし、影響を受ける利用側が増えた場合は標準検証のdomainに足す。

```sh
bun test ./scripts/bundle-budget.test.ts ./scripts/verification-selection.test.ts ./scripts/verification-inputs.test.ts
bun test ./api/domains/voice-dialogue/test/routed-voice.test.ts ./api/domains/voice-dialogue/test/streaming-speech.test.ts ./api/domains/voice-dialogue/test/run-speech.test.ts
bun x --no-install vitest run web/src/queryKeys.test.ts web/src/workspace/DebugDiagnostic.test.tsx web/src/domains/voice-dialogue/test/input-session.test.ts
bun run verify -- --domain conversation --domain dialogue --domain voice-dialogue --domain audio --domain live-voice
bun run build:web
bun run bundle:check
bun scripts/domain-docs.ts --check
```

起動を含む検証は許可の範囲で行う。ブラウザーでの対象例は `bun x --no-install playwright test tests/browser/conversation-scroll.spec.ts tests/browser/conversation-stream.spec.ts` と `bun x --no-install playwright test tests/browser/voice-input.spec.ts tests/browser/run-speech.spec.ts`。実際に変更した仕組みに対応するファイルを選ぶ。通常音声の実機とLiveを別に記録する。

統合時は各担当から「基準コミット・変更パス・適用したID・検証結果・残る制約」を受け取る。変更パスは基準からの `git diff --name-only <基準コミット> --` と未追跡の追加ファイルを照合し、着手前からあった他作業の差分と区別する。3担当の変更一覧に同じパスがあれば、担当を一人に決めて処理する。共有の登録・生成索引はこの担当が一度だけ更新し、`git diff --check` を実行する。全体検証が必要になった場合は `bun run verify:all` の選択と起動有無を確認してから実行する。結果には入力hash、出力hash、ビルド容量、実行したテスト件数、比較条件、未受入を記す。
