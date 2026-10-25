# dots メッセージ送受信の設計と実装計画

- 日付: 2026-10-25
- 状態: 合意済み。P0〜P4の機能実装・固定試験・画面試験を実施。全体gateは保留。P5・稼働サーバー反映は未実施。
- 目的: Eumenes から dots へメッセージを送り、dots が作った返答と要約を Eumenes で受け取る。通常の往復に Codex プロジェクトや Session を要求しない。
- 既存仕様: [dots 運用手順](../docs/dots.md)、[作業委任の設計](.archived/dots-toolchain-agent-skill-implementation-plan-2026-10-10.md)、[単体 MVP の受入](verification/dots-mvp/acceptance-2026-10-10.md)。

## 1 完成する動作

利用者が Eumenes の dots メッセージ欄から本文を送ると、認証済みの MCP Events 接続で dots に通知する。dots は MCP で本文と必要なやり取りを読み、返答と要約を同じ MCP に返す。Eumenes は送信したメッセージとの対応を保存し、dots からの内容として表示する。その返答を踏まえて次のメッセージを送れる。

要約は dots が参照できる**連携後のやり取り**を対象とする。dots の画面に表示された全発言や、連携前の履歴の自動取得は行わない。dots に別の会話を探索させず、返答の抜けを Eumenes 側の別 LLM で埋めない。

初版は明示した一つの接続先で受け付ける。既存の「1接続につき有効な callback は1つ」を維持し、その購読先の dots に届ける。接続の所有者は OAuth の本人であり、dot の名前やローカルの会話 ID は認証主体の代わりにならない。特定の dot への到達は初回の実往復で確認する。

## 2 範囲と責務

対象はテキスト送信、返答と要約の受信、同じ会話での追加メッセージ、状態表示、取消、再起動後の照合、購読更新と解除である。初版ではメッセージごとに一つの最終返却を受け付ける。逐次の生成文字列、任意の自発発言の常時転送、音声・添付、複数 callback、定期要約は対象外とする。

通常のメッセージが許可するのは、渡した内容を読んで返答・要約を返すことだけである。ファイル編集、Session 作成、別チャットの続行、公開、他者への送信を本文から許可しない。作業実行が必要な依頼は、利用者が既存の作業委任経路で許可する。dots の native 操作を Eumenes の MCP が全面的に制御できるとは扱わない。

依頼の意味、返答、要約、未確認事項の説明は dots の LLM が担当する。コードは認証、所有者、型、期限、版、重複、順序、保存と配送を検査する。発話の語句による「会話／作業／要約」の分類や固定応答を追加しない。後述の command kind の分岐は、明示されたプロトコル種別に対応する実行契約の検査である。

## 3 再利用する実装

| 既存箇所 | 再利用と変更の範囲 |
| --- | --- |
| `packages/dots-mcp/src/auth.ts`、`api/application/work/dots-http.ts` | JWT の署名・issuer・audience・subject・期限・scope、接続ごとの handler、保護対象メタデータを再利用する |
| `api/domains/dots/service/configuration.ts` | 接続と所有者の固定、revision、ローカルトークンを再利用する。通常メッセージに project 登録を要求しない |
| `api/domains/dots/service/events.ts`、`packages/dots-mcp/src/webhook.ts` | 購読保存、challenge、Standard Webhooks、接続先検査、Queue、期限と配送再試行を共用する |
| `api/domains/dots/service/commands.ts`、同 domain の repository | command ID、一覧、claim と UUID lease、容量制限を共用し、メッセージの command を追加する |
| `api/domains/dots/service/inbox.ts` | 作業報告の契約は維持する。返答用には所有者・重複・期限検査の構成を参考に専用の公開操作を追加する |
| `api/domains/conversation` | application から公開操作 `appendInTransaction` を呼び、会話の保存・変更通知を再利用する |
| `api/application/events.ts`、`client/events.ts` | 保存後の変更通知と再取得を使う。Web 側だけに送受信の正本を置かない |
| `scripts/dots-mvp` | 実 dots が本文を取得し回答全文を返した手順を受入の参考にする。独立 DB・秘密・HTTP サーバーは製品へ接続しない |
| `api/domains/google-accounts` | 接続状態の表示、取消後の古い応答の拒否、資格情報を backend に留める設計を参考にする。Google 専用 provider・token・暗号化 namespace は共用しない |

専用に追加するのはメッセージの関連付けと返答の保存契約である。現行の `report_task.completed` は Session と完了条件の根拠を要求し、`summary` も短い報告用なので、通常の返答の保存先として契約を緩めない。独立の Events サーバーや第二の配送 Queue も作らない。

## 4 認証と初回接続

### 4.1 既存の認証契約

Eumenes は引き続き OAuth Resource Server とする。保存済みの `issuer`・`jwksUrl`・`resource`・`subject` を正本とし、`dots:read dots:report dots:events` を使う。公開経路は既存の MCP と保護対象メタデータに限定する。ローカルトークンは従来どおり loopback 専用で、クラウドの dots の認証には流用しない。

