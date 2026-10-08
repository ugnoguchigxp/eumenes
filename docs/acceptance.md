# 音声 MVP 受入記録

2026-10-07、macOS 26.6.2、Bun 1.4.2、Playwright 1.61.1 Chromium。Playwright の合成マイクと LARM fixture で、音声開始、ASR 確定、履歴に基づく回答、TTS 再生、再生中の次発話、二重発話 ID の抑止を確認。実 LARM は SAAA の保存済み接続先を読み取り専用で確認し、ローカルで生成した合成日本語 WAV を使った ASR・LLM・TTS の個別操作が成功。ASR 文字列には期待語「こんにちは」が含まれた。ASR 1268ms、LLM 8209ms、TTS 3757ms（この1回の測定値）。実マイク、ヘッドホン、実 ASR・LLM・TTS とブラウザをつないだ3往復は未受入。

| 条件 | 状態 |
| --- | --- |
| 画面から3往復し、前の発話を踏まえた回答を実機器で聞く | 未受入 |
| 再生中に発話して前の再生を止める | fixture で確認、実機器は未受入 |
| 同一発話 ID・request ID の重複抑止 | backend fixture で確認 |
| 音声 stream の上限と順序 | 4 MB 超過を ASR 前に拒否し、sequence の飛び番と同一発話 ID の異なる sequence を拒否する試験を確認 |
| ASR・LLM・TTS・再生の失敗表示 | 部分確認、故障箇所ごとの画面受入は未完了 |
| 録音 start/stop 3回と遅延 callback 抑止 | Web 単体試験で確認 |
| DB 再起動、未確定 run 復旧、writer 排他 | SQLite 試験で確認 |
| CLI と Web の同一履歴 | browser fixture 内で実 CLI の送信、同一 request ID の再送、履歴取得、画面反映を確認。中断・接続不能は未試験 |

次の最小工程は、Chrome と実マイク・ヘッドホンで3往復を操作して各 turn/run を記録し、再生中割込みと失敗表示を確認することです。実機器の型番・権限条件・段階別待ち時間をその際に追記します。

2026-10-08 接続修正の個別疎通: 変更前は `LARM_API_TOKEN` のみで `unconfigured`、明示 URL で文字回答は成功したが TTS は `larm_tts_voice_unconfigured`。変更後は既定 URL で接続し、LARM の声一覧で公開される既定 voice を使って合成音声を生成、ASR で「こんにちは。接続の確認です。」を認識、LLM の回答を確認。`verify:live -- --domain larm` は ASR 1356ms、LLM 3396ms、TTS 978ms、出力 WAV 523820 bytes で成功（各1回の測定値）。空の `LARM_CONTROL_TOKEN` と export 済み `LARM_API_TOKEN` を併用して検証。資格情報は保存していない。実マイク・ヘッドホンの3往復は引き続き未受入。

同日、検証用 DB を持つ Eumenes backend を起動し、公開 API 経由の文字送信が `completed`、合成 WAV 入力の音声 turn が `ready`、出力 WAV 329260 bytes となることを実 LARM で確認。認識文は「こんにちは。接続の確認です。」。この実行のサーバーログは起動通知1行、エラーログ0行。ブラウザでの実音声再生と実機器の3往復は未確認。fixture では接続不能時の定期確認の減速、明示再接続での復旧、CLI と画面の文字送信・音声認識・再生を確認した。

同日の固定した修正版では verify:all が成功（backend 107件、Web 27件、browser fixture 3件）。ブラウザ試験のポートを分離した検証用コピーで実行し、入力 hash の変更なしを確認。元の作業フォルダは設定画面チャットの並行編集により実行中に hash が変わったため、現行全体の合格とは扱っていない。通常起動した backend と Web proxy では HTTP 200、LARM ready を確認。詳細は verification-reports/larm-connection.json。


2026-10-08 SSE 移行: 会話・実行記録・音声 turn・設定・使用記録・予約の定期取得を除去。認証付き SSE を画面内で共有し、DB コミットと LARM 状態変化を100msでまとめて通知する。接続時は毎回最新状態を読み直し、切断中の変更とサーバー再起動を補完する。15秒の heartbeat では再取得しない。失敗時の再接続は5〜30秒に減速し、401/403/404では停止。「接続を再確認」で通知接続も張り直す。回答の確定表示、音声再生、取消後の結果不採用は維持した。

