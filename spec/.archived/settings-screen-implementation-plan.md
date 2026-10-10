# Eumenes 設定画面とクラウド自動フォールバックの実装計画

作成日: 2026-10-08 Asia/Tokyo  
状態: 設定画面とbackendの実装・統合検証済み。実装結果は [設定画面の検証記録](../verification/settings/README.md) を参照。以下は採用時の計画であり、APIの具体的な入力・出力は現行contractsと検証記録を正本とする。実クラウドと実機器の受入は区別して記録する。  
対象: `/Users/y.noguchi/Code/eumenes` の Web、backend、共通 client、検証基盤。  
読者: この会話を読まずに実装を引き継ぐ開発者・エージェント。

通常は LARM が提供するモデルを使い、利用できないときは登録済みのクラウド API に自動で切り替える。会話、音声認識、音声合成を個別に設定し、接続先・設定・実際の利用先を一つの設定画面から確認できるようにする。クラウド自動フォールバックを標準動作とし、実行ごとの確認ダイアログは設けない。

## 1 採用する方針

1. 設定画面は「用途を中心にする」構成を採用する。普段使う接続先とクラウド代替先を、会話・聞き取り・読み上げの三用途で選ぶ。
2. 初期モードは `larm-preferred`。クラウド利用許可と自動フォールバックは初期値で有効にする。代替先が未登録なら LARM を使い、LARM も使えない場合に「クラウド代替先が未登録」と知らせる。キー・URL・モデルを推測して登録しない。
3. 代替先は各用途につき一つとする。クラウドを登録するフォームで「この用途の代替先として使う」を初期選択し、適用時に接続・モデル・割当てをまとめて保存する。既存の割当てはユーザーが選び直すまで維持する。
4. `larm-only` と `cloud-only` も選べる。クラウド送信を禁止する操作は実行中にも反映する。標準モードへの切替だけで、明示的に取り消した送信許可を再付与しない。
5. 設定変更は「変更を適用」に統一する。登録と通常の設定編集を即時保存に混在させない。疎通確認と少量の動作テストは、設定適用とは独立した明示操作にする。
6. LARM の Profile・claim・lease・renew と秘密は backend に留める。Web と CLI は Eumenes API のみを利用する。
7. フォールバックしても会話入力・run・Job を増やさない。同じ依頼の内部で Provider 試行を切り替え、回答は一回だけ採用する。

前回の画面案にあった「LARM のみが初期値」「クラウド送信許可は初期値でオフ」は、この計画で置き換える。前回案は配置と操作の参考として扱い、初期値や実際の接続状態の正本にはしない。

## 2 現在の実装と参照元

調査対象は作業中変更を含む checkout。調査開始時の Eumenes の HEAD は `efc8aba734d6f0f27758f651fbfcd5f5c1e1db1e`。実装開始時に差分を再確認し、既存変更を上書きしない。

| 対象 | 現在の状態 | 今回の変更 |
| --- | --- | --- |
| [Web の入口](../../web/src/App.tsx) | 会話・継続情報・実行記録。モデル名と「ローカル会話」の表示が固定 | 設定への入口と切替、実際の利用先表示。音声 hook の所有を画面切替で失わない |
| [Web の外観](../../web/src/app.css) | 全画面の会話 shell。色と機器状態の表現に直接値がある | 設定 shell を追加。テーマ変更に必要な既存 shell の色だけ token に対応付ける |
| [デザインシステム](../../packages/design-system/README.md) | `@eumenes/design-system` を workspace package として導入済み | 既存部品・token を再利用する。前回モックの CSS をそのまま移植しない |
| [backend の組立て](../../api/application/server.ts) | 起動時の環境変数から一つの `LarmPort` を作り、dialogue と voice に渡す | settings と inference を追加し、利用側へ中立な推論 port を渡す |
| [LARM](../../api/domains/larm/service/index.ts) | Profile 発見、状態確認、claim、renew、解放。既定 Profile は `SAAA-gemma4-26b`。ASR/TTS は Profile 全体を要求 | 契約を維持し、期限・取消を接続準備まで伝播する。秘密を除いた取得情報を公開 |
| [対話](../../api/domains/dialogue/service/index.ts) | 受付・履歴・run・Queue と結果採用を所有。`larm.llm` に依存 | 設定 snapshot と inference 結果に接続。回答採用時に試行・許可世代を検査 |
| [音声対話](../../api/domains/voice-dialogue/service/index.ts) | ASR → dialogue → TTS。発話 sequence と generation、取消、復旧を管理 | 各段階の接続先を選択。読み上げオフ、取消、遅着結果を全経路で扱う |
| [ブラウザ音声](../../web/src/domains/audio/controller/index.ts) | システム標準入力、ブラウザの音声処理、700ms 無音確定、10秒区切り | マイク・感度・待ち時間を options にする。再生中もマイクを受け付ける |
| [認証経路](../../vite.config.ts) | 開発 proxy が backend 用 Bearer を付与。[client](../../client/transport.ts) は任意 token に対応 | この経路を維持。通常の設定画面に backend token の入力を追加しない |
| [Scheduler](../../client/scheduler.ts) | 一回・固定間隔予約の API、照会・停止・再開・取消がある | Web の管理操作を接続。新しい予約方式や通知機構は追加しない |

README の起動手順には token 入力の説明が残る一方、現在の Web は proxy 接続を利用している。実装時の認証判断は現行コードを基準にし、今回触る起動説明を現行動作に合わせる。