メッセージ機能は接続ごとの明示的な有効化を必要とし、既存接続は既定で無効とする。plugin のツール・Skill を更新して再スキャンし、利用者が返答の送信を許可した接続だけ有効にする。既存の scope で公開する操作が増えるため、従来の購読だけを新機能への同意と扱わない。

有効化は dots domain に追加するメッセージ設定の revision と epoch で管理し、接続本体の revision から分ける。メッセージ機能の有効／無効だけで既存の作業委任を失効させない。接続本体の無効化・所有者・認証設定変更については、従来の作業停止規則と新しいメッセージの失効処理の両方を適用する。

Google 連携は Eumenes が Google にログインする OAuth client、dots 接続は ChatGPT が Eumenes に接続する OAuth client であり、認証の向きが異なる。Google の URL を OpenAI に置き換える改修では実現しない。[公式 MCP 認証](https://developers.openai.com/plugins/build/auth)

OpenAI の Sign in with ChatGPT は本人確認として別途利用できるが、identity scope は会話へのアクセスを付与しない。identity-only の実装は現在、選定された商用 partner 向け試行とされているため、本機能の必須依存にしない。OpenAI の ID token を Eumenes MCP の access token として受け付けない。[Sign in with ChatGPT](https://developers.openai.com/siwc/quickstart)、[plugin の二つの認証フロー](https://developers.openai.com/siwc/chatgpt-plugin)

### 4.2 接続手順

1. 管理認証付き設定 API で保存済み接続を読み、公開 HTTPS、OAuth provider、所有者、必要 scope を確認する。同じ接続先を利用者へ再入力させない。
2. ChatGPT で plugin に接続し、更新した MCP tools と Skill を再スキャンする。
3. 利用者が対象 dot に `command.available`、`queue_id=eumenes-dots` の監視と、メッセージの取得・返答・要約の返却を指示する。
4. callback 検証と購読保存の後、Eumenes から短い確認メッセージを送り、dots 自身の返答を保存できた時点でメッセージ接続を確認済みと表示する。

初回購読は ChatGPT が callback と鍵を発行する操作である。送信側だけで初回購読を作らず、購読先を捏造しない。接続手順のうち利用者による監視指示は残る。[公式 MCP Events](https://developers.openai.com/plugins/build/mcp-events)

`scripts/dots-oauth` は2時間限定・鍵と認証状態が非永続の試験用である。既存の恒久 OAuth provider があればそれを使う。恒久 provider がない場合は、安定した公開 HTTPS と認証基盤の配備を別の依存作業として確定する。試験用 provider の時間制限を外すだけで恒久化しない。

## 5 メッセージの記録

以下の名前と値は追加する契約案である。

| 記録 | 内容 |
| --- | --- |
| メッセージ設定 | `connectionRef`、有効／無効、revision、epoch。接続本体の認証情報は複製しない |
| メッセージ会話 | `id`、`connectionRef`、`conversationId`、`epoch`、開始時刻、状態、送信 sequence、revision。Eumenes 内の関連付けであり、ChatGPT の native 会話 ID とは扱わない |
| 送信メッセージ | `id`、`requestId`、会話 ID、sequence、利用者本文の会話 message ID、`commandId`、期限、状態、接続 revision と epoch、前の返答 ID |
| 返却 | `replyId`、`messageId`、`commandId`、`leaseId`、epoch、`outcome`、`replyText`、`summary`、参照範囲、制約、digest、受付 receipt、受信時刻、会話表示先 ID |

会話の本文は `conversation` を正本とする。dots domain は関連付けと受領契約を所有し、他 domain の SQL を直接持たない。送信時の本文は既存の公開読み取り操作で取得し、command snapshot に凍結する。送信後の履歴編集で送信内容を変えない。複数 domain への保存は application の一つの writer transaction で行う。

一つのメッセージ会話では、未解決の送信は一件までとする。後続の文脈を固定するための初版の契約であり、返答が届くか取消・期限切れが確定すれば追加送信できる。複数の独立した会話は別 ID で区別し、本文や要約を混ぜない。

初版の上限案は送信本文32 KiB、返答32 KiB、要約4 KiB、返却引数全体48 KiB の UTF-8 JSON とする。送信期限は10分、本文保持は完了・取消・失効から7日、本文を含まない receipt の保持と冪等性の保証期間は30日とする。いずれもホストの上限で、モデルが内容を判断する基準には使わない。MCP transport の既存上限と保存先の制約に同時に収まることを固定試験で確認する。

## 6 Events と MCP の契約

### 6.1 コマンド台帳の拡張

既存 `Command` を作業用とメッセージ用の discriminated union にする。作業用の既存 JSON と状態遷移を維持し、`kind: message` を追加する。メッセージ用は `messageId`・メッセージ会話 ID・接続 revision・epoch・凍結本文と参照文脈を持ち、`taskId`・project・Session・作業 grant は持たない。

現在の `dots_commands.task_id` は NOT NULL なので、新しい migration で NULL を許し、メッセージ参照列と種別整合の制約を追加する。作業用は task ID 必須、メッセージ用は message ID 必須で相互に混在させない。架空の task ID、空文字、会話 ID を task ID に入れない。共通の command ID、seq、lease、配送台帳の参照は維持する。

テーブル再構築が必要な migration では、`dots_deliveries` の外部キーと storage trigger も保存して作り直し、既存の seq と参照先を変更しない。適用前後の行数・digest・外部キー整合・保存量を旧 DB の fixture で比較する。

`command.available` の名前、`queue_id`、payload の `command_id` を維持する。通知に本文を入れない。イベントの `cursor: null` は継続し、Events 自体の履歴再生を約束しない。通知欠落時の照合には保存済み command の一覧を使う。

| MCP 操作 | メッセージ対応 |
| --- | --- |
| `list_pending_commands` | 作業とメッセージの参照・kind を返す。期限と接続所有者を検査する |
| `get_command` | kind に応じた所有 domain の検査を呼ぶ。メッセージでは本文、文脈 snapshot、要約範囲、既存 receipt を返す |
| `claim_command` | 既存 UUID lease を再利用する。メッセージでは接続・会話 epoch・期限・取消を検査する |
| `submit_message_reply` 新設 | claim 済みメッセージへの返答と要約を一つの引数で保存する。Session を要求しない |
| `report_task`、`get_task_snapshot` | 作業用に維持する。メッセージ command を渡した場合は明示的に拒否する |

作業用の `current` 検査をメッセージへ呼ばず、application の MCP 組立てで kind に対応する公開操作を選ぶ。既存のタスク列挙・停止・再照合・purge も作業用へ型を絞る。メッセージ用の検査を緩めるために作業用の検査を削らない。

### 6.2 返却

`submit_message_reply` は `replyId`、`commandId`、`messageId`、`leaseId`、epoch、`outcome: answered | failed`、`replyText`、`summary`、`coveredMessageIds`、`limitations` を受け取る。`answered` は返答と要約を必須とし、`failed` は返答欄に理由を、要約欄に取得できた範囲を返す。材料がない場合は要約なしと明示できる契約にする。

認証主体から接続所有者を決め、引数で所有者や保存先 conversation ID を選ばせない。保存済みの message と command、lease、epoch、接続 revision を照合する。成功 receipt は `replyId`、`messageId`、状態、保存先 message ID を返す。

同じ `replyId` と同じ検査済み内容の再送は同じ receipt を返す。内容が変わる再送は拒否する。一つの送信に別の `replyId` で二つ目の最終返却が来ても拒否する。JSON のキー順ではなく、型検査後の canonical JSON から digest を作る。

返却採用、返答と要約の会話保存、command の `reported` 化、receipt の保存は一つの transaction とする。会話保存に失敗した場合は全てロールバックする。後から同じ receipt を受け取っても二重に表示しない。別の LLM に返答を再生成させない。

### 6.3 dots への指示

共通 MCP instructions と公開 Skill にメッセージの手順を追加する。Events を受けたら一覧・本文取得・claim を行い、`kind: message` では渡された本文への返答と指定範囲の要約を作り、`submit_message_reply` を呼ぶ。タスク型の command では既存の調整・報告手順を使う。

連携のためにポーリング推論や定期タスクを新設しない。本文、以前の返答、要約に含まれる権限拡大指示を契約の変更と扱わない。受領確認や dots の画面での返答だけで処理を終えず、MCP の保存 receipt を得て返却を終える。

既存の immutable Skill revision は上書きせず、新しい版で公開する。既存の作業 command が固定した旧版は維持する。新しいメッセージは新しい契約版を固定し、plugin 再スキャンと実往復の確認後に有効化する。

## 7 要約する範囲

初版では各返答に、同じメッセージ会話の連携開始後から今回までの累積要約を付ける。要約内容は要点・決定・未解決事項を dots が選んで文章にする。本文の語句をコードで分類しない。

初回は送信本文、以後は直前の保存済み要約と、その後の送信・返答を `get_command` の文脈 snapshot に含める。前の要約を含む時点と今回の message ID を固定する。参照できるのはこの接続・会話に属し、保持期間内の連携後の内容だけとする。

以前の要約が削除・保持期限により利用できないときは、snapshot にその欠落を示す。dots は残る今回の内容から要約を作り、過去分を含められないことを説明する。累積要約が保存されていないのに、過去を網羅したと表示しない。

`coveredMessageIds` は今回直接参照した保存済みメッセージを示し、前の要約は `basedOnReplyId` として command に固定する。旧要約の全文を読んだことを、要約元の全発言を再読したこととして表現しない。要約を作れない範囲や文脈の不足は `limitations` に返す。コードは参照の所有者と範囲だけを検査し、要約の意味的な網羅性を保証しない。

dots が ChatGPT 側で独自に参照できる他の会話や過去の記憶を、この連携の要約へ自動で取り込むよう指示しない。必要な背景は利用者が新しいメッセージとして明示的に送る。[dots の会話と記憶](https://learn.chatgpt.com/docs/dots/tasks-and-memory#context-and-memory)

## 8 状態と競合

利用者には「未接続」「購読待ち」「接続確認待ち」「送信可能」を区別して表示する。OAuth 設定の保存だけで接続済みとは表示しない。購読の期限切れ・認証失敗時は、それぞれ必要な更新や再接続を示す。

送信の状態は「受付済み」「通知受付済み」「dots が取得」「返答待ち」「返答受信」「失敗」「期限切れ」「取消」とする。通知受付は webhook の 2xx、dots の取得は claim、返答受信は返却保存の receipt に対応させる。2xx だけで dots の実行・画面への表示・返答を成功扱いにしない。

- 送信は `requestId` で冪等にする。同じ ID と同じ内容は保存済み受付を返し、異なる内容は409にする。通信結果不明時は新しい ID を作らず照会する。
- 購読なし・失効時の新規送信は受け付けず、入力欄の下書きを残す。受付後に購読が切れた場合は保存済み message を期限内だけ保持し、ChatGPT 側の refresh／再購読時に同じ command を通知する。
- Events 配送の再試行は同じ job の event ID と本文を保ち、署名時刻だけを更新する。refresh 後に別イベントが届いても command ID と lease で重複処理を照合する。
- 再起動後は receipt の有無を確認し、未返却の同じ command を再提示する。claim の有無から返答済みとは推定せず、新規 message や新規 Session を作らない。dots 側で要約を再生成しても、最終返却は一つだけ採用する。
- 取消・期限切れ・接続無効化・会話削除後の新しい返却は採用しない。既に保存した同一返却の再送には、所有者確認後に本文を含まない受付を返せる。削除・保持期限後は receipt 用の識別子と digest だけを保ち、本文を復活させない。
- メッセージの取消は Eumenes が以後の採用を止める操作であり、dots の推論を強制停止した証明ではない。新規送信は同じ会話の epoch を進め、旧 epoch の返却を拒否する。
- `events/unsubscribe` は配送の停止で、既に許可して claim された返答の取消とは区別する。「メッセージ連携解除」はメッセージの有効化を取り消して epoch を進め、未返却の採用と配送を止める。OAuth 接続全体の無効化とは画面と操作を分ける。既存の作業 Session の停止要求・停止確認の例外は維持する。

## 9 保存と削除

dots domain にメッセージ会話、送信、返却の関連付けを追加する。本文を二重の会話履歴として保持せず、凍結 command snapshot と受信中の検査に必要な値だけを保存する。会話上の送信と dots の返答・要約は安定した ID で参照する。

返答は `dots の返答`、要約は `dots の要約` として出所を明示する。既存の会話 message 契約には第三者話者の専用欄がないため、任意の `attribution: { namespace, sourceId, displayName }` を追加する。値は application が保存済みの関連付けから作り、dots の引数や利用者向け送信 API から指定させない。`conversation` は汎用の出所を保存するだけで dots domain を参照しない。既存メッセージは値なしで互換性を保つ。

表示と文脈への投影ではこの出所を読み、外部担当の返答を Eumenes 本人の生成・本人の指示として扱わない。表示本文の接頭辞だけで信頼境界を作ったとは扱わない。会話の出所読取り、continuity と dialogue の既存投影への受け渡しを試験し、ContextWindow の区画構造や agency の判断方式は変更しない。これは全発言を assistant role のまま自己発言に誤帰属することを防ぐための最小の追加である。

本文保持の期限または利用者による会話削除で、command snapshot、返却本文、要約、参照文脈、会話上の複製を同時に取り除く。conversation の削除／訂正フックと application の単一 writer でつなぐ。送信済みの内容は取消にして以後採用せず、訂正を dots に届ける場合は別の明示的な送信にする。

本文削除後も30日の保証期間中は requestId・replyId・digest・結果だけを残し、再送で本文を再作成しない。期間後は関連 command と receipt を削除して容量を解放する。Web・CLI は期限を過ぎた要求を自動再送せず、保存済みの要求が取得できなければ利用者による新規送信を必要とする。期限後まで同じ ID の永続的な重複排除は保証しない。

新しい本文保存も既存 `dots_storage` の通常領域56 MiBに計上し、停止処理のための8 MiB予約を使わない。既存の保存済み値を維持した migration、計数の再確認、削除での減算を試験する。新しい返却本文と会話側の本文を含めた1件あたりの上限を検査する。JSONL には本文・要約・callback URL・鍵・token・provider 生応答を記録しない。

## 10 API と画面

| API 案 | 内容 |
| --- | --- |
| `POST /api/dots/message-conversations` | 所有者の Eumenes 会話と有効な接続を関連付ける。`requestId` で冪等にする |
| `POST /api/dots/message-conversations/:id/messages` | 本文と `requestId` を受け、送信記録・会話本文・command・配送 job を一つの transaction で保存する |
| `GET /api/dots/message-conversations/:id` | 接続状態、送信・返却・要約を seq cursor でページ取得する。受信時刻だけでページングしない |
| `POST /api/dots/messages/:id/cancel` | `requestId` と期待 revision で取消する |
| `PUT /api/dots/connections/:id/messaging` | メッセージ設定の `expectedRevision` と有効／無効を受ける。保存済み接続を公開操作で検査し、接続本体の revision は変えない |

これらの API は既存の Eumenes 管理認証下に置く。MCP は従来の接続所有者認証を使う。Web・CLI は API 経由とし、DB を開かない。返却の MCP ツールに任意の API URL や保存先を渡す契約を作らない。

初版は専用の dots メッセージ欄から明示的に送信する。接続状態、入力、送信と取消、返答、折りたたみ可能な要約、制約、再接続の案内を用意する。自動送信や会話エージェントによる宛先選択は追加しない。

画面は既存の登録式 Artifact と Web adapter を使う。`dots-messaging.bundle.json` と `artifact:dots.messaging@1` を追加する案とし、query は保存状態を投影し、操作は認証済み API に接続する。汎用 DesignSystem の部品を使い、固定 runtime map を増やさない。[登録手順](../docs/toolchain-extension.md)、[検証手順](../docs/toolchain-extension-verification.md)

主会話の生成担当・agency・ContextWindow の構造は変更しない。将来、主会話から依頼する場合は、既存の担当選択とデータドリブン登録に従う別の変更とする。[会話エージェント設計](agency-conversation-agent-design-2026-10-25.md)

## 11 Events の先行修正

以下はこの会話の先行調査で確認した境界条件である。メッセージ機能の追加前に回帰試験を作り、同じ共通経路を修正する。

| 項目 | 修正と受入 |
| --- | --- |
| URL の同一性 | subscribe と unsubscribe で同じ正規化を使う。大文字ホスト・既定443付きの元 URL で登録後、同じ入力で解除できる |
| 鍵の切替 | A→B→B の更新で猶予中の A を失わない。同じ鍵の refresh は rotation を始め直さず、実際の鍵変更でだけ旧鍵を更新する |
| 解除と準備済み配送 | unsubscribe で該当購読の未開始 job を取り消す。送信直前の再検査と進行中要求の取消を既存 Queue に接続する。既にネットワークへ送出済みの要求は取り消せたと保証せず、受信・返却の採用検査で古い結果を止める |
| 失敗の追跡 | HTTP status、固定の失敗理由、command ID・job IDを保存する。403・410・413・429・5xxを区別し、410・413を再試行しない |

購読 ID の同一性、challenge、24〜64 byte の署名鍵、期限、保存後の有効化、SSRF 対策、2xx と実処理の区別を維持する。購読 refresh と解除の競合は永続 revision と Queue の取消で扱い、送信先 URL の正規表現による専用例外を作らない。[MCP Events の管理要件](https://developers.openai.com/plugins/build/mcp-events#manage-subscriptions)

## 12 実装順と完了条件

| 段階 | 主な変更箇所 | 完了条件と依存 |
| --- | --- | --- |
| P0 現状固定 | dots domain、MCP、application の既存試験、接続設定の公開読み取り | 作業委任の baseline、境界条件の失敗、保存済み認証と公開入口の利用条件を確認する。server 操作なしで固定試験を先に通す |
| P1 共通配送修正 | `events.ts`、Webhook、必要な Queue 接続 | §11 の回帰試験、更新・解除・再起動・再試行の固定試験が成功する。作業用の停止配送も維持する |
| P2 メッセージ契約と保存 | dots contracts／service／repository、新規 migration | command union、会話と送信・返却、容量、期限、所有者、取消、receipt が固定試験で成立する。作業報告の契約は維持する |
| P3 MCP と会話保存 | MCP tools／instructions／Skill 新版、conversation の出所、continuity・dialogue の投影、`api/application/work` の合成 | 認証付き HTTP で取得→claim→返答・要約保存→次の送信が成功する。Session・project 未登録で成立し、他接続・旧版・取消後は拒否する。dots の返答を自己発言にしない |
| P4 API と画面 | `client/dots.ts`、bundle、登録 adapter、Artifact と Web | 保存状態から表示し、明示的な送信・取消・再読込・接続更新ができる。既存の会話出所と削除を維持する。P2・P3に依存する |
| P5 実 dots 受入 | 安定した認証・HTTPS・plugin と購読、受入記録 | 実 dots 自身が3往復し、返答と要約が保存・表示され、購読更新後にも次のメッセージを受けられる。P1〜P4と実接続の条件に依存する |

P0〜P4 は製品データを使わない fixture を基本に進められる。P5 の server 起動・停止・再起動、外部設定や実 dot への送信は対象と内容を先に示し、利用者の明示的な許可の範囲で行う。他の Codex チャットへの送信、代理の返答作成を受入の代わりに行わない。

認証 provider と HTTPS の恒久運用が整っていない場合でも固定試験は進められるが、P5 と恒久接続の完成は未完了として残す。OpenAI の本人認証の追加、認証サーバーの内製、複数購読、定期要約、主会話からの自動送信へ自己判断で範囲を広げない。

## 13 検証計画

### 13.1 部分試験

- 現行の dots domain と JWT の試験を baseline とする。新しい契約、保存、UTF-8 上限、所有者分離、期限、requestId と replyId の再送・内容競合、二重返却、lease、epoch、欠けた要約を試験する。
- §11 は修正前に失敗を再現する。DNS 検査・TLS の接続固定・redirect 拒否は製品の Webhook 関数を直接試験し、MVP に似たコードの試験だけで代替しない。
- migration は旧作業 command、claim、購読、配送参照、session、保存量と停止予約の維持を確認する。旧 SQL を書き換えず追記する。

### 13.2 結合試験

- 既存の `api/application/work/dots-http.test.ts`、`dots-tasks.test.ts`、`dots-review.test.ts`、`dots-audit.test.ts` を再実行する。
- `dots-messages.test.ts` と `dots-messaging-http.test.ts` を application に追加し、実 MCP envelope で認証、本文取得、claim、返却、会話への一回の保存、追加送信、削除、再起動を試す。これらは追加予定のファイルである。
- dots domain が conversation/tasks の SQL を持たず、application の単一 writer で一括保存することを境界検査で確認する。会話保存が失敗した場合は返却 receipt も command 完了も残らない。
- 受信本文を自動で再送しないこと、本文を権限に変えないこと、作業 command とメッセージ command が互いの返却ツールへ通らないことを試験する。

domain 検証は `bun run verify -- --domain dots --domain conversation --domain capabilities --domain continuity --domain dialogue` を基本とする。Queue の実装を変更した場合は `--domain queue` を追加し、実際に変更した利用側も選ぶ。`packages/dots-mcp` と `api/application/work` は domain 選択だけで網羅されたと扱わず、対象ファイルを指定した試験と型検査を加える。全体 gate は `bun run verify:all`、ブラウザ E2E は追加する対象ファイルを明示して個別に実行する。

### 13.3 通し試験

ブラウザ E2E の fixture で送信、返答と要約、追加送信、通知だけでは返答済みにならないこと、取消、再接続、再読込を確認する。その後、実 dots で次の受入を行う。

| ケース | 成功条件 |
| --- | --- |
| 初回と追加送信 | 非機密のメッセージを3往復し、後続の返答が前のやり取りを踏まえる。要約には利用者が指定した要点・決定・未解決事項があり、参照不能な範囲は説明される |
| 返答者 | 実 dots が MCP を呼んだ記録と保存された返答・要約が対応する。試験側で `submit_message_reply` を代理実行しない |
| 通常会話 | project 登録や Codex Session 作成なしで成功する。別チャットへの委任は発生しない |
| 継続 | 一件完了後も購読が残り、実際の refresh を挟んで次のメッセージが届く |
| 重複と通信断 | 同じ request、event、reply の再送で二重表示しない。再起動を行う場合は別途許可を得て同じ command を照合する |
| 取消と解除 | 取消後・連携解除後の新しい返却を採用せず、停止した購読を送信側で復活させない |

fixture、live、画面での確認は別々に記録する。実試験の本文と送信対象は事前にこの会話へ示し、受信結果も共有する。実 dots の画面と MCP 保存結果の一致は人間が観測して確認し、OpenAI の会話履歴 API で取得したとは表現しない。

## 14 設計の確認事項

本案では、既存認証と一つの Events 購読を使い、通常の往復を task から分離する。各送信には返答と累積要約を一緒に返し、同じ会話の未解決送信を一件に制限する。初版は専用欄からの明示的な送信とし、新しい OpenAI ログインや自動ポーリングは必須にしない。

合意対象はこの契約、§5の上限・10分の期限・7日の保持、§10の画面範囲、§12の段階である。設計合意時点では製品コードの変更、実 dots への送信、server 操作を含めなかった。その後、利用者がP0〜P4の実装・検証を許可した。実送信とserver操作は引き続き許可範囲に含めない。実装に進むときは [AGENTS.md](../AGENTS.md) の設計合意と操作権限の規則に従う。

## 15 実装と検証の記録

### 着手時点

- 許可範囲: P0〜P4の実装・検証。実dotsへの送信、サーバーの起動・停止・再起動は行わず、必要になる前に状況を報告する。mainで作業し、担当外の既存差分を保持する。
- P0 baseline: dots domain・JWT・applicationの既存試験78件成功。保存済み設定は管理認証付きAPIで読取済み。OAuth付き接続が1件あり、購読は失効している。資格情報やcallbackは転記していない。
- 再利用: 共通command/lease、Queue、OAuth Resource Server、会話保存、登録式Artifact。通常の返答は専用のmessage契約とし、taskの完了要件を緩めない。
- 着手時の残作業: P1境界修正と試験、P2契約・migration・保持、P3公開MCPと会話への保存・出所、P4APIと登録式画面、対象domainと利用側の検証、最終差分点検。


### P0〜P4の実装

| 段階 | 実装・固定試験の結果 |
| --- | --- |
| P0 | 既存78試験のbaselineと管理認証付きAPIによる設定読取。保存済みOAuth接続1件、購読失効を確認。接続設定を変更していない |
| P1 | URL正規化、A→B→Bの鍵更新、準備済み配送の取消と進行中要求へのAbortSignal接続、HTTP失敗status保存。410/413は再試行せず、429/503は同一event ID・本文と新しい署名時刻で再試行する。製品Webhook関数を直接試験し、private IP・混在DNSの拒否、TLS接続先固定、redirectを追わないこと、応答上限を確認 |
| P2 | `message` command、メッセージ設定・会話・送信・返却・取消台帳。append-only migrationで既存lease・配送FK・保存量・削除済みseqのhigh-water markを保存。会話本文も通常56MiBへ計上し、停止予約を使わない。10分の期限、7日の本文保持、30日のreceipt保持、取消・版・所有者・同一ID再送を検査 |
| P3 | `submit_message_reply` とkind別の取得・claim。返答・要約・receipt・完了状態を単一transactionで保存し、会話保存失敗時のrollbackを確認。attributionを会話保存・履歴検索・資料参照・画面に渡し、continuityはspecialistの発言として投影。削除時は派生snapshotと短期記憶の本文も消す。先行要約後の未要約の失敗した往復も次のsnapshotへ渡す |
| P4 | 管理API、型付きclient、`dots-messaging.bundle.json`、登録adapterとArtifact画面。明示送信・取消・状態更新・購読失効時の下書き保持・履歴ページング・既存会話の復元を実装。通信結果不明時に同じrequestIdを保持し、自動再送しない |

既存の `skill:dots.orchestrate@1`、`@2` と既存packageの有効版は維持した。メッセージ手順を同じSkill系列の新版として有効化すると、版2に固定した既存委任が失効することを結合試験で確認したため、**別ID `skill:dots.messaging@1`** と `MESSAGING.v1.md` に登録した。MCPで公開するcoordinator手順はこの互換手順を読み、taskでは旧来の作業手順、messageでは返答・要約の返却を選ぶ。新規の会話LLMや送信判断の分類器を追加していない。

画面の取消revisionはArtifactイベントに合わせて文字列で渡し、Web adapterで数値に変換する。管理APIの数値型・期待revision・有効状態の検査を正本とする。bundleのJSON Schema部分集合で未対応の `pattern` は使わず、登録可否と起動時seed後のlauncher実在を回帰試験にした。既存登録機構の対応範囲を拡張していない。

### 検証の記録と制限

- 部分→結合→画面の順で実施。実MCP envelopeで送信→本文取得→claim→返答と要約保存→追加送信をfixtureで3往復し、Session・task・projectが不要なことを確認した。実dotsの発話として扱わない。
- `bun run verify -- --domain dots --domain conversation --domain capabilities --domain continuity --domain dialogue --domain tool-runtime` は582件のBun試験と65件のWeb試験が成功し、domain境界・型・format・lint・選択範囲のサイズ検査も成功した。ただし検証中の担当外ソース変更を検出し、run全体は **invalidated**。全体gate成功の証拠にはしない。記録: `verification-reports/runs/2026-10-25T05-21-30-758Z-4e79c146-49f0-47df-a5d4-ce99ca726279/report.json`。
- JWT・MCP・既存作業委任・新規メッセージ・画面登録を別指定で検証した。追加の429/503再試行とQueueのプロセス障害復旧もfixtureで確認した。最新の件数・実行結果はこの節末尾へ追記する。
- `tests/browser/dots-messaging.spec.ts` の2件が成功。HTTPサーバーを立てず、実際の登録ArtifactとWeb adapter、模擬clientをブラウザへ読み込むfixtureを使用。送信、通知だけの待機、返答・折りたたみ要約、追加送信、取消、再読込、購読失効と再登録、狭い画面を確認した。再読込試験では画面再作成の完了を待つ。製品の保持条件を緩めて試験を通していない。
- Web本番build、全体型検査、全体domain import境界は成功。稼働中サービスへ変更を反映した結果ではない。
- 全体サイズ検査には着手前からの超過が残る。今回触れた共通ファイルにも `contracts.ts` はHEADの818行→829行、`buildServices` は306行→315行、`createLifecycles` は307行→316行と既存上限超過への追記がある。ほかに担当外の既存超過もあり、基準値の引上げで通していない。
- 全体SQL境界検査は `inference` から `settings_document` へのアクセスで失敗した。dotsのSQLを他domainへ移す対応はしていない。担当外の修正は行っていない。
- `verify:all` は未実行。既知の静的検査の未通過に加え、一部の対象試験がHTTP待受を起動するため、サーバー操作前に報告する指定を優先した。全体gateを残作業とする。同一ソース固定でのdomain gateは下記の最終実行で取得した。

### 実dots・稼働サーバーへ進む前の報告

P0〜P4の機能実装と対象fixture・画面試験を行った。全体gateの未通過を残しているため、工程全体の完了・運用可能とは宣言しない。サーバーの起動・停止・再起動、製品設定の書換え、実dotや別Codexチャットへの送信は行っていない。実dotsが保存した返答と画面の一致も未確認である。

次は未通過gateと並行変更の扱いを確定したうえで、保存済みOAuth・公開HTTPSの到達条件を確認し、更新ツールとSkillの再スキャン、対象dot自身による監視登録、非機密文での実3往復と購読refreshを行う。保存済み購読はP0読取時点で失効している。起動中backendへのmigration・seed反映、認証サービスやgateway操作が必要な場合も、対象と操作内容をこの会話へ先に示し、許可前には行わない。


### 最終の対象検証（2026-10-25）

登録制約の修正・429/503再試行試験を追加した後、上記と同じ6 domainの検証を再実行し、**583件のBun試験＋65件のWeb試験、合計648件が成功**した。型・format・lint・選択範囲のサイズ・境界・SystemContextの検査と、入力ソースとDesignSystem出力の同一性検査も成功した。初回のinvalidated記録に代わる有効な対象検証として、[domain-report.json](verification/dots-messaging-2026-10-25/domain-report.json)を保存した。検証中は記録対象69ファイルのhash一致を確認した。その後、登録試験が内部bundleを直接importしていた参照境界を、公開操作で保存済み定義を読む形に修正した。また異なる返却ツールへの引数は形式上有効な状態で拒否を試すようにした。変更は試験だけで、該当3試験・全体import境界・lintの再実行は成功した。型検査はいったん2,481ファイルで成功した後、最終実行では下記の担当外エラーが出た。機能実装は変えていない。最終hashを受入記録へ保存した。

別指定のMCP・既存委任・新規往復・登録試験は**44件成功**、client試験1件、サーバーなしのブラウザ試験2件、Queueのプロセス障害復旧試験3件が成功した。429/503再試行試験はdomain試験にも含まれるため件数を単純加算しない。全体型検査は2,479ファイル成功、Web本番buildとbundle dry-runも成功した。[検証結果と機能ソースhash](verification/dots-messaging-2026-10-25/checks.json)、[画面のfixture記録](verification/dots-messaging-2026-10-25/screen.png)。

全体サイズ・SQL境界検査の未通過、`verify:all`、稼働サーバー反映、実dots受入は上記のとおり残っている。対象検証の成功をもってこれらが完了したとは扱わない。Context Stillはcontext_compile 1回、compile_eval 1回。


最終の全体型検査は、並行変更された `web/src/workspace/ErrorReportDialog.test.tsx:43`、`:68` の `client` propとcomponent propsの不一致2件で失敗した。dotsの機能実装はこの間変更しておらず、担当外の型・SQL・サイズの問題を修正したり、理由なく再検証を繰り返したりしていない。現在の作業ツリー全体について型検査成功とは宣言しない。最終記録ではこれを `typecheck: fail` として区別した。


## 16 P5着手と接続操作（2026-10-25）

利用者が実dots接続、反映に必要なサーバー操作、送信と返答・要約の3往復を許可した。対象dotは「セバスチャン」。旧10月11日のtrial接続は公開URLのDNSが失効し、OAuthサービスも期限切れのため、元の所有者・履歴を変更せず新しい試験接続を作る。既存の2時間制限のoidc-provider、専用allowlist gateway、Cloudflare HTTPSを再利用する。恒久認証の完成とは扱わない。

接続UIは既存の `artifact:dots.messaging@1` の表示部品とWeb adapterを拡張する。保存済みOAuth設定に任意の公開 `clientId` を追加し、接続先のMCP URL・公開client ID・ChatGPTプラグインへのリンク・監視開始の指示を表示する。認証方向はChatGPT→Eumenesのまま。新しいOpenAIログイン、認可コード交換、トークン保存先、認証判断方式は追加しない。既存issuer・resource・subjectの所有者固定、JWTとscope検証を維持する。公開設定は既存管理APIで保存し、秘密をArtifactへ渡さない。

作業順: 既存接続とプロセス確認→接続案内の実装・型/部分/UI検証→必要なbackend反映→新しいtrial用認証・公開gateway・接続設定→ChatGPTで利用者の接続操作→セバスチャンによるEvents購読→非機密の3往復→保存・表示・累積要約・購読維持の確認。未完成の段階を通し検証して想定内の失敗を追わない。実返却はセバスチャンに任せ、試験側が `submit_message_reply` を代理実行しない。通常メッセージ以外の作業実行・他チャットへの委任は許可しない。

完了条件は、実セバスチャンによる同一メッセージ会話の3件の返答・要約の保存と画面表示を確認し、OAuth接続・購読・配送・返却の観測を分けて残すこと。利用者の認証操作や対象dotの選択が必要な段階では、具体的な操作画面を用意して引き継ぐ。残作業は接続案内、反映、認証、購読、実3往復、受入記録である。


P5反映時の調整: 起動時に既存 `skill:dots.messaging@1` と現在の組込み定義の不一致を検出した。旧版の保存済み定義を上書きせず、現行メッセージ手順を `skill:dots.messaging@2` / `MESSAGING.v2.md` として公開する。版1は保存台帳に残し、現在のseedでは再登録しない。既存 `dots.orchestrate` のprofile・Skill・packageは変更しない。旧版の異なる保存済み本文があっても新しいseedが成功し、旧hashが残るfixtureを追加してから再起動する。
