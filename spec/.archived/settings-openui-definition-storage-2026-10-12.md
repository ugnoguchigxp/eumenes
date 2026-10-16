# 設定項目の登録と保存先の詳細設計

画面レビューで予約は今回の案から除外し、Projectと「委任した作業」は後日検討とした。以下の関連保存表・公開操作は既存実装の調査記録であり、今回のUI登録対象や実用受入済みの機能を意味しない。辞書は現行の3列表と保存操作を再現する。

状態は設計案。2026年10月12日の現行ソースとAstraの保存先調査に基づく。製品コード、DBスキーマ、認証方式の変更はこの文書では実施しない。

薄い設定入口と目的別OpenUIアーティファクトへ、設定項目を少ない変更で追加できるようにする。追加者は項目の型、表示、所有domain、保存先、保存操作、反映時期を定義する。Webはその定義から共通部品を表示し、既存の所有domainが値を検証して保存する。

基本方針は[設定全体設計](settings-openui-redesign-2026-10-12.md)に従う。本書は項目をどこへ保存するか、追加時に何が必要かを具体化する。サービス試用と読み方辞書は既存画面のレイアウトと操作を再現する。ほかの画面見本は外観を合わせる資料とし、値の型と操作の契約は本書を正本にする。

## 保存先と実行の分離

大半の設定は、[settings repository](../../api/domains/settings/repository/index.ts)にある`settings_document`の`id=1`の行、`document`列にJSONとして保存される。名前やテーマに専用の列があるわけではない。接続とモデルもこのJSONの配列で、別のconnectionsテーブルへ保存しているわけではない。

登録定義の保存先情報は、実装者が変更範囲を確認するための監査情報である。実際の書込みは公開操作を通す。画面JSON、LLM、利用者の入力に任意のテーブル、列、SQL、JSONパスを指定する権限を与えない。

| 登録の種類 | 用途 | 実行方法 |
| --- | --- | --- |
| 保存値 | テーマ、名前、音量、用途割当など | 型付き項目IDで共通下書きを編集し、既存settings.applyへ一括適用 |
| 管理操作 | 辞書保存、予約作成、World訂正、担当登録など | 所有domainの公開操作IDと、その操作固有の入力と結果schemaへ接続 |
| 読み取り表示 | 利用記録、選択記録、試用履歴、接続状態など | 許可済みquery IDと表示schemaへ接続。保存欄を作らない |

管理操作は、単一の列更新とは限らない。対象の版、権限、履歴、派生索引、結果の失効などを含むため、保存先情報から汎用SQLを生成しない。

## 最小の項目定義

設定項目は所有domainごとの登録モジュールに置き、applicationで必要な登録だけを組み合わせる。登録定義のための新しいDBや外部プラグイン実行機構は作らない。表示部品を選ぶために全設定の名前を比較する条件分岐も作らない。

| 定義 | 必須の内容 |
| --- | --- |
| fieldId | 用途や表示名が変わっても維持する安定ID。全登録内で一意 |
| owner | 検証と保存を所有するdomain |
| artifactIdとgroup | 表示先とまとまり。Hubと検索の入口にも使用 |
| labelとhelp | 利用者向けの短い名称と説明 |
| valueSchema | 現行契約の型、必須性、文字数、範囲、刻み、選択肢。保存schemaを再利用し、UI側で別の制約を正本にしない |
| control | 登録済みの入力部品。text、toggle、number、range、select、search-select、multiselectなど必要な有限集合 |
| bindingIdとtargetSchema | 登録済みの読取と下書き反映先。配列項目はresourceIdやconnectionIdなど安定IDで対象を特定 |
| saveScope | 共通settings下書き、対象別操作、即時操作、読み取り専用のいずれか |
| effect | 次の返答、次の発話、次の音声開始、保存時の失効など、現行の反映境界 |
| availability | 対応能力と対象状態から得る利用可能性。非対応と取得失敗を区別 |
| confidentiality | 一般入力か、秘密専用channelが必要か |
| storageLocations | テーブル、行キー、列、必要なら固定JSONパス、関連する正本と派生物。サーバーと設計資料で管理 |
| definitionVersion | 項目の意味と契約の版。保存文書のrevisionとは別 |