今回の現行作業フォルダで `verify:all` が成功（backend 125件、Web 28件、browser fixture 6件、入力 hash 変更なし）。LARM・dialogue・voice-dialogue の個別 verify も成功。browser fixture の待機中6.2秒で追加 API 取得0件、常時 SSE 1接続を確認。文字送信、CLI の履歴反映、連続する合成音声の認識・回答・再生、接続不能時の表示と明示再接続、設定・予約操作も成功。共有接続、chunk 分割、取り逃しの再取得、半開き接続の復旧、認証停止、rollback/idle scan の通知除外、低速読取り時の上限を backend 試験で確認。

通常起動した実サーバーを更新し、Web proxy の `/api/status` が HTTP 200・LARM ready、`/api/events` が HTTP 200・text/event-stream、初回 reset と heartbeat を確認。起動後のサーバー追加エラーログ0行。開いていた会話画面も再読込済み。今回の live 確認は接続・通知の疎通であり、実マイクとヘッドホンによる3往復は引き続き未受入。詳細は verification-reports/sse.json。今回の Context Still 呼出しは context_compile 1回、compile_eval 1回。


2026-10-08 設定画面と推論経路の受入: 用途別のLARM優先とクラウド自動切替、保存・再読込、秘密の非公開、設定世代の固定、取消後の結果拒否、読み上げオフ、予約操作をfixtureで確認。実LARMでも、新しいsettings/inference経路を通して合成日本語WAVのASR、LLM回答、TTSが成功した。ASR 897ms、LLM 3334ms、TTS 1446ms、出力WAV 753708 bytes（各1回の測定）。実クラウドAPIの個別疎通と実マイク・ヘッドホンの3往復は未受入。詳細は [設定画面の検証記録](../spec/verification/settings/README.md) を参照。


2026-10-08 音声の結果表示修正: ユーザーの申告時、実 LARM では直近2回の ASR・LLM・TTS が成功し採用済みだったが、会話画面は履歴0件だった。再読込で保存済み4件が表示された。通知接続が停止した原因自体は未観測。SSE だけが取得不能でも既存 API の接続成功に隠れないよう失敗表示と既存の再接続ボタンを有効にし、画面へ戻った時は通知を張り直して最新状態を読み直す。voice turn の取得失敗も表示し、停止後のメーターは0に戻す。定期ポーリングは再導入していない。

音声修正の現行 `verify:all` は backend 126件、Web 29件、browser fixture 7件で成功、入力 hash 変更なし。SSE だけが404となる状態の再現、エラー表示、画面へ戻った際の未表示回答の復旧を確認。audio と voice-dialogue の個別 verify も成功（メーター停止の回帰確認は全体試験、voice Web 3件）。ユーザーから「文字起こしが表示された」と確認を得た。実機器の音声3往復受入は完成扱いにしていない。詳細は verification-reports/voice-display.json。今回の Context Still 呼出しは context_compile 1回、compile_eval 1回。

2026-10-08 SystemContext 調整: 通常は句読点込み20文字以内の執事口調で、TTSへ渡す本文だけを返す。見出し・Markdown・絵文字・演出・毎回の呼称や結びを省き、説明量を明示された場合だけ必要な説明を簡潔に返す。強制切断は加えていない。隔離DBの公開APIと実LARMで7ケースを評価し、通常9〜20文字、詳細説明47文字、詳細後の通常応答15文字、情報不足時の確認、引用内の指示を実行しないことを確認。初回は詳細説明も短すぎたため、明示された説明量を優先する規則に修正して再評価した。モデルへの指示による制御であり、全入力への文字数保証ではない。評価のためのTTS生成は行っていない。

dialogue と voice-dialogue の個別検証が成功。全体試験では削除済みの補助画面を探す試験を現行画面に合わせ、backend 126件・Web 29件・browser fixture 7件を確認。共有checkoutで別の画面・domain変更が継続し、全体ゲートは成功後にも別の検証で上書きされたため、最終checkout全体の合格とは扱わない。稼働中backendを更新し、画面の接続状態readyとAPIのHTTP 200を確認。詳細は verification-reports/system-context.json。今回の Context Still 呼出しは context_compile 1回、compile_eval 1回。実機器の音声3往復は引き続き未受入。


