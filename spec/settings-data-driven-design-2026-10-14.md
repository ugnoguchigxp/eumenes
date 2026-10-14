# 設定のデータドリブン化 設計（2026-10-14）

状態: P1 実装済み・固定試験通過（2026-10-14）。P2〜P4 は未着手。根拠は現行コードの調査（2026-10-14）と、[設定全体設計](settings-openui-redesign-2026-10-12.md)・[保存先の詳細設計](settings-openui-definition-storage-2026-10-12.md)。登録の仕組みは[タイマーで実証したデータドリブン形式](timer-data-driven-implementation-contracts-2026-10-13.md)と[手順書](../docs/toolchain-extension.md)を拡張する。

## 1. 目的と進め方

設定を、bundle（項目・画面・操作の登録データ）＋登録adapter＋共通hostで動く形へ作り直す。**現行の設定（`#settings` の `SettingsPage` 13カテゴリと、OpenUI版の「設定」Hub・会話・音声と入力・表示・記録・変更一覧）には手を入れず残したまま**、新しい入口「設定（データドリブン）」を並べて作る。新版の動作確認とbundle登録（seed）が済んだ後に、利用者の判断で現行版を削除する（削除は本書の範囲外）。

設定で初めて必要になる共通の仕組みを先に作り、他のdomain移行にも使う。

| 共通の仕組み | 内容 |
| --- | --- |
| 単独公開の画面 | 会話のツールチェーンを持たないartifactを、bundleだけでランチャーへ公開する |
| 項目の登録（データ） | 項目ID・表示・入力部品・adapter所有文書内の固定path・検証schemaを登録データで持つ。単純な保存値の追加はbundleだけで済む |
| 共通下書き | 複数画面で共有する下書き、変更一覧、一括適用、競合時の保持。adapter所有文書ごとに一つ |
| 秘密の別channel | 秘密項目は下書き・outbox・受付台帳・ログ・snapshotに平文を残さない |
| 画面間の移動 | Hubから登録済みの別artifactを開くローカル操作 |

## 2. 共通契約の追加

### 2.1 単独公開のartifact

- `ArtifactDefinitionV1` に任意の `launcher: { label, group?, order? }` を加える。`launcher` を持つartifact revisionは、ツールチェーンの参照なしにランチャーへ出る。同じidの新しいrevisionを登録すると公開ポインタが切り替わる（toolchainと同じ規則。capabilitiesが管理）。
- 可用性は、artifactのsourceBindingsが参照するadapterが全て利用可能なとき。`GET /api/toolchain-artifacts` は「有効toolchainが参照するartifact」と「launcher付きの有効artifact」の和を返す。
- `launcher.group` はHubの見出し（例「使い方を変える」「管理と確認」）。Hub自体も一つのartifactとして登録する。

### 2.2 項目の登録（document fields）

adapterが所有する「文書」（設定ではsettings文書）の項目を、artifactの `fields[]` に登録データとして書く。

| 項目 | 内容 |
| --- | --- |
| `fieldId` | 安定ID。全登録で一意（例 `appearance.theme`） |
| `document` | 所有adapterの文書ref（例 `document:settings@1`）。adapterの `describe().documents` に登録済みのものだけ |
| `path` | 文書内の固定path。`$.general.theme` の形、または配列要素を安定IDで選ぶ `$.resources[id=$target].voice`。任意式・index指定は不可。adapterが自分の文書schemaに対して検査する |
| `target` | 配列要素を選ぶ場合の対象source（例 `settings-tts-resources`）。それ以外は無し |
| `label`・`help`・`group`・`detail` | 表示 |
| `control` | DesignSystemの `SettingsInputField.control` の有限集合（text・select・toggle・range・number・multiple） |
| `options`・`optionsSource` | 固定選択肢、または候補を返すadapterの登録query |
| `min`・`max`・`step`・`maxLength` | 表示の制約。正本はadapterの文書schemaで、登録時に矛盾を拒否する |
| `unset` | 空入力の意味（`delete-key`・`null`・`empty-string`）。省略可能な項目だけ |
| `confidential` | 秘密項目。§2.4の扱い |
| `visibleWhen` | adapterの登録条件ID（例 `condition:larm-voice-capable@1`）だけ。任意式は持たない |

