# 会話タイマーとデジタル時計アーティファクトの実装計画

作成日: 2026-10-09 JST。状態: Grok向け実装手順、実装前。改訂2。

この文書をタイマー実装の唯一の設計資料とする。後半の具体契約・作業手順まで順に適用する。他の計画、過去のレビュー、外部Web、別リポジトリを調査する必要はない。コードを安全に変更するため、各作業に列挙した既存ソースとその直接の型定義・テストだけは読む。関数の行番号やmigration番号は並行変更で変わるため、本文の関数名を検索して位置を特定する。ソースとの軽微な命名差は既存名へ合わせ、公開契約と業務ルールを勝手に変更しない。

「3分タイマー測って」という音声・文字の依頼でタイマーを保存し、会話の横に大きなデジタル時計を開く。時計は `03:00 → 02:59 → … → 00:00` とカウントダウンし、期限に達すると終了表示と通知音で知らせる。開始・残り時間の照会・取消を会話から操作でき、画面の再読込みやbackend再起動でも同じタイマーを確認できる。

タイマーの正本はbackendの終了時刻と状態。DesignSystemは時計の見た目を、Webのtimer domainは表示時刻の計算とAPI操作を、既存schedulerとqueueは期限後の処理を担当する。会話runを3分待機させず、開始の保存が確認できたら直ちに応答する。

## 1 現状と利用できない理由

参照HEAD: `2a86b50750da8699706b459d4c465a7fe2301e65`。調査時の作業ツリーには委任タスクなどの並行変更がある。実装着手時に差分を再確認し、他の作業を戻さない。以下はソース確認による現状であり、今回の機能の検証結果ではない。

| 対象 | 確認できた実装 | 追加が必要な点 |
| --- | --- | --- |
| `scheduler/contracts`、`service` | once予約、永続保存、復旧、重複防止、transaction内のtarget作成。`createInTransaction`、`getInTransaction`、`cancelInTransaction`がある | `timer.expire` targetの登録。intervalの最低60秒はonceには適用されない |
| `queue` | 遅延受付、取消、lease、再試行、replay_safe handler | LLM資源を使用しないタイマー終了handler |
| `dialogue.promptTarget` | 予約から会話の推論を再実行 | これをタイマー終了に使うと推論待ちが発生するため、専用targetを用意 |
| `capabilities` | 不変版、SKILL依存、schema検査、準備と失効検査 | backendは既定web、validatorsは調査用。timerのschemaと組込みpackageを追加 |
| `agent-runtime` | route/select/workerと回答採用ticket | routeはrespond/clarify/discover。selectはresearchInput固定、finishは出典付き報告。短い操作を扱う経路が必要 |
| `tool-runtime` | owner付きexecutionRef、stepの重複防止、adapter、invocation台帳 | adapterはjobId必須、結果はhits/documents。即時に保存した操作のreceiptを扱えない |
| `dialogue`の回答投影 | 調査要約を会話へ渡す構成と固定の取得失敗文 | 操作receipt用の投影と失敗文。未実行の「開始しました」を許さない |
| `web/domains/artifact`、`ArtifactPanel` | 会話横のタブ、8タブ上限、Markdown表示 | `kind:"markdown"`とcontentのみ。timer参照とReact rendererを追加 |
| `packages/design-system` | UI部品、テーマtoken、Storybook、テスト、公開export | 再利用可能なDigitalClock。APIやschedulerは部品へ入れない |
| `application/events` | SSEのchange/resetでAPIの再取得を促す | timer更新の通知接続。SSEを終了通知の唯一の保管場所にしない |

不足しているのは、自然文の操作要求、保存の確認、終了処理、成果物表示をつなぐ契約である。SystemContextの追記だけでは作動しない。

## 2 初版の利用体験

1. 利用者が「3分タイマー測って」と話すか送信する。
2. backendが期間180秒を検査し、timer・once予約・操作receiptを同じwriter transactionで保存する。
3. 保存確認後に「3分のタイマーを開始しました」と応答する。音声の開始応答は既存のTTS経路を使う。
4. 同時にtimer参照を含む会話カードを表示し、時計アーティファクトを自動で開く。開始時点から経過していれば `02:58` など実際の残り時間を表示する。
5. 時計の中央に大きな残り時間、その上に「3分タイマー」または明示された名前、その下に状態・終了予定時刻・取消ボタンを置く。
6. 期限後は `00:00` と「時間になりました」を表示し、通知音を一度再生する。終了の判定・保存にLLMやTTSを必要としない。
7. パネルの×は表示を閉じるだけ。取消は専用ボタンまたは会話の依頼で行う。カードから同じtimerを再表示できる。

PCでは既存の横パネルを使用し、スマートフォンでは既存の縦配置に収める。時計を開くために別画面へ移動させない。複数タイマーは別タブで表示し、8タブ上限で閉じられても稼働は続く。表示していないタイマーの終了も共通の通知領域から知らせる。

初版は相対時間の単発タイマー、開始・一覧照会・取消、複数件、会話カード、時計、画面と通知音、復旧を含める。期間は1秒〜24時間、同時activeは最大32件に固定する。絶対時刻のアラーム、反復予約、一時停止・再開・延長、ストップウォッチ、外部通知サービス、任意生成HTML/JavaScript、OSの常駐通知は後続とする。新規ライブラリや外部アプリの配備を前提にしない。

## 3 Domainの所有と接続

| 所有者 | 担当 |
| --- | --- |
| 新規 `timers` backend | 期間・状態・取消の業務判断、timer台帳、操作receipt、通知台帳、終了targetとhandler、SQLと試験 |
| `scheduler` | 指定した期限のonce予約、occurrence、復旧。timerの名前や通知方針を解釈しない |
| `queue` | 終了jobのclaim、lease、取消、再試行。時計の表示状態を所有しない |
| `capabilities` | timer tool/package/SKILLの組込み版とschema、必要な依存と利用可能性 |
| `tool-runtime` | owner付き実行、即時操作receipt、invocationの整合性と重複防止 |
| `agent-runtime` | 自然文の操作選択、許可toolの呼出し、操作receiptの回答ticket |
| `dialogue` | 保存済みユーザー入力の出所、開始応答とカード参照、古い回答の採用拒否 |
| 新規 `timers` Web | APIからのsnapshot、時刻同期、カウントダウン、取消と通知音の調整 |
| 既存 `artifact` Web | timerタブの開閉とrendererの選択。時間・状態の正本を持たない |
| DesignSystem | DigitalClockの表示とアクセシビリティ、テーマ、Storybook |
| `application` | domainの公開操作とportの接続、HTTP組立て、commit後のwake/publish |

`timers.depends=["queue","scheduler"]`に固定する。timersからdialogue・agent-runtime・Webをimportしない。agent-runtime/tool-runtimeはtimersをimportせず、自domainのport契約をapplicationで接続する。会話参照の確認もportで接続し、他domainのSQLを読まない。DesignSystemはbackendへ依存しない。

配置:

- `api/domains/timers/{contracts,repository,service,controller,test}/`、`index.ts`。
- `api/application/timers.ts`と結合試験。起動時にtarget/handlerを登録し、worker開始前にtimerの復旧を行う。
- `api/domains/capabilities/builtin/timers.ts`、`builtin/timers/SKILL.md`。
- `client/timers.ts`、`web/src/domains/timers/`、`web/src/components/domains/timers/TimerArtifact.tsx`。
- `packages/design-system/src/components/DigitalClock/{DigitalClock.tsx,index.ts,DigitalClock.stories.tsx,DigitalClock.test.tsx}`。
- `scripts/domains.ts`、末尾追加migration、query keys、SSE invalidation、既存artifactの型・rendererを更新。

今回は内部timer参照を既存パネルに表示する。外部iframe、LARMアプリ発見、外部文書の版管理の完成を待たない。外部文書用のinstanceIdをtimerへ作らない。他の成果物計画を読む工程は設けない。

## 4 時計コンポーネントとアーティファクト

### DigitalClockの契約

```ts
type DigitalClockProps = {
  seconds: number; // 非負整数。残り時間の計算は呼出し側
  format?: "mm:ss" | "hh:mm:ss" | "auto";
  size?: "sm" | "md" | "lg" | "hero";
  tone?: "default" | "warning" | "finished" | "muted";
  label?: string;
  className?: string;
};
```

DigitalClockは値を表示するcontrolled componentとする。内部interval、開始/取消、通信、音声、完了callbackは持たせない。これによりtimer以外の時計・ストップウォッチにも再利用できる。`auto`は1時間未満をMM:SS、それ以上をHH:MM:SSにする。

数字は等幅で幅を固定し、桁が変わっても位置をずらさない。heroはパネルの有効幅に合わせて拡大し、長時間の8桁表示や狭い画面でも欠けない。色と余白は既存tokenを使う。初版は読みやすいデジタル表示とし、激しい点滅や毎秒のアニメーションは付けない。

残り時間はrole=timer相当の読み取り可能な表示とし、毎秒のaria-live通知は行わない。終了・取消・通信切断など状態の変更だけを別の領域で知らせる。Storybookは3分、1時間超、24時間、終了、muted、light/dark、狭い幅、heroの状態を用意する。

### 型付きのtimerタブ

```ts
type ArtifactTab =
  | { id: string; kind: "markdown"; title: string; content: string }
  | { id: string; kind: "timer"; title: string; timerId: string };

type TimerArtifactRef = { kind: "timer"; timerId: string; version: 1 };
```

timerタブのIDは`timer:<timerId>`。同じIDを開き直してもタブを増やさない。パネルはkindごとに既存Markdown rendererかTimerArtifactを表示する。モデルがHTMLやReactを生成する方式にはしない。

timer参照はtimer台帳にconversationId・開始runId・入力messageIdとともに永続化する。会話の添付表示でAPIから一覧を取得し、開始応答と関連付ける。応答生成が失敗しても保存済みtimerは一覧と元の依頼カードから発見できる。別途、毎秒の値を会話本文やDBへ保存しない。

新しい開始receiptに対してだけ自動で開く。SSE再接続や履歴再取得のたびに、利用者が閉じたパネルを開かない。再読込み後はカードと稼働中一覧から再表示できる。選択タブの記憶を後で追加する場合も、保存するのはIDだけとし、残り時間は再取得する。