SAAA は参照専用。HEAD は `28616e61ce5fe853383d4af6ec14e5b5d542c076`。以下を参考にし、製品 DB・設定・秘密や Rust/Tauri の実装をコピーしない。

- [用途と接続とモデルの分離](/Users/y.noguchi/Code/SAAA/src/lib/serviceRegistry.ts): connection、resource、purpose binding を分ける設計。
- [用途別設定](/Users/y.noguchi/Code/SAAA/src/features/settings/PurposeRoutesSection.tsx): 用途に対応する候補だけを選択可能にする操作。
- [代替先と送信許可](/Users/y.noguchi/Code/SAAA/src/features/settings/PurposeRouteDetails.tsx): 代替先、期限、直近の実利用、許可取消の扱い。
- [LARM 接続設定](/Users/y.noguchi/Code/SAAA/src/features/settings/ServiceConnectionsSection.tsx): 接続先変更後に古い確認結果を表示しない仕組み。
- [音声設定](/Users/y.noguchi/Code/SAAA/src/features/settings/VoiceSettingsSection.tsx): 機器の欠落と対応機能を表示する操作。native AEC・話者登録・常時録音は今回採用しない。

## 3 実装範囲

完成版に含めるものは、六カテゴリの設定画面、LARM 接続設定、三用途のクラウド API 登録と自動代替、設定の永続化、秘密の保管、推論の利用記録、音声の基本調整、既存予約の Web 操作である。途中の工程を保存しても、手動のクラウド切替だけで今回の完成とはしない。

初版のクラウド対応形式は、OpenAI 互換 Chat Completions、HTTP multipart の音声認識、HTTP JSON の音声合成とする。各形式を明記し、「クラウド API なら何でも対応」と表示しない。同じ認証情報を三形式で使える場合は一つの接続に複数 resource を登録できるようにする。

| API 形式 | base URL に追加する path | 必須の入出力 |
| --- | --- | --- |
| 会話 | `chat/completions` | model、messages、非 streaming。response の assistant content を検査 |
| 聞き取り | `audio/transcriptions` | multipart の file、model、response_format=json。response の text を検査 |
| 読み上げ | `audio/speech` | model、input、voice、response_format=wav。response の RIFF/WAVE と byte 上限を検査 |

base URL に含まれる `/v1` などを勝手に付け直さず、末尾 slash を正規化して上記 path を追加する。model や request option が互換でないサービスは未対応として扱う。初版 adapter の実装・試験の根拠は現行 LARM で使っている同形式の契約とし、実際のサービスとの互換性は明示した live lane で別途確認する。

今回追加しないものは、Anthropic 固有形式、Responses、Realtime 音声、streaming 表示、tool 実行、画像・音楽生成、複数クラウドへの連鎖切替、モデル配備、補助 LARM セッション、native AEC、話者登録、常時録音、記憶システム、費用の強制上限、cron、外部通知である。未実装の機能を操作できる項目として置かない。

Eumenes の loopback 制限、既存認証、単一 writer、会話と Job の重複防止を維持する。新規ライブラリは基本的に不要。新しい domain と migration は追加するが、既存 migration の並び替え・再定義や DB 初期化は行わない。

## 4 画面構成と外観

### 設定への入口

会話画面の header に、文字ラベルを持つ「設定」ボタンを追加する。設定は狭い補助 panel や modal ではなく、header を共有する主領域のページとして開く。左にカテゴリ、右に内容と適用欄を置く。「会話へ戻る」と browser の戻る操作で復帰できるよう、既存 router の追加なしに URL hash と表示状態を同期する。

会話・音声の hook は共通 shell に残す。設定を開いただけではマイク、再生、run、Queue を停止しない。settings の編集中 draft はカテゴリ移動で保持する。未適用のまま設定を離れる場合にだけ、保存せず戻るか編集を続けるかを選べるようにする。フォールバックにはこの確認を使わない。

### 六カテゴリ

| カテゴリ | 表示する内容 | 操作と範囲 |
| --- | --- | --- |
| AI の使い方 | 利用モード、三用途の主接続先と代替先、送信内容、直近利用先、切替理由 | 自動代替は標準で有効。詳細に用途別の送信許可と時間制限。クラウド常用と混在構成も可能 |
| 接続先 | LARM の接続 URL・Profile・audience・声、取得モデル、クラウド接続一覧とモデル | 登録・編集・有効化・無効化・削除、疎通確認、少量テスト。LARM の取得値は読み取り専用 |
| 音声 | マイク、権限、発話感度、無音待ち、読み上げ、声、対応時の再生先 | 機器と発話検出は次の音声開始から反映。読み上げは次の発話から反映 |
| データとプライバシー | 保存場所の説明、録音非保存、用途別のクラウド送信、秘密を含まない診断 | 許可は AI 設定と同じ draft を編集。診断 JSON の書き出しを提供。削除・保持期間変更は後続 |
| 定期処理 | 一回予約・固定間隔予約、次回時刻、発火と Job の結果 | 既存 API による作成・停止・再開・取消。予約操作は設定適用とは別の明示操作 |
| 一般 | テーマ、時刻表示、アプリ接続状態 | システム・ダーク・ライト。表示言語は初版は日本語。機能しない言語選択は置かない |

利用モードは初回設定の入口でも使うが、クラウド登録を強制する wizard にはしない。「LARM 優先・クラウド自動代替」が選択済みで、未登録の代替先を用途ごとに案内する。既存の利用者はそのまま会話を続けられる。

