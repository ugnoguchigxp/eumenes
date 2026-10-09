# Toolchain / 調査担当 / SKILL 実装記録

## 2026-10-10 鎌倉の検索・音声回答・録音停止の修正

実装: 通常のページが属性・メタデータだけで安全検査の既定128区画を超えて拒否される問題を修正した。読取りの検査予算を4,096区画・2,000,000文字へ設定し、全区画の検査、命令混入・検査未完了の拒否を維持した。モデルにはtoolの短い名前を提示し、実行時に現在taskのUUID許可へ解決する。契約・所有者・取消・予算・採用検査を省略しない。

音声: 空の認識結果をProvider契約違反にせず、会話runを作らず終了する。雑音の検出や新しい録音の送信だけでは以前の回答を取り消さず、新しい認識文のrun受付を確認してから割り込む。新しい音声認識の失敗は表示に残し、以前の回答を続行する。「マイクを停止」は録音入力だけを止め、受付済みの検索・回答生成・TTS・再生を続行する。録音再開は同じセッションを使い、停止した録音器からの遅いcallbackは破棄する。明示的な中止・権限失効・画面終了の取消は維持する。

fixture: LARM・Web取得・音声応答の97試験、agent・Toolchain・診断・音声応答の60試験が合格（重複あり）。240区画の通常ページの取得、以前の上限より後ろにある命令混入の拒否、空のASR、取消後のTTS抑止、生成文・保存文・読上げ文の一致を確認した。最新voice-dialogue gateはbackend36/Web28、audio・larm・web-research・agent-runtime・tool-runtime・dialogueの個別gateも合格した。全体型チェックが合格した。

ブラウザfixture: voice.spec全14件のうち13件が合格し、SSEの接続数試験が一度失敗した。SSEを単独で再実行して合格し、音声設定・catalog欠落・通知復旧・部分ASRから本文完成後の再生までの4件も再実行で合格した。全体gateはformat・lint・型・境界、backend922合格/1skip、Web165合格、buildまで通過したが、ブラウザのアバター・タイマー・取得先学習の試験に失敗が出たため全体合格とは扱わない。実行記録は `/tmp/eumenes-repair-all-final.log`。途中で未使用の空ファイル `api/application/orld.ts` によるlint停止があり、そのファイルを除去して再実行した。並行変更中のsnapshotを含むため、個別gateの合格を全体の最終snapshot合格へ読み替えない。

06:54 JSTの追加確認: 最新のaudio・voice-dialogueのWeb55試験と全体型チェックが合格した。稼働中の画面が表示され、LARM接続済み、調査cardがエージェント側に分離されていることを確認した。過去に停止したrunの履歴は残し、修正後の成功へ書き換えていない。

全体gateの終了結果: browser30合格/5失敗。失敗は取得先学習の停止後表示、90秒timerの受付応答待ち、24時間timerの表示、timerの狭い画面の操作、アバターcanvasの表示。音声のASR→本文→TTS、通知復旧、SSE、Toolchainの天気・株価はこの全体実行でも合格した。全体gateは失敗として記録し、これら5件の修復完了は宣言しない。

live: 2026-10-10 06:43 JST、製品DBやユーザーの録音をコピーしない隔離backendで実TTS入力→実ASR→実検索→本文取得→主LLM回答→実TTSを完了した。認識文は「今日の鎌倉の天気を教えてください。」。10月10日のtenki.jp予報を引用し、回答「晴れで、気温は17℃から25℃でございます。」と音声chunkの文章が一致し、RIFF音声29,228 bytesを取得した。根拠・結果は `verification-reports/voice-live/result.json`、安全な運用ログは同ディレクトリの `backend.jsonl`（各0600）。最終の合格条件にも回答と読上げ文の一致を追加した。値は試験時点の予報であり固定値ではない。引用不一致を一度修正した後に報告を採用した経過もログで追跡できる。

稼働反映: 受付済みのrunがないことを公開APIで確認し、backendを再起動した。API・WebのHTTP200とLARM readyを確認した。実マイク・ヘッドホンでの3往復受入は未実施であり、音声MVPの完成とは扱わない。