valueSchemaからブラウザへ渡せる型と制約を導出し、動的な候補はqueryのsourceから補う。複雑な関連条件は所有domainが検証する。任意の検証式やJavaScriptをdescriptorに埋め込まない。

例えばテーマの定義は、`fieldId=appearance.theme`、表示先は表示、型は`system/light/dark`、部品はselect、保存範囲はsettings、保存先は`settings_document(id=1).document`の`$.general.theme`、実行は既存settings.applyとする。追加時にHub、検索、変更一覧、描画のそれぞれへ手作業で同じ項目を登録し直さない。

背景のように既存の保存値を表示する場合も同じ手順である。保存先が既存ならDB migrationは不要で、表示定義を登録して既存schemaへ接続する。新しい業務設定なら、その値を実際に読む所有domainの変更は別に必要であり、登録だけで機能が生まれたとは扱わない。

### 登録例

次はサーバー登録の概念例であり、現行の実行可能なAPIではない。schemaRefとbindingIdは所有domainが登録した実体だけを参照する。sourceと入力の検証を省略して、文字列から自由な保存処理を作る仕組みにはしない。

```json
{
  "fieldId": "appearance.theme",
  "owner": "settings",
  "artifactId": "appearance",
  "label": "テーマ",
  "schemaRef": "settings.general.theme",
  "control": "select",
  "saveScope": "settings-document",
  "bindingId": "settings.general.theme",
  "storageLocations": [
    { "table": "settings_document", "rowKey": { "id": 1 },
      "column": "document", "jsonPath": "$.general.theme" }
  ]
}
```

モデル別の声は、同じ項目定義をresourceIdごとのsourceとして使う。保存先の配列位置を固定せず、`resources`内の`id=resourceId`を特定してvoiceを変更する。候補はそのモデルの声カタログqueryであり、項目定義へ全件を埋め込まない。

```json
{
  "fieldId": "resource.voice",
  "owner": "settings",
  "artifactId": "voice-input",
  "label": "声",
  "schemaRef": "settings.resource.voice",
  "control": "search-select",
  "targetSchemaRef": "settings.resource-id",
  "optionsQueryId": "inference.tts-voices",
  "saveScope": "settings-document",
  "bindingId": "settings.resource.voice",
  "storageLocations": [
    { "table": "settings_document", "rowKey": { "id": 1 },
      "column": "document", "array": "resources",
      "elementKey": "id", "target": "resourceId", "field": "voice" }
  ]
}
```

対象別停止は保存値の欄ではなく操作として登録する。予約の停止を例にした以下の説明は操作契約の調査記録で、今回の画面登録は行わない。対象を表示用sourceから選び、入力schemaとガードを使って公開操作を呼ぶ。stateを直接更新するbindingを作らない。

```json
{
  "operationId": "schedule.pause",
  "owner": "scheduler",
  "artifactId": "schedule",
  "label": "一時停止",
  "inputSchemaRef": "scheduler.schedule-operation",
  "bindingId": "scheduler.pause",
  "saveScope": "domain-operation",
  "guard": "expectedRevision",
  "storageLocations": [
    { "table": "scheduler_schedules", "elementKey": "id",
      "target": "scheduleId", "fields": ["state", "revision", "updated_at_ms"] }
  ]
}
```

通常の単一保存値は、信頼された登録にある固定pathと所有schemaから共通bindingを構築する。新しいscalar項目ごとに手書きのSQLや画面イベント処理を追加しない。動的配列は登録済みのキー選択方式を使い、構造変更と管理操作は既存公開操作へのbindingを使う。

ブラウザへ公開するdescriptorは、ID、ラベル、入力型と制約、候補source、保存範囲、状態、許可操作だけへ絞る。上例のstorageLocationsは監査資料とサーバー側に残す。LLMが表示を構成する場合も、この公開descriptorと許可sourceを使う。

## アーティファクトと操作の定義

アーティファクトは、安定ID、題名、許可する項目IDと操作ID、既定の登録view構成を持つ。新しい通常項目を追加したときは既存部品で描画でき、既存アーティファクトへ追加するだけでHubの検索と変更一覧へ反映される。