三用途の説明は「会話と回答」「声を聞く」「声で返す」。LLM・ASR・TTS は詳細表示だけに使う。会話では履歴と今回の入力、聞き取りでは確定発話の音声、読み上げでは回答本文をクラウドに送ることを表示する。

### 入力項目

LARM は現在の有効値を表示する。audience は現行契約の `saaa-desktop` と `same-host` の範囲に限り、後者は loopback URL の場合だけ有効にする。既定 Profile は現行の `SAAA-gemma4-26b` を引き継ぐ。補助 Profile は現在コードで禁止されているため候補にしない。Profile 入力をモデル選択や配備要求に変換しない。

クラウド接続には、表示名、base URL、認証方法、API キーの登録状態、有効状態を持たせる。resource には用途、API 形式、モデル ID、対応機能を持たせる。TTS には voice ID が必要。声の一覧取得に対応しないサービスでは、一覧を捏造せず手入力にする。

LLM の詳細には context window、出力予約、安全余白、token 上限の送信形式を置く。仕様が取得できないモデルの context window は手入力を必要とし、LARM の大きな値をクラウドへ流用しない。reasoning・temperature・速度などは、初版 adapter が対応を保証する項目だけを表示する。

同一用途の候補は、その能力と API 形式に対応し、有効かつ認証情報が登録済みの resource に限る。疎通未確認は選択を妨げない。既存キーを使う編集は「変更しない」、置換は新規入力、削除は明示操作で区別する。空欄を保存済みキーの消去と解釈しない。

### 表示とアクセシビリティ

既存の Inter/system font、会話 shell の密度、デザインシステムの component と token を使う。`Button`、`Input`、`Select`、`Switch`、`Card`、`Tabs`、`Collapsible`、`ConfirmModal`、`ErrorState` を Web の adapter から公開して利用する。足りない部品の追加は最小限にする。

テーマは root の `data-theme` に反映する。設定だけ明るくなり会話が固定色のままになる状態を避けるため、既存 `app.css` の色を意味に対応する token へ置き換える。レイアウトと会話の動作は維持する。システム設定は `matchMedia` の変化にも追従する。

700px 以下ではカテゴリを上部へ回し、二列入力を一列にする。320px でも文言・URL・操作が収まり、設定内容が既存 `body { overflow: hidden }` に隠れないことを確認する。desktop の内容 panel に必要な縦スクロールを持たせ、適用欄が入力を覆わないようにする。

全入力に label、エラーに対応する field、状態更新に `aria-live` を用意する。色だけで成否を伝えない。キーボード操作、フォーカス復帰、画面離脱時の選択、reduced motion を確認する。

## 5 保存する情報と所有境界

### domain の分割

新設する `settings` は接続・resource・用途設定・表示と音声の設定を所有する。新設する `inference` は設定に基づく選択、クラウド adapter、内部試行、利用台帳を所有する。LARM の業務契約は既存 `larm` に残す。

| 所有者 | 所有する状態と判断 | 依存 |
| --- | --- | --- |
| settings | 設定 document、接続、resource、binding、設定 revision、送信許可の世代、暗号化した API キー | domain 依存なし。共通 SQLite と backend 秘密保管機構を利用 |
| larm | catalog、Connection、claim、lease、renew、local inference、秘密を除いた実 Provider 情報 | domain 依存なし |
| inference | 設定 snapshot、能力別の候補、切替、期限、Provider 試行、利用台帳、cloud inference | settings、larm |
| dialogue | 会話入力・履歴、run、Queue、回答採用、内部音声入力の受付 | conversation、inference、queue、scheduler |
| voice-dialogue | 発話と三段階の結果採用、sequence・generation、再生、取消 | audio、dialogue、inference |
| audio | 機器と録音・発話検出・再生。設定は options として受け取る | domain 依存なし |
| scheduler | 既存予約の永続化と発火。Web 管理を追加 | queue |
| application | domain の組立て、設定変更の通知、起動・復旧・終了、設定ページのカテゴリ組立て | 必要な各 domain の公開入口 |

設定ページ全体の組立ては `web/src/application/settings/` に置く。そこから settings と scheduler の公開 UI を組み合わせる。settings domain から scheduler や dialogue を参照せず、inference からも利用側 domain を参照しない。

`scripts/domains.ts` の依存表を更新する。新しい component 配下も境界検査の対象にするため、`scripts/boundaries.ts` の所有者判定と全体検査対象を、登録済みの `components` root まで拡張する。

### 永続データ

通常設定は version 付き document として `settings_documents` に保存する。一つの設定 revision に接続・resource・三用途 binding・音声設定・一般設定を含め、Zod による schema 検証と domain の整合検査を通す。初版は一利用者のローカルアプリを対象にし、複数利用者の設定分離は導入しない。

| データ | 主な情報 |
| --- | --- |
| connection | 安定 ID、表示名、source、base URL、認証方式、秘密参照、有効状態、接続版 |
| resource | 安定 ID、connection ID、能力、API 形式、モデル、voice、context と対応 option、版 |
| purpose binding | 用途、利用モード、主 resource、代替 resource、cloudAllowed、各時間制限 |
| settings document | schemaVersion、revision、updatedAt、上記設定と音声・一般設定 |
| policy epoch | 用途別の許可世代、接続の失効世代。許可を撤回して再付与しても旧結果を復活させない |
| settings credentials | credential ID、暗号文、nonce、認証 tag、key ID、版。通常 DTO には含めない |
| inference request | 依頼 ID、用途、subject 参照、設定 snapshot、期限、許可世代、現在の試行、終端状態 |
| inference attempt | request ID、試行番号、接続・resource・モデル、primary/fallback、切替理由、開始・終了・結果 |
| inference probe | 対象の fingerprint、確認種別、時刻、成否。実利用記録とは別 |

