# 専門担当との対話編集 P0契約

作成日: 2026-10-17

状態: P0契約の確定。実装はこの契約に従って並行で進める。親計画は[実装計画](toolchain-specialist-dialogue-implementation-plan-2026-10-17.md)。容量・出力量の実モデル測定は未実施（§9）。

## 1 コードで固定した契約

以下の型を正本とし、担当者は変更しない。変更が必要なら監督者へ連絡する。

| ファイル | 内容 |
| --- | --- |
| `api/domains/capabilities/contracts/bindings.ts` | `sessionBindingV1`（`execution:"session"`）、`bindingV1`（`execution` による判別union）、bundleの `bindings` は `bindingV1` |
| `api/domains/capabilities/contracts/toolchains.ts` | `ToolchainRuntimeMeta.execution` に `"session"` |
| `api/domains/tool-runtime/contracts/adapters.ts` | `AdapterOrigin` の `specialist`、`SessionWorkState`、`SessionWorkAdapter`、`DomainAdapter.session?` |
| `api/domains/dialogue/contracts/specialist.ts` | `SpecialistSession` とHTTP schema、`viewingSchema`、`SpecialistSet`、`SpecialistPort` |

## 2 共通の流れ

1. 通常担当のツール一覧で、session toolchainのcardは引数 `{request, target?, resolveUnsaved?}` を持つ。`target` は `SpecialistPort.targetChoicesInTransaction` のref enum（無ければ省略）、`resolveUnsaved` は `"discard"` のみ。
2. `settleConversationOperation` の `execution:"session"` 分岐で、dialogueが `dialogue_specialist_sessions` に行を作り、`openWorkInTransaction`、`beginTurnInTransaction` を呼んで、同じrunを `dialogue.specialist_turn` jobへ載せ替える（`linkAnswer` と `transition(queued)` の既存パターン）。
3. 有効なsessionがある会話の入力は、`intake.ts` の受付transaction内で `dialogue.specialist_turn` へ投入し、`beginTurnInTransaction` で作業をbusyにする。system prompt（schedule・notice）は対象外。runに `specialist_session_id` を記録する。
4. 専門ターンの出力は次のいずれか（strict JSON）:
   - `{action:"reply", text}`: 説明・質問・完了報告。ターンを終える。
   - `{action:"invoke", tool, arguments}`: `SpecialistPort.invokeInTransaction` を実行し、結果の `answerContext` を次のモデル入力に加えて続ける。
   - `{action:"return", forward, text?}`: 通常担当へ戻す。dirtyならsuspended、cleanなら終了。`forward:true` なら同じrunを `dialogue.generate` へ載せ替え、通常担当が元発言を一度だけ処理する。
   - `{action:"discard", text?}`: 明確な破棄依頼。作業を破棄して通常担当へ戻す。
5. 1ターンの上限: 120秒（session期限は超えない）、モデル呼出し6回、構造修復1回。出力枠は `captureControlInTransaction` の現行上限4096 tokens。
6. 終了経路（run完了・失敗・取消・中断）はすべて `endTurnInTransaction` を呼ぶ。`run-end.ts` の共通経路で行う。
7. 期限: `expiresAt` は無操作24時間。延長するのは発言受付・再開だけ。applicationのlifecycleが60秒ごとに、dialogueが列挙した期限切れ・closing・cleanなsuspendedを、同じwriter transactionで終了する。起動時のrecoverでは全ての非endedを `restarted` で終了する。
8. World／Memoryからの分離: memoryの `memory_message_block.reason` に `specialist_dialogue` を追加する（表の再作成migration）。専門ターンのuser・assistant発言は受付・採用と同じtransactionでblockする。`forward` で通常担当へ渡した発言だけblockを外す。専門runは `recordExchangeInTransaction` に登録しない。専門担当にはWorld／Memoryの文脈・toolsを合成しない。
9. 通常担当への作業記録: `generation-prepare` は、suspendedのsessionがあれば「保留中の作業（title・label・未保存・期限）」を、直前に終了したsessionがあれば一度だけ「終了理由・label」を短く加える。UI定義の全文は渡さない。
10. needs_resolution: 別の対象・担当への開始時に既存の作業がdirtyなら、新しい担当は起動せず `pendingSwitch` を記録し、`commandNote` で通常担当に「破棄して切り替える／続ける」を確認させる。`resolveUnsaved:"discard"` の再呼出しで、`pendingSwitch.workRevision` が現在の作業revisionと一致する場合だけ破棄して切り替える。同じ対象のsuspendedなら新規作成せずに再開する。