OpenUI定義は例えば`view=settings-section, source=settings-appearance`という短い参照にする。これは新規登録予定のviewとsourceであり、現行でそのまま実行できる定義ではない。sourceには現在値、下書き値、項目状態、対応能力、許可操作を渡す。秘密と物理保存先は渡さない。

| 編集イベントの情報 | 扱い |
| --- | --- |
| eventId | 重複操作の照合。保存のrequestIdと役割を分ける |
| artifact/source ID | この表示が扱える項目と操作を検査 |
| fieldIdとtarget | 登録済み項目と安定した対象ID。配列位置を指定させない |
| draftRevision | 古いフォームや変更案からの上書きを拒否 |
| definitionVersionとtargetEpoch | 古い項目契約や、変更前の接続とモデルを拒否 |
| change | setまたはunsetを区別。setの値は項目schemaで検証 |

unsetは省略可能な項目だけに許可する。空文字、null、省略、provider既定値を同一視しない。例えば辞書の空の読み方には意味があり、LARMの空のvoiceは既定音声を使う指定である。無効な数値の入力途中はフォームの編集状態に残し、NaNや入力途中の文字列を共通設定文書へ入れない。

保存値と表示上の有効値を分け、値の由来を保存済み、アプリ既定、provider既定として保持する。カタログ読込で既定値を知っただけでは設定を書き換えない。接続変更で候補が消えた場合も、値を黙って丸めたり消したりしない。

管理操作は操作ごとのstrict input schema、対象schema、権限、競合ガード、結果schemaを持つ。`expectedRevision`、辞書の`expected.spoken`、担当の`expectedToken`は互換ではないため、一律revisionへ変換しない。即時操作の受付と、長い処理の完了を区別する。

## 共通設定の全保存先

以下のJSONパスはすべて、既存の`settings_document`、行キー`id=1`、列`document`の中である。すべての通常編集は共通下書きから`POST /api/settings/apply`へ送り、全体のstrict schemaと関連条件で検証する。

### 会話と表示

| 項目ID | JSONパス | 現行の型と制約 | 表示先 |
| --- | --- | --- | --- |
| conversation.agent-name | $.general.agentName | string、最大40文字、空欄可 | 会話 |
| conversation.user-name | $.general.userName | string、最大40文字、空欄可 | 会話 |
| conversation.persona | $.general.persona | butler、maid、strategist、sage | 会話 |
| appearance.theme | $.general.theme | system、light、dark | 表示 |
| appearance.background | $.general.background | light-fairy、spatial、省略可能 | 表示 |
| appearance.subtitle-enabled | $.general.subtitles.enabled | boolean | 表示 |
| appearance.subtitle-style | $.general.subtitles.style | netflix、prime、classic、glass | 表示 |
| appearance.subtitle-size | $.general.subtitles.size | medium、large、xlarge | 表示 |

### 入力と読み上げの共通設定

| 項目ID | JSONパス | 現行の型と制約 | 表示先 |
| --- | --- | --- | --- |
| input.languages | $.general.asrLanguages | 許可済み言語コードの配列、1件以上、重複不可 | 音声と入力の聞き取り |
| speech.enabled | $.voice.autoSpeak | boolean | 音声と入力の読み上げ |
| speech.volume | $.voice.outputVolume | number、0から1 | 同上 |
| speech.barge-in | $.voice.bargeIn | boolean | 同上 |
| input.device | $.voice.inputDevice | string、最大300文字、空欄はシステム標準 | 機器 |
| output.device | $.voice.outputDevice | string、最大300文字、空欄はシステム標準 | 機器 |
| input.threshold | $.voice.threshold | number、0.001から0.1 | 聞き取り詳細 |
| input.silence | $.voice.silenceMs | integer、300から3000、保存単位ms | 同上 |
| input.echo-cancellation | $.voice.echoCancellation | boolean | 同上 |
| input.noise-suppression | $.voice.noiseSuppression | boolean | 同上 |
| input.auto-gain | $.voice.autoGainControl | boolean | 同上 |

無音時間を秒で表示する場合は表示と保存の単位変換を定義し、保存時には整数msへ戻す。ブラウザで再生機器を切り替えられない場合も、保存済みdevice IDを黙って空へ変更しない。

### LARM接続と音声設定