設定 document、推論 snapshot、秘密の更新は同じ writer で扱う。ネットワーク通信や非同期暗号処理を transaction 内で行わない。設定適用前に検証・暗号化を終え、revision 検査と保存を一つの同期 transaction で行う。

snapshot と台帳に会話本文、音声、API キー、claim token を重複保存しない。会話本文は会話 domain、発話音声は現行どおりメモリが所有する。台帳には opaque な subject 参照を保存する。削除済み接続の表示名とモデルは台帳側の当時値を残す。

request は `prepared → running → inference-completed → accepted` を通常経路とし、`failed`、`cancelled`、`interrupted`、`skipped` を終端として持つ。内部 attempt は成功・失敗・取消・`superseded` を区別する。cloud への切替時、旧 local attempt は `superseded` にし、request 自体は running のまま次の attempt へ進める。使用しなかった音声 bundle の下流 request は skipped に確定し、上流失敗・取消で prepared の request を残し続けない。

通常設定の編集だけで過去 snapshot を書き換えない。接続の削除は参照中の割当てを外してから行い、旧 snapshot 用の情報は tombstone として残す。未終端 request が参照する情報を物理削除しない。

### 初期化と移行

設定が未保存なら、現在の環境変数から LARM の接続情報と声を bootstrap する。秘密は環境変数への参照に留める。初期化は一回の transaction とし、再起動で保存済みの URL・Profile・利用モードを環境変数の既定値へ戻さない。

`LARM_CONTROL_TOKEN` があればそれを使い、なければ `LARM_API_TOKEN` を使う現行順序を維持する。env 由来のキーは画面から変更・削除できる値として扱わず、「起動環境から取得」と表示する。クラウドも env 参照を指定できるが、未指定の環境変数を探索して自動取り込みしない。

migration は現在の末尾へ追加する。旧 Job の `larm.llm` は同じ handler と共通実行枠に正規化し、新旧資源 key が別枠となって並列実行されないようにする。旧 run が設定 snapshot を持たない場合、未送信の Job は初期 LARM 設定の snapshot を補う。既存の実行中 Job・voice turn の復旧方針は維持し、再起動から自動的にクラウドへ再送しない。

## 6 秘密保管と認証

動的登録した API キーは backend で AES-256-GCM により暗号化し、settings 所有の credential table に保存する。暗号処理は `api/infrastructure/secrets/` が担当し、SQL と登録状態の判断は settings が所有する。nonce は暗号化のたびに新規生成し、credential ID と版を認証対象に含める。

master key は明示した `EUMENES_SECRET_KEY` または backend が管理するキー file から取得する。env の値は Base64 の32 byte とする。file の既定場所は DB のディレクトリ内の `keys/settings.key`、親は0700、file は0600。秘密 table が空の場合だけ排他的作成で生成する。暗号文が存在してキーが失われた場合は再生成しない。「復号不可」としてクラウド候補を使えなくし、LARM で利用可能な処理は継続する。

新規 cloud connection の設定と encrypted credential を同一 transaction で保存する。失敗時は両方 rollback し、キーだけ残った接続や、認証済み扱いの未登録接続を作らない。バックアップで DB と master key が両方必要になる条件を運用説明に記載する。今回バックアップ機能自体は作らない。

API レスポンス・通常ログ・診断・ブラウザ永続状態に秘密値を含めない。入力したキーはメモリ中の draft だけに置き、適用成功・編集破棄時に消去する。エラー文から provider の raw response body、request header、キーを除外する。`VITE_` 変数や client bundle に backend token を置かない。

全 endpoint を現行 `/api/*` の Bearer・Origin 検査下へ置く。初版の mutation は現行の GET/POST に合わせ、不要な認証・CORS 変更を避ける。Web の proxy 認証と CLI の明示 token を別経路として維持する。

LARM URL の local 制限は維持する。cloud URL は HTTPS とし、userinfo・query・fragment を禁止し、redirect に認証情報を転送しない。base URL は path を維持して正規化する。接続の origin を変える編集では、旧 credential の自動流用を許さず、新しいキー指定か明示的な env 参照を必要とする。

## 7 自動フォールバックの契約

### 選択と試行

受付時に設定 snapshot を固定する。利用開始時に現在の送信許可・接続の失効状態を再確認し、`larm-preferred` では LARM を先に試す。許可された切替理由が発生したときだけ、同じ用途の登録済み cloud resource を一回試す。cloud-only はクラウドを主接続先として一回使い、cloud → cloud や cloud → LARM の連鎖は初版では行わない。

Provider の内部試行は最大二回で、Queue の attempt とは区別する。Queue の `maxAttempts` は一回のままとし、inference が全体期限内で切替を管理する。両候補が失敗した場合は、最初の原因と代替先の原因を識別できる結果にし、無限再試行しない。