### カウントダウンの時計

APIは`serverNow`、`startedAt`、`dueAt`、state、revisionを返す。Webは応答取得時にserverNowと`performance.now()`を束縛し、経過時間から現在時刻を推定する。通信往復時間も計測し、往復の半分を補正値として使用するが、表示は近似である。

`remainingSeconds=max(0,ceil((dueAt-estimatedServerNow)/1000))`を毎秒境界付近で再計算する。intervalごとに1を減らす方式にしない。タブの復帰・再接続・端末スリープからの復帰ではsnapshotと時刻を取り直す。表示の毎秒更新ではAPIやDBへ書かない。

elapsedは0で固定する。cancelledは保存したcancelledAt時点の残り時間で固定し、「取消済み」とmuted表示にする。取消後にカウントダウンを続けない。取消APIが失敗した場合は稼働表示を維持し、失敗を知らせる。

0になった表示とbackendで終了処理を確認した状態を区別する。activeのまま期限を過ぎた場合は`00:00`と「終了を確認中」。backendからelapsedを確認して終了通知を行う。切断中は「接続を確認中」を添え、推定表示を続けても終了保存や通知成功を断定しない。PCの時刻変更によるbackend期限への影響は別途検出し、単調時計だけで再起動越しの保証を作らない。

## 5 公開ツールと実行契約

モデルへ公開するtoolは以下の3つ。任意のqueue kind、target、SQL、実行コードを渡す入口は公開しない。

| tool | strict入力 | 説明と成功条件 |
| --- | --- | --- |
| `timer.start` | `{durationSeconds: integer 1..86400, label?: string <=80}` | 現在の明示依頼から相対時間タイマーを開始。timer・予約・receiptのcommit後が成功。180秒待たない |
| `timer.list` | `{state?: "active"\|"elapsed"\|"cancelled", timerId?: string}` | 現在のscopeのtimerとserverNowを取得。残り時間を会話履歴から推測しない |
| `timer.cancel` | `{timerId: string, expectedRevision: integer}` | activeなら予約とtimerを取消。elapsedなら未処理の通知をdismiss。保存確認後に結果を返す |

requestId、scope、conversationId、出所、cancelEpoch、操作権限はホストが注入する。timerIdはAPIまたは検証した選択参照から使い、モデルに発明させない。「止めて」の候補が複数あれば確認する。操作への参照として選択タブをruntime contextに渡せるが、それだけでは取消許可にならない。

```ts
type TimerReceipt = {
  kind: "timer_action";
  operationId: string;
  action: "started" | "listed" | "cancelled" | "dismissed" | "unchanged";
  serverNow: string;
  timer?: {
    id: string; revision: number;
    state: "active" | "elapsed" | "cancelled";
    startedAt: string; dueAt: string; durationSeconds: number;
  };
  artifact?: TimerArtifactRef;
};
```

listは複数itemsを返す別receipt型とし、実装ではactionによるdiscriminated unionで必須項目を固定する。開始成功は「予約を受け付けた」という意味であり、将来の音声再生まで成功したという意味ではない。既に取消済みはunchanged、既にelapsedはdismissedまたはunchangedを返す。同じ操作の再送は元のreceiptを返し、現在状態はlistで取得する。

`POST /api/timers`、`GET /api/timers`、`GET /api/timers/:id`、`POST /api/timers/:id/cancel`、通知のclaim/ack入口を追加する。既存認証・Origin検査、共通client、revision conflictを使用する。CLIにもstart/list/cancelを追加し、DBを直接開かない。

## 6 タイマー台帳と終了通知

`timers`にはid、scope、conversationId、originRunId/messageId、label、duration、startedAt、dueAt、cancelledAt、state、revision、cancelEpoch、scheduleId、expiryJobId、createdAt/updatedAtを保存する。操作台帳はrequestIdと入力digestとreceipt、通知台帳はnotificationId、timerId、世代、dueAt、status、claim期限、ackを保存する。通知の状態とtimerの状態は分ける。snapshotにはcancelledAtも含める。

開始transactionでホストのnowを一度取り、`startedAt=now`、`dueAt=now+durationSeconds*1000`を固定する。モデルに絶対終了時刻を計算させない。冪等再送では時刻を再計算せず既存receiptを返す。同じrequestIdで異なる入力は409。同じ文章の別依頼は別timerになり得るが、同じ出所run/操作のretryは一つにする。

開始はtimer作成、`scheduler.createInTransaction`、schedule参照保存、操作receiptを同時commit。失敗したら全体をrollbackする。writer transactionからnested writeを呼ばない。commit後にschedulerをwakeする公開操作を確認・追加し、メモリー上の通知やタブ表示をcommit前に出さない。

`timer.expire` targetはtimerIdとcancelEpochを持つ。materializeで現在状態を確認してLLM資源なしのreplay_safe jobを作る。handlerのprepare/settleでも世代・active・期限を確認し、elapsedへの遷移と一意notification作成を同じtransactionで行う。execute中に音声やSSEへ直接送信しない。取消が先にcommitしたら古いjobはstaleとなり、終了が先にcommitしたら取消は通知dismissとして処理する。

取消transactionではtimerの世代更新、取消時刻、通知dismissを保存し、scheduleがactive/pausedのときだけschedulerの取消公開操作を使う。既にdispatchされcompletedのscheduleへ取消を要求して全体を失敗させない。dispatch済みのexpiry jobは別途queueへ取消を要求し、取消要求が遅れてもhandlerの世代検査で停止する。

once予約のcompletedはdispatch完了であり、timer終了や音が鳴った証拠ではない。queue満杯ではdue予約を保持する既存処理を使う。terminal job失敗はtimerをactiveのまま放置せず、復旧・保守で未終了のdue timerを照合し、同じ通知キーで再配送する。失敗reasonはsnapshotへ投影する。

終了通知の既定は「期限から5分以内なら音、それより古ければ未確認の終了表示のみ」に固定する。予約はcoalesceで期限超過を捨てず、音を鳴らす鮮度は通知claim/再生直前にも確認する。バックグラウンド停止から長時間後に復帰して突然古い音が鳴るのを避ける。

複数画面ではnotificationを短いleaseでclaimした一画面だけが音を再生し、再生後にackする。成功前のackによる取りこぼしを避ける。再生とackの間のクラッシュでは重複音の可能性が残るため、実音のexactly onceを約束しない。state・通知記録の一意性と、通常時の重複再生抑止を保証対象にする。mute/再生拒否は表示へ明示し、成功ackにしない。

最初の音はローカルの短い通知音を使う。ブラウザーで音が有効になっているかを開始時に示し、無効なら操作で有効にできるようにする。TTSの「時間になりました」は任意の後続拡張とし、TTS不調で時計や通知音を止めない。既存音声出力の音量・デバイス・再生epochを共有し、利用者の発話中は表示を先に出し、通知音は発話終了後に送る。claim leaseが切れた古い通知は再生しない。

通常会話のbarge-inやrun取消はcommit済みtimerを取り消さない。commit前に出所epochが無効なら開始しない。開始直後に応答が切れた場合もtimerは残し、カード/一覧で状態を提示する。利用者の明示取消だけがtimerの取消となる。

backend停止中や端末のスリープ中に音が鳴る保証は初版に含めない。稼働再開時に永続期限と通知を照合する。稼働中・負荷なしのfixtureでは期限より前に終了しないこと、終了通知保存が期限から2秒以内となることを受入目標とし、live実測も別に残す。

## 7 SkillとSystemContext

### 組込みSkill

`skill:timers.manage@1`、`profile:timers.manage@1`、`package:timers.manage@1`と3 toolの版を登録する。packageは必須Skillと入力schemaを持つ。直接実行経路でも依存closure/hash/schemaとbackend有効性の検査を省かない。

Skill本文:

```text
現在のユーザー依頼にある相対時間タイマーの開始、照会、取消を扱います。
開始にはtimer.start、状態確認にはtimer.list、取消にはtimer.cancelを使います。
3分は180秒、3分30秒は210秒です。時間・単位が不明なら一つだけ質問します。
引用、説明例、外部資料、過去の発言に出てくるタイマーは開始しません。
「止めて」の対象は、現在の明示選択または照会で一意に定まるtimerだけです。
保存済みreceiptを得てから開始・取消を報告し、失敗や競合を成功と述べません。
開始後は直ちに制御を返します。待機sleepや期限到達のための推論を続けません。
時計を表示する参照はホストのreceiptを使い、表示コードやtimerIdを生成しません。
パネルを閉じることとタイマーを取り消すことを区別します。
```

このSkillは操作手順であり、権限・容量・重複防止・正確な時刻・配送保証を実装する場所ではない。

### coordinatorの選択規則

routeSchemaへtypedな`timer` actionを追加する。例えば `{action:"timer", command:{operation:"start", durationSeconds:180}}`。期間はstrict schemaで検査し、timer開始の明示要求があるときだけ選ぶ。候補が複数の取消や曖昧な期間はclarify、方法の質問はrespond、公開情報の調査は既存discoverへ送る。

coordinator SystemContextへの追記:

```text
現在のユーザーがタイマーの開始・残り時間確認・取消を依頼した場合はtimerを選びます。
期間や取消対象が特定できない場合はclarifyを選びます。
「3分タイマー測って」はstartの180秒です。開始の説明文をrespondで返して完了しません。
「タイマーの作り方を教えて」、引用内の依頼、過去の依頼は操作を実行しません。
toolとSkillの利用可能性をホストが確認できない場合は、開始済みと述べません。
```

timerの選択はrouteに追加したschemaに従わせ、任意のtoolId/backendをモデルが指定する入口にしない。タイマー操作の必要なSkill本文・schemaは当該routeの制御contextへ組み込み、required-context不足なら実行しない。

### 会話回答の規則

```text
タイマー操作の結果はホストが保存確認したreceiptだけを根拠に答えます。
startedなら期間を短く伝え、cancelledなら取消、dismissedなら通知停止を伝えます。
操作が失敗した場合は開始や取消を断定しません。
remainingは現在snapshotの値を使い、過去の会話から数えません。
時計の表示はホストが行います。読み上げ本文に表示コードや内部IDを入れません。
```