2026-10-08 音声の待ち時間と逐次表示の改善: SAAA の段階的な音声処理と TTS 分割を参照し、録音を16kHzへ変換、発話中の暫定認識、確定認識の優先、LLM の実ストリームからの即時表示、句読点ごとの TTS 合成と順次再生を実装。未再生の合成は最大3区間に制限し、割込み後の文字・音声を採用しない。暫定認識は会話履歴へ保存せず、回答も確定結果だけを保存する。通常20文字以内の執事口調と画面の操作は維持した。参照元と差分は docs/saaa-provenance.md。

現行 checkout の `verify:all` が成功（backend 108件、Web 13件、browser fixture 8件、入力 hash 変更なし）。fixture では発話中の暫定認識、回答完成前の文字表示と音声再生、句読点での合成分割、割込み後の再生継続と古い再生 callback の拒否を確認。SSE の重複送信も修正し、低速読取り時の上限と最終状態の到着を試験した。

実 LARM とローカル生成した合成日本語 WAV（3.32秒）の公開 API 試験では、1.8秒の入力からの暫定認識672ms、確定 WAV 送信から認識表示873ms、最初の回答文字3925ms、最初の音声取得4276ms、回答完成5783ms。11区間の音声が得られ、最初の4区間は回答完成前に取得できた。音声を取得・確認応答した試験で、実機器での再生ではない。「虹」を「二次」と認識したため、認識精度の受入とは扱わない。申告された実マイクの約30秒の遅延は同条件で再現しておらず、実マイク・ヘッドホンの3往復は引き続き未受入。

稼働 backend を更新し、Web proxy の HTTP 200・LARM ready と、確定済み run の認証付き stream が1回だけ通知して終了することを確認。詳細は verification-reports/streaming.json と verification-reports/streaming-live.json。今回の Context Still 呼出しは context_compile 1回、compile_eval 1回。


2026-10-08 音声変更の再レビュー: 稼働 API では直近2回の ASR が約355ms・422msで成功・採用され、LLM は取消されていた。取消経路には次発話・停止があり、この記録だけではどちらかを断定できない。コード上は未確定の発話検出だけで前の生成を取消し、さらに upload 受理前に次発話を検出すると認識結果の取得開始を省略する競合があった。再生中の即時割込みは維持し、生成中は次の録音区間確定まで取消を遅らせる。送信の受理後に前の turn を取消し、未確定の次発話があっても受理済み turn を取得・表示する。競合の Web 回帰試験を追加。voice-dialogue の backend16件・Web5件と、現行 `verify:all` の backend108件・Web14件・browser fixture8件が成功、入力 hash 変更なし。

保存済み入力2件が会話画面に表示されておらず、再読込で現れることも確認した。通知取り逃しの原因は未確定。2026-10-08 09:40:02 JST、実画面から「接続確認です。」を送った run `772ddede-bef3-4ffe-9a5f-fd9c8ea10da2` は111msで `larm_inference_409` となった。接続表示は ready で3能力を保持していた。provider の409本文は現実装で破棄されるため、サーバー不具合・claim状態・競合のどれかは未確定。ユーザーの依頼に応じ LARM側の調査 prompt を作成する。LARM本体の変更や別チャットへの送信はしていない。Web修正は開発画面に反映済み、実マイクの改善と3往復は未受入。詳細は verification-reports/voice-review.json。今回の Context Still 呼出しは context_compile1回・compile_eval1回。

2026-10-08 LARM の idle / Profile 切替への追従: ユーザーからの LARM 調査報告では、09:38:22 JST に300秒無操作で Connection が解放され、09:40:02 の Eumenes 要求が409となった可能性が最有力。過去 run の provider 本文・Connection ID は保存されていないため、この過去事象の最終照合は未確定。資格情報の期限内でも解放済みの接続は使えないという契約に合わせて修正した。