| 事象 | クラウドへの切替 | 扱い |
| --- | --- | --- |
| LARM への接続拒否、DNS 失敗、接続準備の期限超過 | する | `local-unreachable`。代替先があれば確認なしで使用 |
| LARM 未設定 | する | `local-unconfigured`。未設定状態も画面に残す |
| 資源待ちの期限超過、既知の混雑、429、502、503、504 | する | `local-busy` または `local-unavailable`。未知の業務エラーを混雑と推測しない |
| LARM 推論の timeout、応答途中の通信断 | 条件付きでする | 今回の副作用なし・非 streaming 推論で、結果が未採用かつ旧試行を失効済みの場合だけ |
| 既知の lease 失効、Connection 消滅 | 再確保後に判断 | 同じ LARM 試行の期限内で一回再確保。無理なら可用性失敗として代替 |
| 401、403、Profile 不明、契約不一致、voice 未設定、context 超過 | しない | 設定・能力・契約の問題を修正できる形で表示 |
| 不正入力、音声上限超過、不正 JSON、無効 WAV | しない | 入力または response contract の失敗。別 Provider に同じ不正入力を送らない |
| ユーザー取消、音声世代の変更、クラウド許可の取消 | しない | 全候補と遅着結果を失効させる |
| 全体期限切れ、回答採用後、再生開始後 | しない | 完了・失敗・取消を決着させ、同じ段階をやり直さない |

500 のような一般エラーは、adapter が既知の一時障害と分類できる場合だけ切替可能にする。任意の例外文字列を substring で判定する実装にせず、stage、分類、HTTP status、結果採用の有無を持つ型付きエラーを定義する。

推論 timeout 後の代替は、先行した local 推論の遠隔停止を証明するものではない。旧試行に abort を伝播し、試行世代を先に永続的に進め、以後の local 結果を不採用にする。remote での処理が続く可能性と、回答が二重採用されない保証を区別する。tool など外部副作用を導入する際は、この切替条件を流用しない。

### 時間制限と回復

初期値は以下とする。接続準備・容量待ち・推論・response の読み取りを、主試行の予算にすべて含める。現行の120秒 infer timeout と最大60回の接続 poll を無条件に積み重ねない。

| 用途 | 全体の予算 | LARM 主試行の上限 | cloud 試行 |
| --- | --- | --- | --- |
| 会話 | 180秒。受付からの Queue deadline と整合 | 120秒と全体残り時間の小さい方 | 残り時間、最大60秒 |
| 聞き取り | 45秒 | 15秒 | 残り時間、最大30秒 |
| 読み上げ | 45秒 | 15秒 | 残り時間、最大30秒 |

会話の Queue 待ちも全体期限に含む。cloud 用に時間を残すため、未送信なら主試行の予算を cloud 予算分だけ縮められるようにする。残り時間がないときは新しい試行を始めない。HTTP の接続確認は一回3秒を上限とし、手動の疎通確認も内部の全体期限を持つ。

可用性失敗時は capability と設定 fingerprint ごとに30秒の cooldown を設け、その間の新規依頼は cloud へ直接進む。期限後の最初の依頼で一つだけ LARM の再確認を行う。確認は catalog・Connection などの管理 API とし、LLM 推論や ASR/TTS を ping に使わない。idle 中に復帰確認のための推論を繰り返さない。

LARM の回復を確認したら、次に始まる新規依頼は LARM 優先へ戻す。実行中の cloud 試行や音声の途中段階を回復検知だけでやり直さない。設定変更は cooldown の fingerprint を更新する。health 情報はヒントであり、各実行時の能力・許可検査を省略しない。

### 入力予算と音声の段階

LARM と cloud は context の上限が異なる。各候補への送信直前に、元の履歴から候補ごとの入力予算を作り直す。system と今回の入力を残し、古い完了済みの往復から減らす。履歴や台帳そのものは削除しない。初版は現行の UTF-8 byte 数に構造余白を加える保守的推定を用い、正確な token 数と表示しない。最小入力でも収まらない場合は送信せず失敗にする。

ASR、LLM、TTS は別の inference request として扱う。ASR だけ失敗したなら同じ確定発話の WAV を cloud ASR に渡す。LLM の代替には認識済みテキストと履歴だけを渡し、録音を再送しない。TTS の代替には採用済み回答だけを渡し、LLM を再実行しない。

声・モデル・言語 option は各 resource に属する。LARM の voice ID を cloud TTS にコピーしない。TTS 初版の出力は検証済み WAV に統一する。音声認識の入力4 MB、音声合成の応答16 MB、JSON 応答1 MBの既存制限を保つ。

cloud ASR の逐次送信は今回導入せず、VAD で確定した発話単位を送る。読み上げオフなら backend は TTS を呼ばず、voice turn に新しい終端 `completed` を設ける。contracts・repository・polling・cancel・recover を更新し、音声がない状態を `ready` や `played` と偽装しない。TTS が失敗しても、採用済みの文字回答は履歴から消さない。

### LARM の接続単位

現行 LARM は LLM だけなら `providers: ["llm"]`、ASR/TTS 利用時は Profile 全体を要求する。この契約は今回維持し、存在確認していない `["asr"]` や `["tts"]` の部分 claim を前提にしない。用途別の利用先と LARM の資源確保単位を分けて表示・管理する。

混在構成で LARM の未使用能力まで確保される場合、その理由を詳細に表示する。Profile 全体の取得が失敗すれば、当該 ASR/TTS 用途を契約に従って cloud へ代替する。取得 Provider の token、base URL、モデルは claim の値を使い、UI の推測値で上書きしない。

Eumenes 側の cloud 自動代替は LARM の `allowFallback` と別の機能である。LARM への `allowFallback: false`、`deploymentPolicy: existing-only` は維持し、Eumenes の設定 toggle をそのまま LARM に転送しない。

## 8 設定変更と結果採用

### 保存と draft