| 項目ID | JSONパス | 現行の型と制約 | 表示先 |
| --- | --- | --- | --- |
| larm.url | $.larm.baseUrl | URLまたはnull、ローカル接続と関連条件 | AIと接続 |
| larm.profile | $.larm.profile | string、最大200文字 | 同上 |
| larm.audience | $.larm.audience | saaa-desktop、same-host | 同上 |
| larm.speech-voice | $.larm.voice | string、最大200文字、空欄は既定音声 | 音声と入力 |
| larm.speech-speed | $.larm.speed | number、0.5から2、省略可能 | 同上 |
| larm.speech-style | $.larm.style | 非空string、最大200文字、省略可能 | 読み上げ詳細 |
| larm.speech-pitch | $.larm.pitchScale | number、-0.15から0.15、省略可能 | 同上 |
| larm.speech-intonation | $.larm.intonationScale | number、0から2、省略可能 | 同上 |
| larm.speech-auto | $.larm.autoIntonation | boolean、省略可能 | 同上 |
| larm.speech-strength | $.larm.autoStrength | number、0から2、省略可能 | 同上 |

sentenceLanguageEnabledとsentenceLanguageProviderは既存JSONにある内部接続方針で、今回利用者向けの選択欄は追加しない。englishVoice、englishMasculineVoice、englishSpeedは旧設定の読取互換用であり、現行のRosie/Jasperと速度1固定を維持する。これらの保存存在を、編集可能な項目登録へ自動変換しない。

### 用途割当

対象はpurposeの`llm/asr/tts`。次の3項目を各用途に登録する。pは許可済みpurposeであり、任意のJSONキーではない。

| 項目ID | JSONパス | 現行の型と関連条件 |
| --- | --- | --- |
| route.mode | $.routes[p].mode | larm-preferred、larm-only、cloud-only |
| route.cloud-allowed | $.routes[p].cloudAllowed | boolean。取消して適用すると実行中の結果にも効く |
| route.cloud-resource | $.routes[p].fallbackId | resource UUIDまたはnull。用途一致、cloud-onlyは許可と対象が必要 |

各用途のepochはbackend管理である。ユーザーに編集欄を作らない。クラウド送信許可をなくす変更に必要な用途修正は、同じ下書きの変更一覧で確認できるようにする。

### クラウド接続とモデル

配列はindexで指定せず、connectionsはconnectionId、resourcesはresourceIdで一意に選ぶ。`[id=target]`は監査用の選択記法であり、クライアントから実行可能なJSONパスではない。

| 項目ID | JSONパス | 現行の型と制約 |
| --- | --- | --- |
| connection.name | $.connections[id=target].name | 非空string、最大80文字 |
| connection.kind | $.connections[id=target].kind | 現行4接続種類、省略はopenai-compatible。作成と変更は対応adapterの契約で扱う |
| connection.url | $.connections[id=target].baseUrl | URL。外部はHTTPS、認証情報やqueryを埋め込まない |
| connection.enabled | $.connections[id=target].enabled | boolean |
| connection.env-ref | $.connections[id=target].envRef | 許可済み環境変数名またはnull。ホストと認証方法の関連条件あり |
| connection.agent | $.connections[id=target].agentId | agent IDまたはnull、省略可。Managed Agentsで必要 |
| connection.environment | $.connections[id=target].environmentId | environment IDまたはnull、省略可。同上 |
| resource.connection | $.resources[id=target].connectionId | 存在するconnection UUID |
| resource.purpose | $.resources[id=target].purpose | llm、asr、tts。SDK接続は会話だけ |
| resource.model | $.resources[id=target].model | 非空string、最大200文字 |
| resource.context | $.resources[id=target].contextWindow | integer、2048から2000000またはnull。会話で必須 |
| resource.voice | $.resources[id=target].voice | string最大200文字またはnull。TTSで非空必須 |
| resource.speed | $.resources[id=target].speed | number、0.5から2、省略可 |
| coding.confirm-instructions | $.codingSupervision.approveInstructions | boolean。外部作業の実行前確認 |

接続登録は最大32件、モデル登録は最大128件。id、epoch、document revisionは管理値として扱う。接続変更、削除、モデル用途変更は関連する割当と秘密の状態をまとめて検証する構造操作であり、単一のscalar field更新だけで完了しない。