保存は項目単位ではなく、下書きの変更一覧を一つの操作（例 `settings.apply`）に渡す。操作の入力は `{ expectedRevision, changes: [{ fieldId, target?, value } | { fieldId, target?, unset: true }], structural?: [...] }`。backendのadapterが保存済み文書へ変更を当て、文書schemaで全体を検証してから所有domainの既存公開操作（`settings.apply`）で保存する。クライアントから文書全体を送らない。

構造操作（クラウド接続・モデルの追加と削除、用途割当の連動変更）は `structural[]` に登録済みの構造操作ID（例 `structure:settings.add-connection@1`）と入力で載せ、adapterが実装する。

### 2.3 共通下書き（Web）

- 共通hostに文書ごとの下書きストアを置く（Workspace全体で一つ、`client.identity` で分ける）。複数のartifactが同じ文書の項目を表示しても同じ下書きを編集する。
- `settings-edit` は項目IDで下書きへ反映（ローカル、項目schemaで検証）。`settings-review` は変更一覧artifactを開く。`settings-apply` は下書きを凍結して書込み操作として送る（受付台帳を通る）。`settings-discard` は下書きを破棄。
- 適用成功で送った変更だけを下書きから外し、適用中の追加入力は残す。`revision_conflict` は下書きを保持して最新との差を示し、自動再送しない。同じ論理操作の再送は同じeventId。
- 変更一覧の行は登録項目の保存値と下書き値の比較から作る。秘密は件数だけ。

### 2.4 秘密の別channel

- `confidential` 項目の値は下書きのメモリにだけ置き、snapshot・変更一覧・outbox（sessionStorage）・受付台帳・ログ・LLMに平文を出さない。
- action binding に `confidentialFields: string[]`（入力内のpath）を持たせる。Webはこのfieldを含むeventをoutboxへ保存しない（応答不明時は「認証情報を再入力して適用し直してください」と表示し、自動再送しない）。
- 受付台帳は `canonical_input_json` の秘密fieldを `"[secret]"` に置き換え、input digest は秘密を含めた入力全体のHMAC（settingsのmaster keyから用途別に導出した鍵）で計算する（同じeventIdの再送照合を保つ）。鍵が無いときは秘密を含む操作を `secret_key_unavailable` で拒否する。master keyを差し替えると、既存行への同じeventIdの再送は照合できず `request_conflict` になる。
- 文書に `confidential` 項目があれば、その文書を適用するwrite actionは `confidentialFields` を宣言しなければ登録できない。Webは凍結した下書きに秘密があれば宣言に関係なくoutboxへ保存しない。

### 2.5 画面間の移動

- action binding の `effect` に `navigate` を加え、`navigateTo: { artifactId }` を持たせる。共通hostが登録済みartifactを開く（ローカル。backendへ送らない）。Hubの `settings-open` と、音声設定から接続・辞書へ移る導線に使う。

## 3. settings adapter（backend）

`api/application/settings-adapter.ts`。所有domainは settings（保存・秘密・版・接続世代）で、adapterは接続だけを持つ。

| 種類 | ID | 内容 |
| --- | --- | --- |
| 文書 | `document:settings@1` | settings文書。path検査用に `settingsSchema` |
| 操作 | `settings.apply` | `{expectedRevision, changes, structural?, keys?}` → 保存済み文書へ適用し `settings.apply` を呼ぶ。`confirmLarmOrigin` は構造操作 `structure:settings.confirm-larm-origin@1` |
| query | `query:settings.document@1` | 保存済み文書の公開descriptor（値・revision。秘密なし） |
| query | `query:settings.tts-resources@1` 等 | 配列対象（TTSモデル、接続、用途）と候補 |
| 条件 | `condition:*` | 項目の表示条件（音声カタログの能力など） |

他domainの管理操作は各domainのadapterで登録する（§5のP3）。

## 4. 画面（artifact）構成

既存のOpenUI view（`settings-navigation`・`settings-section`・`settings-changes`・`subtitle-preview`・`records-workspace`）を再利用する。足りないものはP2・P3で登録する。