## 3 dialogueのHTTP

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/conversations/:id/specialist` | `{session}`（非endedの1件、なければnull） |
| POST | `/api/specialist-sessions/:id/return` | 画面の「会話に戻る」。進行中runを取消し、dirtyならsuspended |
| POST | `/api/specialist-sessions/:id/resume` | suspendedをactiveへ。epochを進める |
| POST | `/api/specialist-sessions/:id/discard` | 作業を破棄して終了。保存処理中は `work_busy` |
| POST | `/api/specialist-sessions/:id/close` | 未保存なら409 `work_unsaved`、cleanなら終了 |

本文は `specialistCommandSchema`。`POST /api/runs` は任意の `viewing` を受け付ける。`Run` には `specialistSessionId: string | null` を加える。clientは `client/dialogue.ts` に `specialistSession(conversationId)`、`specialistCommand(sessionId, kind, body)` を持つ。

## 4 UI自由制作のbackend（ui-compositions）

`ui-compositions` は旧一回生成（handler・compose・cancel・制作条件・motif）を削除する。保存作品の行と回答は維持する。

### 4.1 保存

- 保存作品: 既存の `ui_compositions` の `state='ready'` の行。`saved_revision`、`definition_json`（OpenUI定義全体）、`fields_json`（フォームのfields）を正本とする。`ready` 以外の旧行は一覧に出さない。
- 一時作業: `ui_composition_works`（id、scope、session_id、composition_id null可、base_saved_revision、draft_revision、generation、busy_run_id、cursor、snapshot数、更新時刻）と、`ui_composition_snapshots`（work_id、index、title、definition_json）。index 0 は開始時の状態（新規は空案）。上限は50変更。

### 4.2 構成案

- 専門担当のtool: `ui.draft.apply`、operation `ui-compositions.draft.apply`、入力は `builtin:uiDraftApply` = `{title: 1..120, definition: object}`。origin `specialist` だけを受け付け、`busy_run_id === origin.runId` の場合だけ採用する。採用するとsnapshotを積み、Redo側を捨て、`draft_revision` を進める。
- 許可するview: `layout`（入れ子可）、`text-block`、`info-card`、`form`（inline `fields` のみ、1定義に最大1つ）。それ以外のview、`source` の指定、16 KiB超、§5の制限超過は拒否する。検査は `parseDefinition` と許可viewの走査を併用する。
- 保存作品の表示では、formを `{view:"form", source:"composition-form", title}` に置き換えて回答経路へ接続する。編集中のプレビューでは試用扱いとし、回答を保存しない。

### 4.3 画面操作（artifactのaction、origin `ui` のみ）

| operation | 入力（builtin） | 内容 |
| --- | --- | --- |
| `ui-compositions.undo` / `.redo` | `uiWorkStep {workRef, expectedRevision}` | busy中は `generation_in_progress`。cursorを移す |
| `ui-compositions.save` | `uiWorkSave {workRef, expectedRevision, expectedSavedRevision}` | busy中は `generation_in_progress`。保存作品と競合したら `save_conflict`。成功で `saved_revision` を進め、Undo列を確定状態1件にまとめる |
| `ui-compositions.submit` | 既存 `uiSubmitRequest` | 保存作品への回答（従来どおり） |

### 4.4 source query

- `query:ui-compositions.studio@1`（target任意＝閲覧する保存作品ID）の返り値: `{kind:"ui-studio", work, viewing, history}`。
  - `work`: null、または `{workRef, sessionId, title, definition, revision, savedRef, savedRevision, dirty, busy, canUndo, canRedo}`。
  - `viewing`: null、または `{id, title, definition, savedRevision}`。
  - `history`: `[{id, title, updatedAt}]`。
- `query:ui-compositions.form@1`: 従来どおり（保存作品のフォーム）。

### 4.5 adapterとbundle

- adapterは `adapter:ui-compositions@1` のまま、`session` を実装する。`choicesInTransaction("builtin:uiTargetRef")` は保存作品の一覧（最大50件。履歴に表示する全作品を再編集先にできるよう、履歴と同じ上限にそろえる）。
- bundleの新revision:
  - `profile:ui.studio@1`、`skill:ui.studio@1`、`tool:ui.draft.apply@1`、`package:ui.studio@1`、`binding:ui.studio@1`（`execution:"session"`、`session.targetSchemaRef:"builtin:uiTargetRef"`）。
  - `artifact:ui.studio@1`（view `ui-studio`、source `ui-studio` と `composition-form`）。改訂: 別ArtifactのJSON確認を廃止し、`ui.studio@2` でプレビュー／ソース切替へ変更（`ui.definition@1` はDBに残るがlauncherなし）。
  - `toolchain:ui.compose@2`（functionName `ui_create`）。
  - 旧 `@1` の定義はDBに残し、bundleファイルからは除く。

## 5 artifact-uiの拡張

- `layout.children` に `layout` を許可する。深さは最大4（rootを含む）、定義全体のview数は最大60。`definitionRequests`・`checkSource`・描画を再帰に対応させる。
- `layout` に任意の `gap: "compact"|"normal"|"relaxed"`、`width: "narrow"|"normal"|"wide"` を加える。`appearance` は既存の4値のまま。
- `text-block` に任意の `emphasis: "normal"|"strong"|"muted"` を加える。
- 新しいview:
  - `ui-studio`（`{view, source, title}`）: プレビュー主体の制作画面。
- 削除するもの: `ui-workspace` view、制作条件・デモ・旧ギャラリー部品、`ui-generate`／`ui-cancel` イベント。
- `ui-studio` の画面イベント:
  - `ui-undo`、`ui-redo`、`ui-save`: actionに対応する。
  - `ui-discard`、`ui-return`、`ui-resume`、`ui-close`、`ui-select`（`""` で閲覧解除＝新規作成）、`ui-refresh`、`ui-stop`: Web adapterのlocal処理に対応する。
- デスクトップ／モバイル切替はプレビュー内の表示状態として維持する。

## 6 Web

- `uiCompositionsWebAdapter` は、studioを表示しつつ、busyの間は1秒ごとにsourceを再取得する。dialogueの操作は `client.specialistCommand` で行う。
- 会話欄: `GET /api/conversations/main/specialist` を購読し、現在の担当（通常／専門のtitle）を常時表示する。sessionがactiveになり、studioのタブが開いていなければ開く。
- 閉じる操作: dirtyなら「破棄して閉じる／編集を続ける」を確認する。cleanなら `close` を呼ぶ。
- 保存作品を閲覧中の送信には `viewing` を付ける。
- ソース確認: studio内の「プレビュー／ソース」切替で、表示中の定義JSONを読取専用で示す。
- 送信時は画面が示していた宛先を `addressee` として送り、変わっていれば409 `addressee_changed` で本文を残して再確認させる。
- 専門担当の作業中に届いた発言は拒否せず、次の専門ターンとして直列に処理する。

## 7 担当分け（write set）

| 担当 | 書いてよい範囲 | 主な内容 |
| --- | --- | --- |
| A: 登録 | `api/domains/capabilities/service/**`、`api/domains/capabilities/test/**`、`api/domains/agent-runtime/service/action-operation.ts`（と同domainの関連試験）、`api/application/toolchain/toolchain-routing.ts`、`scripts/toolchain-bundle.ts` | session bindingの検査・登録・公開catalog・runtime解決（`execution:"session"`）、`SpecialistSet` の解決関数 `sessionSetInTransaction(db, toolchainRevisionId)` をtoolchain-routingに追加 |
| B: dialogue | `api/domains/dialogue/**`（contractsのspecialist.tsは除く）、`api/domains/memory/**`、`api/domains/world/**`（必要な場合のみ）、`client/dialogue.ts`、新規 `api/application/toolchain/specialist-port.ts`・`specialist-sessions.ts`（lifecycle関数）と新規の結合試験 | §2・§3の全て |
| C: UIのbackend | `api/domains/ui-compositions/**`、`api/application/media/ui-compositions-adapter.ts`（とその試験）、`api/domains/capabilities/contracts/ui-compositions.ts`・`contracts/index.ts` の validators、`api/domains/capabilities/bundles/ui-compositions.bundle.json`、`scripts/ui-compositions-*.ts` の削除 | §4 |
| D: 画面 | `packages/artifact-ui/**`、`web/src/domains/ui-compositions/**`、`web/src/domains/dialogue/**`、`web/src/domains/artifact/**`、`web/src/workspace/**`（`toolchain-adapters.ts` を除く）、`web/src/app.css`、`tests/browser/ui-compositions.spec.ts` | §5・§6 |

監督者だけが編集するファイル: `api/application/server-*.ts`、`app-modules.ts`、`migrations.ts`、`toolchain/toolchain.ts`、`toolchain/toolchain-adapters.ts`、`client/index.ts`、`web/src/workspace/toolchain-adapters.ts`、`scripts/domains.ts`、`package.json`、`.s11tnext/**`、`docs/**`、`spec/**`、旧 `contexts/handler` の削除。`bun run context:build` の実行は担当Bだけが行う。

## 8 検証

各担当は自分のdomainの `bun run verify -- --domain <name>` と、追加した試験ファイルだけを実行する。全体の結線、`api/application/toolchain/specialist-dialogue.test.ts`、ブラウザ試験は、監督者が統合時に実行する。

## 9 未確定・未測定

- 代表的な構成案の出力tokens・時間・未指定箇所の維持は、実モデルで測定していない（サーバー起動の許可が必要）。4096 tokens枠を前提にし、固定試験では定義の16 KiB上限で抑える。実測で不足した場合は、計画§7の手順で担当単位の上限を追加する。
- 同じ会話のrunは直列に処理されるため、生成中の「戻って」は現在のターンが終わった後に処理される。即時に止めたい場合は、画面の停止または「会話に戻る」（`return` は進行中runを取消す）を使う。