設定取得は TanStack Query、編集中の draft は React Hook Form で管理する。backend の保存済み document が正本であり、Zustand に設定の第二の正本を置かない。Zustand は既存の音声一時状態に使う。

設定全体に `expectedRevision` を付けて適用する。409 の場合は draft を保持し、最新設定との差を確認して再適用できるようにする。取得 refresh や疎通結果で編集中 draft を上書きしない。保存中に編集した値は、保存した submitted draft と現在 draft を比較して維持する。失敗時は未適用表示を残す。

接続確認は保存済み設定を対象にする。未適用の接続を確認したい場合は、先に適用する導線を示す。確認完了時に connection/resource fingerprint と画面の対象を比較し、古い URL・モデルへの成功を現在の状態として表示しない。

### snapshot と権限

手入力は受付 transaction、予約は発火による受付 transaction で会話用途の snapshot を固定する。音声は発話の受付 transaction で三用途と読み上げ設定を一組として固定する。マイクと VAD の options は音声開始時に固定する。

音声から dialogue への引渡しには backend 専用の公開操作を設け、固定済みの会話用 inference request 参照を渡す。一般の submit HTTP DTO に任意の snapshot や credential 参照を追加しない。dialogue はその参照が未使用で、対象の発話に対応することを検査して run に紐づける。

通常の URL・モデル・代替先・時間制限変更は新規依頼から反映する。cloudAllowed の取消、接続の無効化、credential の失効は直ちに世代を進め、対象の未送信・実行中 request を失効する。通知は application から inference へ送るが、採用可否の正本は transaction 内で読む世代と設定である。

許可を取り消す前に送った内容を取り戻せるとは表示しない。取消後は新しい cloud 送信と古い結果の backend 採用・音声配信を禁止する。許可を再び有効にしても、古い request の世代は一致しないままにする。

### 回答と台帳の確定

inference は、推論結果に request ID・採用可能な試行番号・モデル情報を添えて利用側へ返す。ネットワーク成功の時点では台帳を `inference-completed` とし、回答採用済みとはしない。

dialogue の Queue settle は、run revision と取消状態に加え、inference の request・試行・許可世代を公開操作で検査する。同じ writer transaction で会話への回答追加、run 更新、inference の採用記録、Queue の結果を確定する。検査が stale または更新が false なら採用しない。SQL は各 domain の repository に残す。

voice-dialogue も ASR テキストと TTS ready の確定時に同じ検査を行う。TTS bytes はメモリに保持し、取消・失効時に消去する。音声取得 API も送信直前に許可世代を検査する。voice DTO に出力の失効状態を追加し、ブラウザは現行の session/generation/utterance と合わせて再生前に検査する。

このブラウザから許可を取り消した場合は保存成功時に対象の再生を止め、取得中の buffer を失効する。別の client からの取消は、既存の状態取得で失効を受け取った時点で再生を止める。既に配信した音声を backend から即時回収できるとは保証しない。再生開始後は新しい TTS の自動代替を行わない。

内部の local と cloud 試行を同時に勝者にしない。local の世代失効を commit してから cloud 試行を開始する。Queue の論理実行枠は一つの Job が終端化するまで保持する。LARM の利用数と解放は既存の所有者が管理し、UI がクラウドへ表示変更しただけで local 資源を解放済みと扱わない。

初版は Provider ごとに並列数を増やさず、会話推論の共通枠 `inference.llm` を一つとする。旧 `larm.llm` の正規化、Queue の options、handler の resourceKey、表示を同時に変更する。

## 9 API と画面状態

以下は追加する API 契約。パスと method を揃え、schema、client、controller、fixture を同時に作る。

| 操作 | API 案 | 内容 |
| --- | --- | --- |
| 設定取得 | `GET /api/settings` | version・revision、設定、credential の登録状態。秘密値を除外 |
| 設定適用 | `POST /api/settings/apply` | request ID、expectedRevision、設定 draft、credential の keep/replace/clear。全体を原子的保存 |
| 接続と能力の状態 | `GET /api/inference/status` | 保存済み設定、確認済み能力、LARM health、未設定理由。実利用先と区別 |
| LARM の取得情報 | `GET /api/inference/larm` | 秘密を除く catalog と取得 Provider。GET で新規 Connection を作らない |
| 接続確認 | `POST /api/inference/probes` | 保存済みの対象と expected fingerprint、kind=`connectivity`。202で probe ID と初期状態を返す |
| 少量の動作確認 | 同上、kind=`generation` | 会話・ASR・TTS の固定テスト入力。課金の可能性をボタンに表示 |
| 確認結果の取得 | `GET /api/inference/probes/:id` | fingerprint、状態、時刻、redact した結果。終端までの状態取得に利用 |
| 確認の取消 | `POST /api/inference/probes/:id/cancel` | 表示を閉じても不要な試験を続けない |
| 利用履歴 | `GET /api/inference/usage` | 用途・subject・cursor・limit で台帳を照会 |
| 診断書き出し | `GET /api/settings/diagnostics` | secret・会話本文・録音を除いた版、設定状態、直近エラー |

適用 request ID は通信結果不明時の照会・同一要求再送に使用する。同じ ID と内容なら同じ保存結果を返し、異なる内容なら409。同じキー置換の再送で credential 版を増やし続けない。mutation 本文は64 KiB、接続は最大32、resource は最大128、各キー入力は最大4096 byte、確認同時実行は全体で一つに制限する。