| artifact | 内容 | 段階 |
| --- | --- | --- |
| 設定（データドリブン）Hub | launcher。各画面への移動 | P1 |
| 会話 | 名前・口調 | P1 |
| 表示 | テーマ・背景・字幕と見本 | P1 |
| 音声と入力 | 読み上げ・聞き取り・機器・LARM声・クラウドTTSの声と速度・試聴 | P1 |
| 変更一覧 | 下書きの確認・適用・破棄 | P1 |
| 記録 | AI利用記録・選択記録・取得手順・診断の取得 | P1 |
| AIと接続 | LARM接続、用途割当、クラウド接続とモデル、APIキー（秘密channel）、接続確認 | P2 |
| 外部作業の実行前確認 | `codingSupervision.approveInstructions` | P2 |
| 読み方辞書・記憶・動作確認・外部作業（dots）・World | 各domainのadapterと新規view | P3 |

## 5. 段階と完了条件

| 段階 | 作業 | 完了条件 |
| --- | --- | --- |
| P1 | §2の共通契約、settings adapter、settings bundle（P1の画面）、共通hostの下書き・秘密・移動、Web adapter | 現行OpenUI版の試験（会話・表示・音声・記録・変更一覧・競合・保存中の追加入力）と同じ観点の試験が新版で通る。現行画面は無変更 |
| P2 | 用途割当・LARM・クラウド接続とモデル・APIキー・実行前確認 | 現行 `SettingsPage` の ai・connections・general の試験観点（key/envRef必須、https、origin確認、接続削除の連動）が新版で通る |
| P3 | 辞書・記憶・動作確認・dots・World・ツールチェーン記録を各domainのadapterとviewで | 各パネルの既存試験観点が新版で通る |
| P4 | 新旧の比較とseed確認 | fresh/upgrade DBでbundleが登録され、ブラウザで新版の全画面が操作できる。現行版削除の判断材料を記録 |

## 6. 変えないこと

- settings domainの保存・暗号化・版・接続世代・`settings_requests` の照合は既存のまま使う。新しい保存機構を作らない。
- 画面JSON・LLM・利用者入力に任意のpath・SQL・URLを指定させない。pathは審査済みbundleの固定値だけ。
- 会話から設定を変える機能は作らない。

## 7. 実装中に決めたこと（2026-10-14）

- 読み取り（記録の表のページ送り・並べ替え・検索）は受付台帳を通さない。sourceに `paramsSchemaRef` を持たせ、`GET /api/toolchain-artifacts/:rev/sources/:source?params=<JSON>` で検証済みのparamsを渡す。UI actionの `effect: "read"` は廃止した。
- 画面間の移動は `navigateTo` の `{byValue, artifacts}` で一件のbindingから値で行き先を選ぶ。`launcher.group` 無しは上部メニュー、有りは画面内移動先としてだけ公開する。
- 登録時に、adapterの `describePath` が返す型・範囲・選択肢・省略可否と、項目の部品・選択肢・範囲・`unset`・既定値を突き合わせて矛盾を拒否する。同じ文書pathを別の項目IDで登録することも拒否する。
- 公開ポインタの切戻しは `POST /api/capabilities/toolchains/:id/publish`・`/artifacts/:id/publish`（期待する現行revisionを照合）で行う。

## 8. 現行版を削除するときの確認事項

新版のWeb（`web/src/domains/settings-data`）は、現行版の次のコードを再利用している。現行版を削除するときは、先にこれらを新版側へ移す。

- `web/src/domains/settings` の `useSettings`、`useVoiceSample`、音声カタログ（`VoiceCatalog`）、`presentationLabel`、`serviceSummary`
- 現行のOpenUI版設定（Hub・会話・音声と入力・表示・記録・変更一覧）と `#settings` の `SettingsPage` は、P2・P3で同等の画面が揃うまで削除しない（AIと接続・APIキー・辞書・記憶・動作確認・dots・Worldは現行版にしかない）。予約は新版で作らない（§10.4）。

## 9. P1 の実装記録（2026-10-14）

- 実装: §2 の共通契約（単独公開・文書項目・共通下書き・秘密の別channel・画面移動）、settings・records adapter、`settings.bundle.json`（Hub・会話・表示・音声と入力・変更一覧・記録）、Webの共通下書きと設定Web adapter。現行の `#settings` とOpenUI版設定は無変更。
- 独立レビュー1回（medium 6・low多数）を受け、1回の修正パスで対応した（`keys` の秘密宣言と登録時検査・outboxのfail-closed、Hubの未保存表示、変更一覧の値ラベル、項目と文書schemaの登録時整合検査、記録の読み取りを受付台帳から外してparams付きsource readへ、配布bundleを読むWeb試験、切戻しAPI）。
- 確認: 型検査0件、lint・書式・サイズ予算・境界・domain文書、backend 1912件、Web・client 855件、bundle検査（timers・settings）、ブラウザ `settings-data-driven`・`settings-artifacts`・`settings-display`・`timers` の22件がすべて通過。
- 未確認: 実LARM・実機器での音声設定の試聴と機器切替、記録の表の `pageSize` 変更等の実サーバでの全操作（検索まで確認）。