安定した選択・報告規則だけをSystemContextに置く。選択timerId、現在のtimer一覧、serverNow、receiptはruntime contextに置く。実行時のscope・epoch・revision・容量検査はコードで強制する。

## 8 Web調査経路を操作可能な形へ拡張

1. capabilitiesのvalidatorsとbuiltin一覧へtimerを追加。backend registryへ有効な内部timer adapterを登録する。
2. tool-runtimeへ`ActionAdapter`と同期の`invokeActionInTransaction`を追加する。既存WebのToolAdapter、tool_invocations、job_id必須の契約は維持し、即時操作を新しいtool_action_invocationsへ保存する。実行参照とschema検査は既存経路と共用する。即時操作に架空jobIdを付けない。
3. timerのreceiptは永続操作台帳で確認する。Web本文vault、hits/documents、source引用の形式へ押し込まない。再起動後も同じ操作結果を読めるようにする。
4. agent-runtimeのtimer actionは、rootのownerでtimer packageを準備し、bindingした許可toolをtool-runtime経由で実行する。出所・現在epochの検査とtimer開始・invocation・action receiptの採用を単一transactionに組み合わせる。固定能力の直接prepareは既存候補prepareと同じ検査を共用するhost専用操作として追加する。
5. 単純タイマーは調査workerを作らず、rootにaction receipt用ticketを作る。調査のReport/verifyReportとは別の結果種別にする。receipt ID/hash、owner、epoch、timer revisionを確認し、引用や架空sourceIdを要求しない。
6. dialogueのprojectionをresearch/action/clarification/failureで分岐させる。タイマー失敗を「公開情報を取得できませんでした」にしない。timerがその後elapsed/cancelledへ変わっていれば現状を尊重し、古い開始receiptで「稼働中」と断定しない。
7. 開始・取消の短い応答はreceiptからpersonaに合う固定文を作り、追加の回答LLMは呼ばない。route推論1回＋保存が基本経路。音声開始応答のTTSは既存処理で行う。

期間の簡単な日本語パターンをhostで高速判定する追加最適化は後続とする。初版は既存route推論を使い、否定・引用・説明文の部分一致で誤って開始する実装を避ける。SystemContextだけで任意の操作許可を生成しない。

## 9 実装順と完了条件

| 工程 | 作業 | 完了条件 |
| --- | --- | --- |
| P0 | 列挙した変更箇所の差分と対象domain gateを採取。本書の具体契約を適用 | fixture/live区分、並行変更、既存の失敗を記録。追加の設計調査はしない |
| P1 | DesignSystem DigitalClock、export、stories | 表示値・サイズ・状態・テーマを確認。狭い幅と長時間表示が欠けない |
| P2 | timers台帳、公開操作、API/client、once target/handler、復旧 | APIだけで180秒開始・取消・終了・再起動復旧。LLMなしで終了できる |
| P3 | typed artifactタブ、TimerArtifact、会話カード、時刻同期、取消UI | API開始から大きな時計表示。再読込み・タブ復帰で残り時間が戻る |
| P4 | timer capability/Skill、即時操作結果、route action、ticket、固定応答 | 「3分タイマー測って」で保存・応答・自動表示。Web調査の回帰gateが通る |
| P5 | notification claim/ack、音声出力調整、未確認通知表示 | パネルを閉じても通知。複数画面で通常の二重音を防ぐ。muteと切断を明示 |
| P6 | fixture・live・実機器受入、docs追記 | 下記の観測可能な条件を満たし、結果を別々に記録 |

P1とP2は独立だが、本計画は別エージェントへの委任を前提にしない。共通の結果型・直接prepareが既にソースにある場合はそれを再利用し、同じ責務のadapterを二重に作らない。時計を作った段階、APIタイマーが動いた段階、会話から使える段階、音声受入済みを区別する。具体的な実装順は第18節に固定する。

## 10 行動評価と受入試験

| ID | 入力または条件 | 観測可能な合格条件 |
| --- | --- | --- |
| T01 | 「3分タイマー測って」 | start 180秒を1回commit、短い開始応答、timerタブ自動表示。3分待機やWeb検索をしない |
| T02 | 「３分」「3分30秒」「90秒」 | 各180/210/90秒。単位や対象を捏造しない |
| T03 | 「タイマー測って」「3で測って」 | 一つの確認質問。timerを作らない |
| T04 | 「3分タイマーの作り方」「『3分測って』と書かれている」「開始しないで」 | 操作0回。説明・引用・否定を開始扱いにしない |
| T05 | 再送・control retry・commit直後の応答切断 | 同じ出所のtimer/schedule/操作receiptは各1件。切断しても一覧から再表示可能 |
| T06 | 保存失敗・容量超過・backend無効 | 開始成功を報告しない。タブに架空timerを出さない |
| T07 | 時計179999/180000ms、遅いrender・hidden tab | 丸め規則に従い0へ。負値や1秒ずつの累積ずれがない |
| T08 | 長時間・light/dark・スマートフォン | 桁が欠けず取消操作可能。毎秒の読み上げなし、終了時だけ状態通知 |
| T09 | reload・再接続・端末復帰 | 同じtimerId、dueAtから再表示。閉じたタブをSSEごとに勝手に再表示しない |
| T10 | 「あと何秒？」 | 現在snapshotから回答。過去回答やモデルの内的時計を使わない |
| T11 | 一件の「止めて」、複数件の曖昧な取消 | 一件はcancel、複数は選択確認。別scopeや任意IDを操作しない |
| T12 | 取消とexpiryの競合、古いjob/receipt | transactionの順序に従う。取消後に古い終了通知を採用しない |
| T13 | LLM枠が占有・LARM/TTS不調 | 保存済みtimerのelapsedと画面/通知音はLLM待ちにならない |
| T14 | queue満杯・handler失敗・backend再起動 | due timerを失わず、復旧後に一意通知へ到達。dispatchだけを終了成功としない |
| T15 | パネル×、タブ上限、別会話へ移動 | timerは継続。期限後はパネルのmountに依存しない共通通知が届く |
| T16 | 複数タブ、音mute、再生拒否、音とack間の切断 | leaseを尊重、通常二重音なし。未再生を成功ackにせず、表示に残す |
| T17 | 期限から5分超の復旧 | elapsed/未確認表示は残るが古い音を自動再生しない |
| T18 | 音声の割込み・新しい通常会話 | 開始済みtimerは継続。明示取消したtimerの古い音は再生しない |

fixtureはfake clockと隔離DBで状態・transaction・時刻を検証する。モデルの行動評価は実際のtool呼出しと状態変更を採点し、隠れた推論を採点しない。実LARMではT01〜T04/T10/T11のroute選択と開始応答を評価し、負荷なしの終了遅延も測る。

実機器はマイク・出力デバイスで、開始依頼と短い応答、途中の残り時間確認と応答、終了通知後の停止依頼と応答の3往復を通す。実際に180秒計測し、開始時計・終了表示・通知音を確認する。fixtureやTTS生成成功だけで音声受入完了としない。

検証対象は新規timers、変更するscheduler/queue/capabilities/tool-runtime/agent-runtime/dialogue/voice-dialogue、DesignSystem、Web artifactとtimer、結合試験、browser。日常は該当domainの`bun run verify -- --domain <name>`、横断の最後に`bun run verify:all`。DesignSystemは同packageのtest/typecheckとルートの`build:design-system`でexportも確認する。結果は`spec/verification/timers/`にfixture、live、devicesを分けて保存する。

ログはtimerId、operationId、runId、jobId、notificationId、状態と遅延を記録する。会話本文・label・認証情報・Provider生応答は渡さない。障害調査は`bun run logs -- --level warn`から始め、該当IDとHTTPのX-Request-IdでJSONLを絞る。通常の状態遷移はdebug、復旧失敗・終了処理失敗・通知再生失敗はwarnとする。

以下の具体契約を初版の正本とする。前半の概略型と細部が異なる場合は、以下の型・定数・状態遷移を優先する。

## 11 確定する定数と状態

`timers/service/policy.ts`へ次を置き、testsではnowだけを差し替える。初版に環境変数による値の変更UIは作らない。

```ts
const TIMER_POLICY = {
  minSeconds: 1, maxSeconds: 86400, maxLabelChars: 80,
  maxActive: 32, maxRows: 4096,
  maxOperations: 32768, cancelReserve: 64,
  listDefault: 50, listMax: 100,
  maintenanceMs: 1000, batchSize: 100,
  soundFreshMs: 300000, claimLeaseMs: 15000,
  requestMaxAgeMs: 86400000, requestFutureToleranceMs: 30000,
  retentionMs: 30 * 86400000,
  tombstoneMs: 30 * 86400000,
};
```

| 状態 | 許可する変更 | 禁止する変更 |
| --- | --- | --- |
| timer active | due後のelapsed、cancelled | 期間・dueAtの更新、再開 |
| timer elapsed | timer自体は終端。通知dismissのみ可能 | activeへ戻すこと |
| timer cancelled | 再取消はunchanged | active/elapsedへ戻すこと |
| notification pending | claimed、silent、dismissed | playedへの直接変更 |
| notification claimed | 所有claimでplayed/silent/dismissed、lease切れでpending | 他claimからack |
| notification played/silent | 明示停止でdismissed、その他は終端 | 自動でpendingへ戻すこと |
| notification dismissed | 終端 | 自動再生・再claim |

silentは「音を再生していない終端通知」。reasonはmuted/blocked/staleで、画面には終了を表示し続ける。playedだけを再生成功とする。ユーザーが停止を押すと通知状態をdismissedにして確認済みとする。初版は自動再試行音・繰返しアラーム・手動再鳴動を作らない。

active32件はscope全体で数える。rows4096件と通常operations上限に達したら新規startを429で拒否する。cancelの実際の状態変更は64件の予約枠を利用できる。容量が無いときにunchanged操作のreceiptを増やして予約枠を消費しない。容量判定・回収はtimers domain内で行う。

## 12 DBと公開DTO

### 12.1 追加migration

既存migrationを編集せず、`timers/index.ts`からexportする新規migrationをapplicationの末尾へ追加する。DBは既存の主DBとwriterを使用する。以下の列を作り、既存のmigration export形式へ合わせる。時刻のSQL型はすべてINTEGERのUTC milliseconds、APIではISO文字列へ変換する。