resource.voiceとspeedは音声の編集部品から扱う。モデル登録時もその部品を開き、接続画面へ独立した声の編集経路を作らない。

### 秘密と関連保存

| 保存先 | キーと内容 | 公開操作 |
| --- | --- | --- |
| settings_credentials.encrypted | idはconnectionId:epoch。認証情報の暗号文 | ApplySettings.keysで更新と削除。平文を設定JSONへ入れない |
| settings_connection_epochs.epoch | idはconnectionId。削除後も保持する接続世代 | settings.applyの内部処理 |
| settings_requests.digestとresult | idはrequestId。同じ内容の再送照合と保存結果 | settings.apply。現行の最新64要求の保証を維持 |

秘密入力は別channelでホストのメモリへ置き、keysのvalueとして保存操作にだけ送る。空欄は既存の秘密を維持し、削除はvalue=nullという明示操作である。envRefと平文キーの同時指定は不可。接続先origin変更時の既存確認とキー再指定要件を保持する。

## 管理操作の保存先

以下は現行ソースを確認した対応である。relatedの表や列も公開操作が責任を持つ。UIから一部だけ直接更新する登録はしない。

| 対象 | 正本と主な保存フィールド | 公開操作とガード |
| --- | --- | --- |
| 読み方辞書 | tts_dictionary、キーwritten、列spokenとupdated_at | list/save/delete。originalとexpected.spoken、見出し変更時の旧行削除と新行保存、キャッシュ失効 |
| メモリー利用 | memory_host_settings、id=1、enabledとrevision | memory.setEnabled。変更時の利用版更新と実行中結果の失効を維持 |
| 予約 | scheduler_schedules、id。target_payload_jsonの$.textと$.conversationId、mode、anchor_at_ms、interval_ms、state、revision | scheduler.create/pause/resume/cancel。作成のrequestIdとdigest、状態操作のexpectedRevision。next_due_at_msは派生値 |
| 予約履歴 | scheduler_occurrencesのschedule_id、schedule_revision、scheduled_at_ms、state、job_id、reason | listOccurrences。読み取り表示 |
| dots接続 | dots_connections、id、data_jsonのtitle、enabled、oauth各項目、revision。local_token_hashは別列 | configureDotsConnection。expectedRevisionとOAuth変更制限、関連実行の失効。平文トークンは新規時の一度だけ表示 |
| dotsプロジェクト | dots_projects、ref、connection_refとdata_jsonのtitle、connectionRef、nativeProjectId、hostId、environment、enabled、capabilityRevisionId、allowedOperations、revision | configureDotsProject。列とJSONの双方、接続と権限、版、関連実行の更新を同じwriterで扱う |
| 担当とSkill | capabilities所有のcapability_items、capability_revisions.definition_json、capability_dependencies、検索索引 | configureDotsPackage。expectedToken。packageのtitleとsummary、profile revisionのbody、skill revisionのtitleとbodyを一対多で登録 |
| 委任作業 | work_tasksのstateとdata_jsonのtitle、request、completionConditions、grant、revision、authorityEpoch、executionGeneration。work_task_grantsなど関連表 | tasks.create/start/amend/answer/stop/forget。入力と結果schema、権限と状態遷移を使う |
| World訂正と撤回 | package所有world_assertionのprincipal、scope_key、id、revision、payload_jsonとlifecycle。訂正値はpayload_jsonの$.payload.value。head、transition、evidence、operation等も関連 | worldClaims.correct/retract。対象版と根拠発言を確認し、新版を作る。既存JSONやprojectionへの直接上書きは不可 |
| World忘却 | world_host_forget_intakeのroots_jsonとstate、journal情報、confirmationとepoch。packageのforget、tombstone、scope gate、依存先も関連 | worldClaims.forget。受付、journal、World適用、Memory確認、完了を別状態として追う。全削除先は対象の依存関係で変わる |
| 取得手順 | toolchain_recipesのstateとconsecutive_failures等。検索とvector表も関連 | setRecipeState/deleteRecipe。有効化の失敗数リセット、削除の関連索引更新を維持 |

担当とSkillの役割本文をdots_projectsのJSONへ埋め込む設計にはしない。packageはprofileRevisionIdとrequiredSkillRevisionIdsで別revisionを参照する。WorldとMemoryのパッケージ内部への直接編集を追加せず、導入済み版の公開操作を使う。