設定 DTO と入力 schema は `settings/contracts`、公開状態と usage schema は `inference/contracts` に置く。SQL・内部 token・暗号文を browser に export しない。新 client は既存の transport を利用する。既存 `/api/status` は互換性のため維持し、`larm` 欄を cloud を含む総合 ready 表示に読み替えない。

状態表示は、未登録、未確認、確認中、認証が必要、対応していない、接続確認済み、実利用成功、実利用失敗を分ける。確認は metadata 取得またはテストの成功であり、実際の回答採用ではない。固定の「Gemma」や「ローカル会話」は現在の取得値と台帳に置き換え、クラウド利用中・切替理由・設定変更前の記録も識別する。

probe は保存済みの snapshot と fingerprint を使い、実利用台帳には混ぜない。少量テストの結果を会話履歴や定期 Job に追加しない。probe の完了待ちも上限と取消を持ち、起動時の古い probe は interrupted にする。

## 10 音声と定期処理の設定

音声設定の初期値は、システム標準マイク、標準感度、無音700ms、読み上げオン、再生中の発話による割込みオンとする。感度は低い・標準・高いの三段階を RMS threshold に対応させ、標準は現行値を維持する。無音待ちは500〜3000ms、100ms刻みとする。録音の10秒区切りと音声上限は設定で無制限にしない。

入力デバイス ID は端末依存なので、backend に保存するときも現在のブラウザで列挙・再検証する。欠落時は「選択したマイクを利用できない」と表示し、標準マイクへ戻す操作を提供する。ユーザーが許可するまでは機器名を取得できない場合があることを扱う。

出力機器選択は機能検出と実際の controller 接続が完了したブラウザだけに提供する。未対応ならシステム標準の表示にする。ブラウザの echoCancellation・noiseSuppression・autoGainControl は要求と実際の track settings を区別し、実効 AEC の保証として表示しない。

割込みオンの初期動作は現行どおり。オフにした場合もマイク frame や ASR 受付を止めず、既に確定した回答の再生継続だけを制御する。停止操作、明示取消、世代失効は toggle に関係なく音声を止める。TTS-only の音を人の発話として扱わない検証と、人が再生中に話した内容を受け付ける検証を分ける。

定期処理は既存 scheduler と queue の契約を使う。一回予約は選択した時刻を UTC に変換して登録し、固定間隔は経過時間として表示する。「24時間ごと」を「毎朝同じ現地時刻」と表示しない。作成フォームは保存する対話文、時刻または間隔、既存の遅延時方針を入力し、任意 URL・shell を受け付けない。

予約の停止・取消は将来の発火を止める操作で、発火済み Job を取消済みと表示しない。既に動いている対話は実行記録から別途取消できる。backend 停止中や端末 sleep 中の定刻実行は保証しない。予約の cloud 利用は、発火時に現在の設定を固定するため、対話と同じ自動代替と許可検査を通る。

## 11 実装手順と完了条件

各工程の変更対象と検証を記録して順に進める。新たに domain が使えるようになった時点で、その domain と利用側の検証を行う。全工程が必要であり、画面だけ・adapter だけの状態を今回の完成にしない。

| 工程 | 実装するもの | 主な変更先 | 工程の完了条件 |
| --- | --- | --- | --- |
| A 現状確認と公開契約 | 既存 fixture の baseline、domain と DTO、初期値・エラー分類・snapshot 契約 | settings/inference の contracts、scripts の依存表 | 依存が循環せず、browser DTO に秘密・SQLite 型が出ない |
| B 設定と秘密の保存 | document・revision・冪等適用・bootstrap・暗号化・失効世代・診断 | `api/domains/settings/`、`api/infrastructure/secrets/`、client/settings | 再起動で保持、競合と保存失敗で旧設定を維持、秘密漏洩なし |
| C 推論の共通入口 | LARM port の中立化、取得情報、cloud 三 adapter、能力と入力予算、内部台帳 | `api/domains/inference/`、larm の公開契約・service | 各候補を fixture で単独利用でき、取消と bounded response が成立 |
| D 自動代替と利用側 | 切替・期限・cooldown、受付 snapshot、回答と台帳の原子的採用、旧資源 key の対応 | dialogue、voice-dialogue、queue、application | LARM 失敗から cloud へ自動切替し、遅い local 結果を採用しない |
| E 設定画面 | shell、六カテゴリ、draft・適用・競合、接続登録・確認・テスト、実利用表示 | `web/src/application/settings/`、settings の hooks/components、design-system adapter、App/app.css | 設定を変更して実経路が変わり、固定モデル表示を残さない |
| F 音声と予約の接続 | audio options、読み上げオフの終端、機器能力表示、予約管理 UI、テーマ | audio、voice-dialogue、scheduler の Web 公開入口 | 音声再開始と次発話の反映を区別し、予約の発火・Job結果を表示 |
| G 統合受入と説明 | 全体 gate、live の設定と手順、実機受入、起動・機能範囲の記録 | tests/browser、scripts/verify-live、README、spec の検証記録 | 第12節の必須ケースを満たし、未実施受入を明示 |

推奨配置は以下。不要な空 directory や framework を増やさず、既存 domain の入口形式に合わせる。

```text
api/domains/settings/{contracts,service,repository,controller,test}/
api/domains/inference/{contracts,service,repository,controller,test}/
api/infrastructure/secrets/
client/settings.ts
client/inference.ts
web/src/domains/settings/{hooks,test}/
web/src/components/domains/settings/
web/src/application/settings/
web/src/domains/scheduler/{hooks,test}/
web/src/components/domains/scheduler/
```