```sql
CREATE TABLE timers (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  conversation_id TEXT,
  origin_run_id TEXT,
  origin_message_id TEXT,
  origin_key TEXT,
  label TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 1 AND 86400),
  started_at_ms INTEGER NOT NULL,
  due_at_ms INTEGER NOT NULL,
  cancelled_at_ms INTEGER,
  terminal_at_ms INTEGER,
  state TEXT NOT NULL CHECK(state IN ('active','elapsed','cancelled')),
  revision INTEGER NOT NULL DEFAULT 0,
  cancel_epoch INTEGER NOT NULL DEFAULT 0,
  schedule_id TEXT,
  expiry_job_id TEXT,
  dispatch_generation INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  body_expired INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK(due_at_ms = started_at_ms + duration_seconds * 1000),
  CHECK((state = 'cancelled') = (cancelled_at_ms IS NOT NULL))
);
CREATE UNIQUE INDEX timers_origin ON timers(scope, origin_key)
  WHERE origin_key IS NOT NULL;
CREATE INDEX timers_due ON timers(state, due_at_ms, id);
CREATE INDEX timers_conversation ON timers(scope, conversation_id, created_at_ms, id);

CREATE TABLE timer_operations (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  input_digest TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('start','list','cancel')),
  timer_id TEXT,
  origin_key TEXT,
  receipt_json TEXT,
  receipt_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expired_at_ms INTEGER,
  UNIQUE(scope, request_id)
);

CREATE TABLE timer_notifications (
  id TEXT PRIMARY KEY,
  timer_id TEXT NOT NULL REFERENCES timers(id),
  scope TEXT NOT NULL,
  generation INTEGER NOT NULL,
  due_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','played','silent','dismissed')),
  reason TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT,
  claim_request_id TEXT,
  client_id TEXT,
  lease_until_ms INTEGER,
  played_at_ms INTEGER,
  dismissed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(timer_id, generation)
);
CREATE INDEX timer_notifications_pending
  ON timer_notifications(scope, status, due_at_ms, id);
```

schedule/job/conversation/run/messageへの跨domain FKは追加しない。参照の実在確認は公開操作/portで行う。scope・origin_keyは外部の任意申告から書かない。通知のFKは同domainなので許可する。

repository関数はすべて同期Tx引数とする。必要な操作は`getTimer`、`listTimers`、`countActive`、`getOperationByRequest`、`getTimerByOrigin`、`insertTimer`、`attachSchedule`、`transitionTimer`、`attachExpiryJob`、`insertOperation`、`insertNotificationIfAbsent`、`claimNotification`、`settleNotification`、`findDueActive`、`pruneBatch`。repositoryはstore.write、queue、schedulerを呼ばない。

### 12.2 正式なDTO

```ts
type TimerState = "active" | "elapsed" | "cancelled";
type TimerDto = {
  id: string; revision: number; state: TimerState;
  label: string; durationSeconds: number;
  startedAt: string; dueAt: string; cancelledAt: string | null;
  remainingSeconds: number; // snapshotのserverNowで計算
  conversationId: string | null;
  originRunId: string | null; originMessageId: string | null;
  errorCode: string | null; bodyExpired: boolean;
};
type TimerArtifactRefV1 = { kind: "timer"; version: 1; timerId: string };
type TimerNotificationDto = {
  id: string; timerId: string; generation: number; revision: number;
  status: "pending" | "claimed" | "played" | "silent" | "dismissed";
  reason: "muted" | "blocked" | "stale" | null;
  dueAt: string;
};
type TimerReceipt =
  | {kind:"timer_action"; action:"started"; operationId:string;
     serverNow:string; timer:TimerDto; artifact:TimerArtifactRefV1}
  | {kind:"timer_action"; action:"listed"; operationId:string;
     serverNow:string; items:TimerDto[]; nextCursor:string|null}
  | {kind:"timer_action"; action:"cancelled"|"dismissed"|"unchanged";
     operationId:string; serverNow:string; timer:TimerDto};
```

DTOにscope、claim秘密、内部job/schedule参照は出さない。claim成功にだけclaimIdとleaseUntilを別型で返す。remainingSecondsはactiveではnow、cancelledではcancelledAt、elapsedでは0を使い、ceilして0以上へclampする。labelはReactのtext nodeで表示し、HTMLとして扱わない。

listはcreatedAt降順、同時刻はid降順。cursorは最後の`{createdAtMs,id}`をbase64url化し、strict検査する。通知一覧はdueAt昇順、id昇順。順序をテストで固定する。

### 12.3 receiptの寿命

再送受付時は最初にscope/requestIdで操作を探す。同digestかつreceiptが残る場合は元のreceiptを返し、日時・timerを作り直さない。digest違いはrequest_conflict。expired_at_msありはoperation_expired。操作が無い場合にだけissuedAtの24時間窓と未来30秒を検査する。

30日後の回収は最大100行ずつ。非activeかつ未確認通知の無いtimerはlabelと会話出所を消し、bodyExpiredにする。操作はreceipt_jsonを消しdigest/issuedAt/tombstoneを残す。さらに30日後に参照されていないtombstoneとtimerを削除できる。active、pending/claimed/silentの通知、実行中のaction ticketの参照は回収しない。削除後の旧requestはissuedAtが古いため再作成を拒否する。最大行数に達した場合、保護行を削除して受付を続けず、429にする。

## 13 HTTPとserviceの契約

### 13.1 HTTP

全bodyはZod strict object、UUIDはz.uuid、整数はfinite/int、ISOはoffset必須。labelはtrim後1〜80 UTF-16 code units（Zod string min/max）、空白だけのlabelは拒否、省略は「タイマー」。余計なowner/scope/targetフィールドは拒否する。requestIdとissuedAtはclientが一つの操作の開始時に固定し、通信retryでも変更しない。

| method/path | 入力 | 成功応答 |
| --- | --- | --- |
| POST `/api/timers` | `{requestId,issuedAt,durationSeconds,label?}` | 201でstarted receipt、再送は200 |
| GET `/api/timers` | state/conversationId/timerId/cursor/limitを任意query | `{serverNow,items,nextCursor}` |
| GET `/api/timers/:id` | path id | `{serverNow,timer,notification:Dto|null}` |
| GET `/api/timer-actions/by-run/:runId` | pathはUUID、scopeはhost | `{serverNow,receipt:TimerReceipt|null}`。当該runのstarted receipt。未保存はnull |
| POST `/api/timers/:id/cancel` | `{requestId,issuedAt,expectedRevision}` | cancelled/dismissed/unchanged receipt |
| GET `/api/timer-notifications` | cursor/limit任意。scopeはhost | `{serverNow,items,nextCursor}`。dismissed以外の未確認分を取得 |
| POST `/api/timer-notifications/:id/claim` | `{clientId,claimRequestId,expectedRevision}` | `{serverNow,notification,claimId,leaseUntil}` |
| POST `/api/timer-notifications/:id/ack` | `{clientId,claimId,outcome:"played"|"muted"|"blocked"}` | `{serverNow,notification}` |
| POST `/api/timer-notifications/:id/silence` | `{expectedRevision,reason:"muted"|"blocked"}` | 音を試みないsilent通知 |

clientIdはWeb mountごとのUUIDであり権限ではない。claimRequestIdもUUID。初版では同じclaimRequestIdのretryは未失効なら同じclaimを返す。別clientの有効claimがあれば409。ackは同claimの同outcomeのretryを200で受け、異なるoutcome/claimを409とする。statusがdismissedなら遅いackを拒否する。

GET通知一覧はplayedでも未dismissedなら表示できる。silenceはpendingだけ変更でき、他の画面のclaimedを横取りしない。取消/dismissはclaimedも失効させる。期限から5分を超えるpending/lease切れ通知は保守/claimでsilent(stale)へ移す。

| HTTP | code |
| --- | --- |
| 400 | invalid_timer_input / invalid_cursor |
| 404 | timer_not_found / notification_not_found。scope外も同じ404 |
| 409 | revision_conflict / request_conflict / notification_claimed / claim_invalid |
| 410 | operation_expired |
| 429 | timer_limit_reached / timer_storage_full / operation_capacity |
| 503 | timer_unavailable |

認証失敗は既存401/403を使用する。全endpointに既存API認証とOrigin検査を適用し、GETで状態を変更しない。stateの鮮度更新は保守処理へ任せる。clientは既存Transportを使い、Zodで成功応答をparseする。CLIは`timer start 180 --request-id <UUID>`、`timer list`、`timer show <id>`、`timer cancel <id> <revision> --request-id <UUID>`に固定する。--waitは追加しない。

### 13.2 作成service

```ts
type TimerOrigin = { // applicationが保存済み入力から注入
  scope: string;
  conversationId: string | null;
  runId: string | null; messageId: string | null;
  originKey: string | null;
};
// API経由は会話出所null、会話経由はoriginKey = runId + ":timer:0"
startInTransaction(tx, command, origin): TimerReceipt;
listInTransaction(tx, query, scope): {serverNow,items,nextCursor};
cancelInTransaction(tx, command, scope): TimerReceipt;
getInTransaction(tx, timerId, scope): TimerDto | null;
getOperationInTransaction(tx, operationId, scope): TimerReceipt | null;
recordListOperationInTransaction(tx, command, request, scope): TimerReceipt;
```

startの処理順を固定する:

```text
1. strict入力をparse。scope/requestIdの既存操作を検査して再送ならreturn。
2. issuedAt、容量、出所を検査。originKey既存なら同start入力を確認して
   元のstarted receiptを返す。別duration/labelならrequest_conflict。
3. nowを一度取得。id/operationIdをUUID生成。label省略は「タイマー」。
4. timer(active, revision=0, epoch=0, due=now+seconds*1000)をinsert。
5. scheduler.createInTransaction(tx, {
     requestId: startのrequestId,
     target:{kind:"timer.expire",payload:{timerId, cancelEpoch:0}},
     schedule:{type:"once",at:iso(due)},misfirePolicy:"coalesce",graceMs:300000
   })を呼ぶ。scheduleIdをtimerへ保存。
6. started receiptをcanonical JSON/hashで保存。return。
7. store.writeのcommit成功後だけscheduler.wake()/changes.publish()を呼ぶ。
```