### 記録と試用の保存と寿命

| 表示と操作 | 保存先 | 寿命と書込権限 |
| --- | --- | --- |
| AI利用記録 | inference_attemptsのsource、connection_id、resource_id、model、status、reason、accepted、tokens、provider_details。inference_requestsと用途を結合 | inference.usageで直近100件を読む。設定欄として更新や削除しない |
| 接続プローブ | inference_probesのtarget、status、error、revision、created | startProbe/cancelProbe。保存版と結果を結び付け、古い結果を区別 |
| サービス試用の実行記録 | service_test_runsのrequest_key、input_hash、created、data。data内のtargetId、model、kind、status、phase、revision等 | serviceTestsの既存操作。要求照合と取消を維持 |
| 試用入力と結果の表示 | カタログ、実行中controller、プレビュー、アップロードはメモリにも保持 | previewとuploadは最大30分。DBの実行記録があることを、画像や音声の永久保存と同一視しない |
| 作業の選択記録 | toolchain_selectionsのdecision、候補、history、選択処理、outcome等 | listSelections/getSelection。読み取り表示 |
| 外部実行の補助記録 | dots_commands、dots_reports、dots_sessions、dots_schedules、dots_reminders、dots_subscriptions、dots_deliveries | 各公開操作から読む。作業取消や忘却をwork_tasksだけの更新にしない |

## 新しいTTS固有項目の保存案

現行Resourceにはvoiceとspeedがあるが、話し方の指示など任意のprovider optionsを保存する欄はない。次は追加時の設計案であり、既存の保存先ではない。

Resourceへ省略可能な`ttsConfiguration`を加え、`$.resources[id=target].ttsConfiguration`へ保存する案を第一候補にする。内容はadapterId、configurationVersion、adapterが定めるstrictなoptionsで、声と速度の既存項目を重複してoptionsへコピーしない。

新APIへの対応では、adapterが公開する項目定義と保存schemaと要求変換を同じ契約版で結び付ける。動的な能力情報はカタログにあり、設定文書へ複製しない。未知adapterや未対応契約版の既存設定は黙って別APIへ転送しない。

JSON項目追加はtable追加を必須としない。ただしstrict schemaの読取互換と既存モデルへの影響を検証する。voice等をoptionsへ全面移設するmigrationは今回必須とせず、重複保存を避ける。

## 軽く追加できる範囲と必要作業

| 追加の種類 | 必要な変更 | 変えない部分 |
| --- | --- | --- |
| 既存保存値に通常の入力欄を追加 | 項目定義、既存schemaへのbinding、表示グループ | Hubの個別分岐、検索実装、変更一覧、保存writer |
| 既存のselectへ候補を追加 | 所有schemaと候補定義。対応する利用処理の確認 | フォームの専用ページ |
| 新しい業務設定 | 所有domainのschema、既定値、利用処理、保存先定義、必要なmigration、回帰検証 | 共通の下書きと適用機構 |
| 新しいTTSのAPI | 接続adapter、対応能力、strict設定schema、要求と音声応答変換 | 汎用フォームとHub。API差異の吸収をLLMへ毎回要求しない |
| 既存管理操作の表示追加 | operation/query定義、既存公開操作へのbinding、既存view構成 | そのdomainの保存と権限処理 |
| 既存部品にない操作 | 必要なDesignSystem部品とOpenUI view、sourceとactionを登録 | backendの業務判断をUI packageへ移さない |

追加者の手順は、保存値か操作か読取かを決め、所有domainと保存先を確認し、schemaとbindingを登録し、既存部品を選び、既定のアーティファクトへ配置し、登録と保存の対応検査を行う。既存保存値なら少量の登録で済む一方、APIや業務機能の追加に必要な実装を省略する仕組みではない。

## 保存の流れと競合

項目編集はschemaで検証した後、ホストの共通下書きへ反映する。変更一覧には項目IDと対象、保存済み値と編集値を載せる。秘密の値は載せない。適用時は最新の下書きをfreezeし、既存のApplySettingsへ変換してexpectedRevisionとrequestIdを付ける。