クラウド adapter は inference service 内で API 形式ごとに分け、LARM の claim 処理と混ぜない。larm・inference・settings は公開入口からのみ利用する。SQLite 複数 domain 更新は既存の単一 writer と公開の transaction 操作で実装する。

実装は現在の checkout を使う。別チャットへの送信、worktree 作成、commit、push、公開はこの計画から追加で許可されたものと解釈しない。

## 12 検証と受入

### 秘密なしで再現できる必須試験

clock、sleep、fetch、ID、秘密保管、隔離 SQLite を注入し、実際の API キーなしで動く fixture を先に作る。network 待ち時間を実時間で何十秒も待つ試験にしない。

| ケース | 期待結果 |
| --- | --- |
| 初期設定と再起動 | 保存前は現行 LARM を引き継ぎ自動代替オン。保存後は環境変数の既定値で上書きされない |
| 代替未登録 | LARM 成功なら通常利用。LARM 失敗なら未登録を明示し、不明な API を呼ばない |
| LARM 成功 | 三用途で適切な取得 Provider を使い、cloud 呼出しゼロ |
| LARM 停止・混雑・期限超過 | 対応する用途の cloud を一回使用。入力・run・Job・回答を重複作成しない |
| 主試行の遅着 | cloud 成功後に local が成功しても、一つの回答と音声だけを採用 |
| 両候補失敗 | 終端失敗と二つの原因を記録。retry loop や orphan request を残さない |
| 不適切な切替 | 401/403、契約不一致、voice 不足、context 超過、取消で cloud 呼出しゼロ |
| 混在と cloud-only | ASR・LLM・TTS の設定先と各送信内容が一致。不要な用途や音声を送らない |
| 入力予算 | 小さい cloud context に合わせ履歴を再構成。system・最新入力を保持し、DB履歴は維持 |
| 回復と cooldown | idle の LLM 呼出しゼロ。期限後の再確認を重複させず、新規依頼で LARM に復帰 |
| 許可取消の競合 | 送信前に停止。実行中は abort と失効。false→true でも旧結果を採用しない |
| 設定 snapshot | Queue 待ちと実行途中の通常編集で実行先が変わらない。予約は発火時の設定を使う |
| 保存と秘密 | 全体 rollback、409、同一 apply ID 再送、key keep/replace/clear、キー欠落・誤鍵・origin変更を確認 |
| DTO と診断 | APIキー・master key・claim token・raw body・録音・会話本文が含まれない |
| 確認と利用記録 | 古い fingerprint の成功を現在の成功と表示しない。probe は会話採用に混ざらない |
| 台帳の採用失敗 | 会話追加・voice更新・Queue settle の一つが失敗したら transaction 全体をrollback |
| 資源と復旧 | 旧新 Job が一つの枠を共有。再起動で実行中要求を cloud へ再送せず、旧音声を再生しない |
| 音声調整 | 欠落機器、無音待ち、標準感度、読み上げオフで TTSゼロ、割込み時の取消が動く |
| 設定の開閉 | 設定を開いても会話・マイク状態を失わない。dirty draftと保存中の追加入力を維持 |
| 予約操作 | 作成・停止・再開・取消、発火済み Jobとの違い、timezone 表示と固定間隔を確認 |
| 外観と操作 | 320/736/1280px、light/dark/system、キーボード、焦点復帰、長いURL、読み込めないAPIを確認 |

### 実装後に実行する検証

新 domain 登録後は日常の domain 検証を使い、利用側まで接続した時点で横断 gate を行う。以下は将来の実装後に行うコマンドであり、計画書作成時の成功記録ではない。

```sh
bun run verify -- --domain settings
bun run verify -- --domain inference
bun run verify -- --domain larm
bun run verify -- --domain audio
bun run verify -- --domain dialogue
bun run verify -- --domain voice-dialogue
bun run verify -- --domain scheduler
bun run verify -- --domain queue
bun run verify:all
```

client・application・component 境界と package 利用に変更があるため、domain pass だけで完成扱いにしない。design-system の component 自体を変更した場合は `bun run --cwd packages/design-system test` も必要。現行 `verify:all` の API/Web試験だけでは package の単体試験まで含まれないことを記録する。新しい theme 対応は全体 build と browser fixture で確認する。

### live と実機器

live は指定した LARM と、テスト用に明示設定した cloud 接続の個別疎通を行う。既存 `verify:live` に inference の opt-in lane を追加する。通常の verify からクラウドを呼ばず、テスト用の短い文字列・合成音声・短い読み上げだけで確認する。APIキー、本文、費用をログに含めず、対象とモデル、結果、時刻を記録する。費用は実測情報がない限り表示しない。

実機受入はマイクとヘッドホンによる3往復を最低条件とし、LARM通常、LARMを使えない状態からの自動cloud代替、回復後の新規依頼、再生中の発話と停止を確認する。TTS-only で勝手に新しい依頼が生まれない条件も確認する。実サービスの状態変更は管理者が操作するか、Eumenesだけのテスト用接続遮断で再現し、LARM の製品設定を変更しない。

結果は `spec/verification/settings/` に fixture、live、実機器を分けて記録する。fixture pass を live 成功としない。UIとbackendを実装済みでも、実機器の3往復と割込みが未実施なら「音声 MVP 完成」と宣言しない。

今回の完成条件は、登録と保存の動作、三用途の自動代替、取消後の不採用、秘密を漏らさない API、既存機能を保つ統合試験が成立すること。未実施の live・実機器条件がある場合は、実装済み範囲と未検証範囲を分けて報告する。