公開APIはstartをstore.writeで包む。agentからは同じtransaction内の同期操作を呼ぶ。operationIdの生成と時刻計算は再送分岐の後。scope/requestIdはscheduleでも既存の一意性と衝突しないUUIDを使う。

cancelの順序は操作再送検査→scope確認→revision比較→状態分岐。activeではcancelEpoch/revisionを1増やしcancelledAt/terminalAtを保存、未dispatchのscheduleを取消、既存expiryJobがopenならqueue取消、通知をdismiss、receipt保存。elapsedでは未dismissed通知があればdismiss・epoch/revisionを1増やしdismissed receipt、なければunchanged。cancelledはunchanged。異なるrequestIdで古いrevisionを再送したときはunchangedにせず409を返す。

GETのlistは読取りだけを行い操作台帳へ書かない。toolのtimer.listはrecordListOperationInTransactionでsnapshotとlisted receiptを保存し、action ticketが同じ結果を再確認できるようにする。timerId指定時はそのIDの現在状態を返し、stateを省略した一覧照会はactiveを返す。通常のGET一覧はstateなしなら全状態を返す。listを更新操作の許可に転用しない。

## 14 期限処理と復旧の疑似コード

targetのversion=1、kind=`timer.expire`。payload schemaはstrictな`{timerId:uuid,cancelEpoch:nonnegativeInt}`。job kind=`timer.expire`、payloadVersion=1、lane=background、resourceKeyは設定しない、maxAttempts=3、deadlineAtMs=null、recovery=replay_safe。

```text
target.materializeInTransaction(tx, occurrence):
  timerを公開repositoryから読む。
  active/epoch/scope/期限を確認。
  dispatchGenerationを1増やす。
  queue.enqueueInTransactionでdedupeKey =
    "timer:<id>:<cancelEpoch>:dispatch:<dispatchGeneration>" のjobを作る。
  payloadへtimerId/epoch/dispatchGenerationを束縛。
  timerへjobIdを保存。{jobId,subjectRef:timerId}を返す。

handler.prepareInTransaction(tx, claim):
  active、epoch、dispatchGeneration、dueAt<=nowを確認。
  どれか違えばstale。readyなら{id,epoch,dispatchGeneration}。

handler.execute(input):
  return input。通信・音声・LLM・sleep・DB更新を行わない。

handler.settleInTransaction(tx, claim, input, outcome):
  success以外はerrorCodeだけ保存し、終了を成功扱いしない。
  successならprepareと同じ条件を再検査。
  timerをelapsedへCAS更新。更新0件ならstale。
  terminalAt=now、revision+=1、errorCode=null。
  idは新規UUID、generation=epochの通知を
  INSERT ... ON CONFLICT(timer_id,generation) DO NOTHINGで作る。
  dueから5分超ならsilent/stale、以内ならpending。
  return applied。commit後だけchanges.publish。
```

materializeの世代不一致はtargetの保存を行わない。通常はcancelされたscheduleが発火対象から外れる。想定外の不一致はtarget_failedとして既存schedulerに記録させ、cancelled timerをelapsedへ戻さない。早い発火は業務エラーとし、次回保守まで期限を保つ。

`maintenanceInTransaction(tx)`はdueなactiveを最大100件読む。timerのexpiryJobをqueue.getInTransactionで確認し、open jobがあれば何もしない。scheduleがactiveならschedulerに任せる。scheduleがcompleted/cancelled/missingでjobがterminal/missingなら新世代のreplay_safe expiryJobを一つ作る。同時に保守しても単一writerとdispatchGenerationで二重jobを防ぐ。保護対象の回収と通知lease期限確認も一回100件以内で行う。jobの失敗でscheduleを作り直さない。

起動順はtarget/handler登録→既存domainの復旧→queue.recover→timers.recover（保守を一度実行）→scheduler.recover→worker/scheduler開始。既存の他domainの順序は保持し、この部分の前後関係だけ合わせる。timersの保守はserverの1秒intervalから一つずつ呼び、前回が未完了なら重ねない。closeではinterval停止→未完了保守await→既存close順を使う。起動時のtimer DB/復旧失敗はstartup failureとし、動かないタイマーを有効表示しない。

queueのHandlerDefinitionに任意の`afterCommit?():void`を追加し、runnerはsettleのstore.writeが成功してappliedとなった後にだけ呼ぶ。既存に同等hookがあれば新設せず利用する。rollback/staleでは呼ばない。hookはwake/publishだけを行い、DB更新や例外によるjob再送をしない。hook例外はwarnにして保存済みjob成功を維持する。timer expiry handlerとagent action handlerからapplicationが注入したchanges.publishを呼ぶ。公開APIと保守はstore.writeの成功後にpublishする。この接続でバックグラウンドcommitもSSEへ届く。

## 15 ツール実行と会話の接続

### 15.1 capabilities

`capabilities/contracts/timers.ts`にwire schemaを置く。capabilitiesは他domainをimportしない。timersのAPI schemaと同じ数値/文字列制限を定義し、applicationで両schemaを通す。

```ts
// commandはoperationによるstrict union
type TimerCommand =
  | {operation:"start"; durationSeconds:number; label?:string}
  | {operation:"list"; timerId?:string; state?:TimerState}
  | {operation:"cancel"; timerId:string; expectedRevision:number};
```

validatorsへ`timerStart`、`timerList`、`timerCancel`、`timerCommand`を追加する。builtin一覧をwebとtimersに分けてseedは両方を登録。backend=`timer`、package schemaKey=`timerCommand`、toolは対応するschemaKey、profile/SKILLは第7節の本文で固定。aliasesはタイマー/カウントダウン/残り時間/timer/countdown、avoidWhenは説明/引用/反復アラーム。packageが持つtoolRevisionIdsは3件だけ。既定backend Setへtimerを追加する際、実adapterが無い構成は利用可能にしない。

`prepareActiveByIdInTransaction(tx, owner, packageId, input, deadline)`を追加する。現在activeのpackageを解決し、既存prepareと同じclosure/schema/hash/context上限検査を共用する。hostからだけ呼び、モデルへこの操作やpackageId編集toolを公開しない。関数を別に追加して既存prepareの検査をコピーしない。

推論前のSkill loadingには`loadActiveContextInTransaction(tx, packageId)`を追加する。共通closure検査を使い、`{packageRevisionId,bundleDigest,sections,inputSchema}`を返す。入力commandがまだ無いのでargumentsのparseはここでは行わない。bundleDigestはrevisionId順の`[{revisionId,hash,generation}]`のcanonical hash。rootへtimer_package_revision_idとtimer_bundle_digest（nullable TEXT列）を保存する。route後のprepare結果がこの2値と異なればcapability_unavailableを返し、新しい版へ黙って置き換えない。Task型にも両nullable列を追加する。

### 15.2 tool-runtimeの即時操作

既存Web Adapterは変更しない。第6引数へ任意のActionAdapterを足す形で、既存createToolRuntimeの5引数呼出しを維持する。

```ts
type ActionEnvelope = {
  kind:"local_action"; backend:"timer"; version:1;
  operationId:string; receiptDigest:string; payload:unknown;
};
interface ActionAdapter {
  executeInTransaction(tx, request: {
    requestId:string; issuedAt:string; tool:FixedDefinition;
    arguments:unknown; owner:Owner; originToken:string;
  }): ActionEnvelope;
  readInTransaction(tx, operationId:string, owner:Owner): ActionEnvelope|null;
}
```

generic portのpayloadは未検査unknown。applicationでtimer receipt schemaをparseして返し、agent側でもtimer wire schemaをparseする。タイマーへのdispatchはapplicationの固定toolId switchで行う。

tool-runtimeが新規`tool_action_invocations`を所有する。列はid(PK)、root_run_id、owner_task_id、cancel_epoch、step_id(UNIQUE)、tool_revision_id、request_id、args_digest、operation_id、receipt_digest、state(committedのみ)、created_at。既存tool_invocationsをnullable化・再作成しない。rootの状態確認後、同stepの既存行ならowner/tool/args digest一致を確認しreadInTransactionで再取得する。

新規`invokeActionInTransaction`はexecutionRefのowner/期限、preparedの有効性、allowed tool、strict argumentsを既存invokeと同じhelperで検査する。その後requestIdを生成しadapter実行、receipt確認、action_invocation保存を同じtransactionで行う。呼出し後にrollbackしたらtimerもinvocationも残らない。executionRef、candidateRefは従来の短期メモリー参照で、timerの永続IDにしない。

Web用pending/settle/vault/引用検査にactionを混ぜない。summary APIがactionを出す場合はresultKind=actionとsourceCount=0を明示する。cancelTreeは未commitのstepだけ止め、committed actionのtimer取消をadapterへ送らない。

### 15.3 agent-runtime

routeSchemaへ`{action:"timer",command:TimerCommand}`を追加し、coordinatorContextの固定規則を第7節で更新する。timerのroutingには調査worker・candidate検索・worker推論を使わない。timer commandはrootのroute phaseだけで許可し、同じ出所では一操作にする。compoundな「3分タイマーと天気を教えて」はclarifyで一つの操作を選んでもらい、片方を黙って捨てない。

root起動時にhostがscope内の選択timerとactive最大32件、未dismissedのelapsed候補を合計32件以内の要約で取得しruntime contextへ置く。候補にはid/revision/label/state/dueAtだけを出す。選択参照はAPIでscopeを再検査する。候補が上限で切れて取消対象を一意に確認できないときはclarify。「あと何秒？」はtimer.listで現在値を取り直す。

originTokenはapplicationがrunId/保存済みmessageIdと現在cancelEpochに結び付けたhost-onlyの参照。モデルのJSONに入れず、rootに保管する。invoke直前にsource runがactive、保存済みuser messageが未撤回、epoch一致をportで確認する。root/current-step/owner検査はagent-runtime、入力の実在確認はdialogue/conversationの公開操作、接続はapplicationが担当する。取得資料や子reportからoriginTokenを発行しない。

timer actionを受けたsettle transactionで、package prepare→bind→commandに対応するtoolを選択→invokeAction→receiptのschema検査→ready_for_answerまで行う。命令に含まれないtoolを実行しない。cancelのtimerIdは選択/候補に存在することをホストでも確認し、revisionが変わっていれば409相当の失敗投影を保存する。