保存成功は送信した変更だけに反映し、保存中の追加入力を残す。競合時は現在の下書きを捨てず、最新の保存値との違いを示す。schemaだけで判断できる非重複項目の差分整理と、意味上の採用判断を分ける。無言で再適用しない。

新規接続、モデルの追加と削除、認証更新は構造操作としてstageし、scalar fieldと同じrevisionの共通下書きを使う。安定IDの存在、用途一致、認証送信先、許可取消、削除した接続の参照を全体で検証する。

個別domainの操作は既存の公開APIと固有のガードを維持し、共通設定の一括適用へまとめない。複数domainへの同時変更が新しい要件になった場合だけ、単一writerと公開操作で設計する。

## 登録の検証と受入

登録時に、項目IDの重複、未登録の部品、存在しないbinding、保存先未定義、秘密項目の一般source公開、read-only項目の書込操作、所有schemaとの型不一致を拒否する。保存schemaの各項目は、編集可能、管理値、内部接続方針、旧設定互換、秘密専用のいずれかへ分類し、未分類を検査で検出する。schemaに項目が増えただけで秘密や管理値の欄を自動生成しない。登録から公開descriptorと監査用の保存先一覧を生成し、手書きの別一覧を正本にしない。

| 試験 | 成功条件 |
| --- | --- |
| 定義から描画 | 新しい既存保存項目を1件登録すると、Hub検索、指定アーティファクト、変更一覧に出る。専用のif分岐追加が不要 |
| 保存対応 | fixtureの変更前後を比較し、定義されたJSONパスまたは公開操作の対象だけが変わる。relatedの管理値更新も期待どおり |
| 配列対象 | モデル順序を入れ替えてもresourceIdが同じ項目を指し、他モデルの値を変更しない |
| 型と未設定 | 範囲外、未知enum、未知キー、不正なunsetを拒否。空読み方、空voice、null、省略を契約どおり扱う |
| 関連条件 | SDKへASRを割り当てる、用途が違う代替モデル、キーとenvRefの同時指定などを拒否 |
| 共同下書き | 複数アーティファクト、同一用途の再表示、8タブ押し出しで編集を失わない |
| 遅い応答 | 変更前のカタログと試聴を採用しない。共有する取得の所有者を区別 |
| 保存と再送 | 同じ内容とIDは同じ結果。変更した内容の同じIDは拒否。競合時も下書きを残し、保存中の追加入力を消さない |
| 秘密 | snapshot、definition、receipt、一般履歴、LLMへのデータに平文がない。適用と破棄とidentity変更で適切に解放 |
| 管理操作 | 辞書、予約、担当、Worldの固有ガードと結果状態を維持。一列直接更新で試験を通さない |
| サービス試用 | 参照画像と同じ一覧、入力、結果、履歴、状態、取消操作を再現。表示移行だけで生成を実行しない |

実装時には所有domainと利用側domainの`bun run verify -- --domain <name>`を部分から実施し、横断変更として`bun run verify:all`へ進む。fixtureで保存対応を確認した後、実サービスと実機器の受入を別に記録する。画像見本の作成とPageへの保存は、製品の動作検証の成功として扱わない。

## 根拠

- [共通設定の保存先](../../api/domains/settings/repository/index.ts)と[保存の検証](../../api/domains/settings/service/index.ts)
- [現行設定schema](../../api/domains/settings/contracts/index.ts)
- [辞書の保存処理](../../api/domains/tts-dictionary/service/index.ts)
- [メモリーのホスト設定](../../api/domains/memory/repository/index.ts)
- [schedulerの保存先](../../api/domains/scheduler/repository/index.ts)
- [dotsの保存先](../../api/domains/dots/repository/index.ts)と[設定操作](../../api/domains/dots/service/configuration.ts)
- [担当とSkillの登録](../../api/domains/capabilities/service/dots-packages.ts)
- [委任作業の保存先](../../api/domains/tasks/repository/index.ts)
- [Worldの公開操作](../../api/domains/world/service/world-claims.ts)と[忘却の継続状態](../../api/domains/world/repository/lifecycle.ts)
- [サービス試用の一時データ](../../api/domains/service-tests/service/index.ts)
- [利用記録の保存先](../../api/domains/inference/repository/index.ts)
- [選択記録と取得手順](../../api/domains/toolchain-history/repository/index.ts)