実装: 最後の推論処理が終わって300秒無操作になると、単発のローカル timer で lease と ready 表示を失効する。無操作中の health / renew / keepalive は行わず、LARM の Context Still 用 Profile への切替に任せる。次の発話・送信で設定された Profile を再要求し、新 Connection を作成・claimする。入口の `409 / connection_idle_released` は一度だけ復旧・再送する。実 LARM で観測した `401 / unauthorized` は旧 Connection の control 状態が released / expired / missing と確認できる場合だけ復旧し、ready 状態の認証失敗は再送しない。取消・途中まで公開した SSE は再送しない。新接続は必要な provider が ready / claimable になるまで上限つきで準備を待つ。renew 後の再claimは全providerを検証してから一括更新し、health / renew は無操作期限を延長しない。

照合記録: 既存 migration の順序を維持して `provider_details` を追加。各推論 attempt に旧・新 Connection ID、実モデル、開始時刻、HTTP状態、安全な `error.code` / `error.message` を最大2要求分保存し、既存 usage API で読める。本文は16KiBまで読み、messageは512文字まで、資格情報を伏せる。Authorizationや完全な応答本文・入力は診断として保存しない。過去の attempt は空の診断配列となり、失われた409本文を補完したとは扱わない。

fixture: LARM27件、inference10件、利用側 voice-dialogue backend16件・Web5件の選択検証が成功。最終 `verify:all` はbackend126件・Web14件・browser8件が成功、52959ms、検証中の入力hash変更なし (`655a6f39ba598eb573e6d073bfebe4f4e58a946dc13b5dcb33a8566eefdc06b3`)。無操作中の通信ゼロ、次の音声でProfile再要求、準備待ち、409/解放確認済み401からの一回復旧、同時要求・遅い旧拒否、取消、stream切断、全資格情報更新と更新不整合、既存DBの追加migrationと照合記録を試験した。

live: 隔離した直結probeでローカルidle期限を360秒に遅らせ、実LARMへの302秒放置後の古い資格情報への `401 / unauthorized / provider bearer token is no longer valid` を確認した。この最初のprobeは401追従を追加する前なので失敗し、成功試験とは扱わない。次に隔離probe自身の Connection を公開DELETEで解放し、released 状態を確認した上で、旧接続への401 → 新Connection作成・claim → 200と4回の文字deltaを確認。これは解放からの復旧試験であり、最終版の自然な5分放置試験を通したとは扱わない。409復旧はfixtureで検証。詳細は verification-reports/larm-idle-live.json と larm-release-live.json。

live 音声: 隔離DB・実LARM・ローカル合成日本語WAV（3.32秒）の公開API経路で、暫定認識657ms、確定認識表示978ms、最初の文字3505ms、最初の音声取得3828ms、回答完成5184ms、音声10区間が成功・採用された。各段階のConnection IDも保存された。期待語「虹」を「二次」と認識したため認識精度の受入とはしない。音声の取得・確認応答までで、実機器での再生ではない。詳細は verification-reports/lifecycle-voice-live.json。稼働backendと開発Webを起動・更新し、Web proxyの200/readyを確認した。実マイク・ヘッドホンの3往復は引き続き未受入。今回の Context Still 呼出しは context_compile1回・compile_eval1回。

稼働会話画面では「接続を再確認」からreadyへ戻し、「接続確認です。短く返答してください。」への「接続を確認いたしました。」を表示できた。新しい推論attemptは成功・採用済みで、Connection IDを含む診断も公開API経由で確認した。画面と診断は verification-reports/larm-lifecycle-ready.png / larm-lifecycle-production.json。

2026-10-08 ASR表示場所の変更: ユーザーの依頼に合わせ、下部の「認識:」ラベルを削除し、暫定・確定文字起こしをプロンプトのtextareaへ順次反映した。音声の自動応答は維持する。録音中の未編集認識文は手動二重送信を抑止し、「音声入力は自動送信されます」と表示。手で入力を修正した発話は遅い認識結果で上書きせず、停止後は認識文を通常の入力として編集・送信できる。発話IDを使って前のquery結果を次の入力に採用しない。変更はWeb表示とその試験に限定し、backend/API/DBは変更していない。