`agent_action_results`をagent-runtimeが所有する。task_id(PK)、invocation_id、operation_id、receipt_digest、payload_json、created_atを追加。既存agent_eventsによるready通知を使用する。AnswerTicketへ任意actionフィールド`{invocationId,operationId,receiptDigest,timerVersions:Array<{id,revision}>}`を追加し、既存research ticketとの互換性を維持する。timerVersionsはprepare時に取得した現在snapshotの版、最大100件。結果のない失敗ticketには付けない。

prepareAnswerでは保存したaction結果をread portで再確認し、現在のtimer snapshotも取得する。validAnswerではroot revision/epoch/期限、operation receipt digest、現在snapshot revisionを再検査する。snapshotがprepare後に変わったら古い固定文を採用せず再prepareする。elapsed/cancelledを開始時点のactiveへ戻さない。rootが中断済みでもcommit済みtimerは残る。

action失敗はerrorCodeを保存しready_for_answerへ進む。JSON契約修復は既存の1回上限を使い、保存失敗を成功receiptへ変換しない。実行結果が不明なままrequestIdを変えて再startしない。

route推論の前にhostがtimers.manageのactive closureを検査し、必須Skill本文とtimerCommand schemaをcoordinatorContextへ渡す。Skillが空、required revision不足、context上限超過ならtimer操作をunavailableにする。モデルがtimer actionを返した後に初めてSkillを読む構成にはしない。route後のprepareでも同じ固定版を再検査し、推論中の失効を拒否する。Web調査用workerContextへのtimer Skillの混入は行わない。

### 15.4 dialogueと応答

action ticketでは固定文をprepareし、LLM回答生成を呼ばない。既存GenerateInput.fixedAnswerを使う。ただし既存prepareが先にLLMのcapture/資源取得を行うなら、その前にaction分岐を置く。route推論の完了後に追加のinference.llm枠を取らない。正常fixtureでrouteのcontrol呼出し1回、回答LLM0回、worker0件をassertする。

startedで現在activeは「3分のタイマーを開始しました」で、personaごとの語尾を既存4種類に合わせる。期間の表示関数は整数秒を時間/分/秒に分解する（180→3分、210→3分30秒、3600→1時間）。現在elapsedなら「タイマーは終了しました」、cancelledなら「タイマーは取り消されました」。cancelled receiptは「タイマーを取り消しました」、dismissedは「終了通知を停止しました」。list一件は「残り2分10秒です」、0件は「動いているタイマーはありません」、複数は「タイマーが2件動いています」。

固定失敗文はrevision_conflict→「状態が変わりました。ご確認ください」、timer_limit_reached/storage_full→「タイマーの上限に達しています」、unavailable→「タイマーを利用できません」、その他→「タイマーを開始できませんでした」または操作に合う取消失敗文。persona語尾でも意味と数字を維持する。成功確認と時計参照の生成はLLMへ任せない。

応答保存後は既存TTS経路を使う。文面にHTML、JSON、timerId、内部状態名を含めない。選択タブのtimerRefをsubmitへ任意追加する場合は保存済みinputと別の参考contextとして扱い、選択だけで操作を実行しない。

## 16 時計とWeb接続の実装詳細

### 16.1 DigitalClock

format関数を同componentディレクトリへ置く。無効値（NaN/負数/非整数）は表示用に0へclampし、API値の検査は呼出し側に任せる。MM:SSは分を切り捨てず累積分とする（3600→60:00）。HH:MM:SSは時間を24で巻き戻さない（86400→24:00:00）。autoは3600未満だけMM:SS。外枠はrole=timer、aria-live=off、accessible labelは「残り3分」などを指定できる。

数字はtabular-numsと等幅フォント、heroはcontainer幅に応じてclampする。2桁の幅とコロンの幅を一定にする。状態と操作はTimerArtifactが表示するため、DigitalClockにButton・API・finished eventを入れない。秒が更新されてもフォーカスを動かさない。

### 16.2 Hooksとアーティファクト

`web/src/domains/timers/hooks/useTimer.ts`はtimer GET、`useTimerList.ts`は一覧、`useTimerClock.ts`は時刻計算、`useTimerNotifications.ts`は全scope通知を所有する。queryKeyはtimers/all、timers/list/filter、timers/item/id、timers/notifications。SSE change/resetはこれらをinvalidate。時計は250msのローカルtickで計算し、表示整数が変わったときだけrenderする。通信は毎秒tickで行わない。

serverNowはsnapshotを読むときのnow。Webは送信時p0、受信時p1をperformance.nowで測り、baseServer=Date.parse(serverNow)+(p1-p0)/2、baseMono=p1。推定now=baseServer+(performance.now()-baseMono)。端末復帰/visibilitychange/onlineでは必ずrefetch。activeが0に達したときは一回refetchし、確認中なら2秒間隔、最大30秒まで再確認する。その後はエラー表示と手動再取得を用意し、裏で無限pollしない。

TimerArtifactはlabel、hero時計、state、終了予定時刻、server接続状態、取消ボタンを表示する。pending mutationではボタンdisabled。成功するまではcancelled表示にしない。409はsnapshot再取得＋「状態が変わりました」、その他の失敗は再試行ボタンを表示する。bodyExpiredは「このタイマーの表示期限が過ぎました」、404は「タイマーが見つかりません」。いずれも新timerを作らない。

既存ArtifactPanelにtimer rendererをpropsで注入する。たとえば`renderTimer:(timerId:string)=>ReactNode`を追加し、AppがTimerArtifactを渡す。artifact domainからtimers hookを直接importして循環させない。既存Markdownのsanitize経路、8タブ上限とreducerの動作を維持する。

会話カードはoriginRunIdが応答runIdと一致するassistant messageに一度出し、対応するassistantが無いときはoriginMessageIdのuser messageへ出す。同timerを両方へ重複表示しない。カードの「時計を開く」はtimerIdだけを使う。Appの共通一覧には全activeを表示し、別会話のtimerを再発見できる。

自動openは現在のsend/voice turnのrunIdに結び付いた新しいstarted receiptを受け取った場合に限定する。最初の一覧snapshotは既知IDの初期集合にする。scope全件の差分だけでは自動openしない。`autoOpenedTimerIds:Set`をAppのmount中に保持し、閉じても消さない。手動openは集合に関係なく可能。履歴fetch/resetで自動openを発生させない。

現在送信中のrunIdについて、SSE changeまたはrun完了で`GET /api/timer-actions/by-run/:runId`を取得する。SSEが切れた場合のfallbackは2秒ごと、当該runの終了まで、最大180秒。receipt.action=startedならartifactのtimerIdを開き、集合へ登録する。read-only endpointはtimers内のorigin_run_idとtimer_operationsを同scopeで照合する。null/失敗では時計を捏造しない。runが失敗/中断した後も最後に一度取得してcommit済みtimerを表示できるが、現在runの監視が終わったらpollを止める。履歴のrun全件をpollしない。

### 16.3 通知音

通知hookはTimerArtifactより上のAppで一度mountし、どの会話・tabを開いていてもscope全体を監視する。pendingをdueAt順に一件ずつ処理する。複数timer同時終了の際も音を重ねない。画面表示は音待ちと独立させる。

```text
pending通知を取得。
  dueから5分超: backendがsilent/staleへ更新するまで再取得。鳴らさない。
  mute: silence(muted)を要求。終了表示を残す。
  音声入力中/他の通知音処理中: claimせず待つ。
  その他: claim→再生直前にGET通知/claim有効性を確認→音を再生→ack(played)。
再生失敗: ack(blocked)。音を成功扱いしない。
取消/lease失効/新しい発話:再生epochを無効化し音を停止。
  自分のclaimがまだ有効ならack(blocked)、失効済みなら何も更新しない。
```

出力は既存audio domainへ`playTimerTone(signal)`を追加し、Appが下記TimerAudioPortを組み立ててnotification hookへ注入する。timers Webからaudio/voice-dialogueを直接importしないので、timersの依存をqueue/schedulerから増やさない。PCM16 mono、24000Hz、長さ0.6秒、880Hzの正弦波、前後20msのfade、ピーク振幅0.15でWAVを生成する純関数をaudio domainに置く。外部音声ファイル・TTS・fetchを使わない。既存出力controllerのplay/volume/deviceと再生epochを利用し、別のAudioContextをtimerごとに増やさない。

```ts
interface TimerAudioPort { // timers Webが契約を所有、Appで実装
  isMuted(): boolean;
  isBusy(): boolean; // ユーザー発話/認識確定待ち/既存再生中
  isEnabled(): boolean;
  enable(): Promise<void>; // ユーザー操作内だけで呼ぶ
  playTone(signal: AbortSignal): Promise<void>; // 再生完了でresolve
  onAvailabilityChange(listener: () => void): () => void;
}
```

音を有効にするボタンは明示操作の中で既存startOutputを呼ぶ。自動開始できない場合はclockに「通知音を有効にする」を表示する。最初のtimer終了まで無効のままならblockedへ記録する。音声入力中はclaimしないので、15秒leaseを待機だけで使い切らない。通知hookのunmount時にローカル処理をabortし、timer自体のcancelは呼ばない。

現在のclaimIdの有効性とleaseUntilは同じclientId/claimRequestIdによるclaim再送で確認する。backendは自分の未失効claim再送をexpectedRevision比較より先に処理し、同じclaimを返す。leaseを延長しない。claimIdを他clientの通知一覧へ出さない。backendのcancel/dismissはclaimを失効させ、SSEをpublishする。WebはSSEと通知処理中の1秒snapshotでabortする。通信遅延と再生の間に生じる短い取消競合は実音の強い原子性保証に含めず、backendで古いackや再claimを採用しないことを保証する。

## 17 ツールチェーンへ組み込む正確な経路

### 17.1 組立て箇所

`api/application/toolchain.ts`の`createToolchain`へ任意の第5引数`timerPorts`を追加する。既存の4引数fixtureはWebだけを利用できる状態で維持する。timerPortsがあるfixture/productionだけbackend timerを有効にする。timerPortsはActionAdapter、TimerRouteContextPort、TimerOriginPortを持ち、port型はそれぞれtool-runtime/agent-runtimeが所有する。