Context作業: この修正の `context_compile` / `compile_eval` は各1回。今回までの障害対応の累計は各4回。

2026-10-09。実装の詳細は[計画書の実装結果](../../.archived/toolchain-web-research-implementation-plan-2026-10-09.md#18-実装結果と確定した変更2026-10-09)。

## 実装

`capabilities`、`tool-runtime`、`agent-runtime` を追加し、会話・inference・Queue・既存Web取得へ接続した。子はプロフィール・必須SKILL・選んだtool契約を受け取り、本文を読む。メインへは要約・主張・ホスト由来の出典情報・不足情報だけを返し、本文・引用・titleを返さない。

候補は最大8件/8KiB、必須内容は16KiB。各参照はroot/task/取消epochに所属し、入力schema、依存hash・利用停止、URLの依頼範囲をホストで再検査する。原観測はメモリーだけに置き、確定report/input/argsは14日、本文なしmetadataは30日。最終回答採用にはreportのepoch/hashとroot revisionを再検査する。取消・再起動・削除・失効後の結果は採用しない。

## fixture

関連9 domain（capabilities、tool-runtime、agent-runtime、web-research、queue、inference、larm、dialogue、voice-dialogue）の個別gateを実行した。最終の全体gate件数は下記へ記録する。新しいAPI E2Eでは天気/株価、必須SKILL、要約の境界、1推論枠での新しい会話、取消・再起動・期限・容量・JSON修正・引用偽装と一度の修正・失敗時の架空数値の廃棄・削除/保持期限・CLIを確認する。browser fixtureは入力から調査card・出典・最終回答・再読込みまで確認する。外部命令sentinelが子にだけ届き、メインと画面へ流れないことを検査する。

5,000 toolと5,000 package、固定の2依存を登録した合成catalogで、明示alias 100/100、候補の件数/bytes、所有者違い、停止した依存の除外、選択済み3依存だけの展開を確認した。一般日本語の意味品質評価やp95性能測定を行った結果ではない。

最終snapshotで関連9 domainの個別gateは全件合格。`bun run verify:all` はformat・lint・型・境界・build、backend **354/354**、Web **92/92**、browser **16/16** が合格（104.6秒）。browserの内訳はToolchain 2件と既存音声・設定等14件。全体gateはfixtureを使い、下記liveとは分けて扱う。出力はGit対象外の `verification-reports/toolchain/{domain}.txt` と `all.txt`、入力revisionと工程別結果は `verification-reports/latest.json`。`git diff --check` も合格。

## live

`EUMENES_LIVE_TOOLCHAIN=1 bun run verify:live -- --domain agent-runtime`。実LARM・公開Web・一時DBの隔離backendから認証付きAPIで入力し、fixture置換を使わない。2026-10-09 20:19〜20:20 JSTの最終版の実行で2/2成功した。株価は引用した取引所日付と最終回答の日付の一致も合格条件に含む。

| 依頼 | 取得した数値 | 取得元・対象時点 | 最終回答 | 推論/tool | 所要時間 |
| --- | --- | --- | --- | --- | --- |
| 東京の翌日の天気・最高気温 | 晴れ、26℃ | 気象庁、2026-10-10短期予報 | 晴れ・26℃・対象日を回答 | 4/1 | 30.1秒 |
| AAPLの最新の株価 | 340.42 USD | Yahoo Finance、2026-10-08 16:00 America/New_York | 340.42 USD・価格時点を回答 | 4/1 | 27.6秒 |

実行ごとの公開結果はGit対象外の `verification-reports/toolchain/live.json`。価格・予報は上記の試験時点の値であり、現在値として固定しない。検索だけでは株価数値が得られない試行、guard拒否・上流失敗、制御JSON不正、tool引数不正、引用不一致も観測した。JSON object生成、依頼の一意な対象から作る呼出し例、一度の修正で対応し、修正できない場合は失敗通知を返す。誤ったUnix時刻換算はホストの変換で防いだ。取得失敗時に古い株価を生成するケースは固定通知へ置換し、架空の数値を返すfixtureで検査した。成功試験2件から全サイト・全銘柄・全質問に対する成功率は推定しない。

## コードレビュー後の再検証

レビューと修正内容は[2026-10-09のレビュー記録](review-2026-10-09.md)。上記354/92/16件と20:19〜20:20のliveは実装時の過去snapshotであり、レビュー後の検証結果は別に記録する。

取消rollbackの波及、vault容量漏れ、候補の再利用、必須指示の混入・欠落、tickerの境界、削除済みreportの表示、失敗表示、step台帳、liveの数値判定、長い依頼の契約を修正した。レビュー後の関連9 domainの個別gateは全件合格。全体gateはbackend **363/363**、Web **94/94**、browser **16/16** と全工程が合格（106.1秒）。revisionと工程別結果はレビュー記録と `verification-reports/latest.json` に記録した。

実LARM＋公開Webの再実行は20:50〜20:51 JSTに2/2成功。東京の10月10日予報は晴れ・最高26度（29.0秒、推論4/tool1）、AAPLは340.42 USD・10月8日16時 America/New_York（34.8秒、推論5/tool1）。数値が引用・子の主張・最終回答で一致し、株価の取引所日付も一致した。元データ・最終回答は `verification-reports/toolchain/live.json`、出力は `review-live-final.txt`。全て隔離backendでの試験であり、実機器の音声受入ではない。

## 未実施・意味品質の限界

実マイク・ヘッドホン3往復、一般日本語query100件のRecall@8、p50/p95の基準機測定、10ケース以上の実モデル品質評価は未実施。本文内の引用の実在は検査するが、意味の一致と完全なinjection耐性を保証しない。天気の要約には予報対象時刻を発表時刻として書く誤りや、週間予報の日付を読み違える不足情報も観測した。最終E2Eは天気・最高気温の取得と回答を確認するもので、説明の全事実を検証した結果ではない。sourceの取得日時はホストの値であり、本文中の対象日とは別に表示する。取得拒否やguard拒否は迂回しない。株価は遅延/終値を含む。

## 2026-10-10 調査失敗の診断ログ

実装: 制御出力の解析失敗と契約違反を分け、項目の位置・期待型・実際型・制約・修正試行・step/推論/試行のIDを警告ログへ記録した。tool引数の契約違反、存在しない引用元、引用の不一致にも診断を付けた。検索の失敗理由、取得件数、会話runからWeb取得run/jobへ辿れる相関ログを追加した。本文・検索語・生応答・未知のキー・Zodのmessageは記録しない。詳細と確認手順は [logging.md](../../../docs/logging.md#調査失敗の原因)。公開API・DB schema・修正回数・出力の採用条件は変更していない。

fixture: `api/application/control-logging.test.ts` とlogger/validation-log/control-output/rejection-loggingの計14試験が合格。検索タイムアウト→再検索成功→報告JSON不正、報告summaryの不足、不正な読取り引数、引用の不一致を、実際のQueue・推論・認証API経路で確認した。rollback、古い結果、取消後の拒否ログを抑止し、未知のキーや会話本文をログへ漏らさないことも合格。最後に追加した取消後のケースも単独再実行で合格。全体の型チェックと変更範囲のlintが合格。agent-runtime（backend30/Web5）、web-research（39）、tool-runtime（5）、queue（31）の個別gateが合格。dialogueはbackend82/Web2が合格したが、並行作業によるsource変更を検出してgateは無効になった。

全体検証: `bun run verify:all` は、今回の変更外の `api/domains/capabilities/builtin/timers.ts`、`api/domains/capabilities/contracts/index.ts`、`tests/browser/timers.spec.ts` のformatで停止した。追加で実行した既存 `api/application/toolchain.test.ts` は、失敗通知で親モデルを呼ばないため `parentContexts[0]` が存在せず、3件の既存期待値が失敗した。全体合格とは扱わない。

live/実機器: 今回のログ変更後の実Provider疎通、実マイク・再生受入は未実施。稼働中backendへの反映には再起動が必要。記録されなかった過去のJSON不正箇所は復元できない。

## 2026-10-10 エージェントの応答生成とTTS、停止の調査

実装: 失敗時の固定応答と、操作結果によるモデル出力の上書きを廃止した。調査の失敗・不足情報・操作結果も主エージェントが生成し、推論Receiptと既存の採用検査を通して会話へ保存する。音声入力ではその文章をTTSへ渡す。操作の二重実行は行わず、生成直前に結果を再確認する。取消・報告削除・失効後の結果は採用しない。自動読上げを無効にした設定は維持する。上記の過去記録にある固定失敗通知への置換は、この変更で廃止した。

進捗cardは状態表示とし、固定の会話文を重ねて表示しない。主エージェントの失敗回答に渡すのは実際の検索・読取りの試行数と成功数、検証済み報告がない事実であり、拒否された報告の値は渡さない。制御出力修正には直前に確定した安全な診断を追加した。未登録のexecutionRefは操作を実行せず一度だけ修正できる。適用地点が特定できない依頼には固定の地域別予報toolを提示せず、検索・本文取得へ進む。日付は日本の現在日を明示し、取得時刻・記事の日付・予報対象日の区別を指示する。これらの指示は意味品質を保証するホスト検証ではない。

運用ログ: TTS開始・完了・設定による省略・失敗phaseをrunIdで追える。Web本文の安全検査による拒否は、ライブラリの有限な理由だけを `web.acquisition_rejected` に残す。隔離live backendのJSONLも一時DB削除前に保存する。ASRでは日本語の長音を許可言語の判定で誤って拒否する問題を修正した。

fixture: Toolchain・timer・音声応答・診断・agent-runtimeの73試験、Web取得・診断・音声応答の50試験が合格（重複あり）。失敗時に主モデルが生成した文章と保存・TTSの文章が一致すること、Receipt採用、取消後のTTS抑止、設定による省略、未登録参照の修正、安全検査理由以外をログへ出さないことを確認した。全体型チェックは合格。個別gateと全体gateは別途実行し、全体は並行作業中の `tests/browser/artifact-showcase.spec.ts` のformatで停止したsnapshotがあるため、全体合格とは扱わない。

最終の組合せ再実行は112/112試験と変更範囲のlintが合格。agent-runtimeとweb-researchの個別gateは合格。dialogueの後続再実行は試験が合格したが並行作業のsource変更を検出してgate無効となった。voice-dialogueはbackend/Webの個別gateが合格したsnapshotがある。稼働中backendを06:28 JSTに再起動し、認証APIの200とLARM readyを確認した。

live: 実LARM・公開Web・隔離DBで鎌倉の依頼を再現した。検索は成功したが本文取得に `web_guard_requires_approval` があり、同じ取得portで `SEGMENT_COUNT_LIMIT` が理由と確認できた。3候補中1件は本文取得が成功し、2件はこの理由で拒否された。ガードは迂回していない。地域別toolのscope拒否、古い記事を今日として回答する誤りも観測して修正対象とした。日付指示変更後の再実行は不足を主エージェントが回答したが、子は未登録のtool参照で失敗した。その後、一度だけの参照修正を追加してfixture検証した。鎌倉の現在の天気への正答や、実機器でのTTS受入が成功したとは扱わない。

参照修正後の追加live試行は隔離backendのLARM接続確立が失敗し、`larm_connection_released` で終了した（26.4秒）。検索経路の再合格とは扱わず、主エージェント生成もこの試行では成功していない。運用JSONLを保持した。

製品の停止調査: 06:10:37 JSTの検索成功後、06:10:39の音声セッション停止要求で回答途中のroot/workerが取消となった。その前の依頼も次の音声入力直後のturn取消要求で停止していた。LLMは開始・完了ログがあり、検索未実行やLLMが思考しない状態とは区別する。停止・割込みの意味はこの変更で変えていない。

設計コンテキスト: 今回の作業では `context_compile` 1回、`compile_eval` 1回を実施した。このチャットの累計は各3回。
