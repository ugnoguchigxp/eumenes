# ツールチェーンの登録と拡張

更新日: 2026年10月14日。ツールチェーンはデータドリブン形式（bundle＋登録adapter）で追加する。設計は[タイマー設計書](../spec/timer-data-driven-ui-acceptance-design-2026-10-13.md)、実装契約は[実装契約](../spec/timer-data-driven-implementation-contracts-2026-10-13.md)。

移行状況: `timers.manage`（「タイマー」）が移行済み。楽曲生成**画面**は `music-screen.bundle.json` の単独公開artifactと登録adapterへ移し、ジャンル・雰囲気・楽器・テンポ・長さ・歌声の選択肢と初期値も画面定義へ登録した。生成・取消は既存の認証済み会話APIを使い、会話の `music.create` / `music.library` と音楽プレイリスト画面は旧形式のまま。Web検索・会話履歴・画像・Excalidraw・物体認識・dotsも未移行。旧形式の保守は[付録](#付録-旧形式固定runtime-mapの保守)、ツールチェーン全体の移行は[§6](#6-旧形式のツールチェーンを移行する)。

[作業規則](../AGENTS.md)を守る。依頼の解釈・担当選択・不足情報の判断はLLMに任せ、発話の語句・企業名・地域による振り分けを追加しない。コードで書くのは、登録済みの操作をdomainへ接続する型付きadapterだけにする。

## 1. 全体像

| 単位 | 置き場所 | 持つもの |
| --- | --- | --- |
| bundle | `api/domains/capabilities/bundles/<名前>.bundle.json`（`CapabilityBundleV1`） | 依存revisionのpin、definitions、bindings、artifacts、schemas。コード・URLは実行しない |
| definition | bundle の `definitions[]`（既存の `Definition`） | profile・skill（本文はJSON内のUTF-8）・tool・package・toolchain。toolchainは会話に出す関数名・説明・例・依存package一つ |
| binding | bundle の `bindings[]`（`CommandBindingV1`） | packageの各toolを登録adapterの操作名と入力schema参照へ結ぶ |
| artifact | bundle の `artifacts[]`（`ArtifactDefinitionV1`） | OpenUI定義のvariant、source（adapterの登録query）、action（既存event→操作・回答・ローカル） |
| schema | `builtin:<キー>`（`capabilities/contracts` のvalidators）、`domain:<owner>.<名前>@n`（hostの結果schema）、`schema:<id>@n`（bundle内JSON Schemaの有限subset） | 入力・出力・質問の検査。同じ参照をhost・UI・モデル提示で共有する |
| DomainAdapter | `api/application/<domain>-adapter.ts` | 操作・query・入力変換・projectionの実装。domainの既存公開transaction操作を呼ぶ |
| Web adapter | `web/src/domains/<domain>/toolchain-adapter.tsx` | sourceの表示snapshot、時計などのローカル操作、確定receiptの画面反映 |

実行の流れは次のとおり。

- **会話**: 候補は「有効catalog ∩ host対応adapter ∩ 現在の可用性」。会話担当がtoolchainの関数を選ぶ → command担当がbindingのtoolsだけを見て一操作（invoke）か確認質問（clarify）を返す → agent-runtimeの`action`経路 → tool-runtime → registry → adapter → domain。
- **UI**: ランチャーは `GET /api/toolchain-artifacts` の一件ずつ。共通host（`web/src/domains/toolchain-artifacts`）が登録artifactを開き、書込みは `POST /api/toolchain-actions` が受付・domain実行・receipt参照を一つのtransactionで保存する。
- **質問**: clarifyは `command_interactions` に保存され、UI（`POST /api/toolchain-interactions/:id/answers`）または会話の次の発話で回答して同じ凍結revisionで再開する。

## 2. 追加の種類を選ぶ

| 追加したいもの | 手順 | 製品コードの変更 |
| --- | --- | --- |
| 既存adapterのまま担当（profile・SKILL）・tool構成・表示variantを追加・改訂 | [§3](#3-bundleだけで追加改訂する) | なし。bundleだけ |
| 既存adapterに新しい操作を足す | [§4](#4-既存adapterに操作を足す) | adapterの操作、入力schema、bundle |
| 新しいdomainを接続する | [§5](#5-新しいdomainをadapterで接続する) | DomainAdapter、Web adapter、登録各1行、bundle |
| 旧形式のツールチェーンを移す | [§6](#6-旧形式のツールチェーンを移行する) | §5に加え旧経路の削除 |
| 新しい画面部品が要る | [§10 E](#10-e-designsystemopenuiartifactを追加する) | DesignSystem部品とOpenUI登録 |
| 履歴調査の要件profile・dotsの担当 | [§9 A](#9-a-登録apiで追加する) | なし。登録API |
| 単純なHTTP JSON API | 未対応 | `HttpJsonBindingV1` と実行器（`tool-runtime/service/http-json.ts`）はfixture試験のみで、hostの接続設定に未接続 |

まず「何を入力して何が返れば完了か」「どのadapterを再利用するか」「今回どこまで確認するか」を短く記録する。既存adapterで同じ操作ができるならadapterを増やさず§3を使う。

## 3. bundleだけで追加・改訂する

1. **bundleを作る**: `api/domains/capabilities/bundles/<名前>.bundle.json`。`formatVersion:1`、`bundleId`、`pins`、`definitions`、`bindings`、`artifacts`、`schemas`。起動時に名前順で全bundleを検査・登録する。
2. **依存を固定する**: bundle外の既存revision（再利用するpackage・tool等）は `pins` に revision ID と digest で書く。digestは次で得る。

   ```sh
   bun run toolchain:bundle -- pins package:timers.manage@1 tool:timer.start@1
   ```
3. **definitionsを書く**: 新しいprofile・skill・package・toolchainを書く。本文はJSON文字列で持ち、既存revisionの本文は変えない。toolchainの必須項目は `functionName`（`^[a-z][a-z0-9_]{2,40}$`、全体で一意）、`summary`、`useWhen`（1件以上）、`examples`（3件以上・各200字以内。候補検索の索引と評価に使う）、`redirects`、`dependencies` と `packageRevisionId`（同じpackage一つ）、`bindingRevisionId`、`artifactRevisionId`。表示はartifact登録が担うので、旧形式の `artifact` 項目は不要（書いても使われない。新しく書かない）。
4. **bindingを書く**:

   | 項目 | 内容 |
   | --- | --- |
   | `id`・`revision` | revision ID は `binding:<id>@<revision>` |
   | `adapterRef`・`availabilityRef` | hostに登録済みのadapterと可用性（例 `adapter:timers@1`・`availability:timers@1`） |
   | `tools[]` | `toolRevisionId`（packageのtoolの部分集合）、`operationId`（adapterの登録操作名）、`inputSchemaRef`（toolの`schemaKey`なら`builtin:<schemaKey>`と一致。adapter側の操作schemaとも一致） |
   | `outputSchemaRef`・`resultProjectionRef` | domainの結果schemaと会話回答用projection |
   | `artifactRevisionId` | 表示に使うartifact。toolchainの値と一致させる |
   | `questions`（任意） | command担当が確認質問に使える回答schema。`builtin:answerText`（自由文）は常に使えるので書かない。対象選択の質問は `choiceField` に候補で埋めるfieldを書き、候補はadapterの `choicesInTransaction` がhostのデータから出す（モデルは候補を作らない） |

5. **artifactを書く**:

   | 項目 | 内容 |
   | --- | --- |
   | `title` | ランチャーとタブの名前。保存項目ごとに入口を増やさない |
   | `variants[]` | `definition`（登録viewのOpenUI JSON。layout可、16 KiB以内）と、質問が開いているときの `questionDefinition`（`question` leafを含む）。`defaultVariant` で既定を選ぶ。`?artifactVariant=<id>` で比較用に切替えられる |
   | `sourceBindings[]` | OpenUIの `source` 名 → `adapterRef` と登録 `query`。`target` は `none`・`required`（hostが発行したID、例: timer id）・`optional`。読み取りに条件（ページ・並べ替え・検索）が要るなら `paramsSchemaRef` を書き、クライアントは `GET …/sources/:source?params=<JSON>` で渡す（受付台帳を通さない） |
   | `actionBindings[]` | 既存の `eventAction` と `source` → `operationId`（adapter操作）か `answer:true`（開いた質問への回答）、生入力の `inputSchemaRef`、必要なら `inputAdapterRef`（例 `input:timer-hms@1`）。`effect` は `write`（受付台帳を通る）、`local`（Web adapterが処理）、`navigate`（`navigateTo` の登録artifactを開く。固定 `artifactId` か、eventの値で選ぶ `{byValue, artifacts}`）、`draft`（共通下書きの `edit`・`discard`）。同じ `source`＋`eventAction` は一件だけ |
   | `launcher`（任意） | ツールチェーン無しで画面を公開する。`group` 無しは上部メニュー、`group` 有りは画面内移動（Hub等）の行き先としてだけ公開。`label`・`description`・`order` |
   | `fields[]`（任意） | adapterが所有する文書の登録項目（§3.1） |

   **3.1 文書の項目と共通下書き**（設定で使用。[設計](../spec/settings-data-driven-design-2026-10-14.md)）

   | 項目 | 内容 |
   | --- | --- |
   | `fieldId` | 全登録で一意の安定ID（例 `appearance.theme`） |
   | `document`・`path` | adapterの文書（例 `document:settings@1`）と、審査済みの固定path（`$.general.theme`、配列要素は安定IDで `$.resources[id=$target].voice` と `target` に対象source）。adapterの `checkPath` が文書schemaで検査する。クライアントはpathを送らない |
   | `control`・`options`・`optionsSource`・`min`・`max`・`step`・`maxLength`・`defaultValue` | 表示と入力。正本は文書schema。`defaultValue` は表示だけで変更として書かない |
   | `unset` | 空入力の意味（`delete-key`・`null`・`empty-string`） |
   | `visibleWhen` | adapterが宣言しWeb adapterが実装する登録条件（例 `condition:settings.larm-style@1`） |
   | `confidential` | 秘密。下書きのメモリだけに置き、snapshot・変更一覧・outbox・受付台帳・ログに平文を残さない。送る操作は `confidentialFields` に入力keyを書き、台帳はHMACだけを保存する |

   編集は `draft` actionで共通下書き（文書ごと・利用者ごとに一つ、複数画面で共有）へ入り、`draftDocument` を持つwrite actionが `{expectedRevision, changes, keys?}` を一つの操作として送る。adapterが保存済み文書へ変更を当てて全体を検証し、所有domainの既存公開操作で保存する。適用中の追加入力は残り、`revision_conflict` では下書きを保持して自動再送しない。

6. **schemaを書く（必要な場合だけ）**: 既存の `builtin:` で足りなければ bundle の `schemas[]` に有限subsetのJSON Schemaを置く。使えるのは object/properties/required/additionalProperties:false、string（minLength・maxLength・enum）、number/integer（minimum・maximum・enum）、boolean、array（items・minItems・maxItems）。`$ref`・`pattern`・`format`・`oneOf`等は拒否される（黙って捨てない）。モデルへ渡すtool入力は平坦objectにする。
7. **検査する**: 書き終えたら dry-run で全issueを一覧する。何も保存しない。

   ```sh
   bun run toolchain:bundle -- check api/domains/capabilities/bundles/<名前>.bundle.json
   ```

   | issue | 直す場所 |
   | --- | --- |
   | `invalid_format`・`invalid_toolchain` | bundle・definitionの必須項目と型 |
   | `unknown_reference`・`dependency_cycle` | revision ID の綴り、bundle内の依存順、pinの漏れ |
   | `digest_mismatch`・`revision_conflict` | pinのdigest（`pins`で取り直す）。同じrevisionで内容を変えていないか（変えるなら新revision） |
   | `unregistered_adapter`・`unregistered_operation`・`unregistered_query`・`unregistered_input_adapter`・`unregistered_projection`・`unavailable` | hostに無いadapter・操作。§4・§5で登録するか、既存の名前を使う |
   | `schema_mismatch`・`unsupported_schema` | toolの`schemaKey`とbindingの`inputSchemaRef`、`questions` のschemaと `choiceField`、subsetの範囲 |
   | `duplicate_function` | 他のtoolchainと同じ`functionName` |

8. **登録を確認する**: backendを通常の起動経路で起動すると登録される。登録できないbundleは丸ごと飛ばされ `capability.bundle_skipped` が出る（`bun run logs -- --level warn`）。会話の候補は `dialogue.candidates_selected`、UIの入口は `GET /api/toolchain-artifacts` で確認する。

最小例として、既存のtimer adapterとtoolを使い、担当の指示だけを変えた別の会話入口を足すbundleの骨格を示す（例示用ID）。

```json
{
  "formatVersion": 1,
  "bundleId": "timers.kitchen",
  "pins": [
    { "revisionId": "tool:timer.start@1", "digest": "<pinsの出力>" },
    { "revisionId": "tool:timer.list@1", "digest": "<pinsの出力>" },
    { "revisionId": "tool:timer.cancel@1", "digest": "<pinsの出力>" }
  ],
  "definitions": [
    { "kind": "profile", "id": "timers.kitchen", "revision": 1, "title": "台所タイマー担当", "summary": "調理の時間を扱う", "aliases": [], "tags": [], "useWhen": [], "avoidWhen": [], "dependencies": [], "body": "…" },
    { "kind": "skill", "id": "timers.kitchen", "revision": 1, "title": "台所タイマー操作", "summary": "…", "aliases": [], "tags": [], "useWhen": [], "avoidWhen": [], "dependencies": [], "body": "…" },
    { "kind": "package", "id": "timers.kitchen", "revision": 1, "title": "台所タイマー", "summary": "…", "aliases": [], "tags": [], "useWhen": ["…"], "avoidWhen": [], "backend": "timer", "schemaKey": "timerCommand",
      "dependencies": ["profile:timers.kitchen@1", "skill:timers.kitchen@1", "tool:timer.start@1", "tool:timer.list@1", "tool:timer.cancel@1"],
      "profileRevisionId": "profile:timers.kitchen@1", "requiredSkillRevisionIds": ["skill:timers.kitchen@1"],
      "toolRevisionIds": ["tool:timer.start@1", "tool:timer.list@1", "tool:timer.cancel@1"] },
    { "kind": "toolchain", "id": "timers.kitchen", "revision": 1, "title": "台所タイマー", "functionName": "kitchen_timer", "…": "§3の必須項目",
      "dependencies": ["package:timers.kitchen@1"], "packageRevisionId": "package:timers.kitchen@1",
      "redirects": [],
      "bindingRevisionId": "binding:timers.kitchen@1", "artifactRevisionId": "artifact:timers.workspace@1" }
  ],
  "bindings": [ { "kind": "binding", "id": "timers.kitchen", "revision": 1, "…": "timers.bundle.json の binding と同じ形" } ],
  "artifacts": [],
  "schemas": []
}
```

実在の完全な例は [timers.bundle.json](../api/domains/capabilities/bundles/timers.bundle.json)。既存artifactを参照する場合は bundle に artifact を重複して書かない。

## 4. 既存adapterに操作を足す

1. **入力schema**: 既存キーで足りなければ `api/domains/capabilities/contracts/` に新しいvalidatorキーを追加する。既存キーのschemaは変えない（hashが変わり旧revisionが壊れる）。bundle内schemaで済むならコード変更は不要。
2. **adapterの操作**: `describe().operations` に操作名・`inputSchemaRef`・`effect`（read/write）を加え、`invokeInTransaction` でdomainの既存公開transaction操作を呼ぶ。domainに公開操作が無ければdomain側へ足す（他domainのSQLを直接触らない）。UIの対象付き操作なら `sourceInTransaction`・`targetInput` も確認する。
3. **定義**: 新toolの定義（新revision）、それを含むpackageの新revision、bindingの新revision、toolchainの新revisionをbundleに書く。旧revisionは書き換えない。
4. **Web**: UI操作を足すなら artifact の新revisionで `actionBindings` を足し、Web adapterの `settled` がそのreceiptを画面へ反映するか確認する。
5. **試験**: adapterの操作単体（正常・拒否・replay・revision競合）と、bundleの `check`。

## 5. 新しいdomainをadapterで接続する

### 5.1 backendのadapter

`DomainAdapter`（`api/domains/tool-runtime/contracts/adapters.ts`）を `api/application/<domain>-adapter.ts` に実装する。例は [timer-adapter.ts](../api/application/timer-adapter.ts)。

| メソッド | 役割 |
| --- | --- |
| `ref`・`describe()` | `adapter:<owner>@1`、操作（入力schema・effect）、query、入力変換、projection、可用性 |
| `availableInTransaction` | このhostで今使えるか。falseなら会話にもランチャーにも出ない |
| `snapshotInTransaction` | command担当に見せる対象一覧（hostのデータ。モデル生成IDを含めない） |
| `invokeInTransaction` | 検証済み入力で一操作。domainの既存公開transaction操作を呼び、receipt・receiptRef・resultRefs・replay・会話回答用 `answerContext` を返す。拒否は `/^[a-z_]+$/` のcodeで投げる |
| `readInTransaction` | 保存済みreceiptの再読込み（回答直前のrefresh・照合） |
| `sourceInTransaction`・`targetInput` | UI source の現在値とrevision、source対象から操作入力（例: timerId と expectedRevision）への変換 |
| `choicesInTransaction`（任意） | bindingの `questions` で `choiceField` を持つ質問に、hostのデータから出す候補 |
| `afterCommit`（任意） | commit後の通知（scheduler起床、変更publish） |

登録は3か所。

- `api/application/toolchain.ts` の `createAdapterRegistry([...])` に1件。
- `api/application/toolchain-adapters.ts` の `hostAdapterDescriptions` に1件（bundle検査・評価用。domainサービス無しで`describe`を返す）、結果schemaがあれば `domainSchemas` に1件。
- domain側に公開transaction操作と、必要ならcommit後通知を用意する。

### 5.2 Webのadapter

`WebArtifactAdapter`（`web/src/domains/toolchain-artifacts/registry.ts`）を `web/src/domains/<domain>/toolchain-adapter.tsx` に実装し、`web/src/workspace/toolchain-adapters.ts` に1行足す。共通hostが登録の解決・variant・action配送・outbox・照合を受け持つので、WorkspaceArtifactsへ分岐を足さない。

| `AdapterState` | 役割 |
| --- | --- |
| `phase`・`snapshot` | sourceごとの表示resource（質問sourceはhostが作る） |
| `targetOf(source)` | eventに付ける対象ref |
| `local(binding, event)` | ローカル操作（backendへ送らない） |
| `settled(binding, result, timing)` | 確定したdomain receiptを画面へ反映、関連queryの無効化 |
| `refresh()` | revision競合時の読み直し（旧操作を自動再送しない） |
| `describeRejection`・`answerInput`（任意） | domainの言葉での拒否理由、質問への回答文→回答schemaの入力 |

### 5.3 現在の制約

- 新しい見た目が必要なら[§10 E](#10-e-designsystemopenuiartifactを追加する)でDesignSystem部品とOpenUI viewを追加する。
- scopeは単一（`DEFAULT_TIMER_SCOPE`）。複数利用者のscope境界は未設計。

## 6. 旧形式のツールチェーンを移行する

タイマーで行った手順を一般化したもの。

1. 現行の公開操作・受付・receipt・UIを固定試験で押さえる（比較基準）。
2. §5でadapterとWeb adapterを作る。domainの業務処理・時計・保存はdomainに残す。
3. bundleを書く。既存packageを再利用するならpinで固定し、toolchainは**新revision**（例 `@2`）にして `bindingRevisionId`・`artifactRevisionId` を足し、旧形式の `artifact` 項目は外す。domain固有の確認質問があればbindingの `questions` に宣言する。表示名・入口は一つにする。
4. 旧経路を削除する: `builtin/toolchains.ts` の旧toolchain定義、`runtime-meta.ts` の固定runtime（toolchainと`localAction`等）、dialogueの専用分岐、Webの専用hostとWorkspaceArtifactsの分岐。DB上の旧revisionはデータとして残る。
5. 固定試験（domain・application結合・ブラウザ）を新経路へ合わせ、`check`・domain verify・ブラウザを通す。
6. 自然言語受入の凍結ケースを用意し、必要なら旧UIをbaselineにpilotする（[自然言語UI受入](nl-acceptance.md)）。

## 7. 版更新・公開・切戻し

- 同じ `kind:id@revision`（binding・artifactも同様）で内容を変えると `capability_revision_conflict`。変更は新revisionで追加する。
- 公開ポインタは同じidの新しいtoolchain revisionを登録した時点で切り替わる。実行中のrunは開始時に凍結したrevisionとbinding digestで続く。
- 切戻しは認証済みの `POST /api/capabilities/toolchains/:id/publish`（単独公開の画面は `/api/capabilities/artifacts/:id/publish`）に `{revisionId, expectedActiveRevisionId}` を送り、binding を持つ以前のrevisionへ戻す。現在の公開revisionが期待と違えば409で何も変えない。binding の無い旧revisionは固定runtimeを削除済みなので、戻すとその能力は提供されなくなる（停止スイッチとして働く）。保存済みdomain状態・receiptは巻き戻さない。
- 新規DBへの登録だけでなく、旧版をseed済みの隔離DBへ新版を追加するケースも試す。二度目のseedは冪等であること。

## 8. 確認・止まりやすい場所・完了報告

検証の段階と範囲は[検証手順](toolchain-extension-verification.md)。データドリブン形式で最低限見るのは次のとおり。

| 確認 | 成功条件 | 入口 |
| --- | --- | --- |
| bundle | `check` がissue無し。fresh・upgrade両方で登録でき、旧revisionのhashが変わらない | `bun run toolchain:bundle -- check …`、`api/domains/capabilities/test/bundles.test.ts` |
| adapter | 各操作の正常・拒否・replay・revision競合、conversation originの対象検査 | adapterの単体試験（例 `api/application/timer-question.test.ts`） |
| 会話 | 候補提示 → command → 保存receipt → 回答。clarifyで質問が保存され、回答で再開する | `api/application/timer-toolchain.test.ts`、`api/domains/dialogue/test/command-interactions.test.ts` |
| UI操作 | 受付と実行の原子性、同ID再送、時刻窓、source/action偽装の拒否 | `api/domains/tool-runtime/test/action-requests.test.ts` |
| 画面 | 入口一件、操作、競合、通信断からの照合 | Web adapterの試験、`tests/browser/<domain>.spec.ts` |
| 自然言語受入 | 凍結した目的・基準で、host状態から判定 | [自然言語UI受入](nl-acceptance.md) |

| 症状・code | 最初に確認する場所 | 対応 |
| --- | --- | --- |
| 会話にもランチャーにも出ない | `capability.bundle_skipped` ログ、`check` の結果、adapterの `availableInTransaction` | issueを直す。hostにadapterを登録する |
| 会話には出るがUIの入口が無い | `GET /api/toolchain-artifacts`、Web adapterの登録行 | `artifactRevisionId` とWeb adapterの `adapterRef` を揃える |
| `adapter_unavailable` | bindingの `adapterRef`、registry | adapterを登録する。未知backendへのfallbackは無い |
| `toolchain_command_invalid_arguments` | bindingの `inputSchemaRef` とモデルへの提示schema | 入力契約を揃える。制約を弱めて通さない |
| UI操作が `rejected`（HTTP 200） | `errorCode`（例 `revision_conflict`、domainの拒否） | 最新を読み直す。自動再送しない |
| 422 `invalid_input` | actionの `inputSchemaRef`・`inputAdapterRef` | field errorを画面の言葉で示す |
| 503 `artifact_unavailable`・`effect_mismatch` 等 | artifactの `adapterRef`・actionの `effect` と adapter操作の `effect` | 定義を揃える |
| 質問に答えても進まない | `GET /api/toolchain-interactions/:id` の status・expiresAt・revision | 期限切れ・取消済み・古いrevisionは新しい依頼として扱う |

ログは `bun run logs -- --level warn` から始め、runId・jobId・HTTPの `X-Request-Id` で絞る。通常ログへ会話本文・秘密・Provider生応答を保存しない。

完了報告には、bundleのrevision ID一覧、公開操作 → package → binding → adapter → domain → artifact の接続、変更ファイル、固定試験の結果、未実施のlive・実機器・自然言語受入を記し、「登録済み」「固定試験済み」「実LLM・自然言語受入済み」を区別する。

## 9. A 登録APIで追加する

既存の認証・Origin検査を使う。以下のJSONはAPIの本文またはCLIの入力ファイルであり、認証なしで呼べるという意味ではない。CLIはAPIを使う。製品DBへ直接書き込まない。

### A1 要件profileを登録する

変更する製品ファイルはない。次を `history-criteria.json` として用意する。これは例であり、本書の編集ではファイル作成・登録を実行しない。

```json
{
  "version": 1,
  "title": "履歴の決定事項",
  "scope": "保存済みの会話から決定事項を確認する依頼",
  "requirements": [{
    "id": "decision",
    "statement": "会話で決まった内容を示す",
    "required": true,
    "applicability": "決定事項を尋ねている場合",
    "allowNotApplicable": false,
    "valueSchema": { "type": "string" }
  }],
  "provenance": { "kind": "user" }
}
```

```sh
bun run cli -- requirements import history-criteria ./history-criteria.json new --json
bun run cli -- requirements show history-criteria --json
```

改訂はshowで取得した`stateToken`を`new`の代わりに渡す。APIでは `PUT /api/capabilities/requirements/history-criteria` に `{"expectedStateToken":null,"data":上記JSON}` を送る。更新時はnullを現行tokenへ置き換える。競合時は最新内容を読んで判断し、無条件に再送しない。

登録後は有効状態とrevisionを確認する。会話には短いrefが提示され、LLMがhistoryに適用するものを選ぶ。登録しただけで常時適用されるわけではなく、webへ渡してはいけない。上限・無効化・再有効化は[要件の登録と改訂](toolchain.md#要件の登録と改訂)を参照する。

### A2 dotsの担当packageを登録する

Web の dots 設定画面は削除したため、APIで保存する。dotsが有効で標準依存`tool:dots.coordinate@1`がseed済みの環境で `PUT /api/capabilities/dots-packages` へ次を送る。

```json
{
  "id": "dots.user.0123456789abcdef0123456789abcdef",
  "expectedToken": null,
  "title": "文書レビュー担当",
  "summary": "指定された文書の矛盾と不足を報告する",
  "profile": "依頼された文書をレビューし、指摘と根拠を報告します。",
  "skills": [{
    "title": "文書レビュー",
    "body": "対象文書と指定された参照資料を読み、問題箇所、影響、修正案を整理します。編集を依頼されていなければ変更しません。"
  }],
  "enabled": true
}
```

1. 新規IDは`dots.user.`＋小文字16進数32桁で生成する。例の固定IDを繰り返し使わない。
2. 応答の`revisionId`と`stateToken`を保存する。改訂時は同じIDと現行`stateToken`を`expectedToken`へ渡す。
3. `/api/dots/projects` で対象プロジェクトに返された担当版を指定して保存する。`capabilityRevisionId`の更新が必要で、packageの保存だけではプロジェクトの担当は切り替わらない。
4. `GET /api/capabilities/dots-packages`とプロジェクト設定で、版・有効状態・担当の接続を確認する。

profile・skill・packageの生成とrevision更新はAPIが行う。skillsは1〜4件、profileとSkill本文の合計には14,000 bytesの枠がある。新規Sessionや成果返却の実受入は別段階であり、登録成功を実行成功と扱わない。接続とプロジェクト設定は[dotsの設定手順](dots.md#設定して使う)を使う。

## 10. E DesignSystem・OpenUI・Artifactを追加する

UIが必要なツールチェーンの画面部品をこの手順で用意する。データドリブン形式では、部品をOpenUIへ登録した後の接続はbundleのartifact（variants・sourceBindings・actionBindings）とWeb adapterで行い、E4のホスト直書きは旧形式の画面だけに使う。表示を追加するだけなら新しい担当やbackendを作らない。

### E1 既存の部品で組めるか決める

| 状況 | 必要な変更 | 次の手順 |
| --- | --- | --- |
| 必要なviewがOpenUIへ登録済み | 表示JSONと、必要ならホストのsource接続 | E4・E5 |
| DesignSystemに部品はあるがOpenUIにはない | viewのschema、描画adapter、必要なsource・操作契約 | E3〜E5 |
| 既存部品の組合せでは必要な操作を満たせない | 再利用できるDesignSystem部品、Storybook、操作試験を追加 | E2〜E5 |

登録済みviewの正本は [viewRegistry](../packages/artifact-ui/src/contracts.ts)、DesignSystemの公開部品は [index.ts](../packages/design-system/src/index.ts)。既存viewの組合せには`layout`を使う。独自部品を作る場合は、既存部品で不足する操作を作業記録に一文で残す。例えば音楽プレイヤーは、音声の再生位置・シーク・前後10秒・曲送りを一体で扱うため、MusicPlayerとして追加した。

### E2 必要なDesignSystemコンポーネントを作る

リポジトリルートからの変更先は次のとおり。`<Name>`だけを新しい部品名へ置き換える。

| 変更先 | 内容 |
| --- | --- |
| `packages/design-system/src/components/<Name>/<Name>.tsx` | props・イベントと描画。業務APIや認証を持たせない |
| 同ディレクトリの`<Name>.css` | 既存のデザイントークンで配色・余白・状態を表現 |
| 同ディレクトリの`index.ts` | コンポーネントとprops型を公開 |
| 同ディレクトリの`<Name>.stories.tsx` | 通常・処理中・失敗・無効状態など、その部品に必要な状態 |
| 同ディレクトリの`<Name>.test.tsx` | 利用者の操作とイベント、キーボード操作、必要な状態遷移 |
| `packages/design-system/src/index.ts` | パッケージの公開exportを追加 |

最小の登録形は、実装済みのGenerationStatusなら次になる。

```ts
// components/GenerationStatus/index.ts
export { GenerationStatus, type GenerationStatusProps } from "./GenerationStatus";
// src/index.ts に追加
export * from "./components/GenerationStatus";
```

```tsx
import { GenerationStatus } from "@eumenes/design-system";

<GenerationStatus status="running" title="生成しています" />
```

[GenerationStatusの実装](../packages/design-system/src/components/GenerationStatus/GenerationStatus.tsx)と[Storybook](../packages/design-system/src/components/GenerationStatus/GenerationStatus.stories.tsx)を最小の参照先とする。生成状況はpropsで渡し、取得できない進捗率を時間から作らない。取消・再試行などの業務操作はcallbackでホストへ返す。MusicPlayerの再生・シークのようなブラウザ内の部品動作は部品が扱う。

### E3 OpenUIへ登録する

DesignSystemからexportしただけでは、OpenUIのJSONから呼べない。次を接続する。

| 変更先 | 必要な内容 |
| --- | --- |
| `packages/artifact-ui/src/contracts.ts` | `viewRegistry`へ名前・label・strict schemaを追加。新しいデータや操作が必要なら`Resource`・`ArtifactEvent`も拡張 |
| `packages/artifact-ui/src/media-contracts.ts` | 音楽・生成状態のsource型。別用途は適切な契約ファイルに定義し`Resource`へ接続 |
| `packages/artifact-ui/src/media-components.tsx`または`components.tsx` | runtimeのsourceをDesignSystemのpropsへ変換する描画adapter。必要な操作だけdispatchする |
| `packages/artifact-ui/src/library.tsx` | `renderers`へviewと描画adapterを追加。SDKのleaf登録は`viewRegistry`から生成される |
| `packages/artifact-ui/src/compiler.ts` | view名とsourceのkindが違う場合、`checkSource`の対応を追加。存在しないsource・種類違いは拒否する |

最小のview登録例は、既存の`source`・`title`バリデータを使うGenerationStatusのエントリー。

```ts
// contracts.ts の viewRegistry 内
"generation-status": {
  name: "GenerationStatus",
  label: "生成の状態",
  schema: z.strictObject({ view: z.literal("generation-status"), source, title }),
},
// library.tsx の renderers 内（GenerationViewをimportする）
"generation-status": GenerationView,
```

このviewが読むsourceのkindは`generation`なので、`checkSource`にもその対応が必要。音楽プレイヤーとPlaylistはいずれも`music`を読む。描画adapterの完成例は[media-components.tsx](../packages/artifact-ui/src/media-components.tsx)。操作を増やす場合は、イベントを受けるホストの権限・revision・重複処理とreceiptまで実装する。ボタン表示だけで接続完了にしない。

### E4 JSONで組み合わせ、ホストへ接続する

登録済み部品を組み合わせる最小例。任意の楽曲IDをJSONへ埋め込むのではなく、ホストが公開したsource名を参照する。

```json
{
  "view": "layout",
  "direction": "grid",
  "title": "楽曲とプレイリスト",
  "children": [
    { "view": "generation-status", "source": "generation-example" },
    { "view": "music-player", "source": "music-example" },
    { "view": "playlist", "source": "music-example" }
  ]
}
```

`direction`は`stack`または`grid`。現在はleafを1〜12件配置でき、layoutの入れ子は非対応。定義全体は16 KiB以内。source名は小文字英字で始まる英小文字・数字・ハイフンの1〜64文字。任意のReact props、JavaScript、取得先URLを追加しても受理されない。

ホスト接続の最小例は、操作のない生成中表示なら次のとおり。

```tsx
import { ArtifactRenderer, type ArtifactRuntime } from "@eumenes/artifact-ui";
import "@eumenes/artifact-ui/styles";

const definition = JSON.stringify({ view: "generation-status", source: "job1" });
const runtime: ArtifactRuntime = {
  snapshot: {
    job1: { kind: "generation", revision: 1, status: "running", title: "生成しています" },
  },
  dispatch: async () => ({ status: "rejected", message: "この表示には操作がありません" }),
};
// ホストコンポーネント内で返す
<ArtifactRenderer definition={definition} runtime={runtime} />
```

これは固定状態の表示例。実際の生成経過は、認証済みAPIの状態からsnapshotを更新する。上の音楽合成例では、同じruntimeに`generation-example`（kind=`generation`）と`music-example`（kind=`music`）を用意する。音楽sourceの最小形は`{kind:"music", revision:1, currentId:"track1", tracks:[{id:"track1", title:"曲名", url:audioUrl}]}`。`audioUrl`はホストが許可済みの音声を取得して用意するHTTPSまたはBlob URLであり、表示JSONには保存しない。

| ホスト側の変更先・参照例 | 役割 |
| --- | --- |
| `web/src/domains/music/artifact-definition.ts` | 結果IDから表示JSONを作る既存例 |
| `web/src/domains/music/use-music-runtime.ts` | 認証済み一覧・音声取得、選曲、revision、取消と遅延応答の破棄、Blob解放の既存例 |
| `web/src/components/domains/music/MusicArtifact.tsx` | runtimeを共通ArtifactRendererへ渡すホスト。部品の見た目はここへ再実装しない |
| `web/src/domains/artifact/store/index.ts`と`web/src/App.tsx` | `{id, kind:"openui", title, definition}`のタブを開き、ホストへ接続する |

新しい用途のsourceは所有domainの公開APIから作り、他用途のmusic hookへ混ぜない。ホストに許可されたsourceだけを公開し、操作時にも権限・版を確認する。音声の取得取消と生成そのものの取消は別であり、後者はAPI接続がある場合だけ有効にする。

Artifactが保持する表示定義はJSONとし、専用の`kind`やReactコードを増やさない。ただし、現行のArtifactタブはインメモリーで、再読込み後のタブ復元は未実装。DBへのJSON保存・復元が要件なら別途範囲に含め、実装前に対応済みと書かない。

WebGLなどパッケージに持ち込まない描画は、viewを `source` なしで登録し、ホストが `ArtifactRuntime.hostViews` で描画を渡す（例: 光の精霊の動作試写 `avatar-motion-lab`。`ToolchainArtifactHost` が `LightAvatarMotionLab` を渡す）。hostViewsの無いホストでは「利用できません」と表示する。tabsの各タブは `arrangement: "form-preview"` で、設定項目と字幕の見本を一つの設定欄にまとめて表示できる。

LLMに表示の選択・構成を任せる場合は、公開済みview・source・入力schemaをSystemContextとツール契約へ提示する。UI登録だけで会話に新しいツールが公開されるわけではない。既存操作の結果を既定の画面で開く用途では、その返却経路を再利用する。

### E5 完了条件と記録

[UI検証手順](toolchain-extension-verification.md#uiを追加変更した場合)に従い、部品→JSONとホストの結合→画面の順で確認する。他の登録済みUIと組み合わせ、表示だけでなく今回必要な操作まで確認する。保存済み成果物で確認できる変更なら生成APIを再実行しない。

作業記録には、再利用した部品、新設が必要だった理由、登録view、sourceと操作の接続、JSON例、確認した状態・操作、失敗と未確認を残す。音楽UIの実績とfixtureの制約は[OpenUI移行の検証記録](../spec/verification/music-openui-2026-10-11/README.md)を参照する。

物体認識の登録例は `builtin/object-recognition.ts` と `builtin/object-recognition/SKILL.md`。既存command経路で入力画面・保存結果・取消を扱い、`object-recognition-workspace`をアーティファクト領域内に表示する。APIと検証入口は[物体認識](object-recognition.md)を参照。

Excalidrawの登録例は `builtin/excalidraw.ts` と `builtin/excalidraw/SKILL.md`。queueのplan/open二段階で結果を採用し、OpenUIの`drawing-workspace`とEumenesの認証済みWeb入口へ返す。sceneの正本は上流、Eumenesは図IDと版の参照を保持する。接続・API・配備前提は[Excalidraw連携](excalidraw.md)を参照する。

## 付録 旧形式（固定runtime map）の保守

未移行のツールチェーン（Web検索・会話履歴・音楽・画像・Excalidraw・物体認識・dots）は、`builtin/toolchains.ts` の定義と `runtime-meta.ts` の固定runtimeで動く。新規追加は本文の§3〜§5を使い、ここは既存の旧形式を移行までの間に直す場合だけに使う。移行は[§6](#6-旧形式のツールチェーンを移行する)。

### 付録B 既存ツールを使うpackageを追加・改訂する

#### 変更箇所

以下のパスはリポジトリルートからの相対パス。

| 順序 | 変更先 | 追加・確認する内容 |
| --- | --- | --- |
| 1 | `api/domains/capabilities/builtin/<対象>.ts`とSkill本文 | profile・skill・packageのDefinition。公開済みの版は残す |
| 2 | `api/domains/capabilities/service/builtin-seed.ts` | 新しい定義配列ならimportし、対応backendが有効なとき登録する。既存配列へ追加する場合は追加配線不要 |
| 3 | `api/domains/capabilities/contracts/runtime-meta.ts` | 新package IDの予算・報告方式。既存IDの新revisionは同じ設定を引き継ぐ |
| 4 | `api/domains/agent-runtime/service/start-task.ts` | 新しい実行で起動する正確な`package:<id>@<revision>` |
| 5 | `api/domains/capabilities/builtin/toolchains.ts` | 会話へ出す新経路なら[0章](#1-全体像)のツールチェーンを追加し、`packageRevisionId`で版を指す。会話の関数・方針は手で書かない |
| 6 | `api/domains/dialogue/service/delegate-conversation.ts` | 新しいruntime条件が必要な場合だけ`prepareRouting`の利用可否へ追加する。既存経路の版更新なら変更不要 |
| 7 | 所有domainのtest、`api/application/`の該当結合試験 | 登録、選択、起動したpackageの版、報告方式、会話への返却 |

登録順は依存が先、packageが最後。`dependencies`は依存閉包を作る一覧、`profileRevisionId`・`requiredSkillRevisionIds`・`toolRevisionIds`はその中で実際に使う役割指定なので、両方を揃える。profileとskillには空でないbody、toolにはschemaKeyが必要。packageにも入力に合うschemaKeyを指定する。

#### 最小例 既存のquick担当を改訂する

新しい公開操作やadapterを作らず、`web.quick@2`のSkillを変える例。`api/domains/capabilities/builtin/web-research.ts`の既存配列の組立て後へ追加する想定である。`Definition`は`../contracts`からimportする。

```ts
const quickV2 = builtins.find(
  d => d.kind === "package" && d.id === "web.quick" && d.revision === 2,
)!;
const briefSkill: Definition = {
  kind: "skill", id: "web.brief", revision: 1,
  title: "短い公開情報の確認", summary: "要点と出典を短く返す",
  aliases: [], tags: [], useWhen: [], avoidWhen: [], dependencies: [],
  body: "依頼に答える資料を取得し、対象・時点・単位を保って要点を短く返します。不足は明示します。",
};
builtins.push(briefSkill, {
  ...quickV2,
  revision: 3,
  dependencies: quickV2.dependencies.map(ref =>
    ref === "skill:web.search@1" ? "skill:web.brief@1" : ref),
  requiredSkillRevisionIds: ["skill:web.brief@1"],
});
```

この例ではツールチェーン`web.search`の`packageRevisionId`を新しい版へ向ける(ツールチェーンも新revisionにする)。`start-task.ts`はツールチェーンが指すpackageを起動するので変更不要。旧`@2`は削除しない。metadataはpackage IDの`web.quick`に紐づくため変更不要。会話ツール、tool schema、外部adapter、inferenceには変更不要。報告契約と共通方針はそのまま使い、Skillで上位の権限・予算を変えない。

#### 新しいpackage IDを並行して追加する場合

上の例でpackageを`id: "web.brief", revision: 1`にすれば別IDの定義になる。ただし、次も必要になる。

- `runtime-meta.ts`のpackagesへ `"web.brief": { budget: "quick", report: "search" }` を追加する。
- 既存quickと併存させる場合、`package:web.brief@1`を指す別のツールチェーン(例 `functionName:"web_brief"`)を登録する。`aliases`や`useWhen`だけを追加しても起動先は変わらない。
- 既存経路を置き換える場合は、起動先と説明を更新する。どちらの用途かを先に決め、併存の依頼で既定経路を勝手に置き換えない。

併存の配線例は次の対応を一組として実装する。これは未実装の例である。

| 接続 | 例で追加する内容 |
| --- | --- |
| `builtin/toolchains.ts` | `web.brief`ツールチェーン。`useWhen`・`examples`・既存`web.search`との`redirects`を双方に書く。会話の引数は共通の`{request}`のまま |
| `runtime-meta.ts` | toolchainsへ`"web.brief": { execution: "research", route: "web" }` |
| 結合fixture | 呼出しから開始したpackageRevisionIdまで確認。会話の選択と起動先が一致することを試す |

`web.brief`というIDや上の分岐を共通機構へ追加するのは、利用者がこの独立経路を必要としている場合だけ。単に短く答えたい場合は先の既存package改訂で足りる。

### 付録C 既存backendにツールを追加する

#### 変更箇所と順序

| 順序 | 変更先 | 内容 |
| --- | --- | --- |
| 1 | `api/domains/capabilities/contracts/index.ts` | 新しい引数ならZod schemaとvalidatorsのキーを追加。既存と同じなら再利用 |
| 2 | `api/domains/capabilities/builtin/<対象>.ts` | toolのDefinitionを追加し、利用packageの新revisionに依存とtoolRevisionIdsを追加 |
| 3 | `api/domains/capabilities/contracts/runtime-meta.ts` | toolsへ操作分類・URL範囲・保存本文の要否を登録 |
| 4 | 所有domainのadapter/service | tool IDを実際の公開操作へ変換し、入出力を共通契約へ合わせる |
| 5 | `api/application/toolchain.ts`、必要なら`research-history-ports.ts` | 外部・保存本文・履歴の適切な実行先へ接続する |
| 6 | Bの起動先と試験 | 改訂packageを起動し、モデルへ提示されたツールを実行して結果を返す |

会話が既存の担当を選び、workerが新ツールを使うだけなら、会話のツールを増やす必要はない。Provider側のschemaも含め、提示する引数とホストが受理する引数を一致させる。Zodの独自refineがJSON Schemaで表現されない場合は、既存の契約変換とホスト検査の両方を確認する。

#### 最小例 URL本文を読むツールの登録接続

登録箇所を示すための例として`web.document`を使う。実際に既存`web.read`と同じ機能でよければ、別名を増やさず既存ツールを使う。

```ts
// builtin/web-research.ts: 利用packageより前に追加
builtins.push({
  kind: "tool", id: "web.document", revision: 1,
  title: "公開文書を読む", summary: "許可された公開URLの本文を取得する",
  aliases: [], tags: [], useWhen: [], avoidWhen: [], dependencies: [],
  backend: "web", schemaKey: "read",
});
```

```ts
// contracts/runtime-meta.ts の tools へ追加
"web.document": { operation: "read", urlScope: "request_or_observed" },
```

`web-research/adapters/toolchain.ts`の`webToolArguments`は現状`web.lookup`と`web.read`だけを許可する。この例を実装する場合は、許可するIDに`web.document`を加え、既存の`operation:"read", retention:"none"`へ接続する。取得、取消、保存本文、根拠検査は既存Web経路を使う。tool定義だけ追加してもこのadapterは呼べない。

利用packageは新revisionとして、`dependencies`と`toolRevisionIds`の両方へ`tool:web.document@1`を含める。既存`web.read`を置き換えるなら両方の参照を置き換え、Bの起動先も更新する。別の引数・別の外部操作を追加する場合は、その操作のschemaと所有domainの公開操作も先に実装する。

#### 実行分類を省略しない

| metadata | 現行の意味 | 省略・誤設定の影響 |
| --- | --- | --- |
| toolの`operation:"search"` | 検索予算として計上 | 未登録は検索として計上されず、期待した上限にならない |
| `operation:"read"`と`urlScope` | 外部読取と、依頼・観測URLへの制限 | URL制限を設定しないとこの制限が働かず、ツール別上限も変わる |
| `operation:"saved_read"`、`requiresSavedBody:true` | 保存本文をlocal経路で読む | 未設定では外部adapterへ進み得る |
| `operation:"history"`、必要なら`cursorPaging:true` | 履歴のlocal処理とcursor制御 | 新しいローカル機能を便宜上history扱いにしない |
| packageの`report:"search"` | V2報告を直接返し、要件抽出・意味検証をしない | 未登録は要件付き報告の経路になる |
| packageの`budget:"quick"` | 検索1・本文1・モデル5回の枠 | 名前にquickを含めても自動では適用されない |

metadataはrevision本文に保存されず、ID単位で全revisionへ適用される。既存IDのmetadata変更は、そのIDの旧版にも影響する。報告や権限の意味を変える場合は、revision更新だけでは隔離できない点を計画に記す。

### 付録D backend・実行担当・更新操作を追加する

これは定義だけの登録ではなく、共通機構に新しい実行先を接続する作業。次の三つを区別する。

| 種類 | 主な変更先 | 最小の接続単位 |
| --- | --- | --- |
| 別サービスから資料を取得 | 所有domain、`api/application/toolchain.ts`、capabilitiesのseed/backend有効集合 | 受付・キュー実行・取得結果・取消・根拠の所有者/版検査 |
| 同じツール群を別モデルで実行 | `api/domains/inference/contracts/index.ts`、同service/adapter、agent-runtimeのstart-task/step-handler、会話の公開条件 | engineの保存・capture・execute・receipt採用・stream/非stream・取消 |
| データを書き換える操作 | 所有domainの公開操作、tool-runtimeのActionAdapter/ActionEnvelope、agent-runtime、会話と結果返却 | 現在の人間の依頼による権限・冪等性・transaction・操作receipt・失効 |

`backend:"archive"`を書くだけで外部adapterは追加されない。`engine`も現状は任意のモデル名を登録する欄ではなく、追加の契約が必要。`local_action`とActionEnvelopeも現在はtimer専用なので、更新操作をreadやhistoryに見せかけない。

#### 最小例 新しい資料取得backendの定義と接続

`archive.read`が公開URLの文書を別サービスから読む想定。引数は既存の`read`、package入力は`research`を再利用できる場合の例である。実装する外部サービスの仕様・接続設定・結果形式は別途必要で、以下だけでは稼働しない。

```ts
// builtin/archive.ts の定義例。Definitionは ../contracts からimport。
const base = { revision: 1, aliases: [], tags: [], useWhen: [], avoidWhen: [], dependencies: [] };
export const archiveBuiltins: Definition[] = [
  { ...base, kind: "profile", id: "archive.reader", title: "文書担当",
    summary: "文書の情報を返す", body: "依頼された文書から要点と出典を返します。" },
  { ...base, kind: "skill", id: "archive.read", title: "文書参照",
    summary: "許可URLを読む", body: "指定URLを読み、回答に必要な情報と不足を報告します。" },
  { ...base, kind: "tool", id: "archive.read", title: "文書取得",
    summary: "許可された公開URLの文書を取得", backend: "archive", schemaKey: "read" },
  { ...base, kind: "package", id: "archive.read", title: "文書の確認",
    summary: "指定文書から答える", backend: "archive", schemaKey: "research",
    dependencies: ["profile:archive.reader@1", "skill:archive.read@1", "tool:archive.read@1"],
    profileRevisionId: "profile:archive.reader@1",
    requiredSkillRevisionIds: ["skill:archive.read@1"],
    toolRevisionIds: ["tool:archive.read@1"] },
];
```

1. `builtin-seed.ts`で配列をimportし、`backends.has("archive")`のとき依存順に登録する。`api/application/toolchain.ts`の有効backend集合へ、サービスが利用可能な場合だけarchiveを追加する。
2. `runtime-meta.ts`のtoolsへ `"archive.read": {operation:"read",urlScope:"request_or_observed"}`、packagesへ `"archive.read": {budget:"quick",report:"search"}` を追加する。この予算とV2報告が用途に合う場合に限る。
3. 所有domainで以下のToolAdapter契約を実装し、application層で既存adapterと接続する。ネットワーク実行はtransaction内に置かず、キューの実行段階へ渡す。
4. `get`と`cancelInTransaction`はtool IDを受け取らないため、受付時のoperationIdから同じbackendへ戻せるようにする。開始だけを新サービスへ向け、完了照会や取消をWebへ流さない。再起動後の照合も所有domainの保存情報を使う。
5. Bの併存例と同じように、会話の明示操作から`package:archive.read@1`へ接続する。外部URLは依頼で許可された範囲を渡す。資料の意味による担当選択はLLMに任せる。

| ToolAdapterの入口 | 実装する戻り値・役割 |
| --- | --- |
| `startInTransaction(db, request)` | `{operationId, jobId}`。requestId、owner、deadline、parentJobIdを引き継ぐ |
| `get(operationId)` | pending、succeeded、partial、failed、cancelled等の状態と共通ToolResult |
| `cancelInTransaction(db, operationId)` | 所有domainの取消公開操作を呼び、取消対象job IDの配列を返す |
| `prepareSourcesInTransaction` | 取得資料をモデルへ提示できるSourceへ変換。viewId・正確な本文・版・取得時点を保持 |
| `validateEvidenceInTransaction` | 採用時に所有者、版、期限、失効を検査 |
| `releaseTask` / `releaseRoot` | 担当の一時参照・保存本文を解放 |

契約の正本は[ToolAdapterとToolResult](../api/domains/tool-runtime/contracts/index.ts)。現在の`research-history-ports.ts`はWeb保存本文と履歴を扱うため、新backendの資料を無条件に渡さない。受け取る資料に応じた変換と検査をapplication層で接続する。新backend固有のデータを、架空の履歴参照や既存Webの所有者参照に置き換えない。

別モデルの最小参照実装は[Codexアダプタ](../api/domains/inference/adapters/codex-research.ts)、更新操作は[timer-operation](../api/domains/agent-runtime/service/timer-operation.ts)と`api/application/toolchain.ts`のtimerActions。サービス仕様の違う新担当に、そのまま流用して完成と扱わない。接続設定・認証・取消・receiptを満たす最小範囲を実装する。

### 付録R revision更新と起動時登録

登録の正本は[registerRevision](../api/domains/capabilities/service/registry.ts)。同じ`kind:id@revision`で内容が変わると`capability_revision_conflict`になる。

1. 公開済みの定義・Skill本文をそのまま残す。変更した定義を新revisionとして追加する。
2. Skillをファイルから読む場合は版別ファイルを使い、旧定義が新しい本文を読むように変更しない。
3. 依存先が変わったpackageも新revisionにし、`dependencies`と各役割のrevision参照を揃える。
4. schema変更はschemaHashにも影響する。同じschemaKeyが旧tool/packageにも使われている場合、そのvalidatorsを上書きすると旧定義まで変わる。旧schemaを残し、新schemaKey・新tool/package版を使う必要があるか確認する。
5. 定義は依存順、同じIDの版は旧→新の順でseedする。Webのseedには既存旧版の保全処理があるが、全backend共通の移行機能だと仮定しない。
6. 新しい実行が選ぶ版を更新する。会話起動はstart-task、dotsはプロジェクト設定。実行中の固定参照を手動で書き換えない。
7. backendを通常の起動経路で起動しseedする。API/CLIの一覧で登録を確認する。任意のpackageを追加する汎用PUT APIや、一覧だけで会話の起動先を更新する機能はない。

新規DBへの登録だけでなく、旧版をseed済みの隔離DBへ新版を追加するケースも用意する。既存DBを削除して競合を隠さない。有効な現行版・旧版の読取り・二度目のseedの冪等性を確認する。