```ts
interface TimerRouteContextPort { // agent-runtimeが所有
  snapshotInTransaction(tx, rootRunId: string): {
    selected: {id:string; revision:number} | null;
    candidates: Array<{id:string; revision:number; label:string;
      state:"active"|"elapsed"|"cancelled"; dueAt:string}>;
    truncated: boolean;
  };
}
interface TimerOriginPort { // agent-runtimeが所有
  bindInTransaction(tx, rootRunId: string, owner: Owner): string;
  validateInTransaction(tx, token: string, owner: Owner): boolean;
}
```

`api/application/timers.ts`でtimers serviceとtimer chain bindingsを作る。timersの公開操作をapplicationの固定switchで接続し、application自身にはSQLやstate判断を置かない。source/owner確認後、timer.start→startInTransaction、timer.list→recordListOperationInTransaction、timer.cancel→cancelInTransactionを呼ぶ。DTO/schema変換とport接続だけを行う。

serverの組立てはstore/queue/scheduler→timers→timer ports→toolchain→dialogue→voiceの順。timer portsからdialogueへは遅延getterを使う。`let dialogue`を組立てスコープで宣言し、既存createDialogueServiceを代入する。getterが未初期化ならtimer_unavailable。全serviceの初期化・登録が終わる前にagent/queue/schedulerをstartしない。この方法でserviceを二重作成したり、上位domainへのimportを下位へ足したりしない。

dialogueへ`timerOriginInTransaction(tx, runId)`を公開操作として追加する。保存済みuser message、会話、入力runの有効性、手動送信/音声受付由来であることを確認して返す。schedule・取得資料・assistant messageはtimerの実行出所にしない。agent-runtime側でowner/root/cancelEpochを確認し、OriginPortはその確認済みownerと出所をtokenへ束縛する。実adapterもtokenを再確認し、requestのmodel argumentsからscopeや出所を受け取らない。

capabilitiesのtimer builtinはcatalogに登録されていても、timerPortsなし、toolchain無効、必須Skill失効のいずれかでは実行不可。coordinatorのtimer routing contextにavailable=falseを渡す。dialogueでagentsが無効の場合もSystemPromptへ「操作ツールを使用できないためタイマーを開始・取消したとは答えない」を追加する。Web/APIによる手動タイマーはtoolchain無効でも動作できるが、その動作を会話toolchainの合格結果として数えない。

### 17.2 一つの開始依頼を追跡する

```text
dialogue.accept: 保存済みuser messageとrunを作る
  → agent-runtime.start: root task、origin token、runtime timer候補を束縛
  → capabilities: timer packageのactive closure/必須Skillをroute contextへロード
  → agent control inference: {action:timer,command:{operation:start,durationSeconds:180}}
  → agent settle: root/step/revision/epoch/出所を検査
  → capabilities.prepareActiveById: package/SKILL/schema/hashを再検査
  → tool-runtime.bind: root owner用の新executionRefを発行
  → tool-runtime.invokeAction: 許可tool/schema/owner/期限/同step再送を検査
  → applicationのtimer ActionAdapter: 固定tool switchとorigin確認
  → timers.startInTransaction: timer＋scheduler once＋receipt保存
  → tool-runtime: tool_action_invocations保存
  → agent-runtime: action result＋ready event保存
  → 同じwriter transactionをcommit
  → commit後にwake/change。ここで初めてUIが保存結果を取得できる
  → dialogue.prepareAnswer: receiptを確認、現在timer stateに合う固定文を作る
  → dialogue.adopt: ticket/epoch/現在snapshotを検査して会話へ保存
  → Web: 会話添付＋開始runに合うtimer tabを開く
  → voice: 既存TTSで開始応答を読み上げる
```

禁止する短絡経路は「自然文をWebでregex判定してPOSTする」「dialogueからtool-runtimeを通さずtimer serviceを呼ぶ」「LLMの回答文から時計を作る」「HTML artifactの内部で独自timerを開始する」。手動UIの取消とCLIだけは公開APIを直接利用できる。これらも同じtimer domain/receiptを使う。

### 17.3 合格を証明する結合試験

`api/application/timer-toolchain.test.ts`へ隔離DB＋実capabilities/tool-runtime/agent-runtime/dialogue＋fake inferenceの試験を作る。timer adapterをmock成功だけで済ませず、実timers serviceを使う。fake inferenceはcontrolでtimer actionを一回返し、回答用LLMが呼ばれたらテストをfailさせる。

| ID | 必須assert |
| --- | --- |
| C01 | duration180、同じscopeのtimer1件、once schedule1件、timer_operations started1件、tool_action_invocations1件、agent_action_results1件、採用済みassistant message1件 |
| C02 | action invocationのowner/root/stepがroot taskと一致。toolRevisionIdがtool:timer.start@1。receipt digestがtimers保存receiptと一致 |
| C03 | controlのmessagesにSkill本文とtimerCommand schemaがある。respondによる開始応答、worker生成、Web lookup/read、回答LLM呼出しは各0 |
| C04 | 必須Skillを失効→timer操作0件。executionRefの別owner利用→拒否。inputにscope/SQLを追加→strict拒否 |
| C05 | adapter後・agent result保存前に意図的に例外→timer/schedule/operation/action invocationが全部0件。次回同stepで成功させても各1件 |
| C06 | commit後にdialogueを取消→timerはactiveで残る。old answer ticketは採用されない。候補一覧と出所カードから発見可能 |
| C07 | cancel/listも同じcapabilities→tool-runtime→adapter経路を通り、同step再実行で操作を増やさない |
| C08 | timerPortsなしの従来Web fixtureで既存調査が合格。timer actionはunavailableとなり架空の開始回答を出さない |

browser試験ではC01に対応する開始依頼からtimerタブが開き、内部timerIdがC01のreceiptと同じであることをAPI経由で確認する。時計が動いたという見た目だけでtoolchain合格にしない。

## 18 Grokの実装チェックリスト

一つの項目を完了してから次へ進む。各項目は変更・fixture・確認までの単位であり、実装途中の型エラーを残して次の大きな工程へ移らない。ただし公開型を先に追加した結果の未使用exportは許容する。別エージェントや既存チャットへ作業を送らない。

### G00 作業開始とbaseline

- 変更対象: この文書の実装記録欄だけ。
- `git status --short`で並行変更を把握。未完了の他機能を削除・整理しない。
- 初回だけinitial_instructionsを実行済みか確認し、未実行なら実行。このチャットで実行済みなら再実行しない。
- 追加設計資料/Web検索/別repo調査は行わない。以下の各項目で指定した実装ソースだけを読む。
- 既存scheduler/queue/agent-runtime/tool-runtime/dialogueのdomain gateを一度実行し、既存失敗を記録する。
- 合格: baselineがfixture扱いで保存され、差分を保ったまま作業を始められる。

### G01 timer contracts

- 変更: `api/domains/timers/contracts/index.ts`、`index.ts`、`scripts/domains.ts`。
- 第11〜13節の定数、DTO、strict input、error codeを定義。backendとWebの所有パスを登録。dependsはqueue/schedulerだけ。
- 試験: 0/1/86400/86401秒、小数、NaN、80/81文字、未知のscopeフィールド、ISO offset欠落を境界表で試す。
- 合格: contracts exportをclientから型参照でき、API内部のservice/repository importをWebへ出さない。

### G02 timers migrationとrepository

- 変更: `timers/repository/index.ts`、migration export、`api/application/migrations.ts`、`migrations.test.ts`。
- 第12節の3テーブルとindexを追加。新規DBと旧migration済みDBの両方に適用する。
- 試験: 起動・再適用、origin/request一意制約、durationとcancelledAt check、通知FK、既存migration順/checksum維持。
- 合格: 隔離DBが開け、repositoryのCAS更新0件を成功扱いしない。

### G03 startとreceipt

- 変更: `timers/service/index.ts`、`policy.ts`、`test/start.test.ts`。
- start/list/getと操作receiptを実装。schedulerのcreateInTransaction/getInTransactionを使う。必要ならschedulerにpublic wakeを一つだけ追加。
- 試験: 180秒のdue、same request同receipt、違うdigest409、origin retry、容量429、scheduler受付失敗時の全rollback。
- 合格: scheduler予約とtimerを別writeに分けず、commit前にwake/publishしない。

### G04 cancel

- 変更: timer service/repository、`test/cancel.test.ts`。
- active取消、completed scheduleの処理、elapsed通知dismiss、unchanged、expectedRevision検査を実装。
- 試験: schedulerがactive/completedの両方、古いrevision、同request retry、取消と終了の両commit順。
- 合格: timer cancelEpochと通知失効が同時に保存される。

### G05 targetとexpiry handler

- 変更: `timers/service/expiry.ts`、`index.ts`、`test/expiry.test.ts`、必要なqueueのafterCommit hook。
- 第14節のtarget/handlerを実装し登録用exportを返す。
- 試験: due直前は未終了、dueでelapsedと一意通知、二回settle、旧epoch/旧dispatch、CAS失敗。afterCommitはcommit成功だけ、rollback/staleは0回、hook失敗でjob再送なし。
- 合格: LLM/音声/通信なし、replay_safe、resourceKeyなし、実更新が確認できてからapplied。

### G06 recoverとmaintenance

- 変更: `timers/service/maintenance.ts`、`test/recovery.test.ts`。
- due未dispatch、terminal job失敗、queue満杯、claim lease切れ、保持期限を処理。protected operation IDを受け取るportはtimersが所有しapplicationで接続。
- 試験: fake clockによる再起動、同保守の再実行、failed jobの世代更新、30/60日の回収、保護対象維持。
- 合格: 保守一回は各対象100件以内、open jobを重複作成せず、旧jobが新世代をsettleできない。

### G07 notification操作

- 変更: `timers/service/notifications.ts`、`test/notifications.test.ts`。
- claim/ack/silence/dismissを第11/13節どおり実装する。
- 試験: 2client競合、同claim再送、lease失効、played ack再送、違うoutcome拒否、取消後ack拒否、5分境界。
- 合格: claimはDBに保存し、silentをplayedとして記録しない。

### G08 HTTPとclient