fixture: voice-dialogue選択検証 backend16件・Web5件成功。ブラウザ試験で、発話途中のtextareaへの暫定結果、確定結果の保持、旧ラベルの削除、未編集認識の手動二重送信抑止、手入力後の確定ASRによる上書き防止、停止後の通常送信を確認。最終verify:allはbackend126件・Web14件・browser8件成功、52711ms、検証中の入力hash変更なし。詳細は verification-reports/asr-composer.json。開発Webへ反映し、現在の会話画面を確認した。今回の実マイクでの表示受入は未実施、音声MVPの実機器3往復も引き続き未受入。Context Stillはcontext_compile1回・compile_eval1回。


2026-10-08 全体コードレビュー: fixtureによるCLIプロセス試験で、接続不能時の終了コード5、標準出力の非汚染、不正または欠落したrequest IDによる送信の抑止、接続先設定不正時の終了コード2を確認。CLIのSIGINT中断と実機器3往復は引き続き未受入。レビューの修正と再検証の根拠は `spec/reviews/code-review-2026-10-08/README.md` に記録する。

2026-10-08 TTSの調整設定: キャラクター、発話スタイル、話す速さ、声の高さ、抑揚、再生音量を保存し、各発話へ反映する。claimしたTTS ProviderのbaseUrl・model・tokenによるcatalog取得、表示名と送信IDの分離、voice変更時のdefault_style、catalog範囲、取得失敗・保存済みvoice消失時の保存値保持と明示リセット、合成クレジットの復号をfixtureで確認。VOICEVOX専用値は他modelへ送らず、cloudのvoice・speedは用途別設定を使う。応答句の記号と注意語による簡易抑揚を追加したが、Layaによる意味の判断ではない。

settings・inference・larm・voice-dialogue・audioの個別verifyは成功。直近のverify:allはbackend154件・Web27件・browser fixture10件と型・境界・ビルド検査が成功したが、検証中に別作業の背景アバターなどのソースが変わり、最後の入力hash一致検査で失敗。最終checkout全体の合格とは扱わない。詳細は[実行ログ](../verification-reports/tts-settings-all.log)。LayaのAPI接続、手動ロック、アバターの再生同期は[実装計画](../spec/laya-voicevox-avatar-plan.md)として整理し、未実装。実Laya・実VOICEVOXの音質と遅延、および実マイク・ヘッドホンの3往復は今回未受入。Context Stillはcontext_compile2回・compile_eval2回。


2026-10-09 音声入力後の無回答調査と修正: 直近の取消されたLLM 5件をrun/job/HTTP IDで照合し、3件はセッション停止、2件は発話単位の取消要求による中断を確認。最新の例はASR 827msで成功し、その後LLMが1487msで取消された。停止ボタンと画面の自動停止・設定変更の区別、および発話取消の画面側の発生理由はログだけでは断定しない。

コードレビューと失敗する回帰試験で、旧マイクの遅い通知・送信エラーが新セッションに混ざること、遅い停止完了が新しいturn取得を消すこと、次の送信拒否前に前の回答を取消すことを再現した。通知・状態・再送・エラーをセッションで照合し、停止時のquery解除を非同期処理より前へ移動。次の音声の受理後に前のturnを取消し、送信失敗時は未送信区間を破棄して前の回答の取得・再生を復旧する。再生中の即時割込みと明示停止による取消は維持。LARMの呼出元による取消を通信障害と誤記していたログも区別した。全体検証で見つかったdomainの型参照規則違反、同時刻の試行順に依存した試験、古い設定画面のラベルを探す試験も修正。

fixture: voice-dialogue backend25件・Web13件、LARM36件、dialogueとinferenceの選択検証が成功。最終verify:allはbackend194件・Web54件・browser12件、型・参照規則・整形・lint・ビルドが成功、87356ms、検証中の入力hash変更なし。アバターの画面移動時の解放試験は先行する全体実行2回で失敗し、単独・ブラウザ一括・最終全体では成功。先行失敗の原因は未確定で、失敗時の移動状態を記録する診断を加えた。詳細は[調査・修正記録](../verification-reports/voice-no-answer-review.json)。liveは既存運用ログの調査のみで、新しいProvider疎通・実マイクとヘッドホンの症状解消・3往復は未受入。稼働backendの再起動は行っていない。Context Stillはcontext_compile1回・compile_eval1回。