## 10. P2・P3 の追加契約（2026-10-14）

### 10.1 構造操作（P2）

- action binding の `draftAction` に `structure` を加え、`structure: structure:<adapter>.<名前>@n`（adapterが `describe().structures` に登録）と入力の `inputSchemaRef` を持たせる。表示用に action binding の任意 `label`。
- 共通下書きは構造操作を順に保持する（例: 接続の追加・削除、モデルの追加・削除、LARM接続先変更の確認）。追加する要素のIDはhostが生成したUUIDを入力に含め、同じ下書きの項目変更はそのIDを `target` にできる。
- 適用の入力は `{ expectedRevision, structural?: [{ structure, input }], changes, keys? }`。adapterは保存済み文書へ構造操作を先に、項目変更を後に当て、全体を文書schemaと所有domainの関連条件で検証して既存の公開操作で保存する。
- 変更一覧は構造操作を `label` と対象名で示す。秘密は件数だけ。

### 10.2 一覧編集（collection、P2・P3）

- artifact に任意の `collections[]` を加える。各要素は `source`（一覧を返すadapter query。params可）、`title`、`rowKey`（行の安定IDのfield）、`columns[]`（`key` は行オブジェクト内の固定path、`label`、`format`: text・date・number・boolean・badge）、`rowActions[]`（`actionId`・`label`・任意 `confirm` 文言・任意 `visibleWhen`）、任意 `create`（`actionId`・`label`・`fields[]`）、任意 `paging`。
- 行操作は write action で、入力は action binding の `rowInput`（入力key → `$row.<path>` または文字列の定数）から作る。行の任意値・任意pathはクライアントから送らない（hostが登録された写像で作る）。
- 作成・編集フォームの項目は `formFieldV1`（`fieldId`・`label`・`control`・`options`・`maxLength`・`min`・`max`・`required`・`confidential`）。入力は action の `inputSchemaRef` で検証し、`confidential` は `confidentialFields` に必ず含める。
- 表示は artifact-ui の新しい view `collection-workspace`（DesignSystemの `ServerDataTable`・`Form`・`ConfirmModal`・`Button` を組み合わせる。DesignSystemの公開入口は変えない）。resource は共通hostが登録とsourceデータから作り、domain固有のWebコードを必須にしない。

### 10.3 domain adapter（application）

| adapter | 主なquery | 主な操作 | 段階 |
| --- | --- | --- | --- |
| `adapter:settings@1`（拡張） | 接続・モデル・用途割当の一覧 | `settings.apply` に構造操作（接続・モデルの追加と削除、LARM接続先変更の確認） | P2 |
| `adapter:inference@1` | 接続確認の履歴、LARM詳細、直近の利用 | 接続確認の開始・取消 | P2 |
| `adapter:tts-dictionary@1` | 辞書一覧 | 保存（`expected.spoken`）・削除 | P3 |
| `adapter:memory@1` | 状態・記憶項目・傾向・短期・文脈 | 利用の有効化、忘却・停止・再開・撤回、傾向削除、継続性の遷移 | P3 |
| `adapter:world@1` | 状態・主張一覧・忘却一覧 | 訂正・撤回・忘却 | P3 |
| `adapter:dots@1` | 接続・プロジェクト・担当 | 接続・プロジェクト・担当の設定（`expectedRevision`・`expectedToken`、新規トークンは一度だけ表示） | P3 |
| `adapter:service-tests@1` | カタログ・実行・診断 | 実行・取消・アップロード | P3 |

各adapterは所有domainの既存公開操作（必要ならtransaction版を公開）を呼ぶだけで、業務判断を持たない。会話origin（`origin.kind !== "ui"`）は拒否する。

### 10.4 予約画面は作らない（2026-10-14 利用者判断）

予約（scheduler）の設定画面は新版の計画から外した。現行の `#settings` にある予約カテゴリは、現行版の削除とともに無くなる（scheduler domain自体と、会話からの時刻指定の起動は変えない）。