- 変更: `timers/controller/index.ts`、`client/timers.ts`、`client/index.ts`、applicationのHTTP接続。
- 第13節のendpointを既存認証・Transportへ接続。handler内でSQLを書かない。
- 試験: 認証/Origin拒否、scope外404、strict400、409/410/429/503のJSON、応答schema、pagination。
- 合格: Web/CLIからDBへ接続せず、成功結果をZod parseする。

### G09 production/fixtureの起動結合

- 変更: `api/application/timers.ts`、`server.ts`、timer用fixture factory。
- target/handlerの登録、recover順、1秒保守、commit後change、closeを組み立てる。
- 試験: worker開始前の復旧、close中に保守が重ならない、startup failure、queue枠がLLM占有でも期限処理。
- 合格: APIだけでstart→elapsed→cancel/dismissまで通る。この段階で会話対応完了と書かない。

### G10 DigitalClock

- 変更: DigitalClockのtsx/index/stories/test、DesignSystemのsrc/index.ts。
- 第16節のformat、controlled props、hero、tone、a11yを実装。
- 試験: 0→00:00、180→03:00、3599→59:59、3600→01:00:00、86400→24:00:00。狭い幅とdark/lightをstoriesで確認。
- 合格: component内にAPI、interval、完了callback、通知音がない。package build後の公開exportを利用できる。

### G11 snapshot hooksと時計

- 変更: `web/src/domains/timers/`のhooks、query keys、events invalidation。
- 第16節の時刻推定、250ms表示tick、復帰時refetch、0での確認中処理を実装。
- 試験: fake performance clock、delay tick、hidden/online復帰、cancelled時間固定、30秒超の停止。
- 合格: 毎秒のAPI/DB更新がなく、未確認の0をelapsedとして保存しない。

### G12 timer artifact

- 変更: artifact storeのunion、ArtifactPanel、TimerArtifact、Appのrenderer注入。
- 既存Markdown経路はそのまま。hero時計と取消UI、pending/失敗/期限切れ表示を追加。
- 試験: 同timer再openは1tab、×でAPI cancelなし、8tab上限、取消409、404、狭い画面。
- 合格: API作成timerをパネルで開ける。UIが独自終了jobを作らない。

### G13 timer capabilitiesとSkill

- 変更: capabilities/contracts/timers.ts、builtin/timers.ts、builtin/timers/SKILL.md、builtin seed登録。
- 第7/15節の固定profile/Skill/package/tool/schemaを登録する。
- 試験: closure、required skill失効、schema hash、backend未接続、context容量超過。
- 合格: catalog登録と実行可能性を分け、未接続timerをprepare成功にしない。

### G14 即時action実行台帳

- 変更: tool-runtime/contracts、service、action repository/migration、`test/action.test.ts`。
- 第15.2節のActionAdapter/invokeActionを実装。Web invokeのowner/schema helperを共用。
- 試験: 別owner/期限切れref、same step、違うarguments、adapter成功後rollback、receiptの再取得、cancelTree。
- 合格: 実行参照検査を通し、Web job_id契約やvaultへactionを偽装しない。

### G15 direct prepareとrouting context

- 変更: capabilities/service、agent-runtime/contracts/context、rootのtimer bundle保存migration、各domainの対象tests。
- prepareActiveByIdで検査を共用し、timer route unionと推論前Skill loadingを実装。
- 試験: T01〜T04のfake control action、必須Skill欠落、route中の失効、複合依頼clarify。
- 合格: route contextに実Skill本文が入り、timer routingに調査workerを使わない。

### G16 root actionとticket

- 変更: agent-runtime/service、action_results migration/repository、`test/actions.test.ts`。
- root settleでprepare/bind/invoke/receipt/result/readyを同transactionで実行。ticketとsnapshot再検査を追加。
- 試験: root epoch変更、receipt digest違い、期限到達/取消によるsnapshot変更、二重step、元run取消。
- 合格: commit済みtimerをcancelTreeが巻き戻さず、古い回答を採用しない。

### G17 application toolchain wiring

- 変更: application/timers.ts、toolchain.ts、server.ts、toolchain fixture。
- 第17.1節のtimerPorts、lazy dialogue getter、固定tool dispatch、OriginPortを接続する。
- 試験: C01/C02の保存段階、C04/C05、timerPortsなしの既存Web fixture。C01のassistant採用とC03の回答LLM0はG18で完成させる。
- 合格: timer1件とtool action invocation1件が同じ保存済みreceiptへつながる。adapterだけのmockで合格にしない。

### G18 fixed answerと出所カード

- 変更: dialogue/service、public origin操作、conversation添付render、Appのauto-open。
- 第15.4/16節の固定文、追加LLM省略、元runとtimerの関連、自動openの条件を実装。
- 試験: C01/C03/C06/C07、開始応答前の取消/expiry、stream切断、履歴再取得と閉じたtab、voice開始run。
- 合格: 「3分タイマー測って」で保存確認・短い応答・自動時計表示まで通る。

### G19 toneとaudio port

- 変更: audio domainのtone純関数/再生操作、AppのTimerAudioPort組立て、notification hook。
- 第16.3節の単発WAV、出力共有、claim前busy判定、play/ack、abortを実装。
- 試験: waveform header/長さ/fade、mute、blocked、発話でabort、claim切れ、2client、App unmount。
- 合格: 各timerパネルにAudioContextを持たず、played確認前にackしない。

### G20 CLIと通知表示

- 変更: CLIのtimerコマンド、Appのactive一覧/終了通知領域。
- timer start/list/show/cancel、全scopeの未確認表示と停止ボタンを実装。
- 試験: stdout JSON、stderrエラー/X-Request-Id、別会話timer、×の後の通知、silence表示。
- 合格: パネルが無くても表示/通知が届き、CLIがDBを読まない。

### G21 fixture最終受入

- 変更: `api/application/timer-toolchain.test.ts`、`tests/browser/timers.spec.ts`、検証記録。
- T01〜T18/C01〜C08の該当fixtureを実行する。
- browserはfake時計で高速に、180秒実待機はlive/devicesだけ。tick/expiry/通知取得を別々に観測する。
- 合格: domain gates＋DesignSystem build＋横断verify:all。新規機能のfixture成功だけを記録しlive済みとしない。

### G22 liveと実機器

- 変更: `spec/verification/timers/live.md`、`devices.md`。
- 実LARMでroute選択、追加回答LLM0、180秒経過、終了遅延を記録。実マイク/出力で3往復受入。
- 実機器が利用できなければ未実施と記録し、具体的な手順と期待値を残す。成功を捏造しない。
- 合格: 実施済みと未実施を明記し、UI/fixture/live/実機器の状態を別々に報告する。

## 19 具体的なテストfixtureと実行コマンド

fake clockの開始は`Date.parse("2026-10-09T00:00:00Z")`。start(180)後のdueは`2026-10-09T00:03:00.000Z`。t=179999ではactiveで通知0、t=180000でscheduler.tick/queue tick・settle後にelapsed/通知1を検査する。Webは同serverNowに対し0/1000/179999/180000msのmono値で180/179/1/0秒を検査する。cancel at t=60000ならremaining=120で固定する。

復旧試験は一度DBを閉じ、同じ隔離DBを新store/queue/scheduler/timersで開く。t=181000で一通知、t=480001でsilent(stale)。claim at t=180000のleaseは195000、195000で旧claimは無効。fresh判定はnow-due<=300000を許可し、300001で音不可。

すべてのfixtureは一時ディレクトリのDBを使い、finally/afterEachでworkerとstoreを閉じる。製品DB、設定、LARM tokenをfixtureへコピーしない。fake inferenceの入力は「3分タイマー測って」など非機密の固定例だけ。通常ログへ制御JSONやモデル生応答を出さない。

```sh
bun run verify -- --domain timers
bun run verify -- --domain scheduler
bun run verify -- --domain queue
bun run verify -- --domain capabilities
bun run verify -- --domain tool-runtime
bun run verify -- --domain agent-runtime
bun run verify -- --domain dialogue
bun run verify -- --domain voice-dialogue
bun run verify -- --domain audio
bun test api/application/timer-toolchain.test.ts
bun run build:design-system
bun run verify:all
```

DesignSystemのtest/typecheckは同packageの既存scriptsを使い、G10ではDigitalClockの対象試験、最終ではpackageの既存gateを通す。browserは既存Playwrightのfixture起動方法をそのソースから利用し、timers.spec.tsだけを最初に実行する。無関係な失敗はbaselineと比較して区別するが、自分の変更による回帰は修正する。

## 20 実装記録と引渡し

実装担当は以下を埋め、本文の契約を途中経過のメモで書き換えない。仕様変更が必要な重大な矛盾がソースに見つかった場合だけ、矛盾した契約・影響・最小の変更案をここへ記載する。単なる命名差や既存helperの再利用に追加調査/承認を挟まない。

| 項目 | 記録 |
| --- | --- |
| 開始時のHEADと並行差分 | 継続時の HEAD は `ff2b237`。委任タスク、research-routes、world など既存の未コミット差分は戻していない。 |
| G00〜G22の完了/未完了 | G00〜G21 は実装と一部 fixture まで。G22 の live と実機器は未実施。 |
| fixture T01〜T18/C01〜C08 | timers domain と C01〜C03、90/210/3600 秒、C06、C08 は成功。C04、C05、C07 と browser は未実施。詳細は `spec/verification/timers/fixture.md`。 |
| DesignSystem/stories/browser表示 | DigitalClock を追加。stories の目視と browser の timer タブは未実施。 |
| live control回数/回答LLM回数/終了遅延 | 未実施。`spec/verification/timers/live.md`。 |
| マイクと出力デバイスの3往復 | 未実施。`spec/verification/timers/devices.md`。音声受入完了ではない。 |
| 契約変更と理由 | `createToolRuntime` の第6引数は既存の cached source のため、ActionAdapter は第7引数にした。migration は world の連続ブロックの後に timers、agent_action_results、tool_action_invocations を足した。 |

最終報告には変更した入口、実行したgate、未実施の受入、既知の制限を短く記載する。「ツールチェーン対応」はC01〜C08、「音声受入完了」はG22の実機器試験が根拠になる。時計だけが動く、APIだけが動く、LLMが開始文だけを返す状態を完成と呼ばない。
