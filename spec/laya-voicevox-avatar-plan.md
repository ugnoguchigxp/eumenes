# LayaとVOICEVOXによる話し方とアバター同期の実装計画

2026年10月8日。対象は、応答本文に合う話し方をLayaで判断し、VOICEVOXの合成とアバターの再生を同期させる機能。利用者の怒りや不安をそのまま演技に移さず、回答の内容と場面に適した態度を選ぶ。

音声の手動調整に加え、Laya の判断と既存の光アバターへの接続を実装した。以下の「今回接続した範囲」が現在の実装を示す。それ以降は当初の拡張案であり、6分類・score/noul・個別ロック・口の振幅同期・pause/resume・turn内再利用はまだ実装していない。実サービスでのAPI受入と、人が音声や動きを確認する試聴受入は別に行う。

## 今回接続した範囲

- LARMの音声用Profile全体をclaimする既存経路に、optionalな `system-one` を追加した。discoveryの `decision.system-one`、`larm.system-one.v1`、`/v1/systemone` とclaimの `configuration.fields.daemonURL` / model / tokenを検査する。同じConnectionをASR、LLM、TTS、Layaで共有し、更新時は専用tokenも取り直す。公開の3用途とクラウド許可設定は従来通り。
- delivery domainが、13種類のmotionと5種類のvoice toneをnative choiceで一度に質問する。判断対象は各句の辞書置換後の実際の読み上げ文とphaseだけ。受信したchoiceの型・候補・数値範囲、切詰めを検証し、motionとtoneを個別に判定し、各 `answer_confidence` が0.6以上ならその結果を採用する。片方だけ低確度なら、その項目だけneutral / naturalに戻す。別の `confidence` を選択候補の確率として扱わない。
- 各TTS句に2秒の判断予算を設けた。判定結果を音声のreceiptへ添付し、既存のwriter transactionで世代・許可を検査してからaudio chunkとともに公開する。ネットワーク要求はtransactionの外。再起動時は音声と同様に失効し、判断を別DBへ永続化しない。turn内再利用と250ms目標は今後の最適化対象。
- 自動抑揚がオンのときだけ、受付時の速度・高さ・抑揚の基準へtoneの差分を適用する。natural=(0,0,0)、bright=(+0.05,+0.02,+0.15)、gentle=(−0.06,−0.01,−0.10)、serious=(−0.04,0,+0.05)、excited=(+0.08,+0.025,+0.20)。話者とstyleを維持し、VOICEVOXの絶対範囲と話者catalogの範囲に収める。オフでもアバターのmotionは判断するが声は手動設定に従う。
- Layaのtimeout・形式違反・失敗、両項目の低確度は通常の声とneutral動作に戻る。optional Providerが存在しない場合は従来の簡易抑揚を維持する。判断失敗を理由に回答を取消したり、判断だけをクラウドへ送ったりしない。取消後の遅着結果は採用しない。
- WebのAudioBufferSourceの実再生開始に合わせ、各句の発話cueを一度だけ開始する。頷きや手振りにLayaのmotionを重ね、8秒の動作を実音声終了まで繰り返す。消音時は発話動作を開始しない。終了・取消・割込みで旧cueとその予約frameを失効させ、0.7秒で待機へ戻す。待機中も呼吸・揺れ・光の動きを継続し、約30秒間隔で4.8秒だけ体を左右に振る。発話や回答動作中はこの仕草を抑える。listeningとthinkingは実処理状態から導く。待機12fps・身振りと発話24fps上限、控えめな身振り、タブ非表示・画面破棄時の解放、`prefers-reduced-motion` に対応した。

接続済みの対象は音声対話の回答句と「読み上げ直し」。読み上げ直しでは、既存のwriter transactionで採用したreceiptから音声とmotionを返し、HTMLAudioElementのplayingで同期を開始する。文章だけの回答は、読み上げ操作をしたときに発話動作を行う。口の部位追加・音声振幅同期・個別ロック・pause/resume・モデル判断の品質調整は次の段階。

## 現行実装との対応

| 項目 | 状態 | 根拠と不足 |
| --- | --- | --- |
| LLMによる回答と句の分割 | 実装済み | [音声対話](../api/domains/voice-dialogue/service/index.ts)と[句分割](../api/domains/voice-dialogue/service/sentences.ts)。生成途中の読み上げ可能な句を合成する |
| 句単位の合成と順序再生 | 実装済み | backendの生成先行は最大3句。[Webの再生キュー](../web/src/domains/voice-dialogue/hooks/index.ts)は句の再生完了を待つ |
| 音声の設定保存 | 今回実装 | [設定契約](../api/domains/settings/contracts/index.ts)。LARMのvoice、style、speed、pitchScale、intonationScaleと再生音量。受付時の設定を各句へ引き継ぐ |
| 話者とスタイルの一覧 | 今回実装 | claimしたTTS ProviderのbaseUrl、model、tokenで取得。[catalog検証](../api/domains/larm/contracts/voices.ts)。表示名、スタイル、数値範囲、既定値、クレジットを扱う |
| VOICEVOX専用の合成値 | 今回実装 | [LARM adapter](../api/domains/larm/service/index.ts)。modelがvoicevox-coreのときだけstyle、pitch_scale、intonation_scaleを送る。未設定値は省略 |
| WAVとPCM | WAV対応済み | 現行の検証・再生はWAV固定。PCMの受信・再生は未実装。native streamingは要求せず、句単位の合成を維持する |
| 保存済み話者が消えた場合 | 今回実装 | [音声設定画面](../web/src/domains/settings/index.tsx)。保存値を保持し、再取得と既定話者へ戻す操作を提供 |
| クレジット | 今回実装 | catalogのcreditを表示し、合成応答のX-VOICEVOX-Creditを復号して採用済みの利用記録に保存。選択話者に一致する記録を表示 |
| 文章による自動抑揚 | 簡易版を実装 | [句の判定](../api/domains/inference/service/speech-intonation.ts)。応答の疑問符・感嘆符・注意語による補正。意味や感情をLayaで判断する機能とは異なる |
| 取消とbarge-in | 実装済み | session、generation、utteranceIdとplaybackEpochで旧音声を拒否。Laya判断・アニメーションにも取消と遅着拒否を接続した |
| busyと認証とidle解放 | 区別済み | 429や400/422でConnectionを作り直さない。Retry-Afterに従う待機とdetail形式の診断保存は未実装 |
| Layaのsystem-one Provider | 実装済み | [LARM adapter](../api/domains/larm/service/index.ts)がoptional Providerの専用endpointとtokenを扱う。公開Capabilityは従来の3用途 |
| 判断結果からの話し方計画 | choiceを実装 | [delivery](../api/domains/delivery/service/index.ts)が13動作と5toneを検証。2秒予算と低確度fallback。score/noul、250ms、turn内再利用は未実装 |
| 手動ロック | 未実装 | 現在は手動基準と簡易抑揚のオン・オフ。速度・高さ・抑揚を個別に固定する設定が必要 |
| アバター描画と素材 | 音声句と接続済み | [LightAvatarBackground](../web/src/components/domains/conversation/LightAvatarBackground.tsx)へ実処理状態と各句のmotionを渡す。既存モデルの頭・目・腕を使用 |
| 口と動きの再生同期 | 動作開始と取消を実装 | [audio controller](../web/src/domains/audio/controller/index.ts)の実再生開始に合わせる。口の振幅同期とpause/resumeは未実装 |
| 動きを減らす設定 | OS設定に対応 | アバターもprefers-reduced-motion時は静止姿勢を表示する。製品内の個別設定は未実装 |

## 当初の拡張案（以下は次段階の計画）

### domainの責務

LARM domainはdiscovery、Connectionの作成・ready確認・claim、Providerごとの認証、更新・解放、公開APIの入力と応答の検証を所有する。system-oneはProvider名として追加し、会話・聞き取り・読み上げの用途を表すPurposeと区別する。既存の3用途へdecision.system-oneを混ぜて、クラウド送信の許可や保存済み設定を変質させない。

inference domainには、現在の設定snapshotに対応するLARM接続を使って判断を実行する公開操作を追加する。同じProfileのConnectionをLLM、Laya、TTSで共有し、判断のたびに別のConnectionを作らない。system-oneは自動cloud代替の対象に追加しない。判断結果はLLMの回答採用・発話許可を変更しない。

新しいdelivery domainが、質問の定義、態度の検証、手動基準とプリセットの合成、ロック、確度判定、計画の記録とfallbackを所有する。deliveryは判断規則と値の合成を所有する下位domainとし、settings、inference、voice-dialogueを参照しない。inferenceが受付時snapshotから基準値を渡す。[domain検査](../scripts/domains.ts)にも追加する。

voice-dialogue domainが最初の句でdeliveryを呼び、turn内で計画を再利用する。判断を待つ間もLLMの生成は継続する。計画と句を公開するときは、単一writerのtransactionでvoice turnの状態と世代を確認してから保存する。ネットワーク待ちをtransaction内に入れない。

Webのaudio domainは再生振幅とクロックを提供する。新しいavatar domainは、口・表情・身体の部位別の描画と動作取消を所有する。voice-dialogueのWeb側が句の計画と実再生イベントを両者へ渡す。WebとCLIはAPIだけを使い、Providerの秘密やDBを直接参照しない。

## LayaのAPI契約

音声Profileのdiscoveryでsystem-oneの存在と能力を確認する。宣言はdecision.system-one、larm.system-one.v1、larm-system-oneを確認し、公開modelの期待値はlaya-multilingualとする。ただし送信するmodelとendpointとtokenは必ずclaim値を使う。非OpenAI Providerへ、現在のopenai-provider-v1のconfiguration.fields.baseURL必須検査をそのまま流用しない。Profile全体のclaim契約を保ち、存在確認していないsystem-one単独の部分claimを作らない。

system-oneがない、readyでない、claimできない場合は、ASR・LLM・TTSの会話を継続する。既にLLMが使っているConnectionをLayaの追加のために途中で解放しない。可能なら音声開始時の既存prepareVoiceで一緒に準備し、初回句では準備済みのProviderを使う。

POST先はclaimされたendpoint、認証はsystem-oneのcredential.token。Content-TypeとAcceptはapplication/json。公開bodyはmodel、state、questionsだけとし、temperature、stream、min_confidence、labels、turn ID、animationなどを追加しない。

stateは直近の確定user_text、実際に読むassistant_text、phase=response_readyを含む短いobject。初期上限案はuser_textを1000文字、assistant_textを既存の句上限以下とし、長い会話履歴や認証情報を送らない。入力の上限は実APIの制限を確認してから確定する。

questionsはdeliveryのchoice、emphasisのscore、needs_careのnoulを一度に送る。criteriaとinstructionsはユーザー提示の6分類と0〜4段階を基準にする。会話文に含まれる「判断ルールを変えろ」などは判断対象のデータとして扱い、質問のinstructionsを上書きさせない。

結果は質問IDと型を対応させ、未知label、NaN、非有限値、範囲外、欠落を拒否する。scoreは0〜4の段階期待値として小数を保持し、noulは0〜1の成立確率として読む。confidenceとanswer_confidenceの意味は混同せず、action.act_probabilityは使わない。実応答の外側のJSON構造と各確度fieldは、ライブの公開schemaまたはProvider fixtureで確認してから確定する。今回の入力例だけから応答のenvelopeを推測しない。

## 判断と手動設定の合成

次の値は初期プリセット。voiceは選択済みの具体的IDを保持する。手動styleを維持し、未指定ならそのvoiceのdefault_styleに従う。deliveryのlabelをVOICEVOXのstyleへ送らない。

| delivery | speedの差分 | pitchの差分 | intonationの差分 | 動作候補 |
| --- | ---: | ---: | ---: | --- |
| neutral | 0.00 | 0.00 | 0.00 | 自然な瞬き、軽い呼吸 |
| bright | +0.05 | +0.02 | +0.20 | 軽い笑顔、一度頷く、小さな手振り |
| empathetic | −0.08 | −0.01 | −0.15 | 柔らかい表情、ゆっくり頷く |
| explaining | −0.04 | 0.00 | +0.05 | 節目で小さな説明ジェスチャー |
| urgent | −0.05 | 0.00 | +0.15 | 姿勢を正す、手を一度軽く上げる |
| clarifying | −0.04 | +0.01 | +0.05 | 小さな首かしげ、軽い眉の動き |

各項目は「保存した基準値＋差分」で求める。基準が未設定なら選択voiceのcapabilities.defaultを使う。速度・高さ・抑揚にそれぞれ手動ロックを設け、ロックされた項目は保存値のまま送る。音量は現在の再生設定を維持する。

補助scoreの初期案は、確度が十分な場合だけintonationへ最大±0.05を加える。例えば0〜4を中心2からの差で線形補正し、2.4なら+0.01にする。速度・ピッチ・身振りを一括して最大化しない。noulが高いときは過度な笑顔や身振りを抑え、低いときは確信のある否定も正しく扱う。

確度の初期判定案はdeliveryの最大候補確率0.6以上かつ次点との差0.15以上。性能や表現の保証値ではなく、fixtureと実測で調整する。確度情報がない場合は補正しない。brightとneeds_careが強く競合するなど矛盾した結果はneutralと保存済み基準値へ戻す。

最終値は実際のcatalogの範囲内に収め、VOICEVOXの絶対範囲でも検査する。範囲が狭くなった手動保存値は自動で書き換えず、画面で修正を求める。声の高さはサービス固有のscaleで、Hzや半音へ変換しない。男性系・女性系の切替は話者IDの選択で行う。

Layaモードと現在の簡易抑揚は排他的にする。Layaが失敗したときに簡易ルールで追加補正せず、保存済みの通常音声設定へ戻す。

## 待ち時間と計画の再利用

最初の確定句で、warm時250msを初期予算として判断を開始する。この時間は通信と応答検証を含む。cold接続の準備はこの予算とは別に計測し、準備が間に合わなければ通常設定で最初の句を合成する。判断を待つためにASRやLLMを再実行しない。

timeout時は判断要求をabortし、通常設定の計画を固定する。HTTP adapterがabortを無視しても、計画の採用世代と締切を検査して遅着結果を拒否する。既に生成・再生を開始した句の値は変更しない。

同じturnでは計画を再利用する。初期実装は最初の句で一度だけ判断する。成功報告から注意事項へ移るなどの再評価は、明確なセクション境界を応答生成の内部metadataとして利用できる次段階で追加する。未確定tokenや各句への総当たり、アニメーションframeからのAPI呼出しは行わない。

計画は既存sessionId、generation、utteranceIdとaudio chunkのindexに結び付ける。planIdはEumenes内部の識別子。保存するのは分類、補正後の値、確度の要約、source、fallback理由、判断時間、設定revisionなどとし、Provider tokenや会話本文を新しい記録に複製しない。

## 再生とアバターの同期

LLMやTTSの完了通知はthinkingのままにする。speakingへ移るのはAudioBufferSourceの実再生開始。句のplanIdを再生イベントへ付け、同じ計画でも句単位のジェスチャーを最大一度だけ開始する。

口の開閉には再生経路のGainNodeの後ろにAnalyserNodeを置き、ローカルで音声振幅を読む。現在のマイクlevelを口の動きに使わない。無音、音量0、pause、終了、取消では口を閉じる。単純な平滑化と開閉のしきい値から始め、visemeや音素時刻を捏造しない。

| 実状態 | 口 | 表情と身体 |
| --- | --- | --- |
| listening | 閉じる | 相手に視線、自然な瞬き |
| thinking | 閉じる | 控えめな視線移動や首の動き |
| speaking | 再生音声の振幅に追従 | 計画に応じた控えめな表情と身振り |
| interrupted | 直ちに閉じる | 音声、frame更新、予約ジェスチャーを全停止してlisteningへ |
| error | 閉じる | 明瞭な案内と軽い困り顔。通信待ちを感情へ分類しない |

口・表情・身体を別チャンネルで制御する。同じ部位には動作の優先順位を設け、首かしげと頷きの競合、待機呼吸と身体ジェスチャーの重複を避ける。prefers-reduced-motionと保存した「動きを減らす」設定では、身体と首の動作を省き、口と静止表情だけにする。

現在のLightAvatarモデルの頭・目・腕と動作候補をまず利用する。listeningとthinkingは同名の既存動作、explainingはspeakingの小さな腕振り、clarifyingはcurious、控えめな頷きはagreeingへ割り当てる。brightはjoyfulの振幅を抑える。empatheticをdowncastに直結させず、listeningまたは小さな頷きで落ち着きを表す。urgent専用の手上げや口の開閉・笑顔に対応する部位は追加が必要なため、それまでは省略する。既存の8秒の動作全体を短い句へ押し込まず、動作を一度だけ開始して句の終了で穏やかに戻す。

LightAvatarBackgroundのactiveは現在、会話画面が表示されているかを表す。ここへ実処理状態と句のplanId・再生クロックを接続し、背景の表示と発話動作の開始を分ける。異なる顔素材へ変更する場合は口・目・眉・頭・身体の部位構成を確認する。VOICEVOX話者の音声利用とキャラクター画像の利用条件は別に扱う。

現在のaudio controllerにはpauseとresumeがない。次段階で再生オフセットとAudioContext.currentTimeを基準に追加し、経過実時間だけで頷きを予約しない。pauseはマイク受付を止めず、音声・口・ジェスチャーのクロックを一緒に停止する。再開やonendedには既存のplaybackEpochと同じ世代検査を行う。

## fallbackとエラーの区別

Laya不在、timeout、busy、低確度、未知label、応答形式違反、矛盾は、保存済み通常音声とneutral表示で継続する。失敗理由は内部計画へ記録する。失敗しても回答本文を消さず、通常TTSが正常なら会話を終端まで進める。

429とRetry-Afterはbusyとして扱い、認証失敗やConnectionのidle解放に読み替えない。最初の句は待たずfallbackし、以後の再評価はRetry-Afterの間抑止する。401と403は別の認証問題。idle解放を確認したConnectionは旧tokenを使わず、新規Connectionのreadyとclaimを経る。

現行TTSは429をavailability失敗としてcloud代替へ進めることがあり、Retry-Afterに合わせた待機は未実装。400と422のstyle違反をidle解放やbusyとして再試行しない。detail形式のエラーもあるため、invalid_voice_styleというコードの存在を前提にしない。診断文の保存を拡充する場合も秘密を除去して上限を守る。

barge-inと明示取消、許可取消、session終了、再起動、画面の破棄で、Laya要求・未採用計画・音声buffer・frame更新・予約動作をまとめて失効させる。新しい判断で古い声や動きを復活させない。UI状態はLayaの分類ではなく、実際の再生と処理状態から導出する。

## 実装順と受入

1. LARMにsystem-oneのdiscoveryと専用endpoint/tokenの取り扱いを追加する。ready/claim/renew/idle解放をfixtureで確認し、optional Provider不在でも従来の3用途が使えることを確認する。
2. delivery domainと設定の手動ロックを追加する。6分類、score小数、noulの否定、確度判定、プリセット差分、catalog範囲、通常設定への復帰を純粋な試験で確認する。
3. voice-dialogueの最初の句へ250ms予算と計画採用を接続する。turn内再利用、遅着拒否、取消、最大3句の生成先行、句の順序を再現試験で確認する。
4. Webに再生開始イベント・再生振幅・クロックを追加する。既存LightAvatarの状態動作を接続し、未対応の口の部位を追加して、対応する身振りを順に増やす。無音、消音、pause/resume、割込み、画面破棄をブラウザ試験で確認する。
5. 実LayaとVOICEVOXでAPI契約と待ち時間を確認する。warm/coldの分類時間、fallback率、最初の句の再生開始時間を測る。250msは測定結果で見直す。
6. マイクとヘッドホンで最低3往復し、通常案内、成功報告、困り事、手順、注意、確認を試聴する。利用者が怒っていても怒りを真似ないこと、Laya停止時も会話が続くこと、音声と動きの過剰さ、読みやすさを人が確認する。

各工程は所有domainと利用側domainのverifyを実行し、横断変更はverify:allを通す。Layaの公開応答形式、素材の権利と不足部位、cold時の待ち時間は実装前に確認する条件。既存LightAvatarの描画基盤を使い、新しい描画ライブラリ、正確なalignment、別の3D全身モデル、追加のクラウド判断サービスは初版の対象に含めない。

## 今回の音声調整の検証

変更前のsettings verifyは6試験成功。変更後は設定の互換性・保存と、cloudの独立したvoice/speed、受付時snapshotによる各句の簡易抑揚を確認した。

ブラウザfixtureで、表示名によるキャラクター選択、変更時のdefault_style、速度・高さ・抑揚・音量の保存と再読込、保存値からvoicevox-coreの合成bodyへの反映、合成headerのクレジット復号を確認した。これは実Layaや実VOICEVOXの音質・遅延、および実機器の受入を示す結果ではない。この節は音声調整のみを実装した時点の検証記録。後続のLaya・アバター接続の検証は末尾に追記する。

settings、inference、larm、voice-dialogue、audioの個別verifyは成功。直近のverify:allではbackend154件、Web27件、browser fixture10件と型・境界・ビルドの検査が成功したが、検証中に背景アバターなど別作業のソースが変更され、最後の入力hash一致検査で失敗した。このため最終checkout全体の合格とは扱わない。実行ログは[tts-settings-all.log](../verification-reports/tts-settings-all.log)。今回のContext Still呼出しはcontext_compile2回・compile_eval2回。


## Layaと光アバター接続の検証（2026年10月8日追記）

fixtureでnative Providerの専用認証・同じ音声Connectionの共有・更新時のtoken交換・optional Provider不在/形式違反でも従来の音声が継続することを確認した。deliveryではchoiceの型、候補、数値範囲、answer_confidenceとconfidenceの区別、項目ごとの低確度fallback、切詰め、timeout、取消、遅着拒否を試験した。inferenceでは辞書置換後の実際の読み上げ文、受付時の手動基準、自動抑揚オフ、遅着拒否を確認した。voice-dialogueでは採用した音声句への判断結果の添付と取消時の同時失効を確認した。Webでは実再生開始のcallback、旧句の遅い開始/終了通知、取消済みframe、有限再生、動きを減らす設定を試験した。

直近のverify:allはbackend175件、Web30件、ブラウザ11件、型・境界・ビルドの各検査が通過した。ただし最後の入力hash比較で、検証中の別作業のソース変更を検出して失敗した。最終checkout全体の合格とは扱わない。ログは[avatar-agent-all.log](../verification-reports/avatar-agent-all.log)。操作のブラウザ試験はWebGL非対応時の経路を使い、専用の描画試験は別ブラウザのSwiftShaderで透過canvas、配置、移動時の解放を確認する。

実LARMのProfileでsystem-one / laya-multilingualを確認し、native応答を受信した。「おめでとうございます！とても嬉しいお知らせですね。」ではmotion=joyful、answer_confidence=0.9736を採用し、voiceの0.5369は低確度としてnaturalを維持した。判断時間は195ms。これはAPIの接続と採用規則の確認であり、分類品質の保証ではない。実TTSは話者一覧取得でlarm_inference_401となり、音声合成までの受入は未完了。追加の切分け要求はConnection準備で20秒のtimeoutとなった。[live記録](../verification-reports/avatar-agent-live-accepted.log)。マイク・ヘッドホンの3往復試聴は実施していない。

この依頼のContext Still呼出しはcontext_compile1回・compile_eval1回。前回の静止配置の依頼を含むこのチャットの累計は2回・2回。

最終確認では別のverifyが実行中だったためdomain verifyの排他ロックを取得できなかった。関連domainを直接再試験し、backend74件・Web15件が通過した。これらは最終checkout全体のverify合格を意味しない。[backend記録](../verification-reports/avatar-agent-final-backend.log)、[Web記録](../verification-reports/avatar-agent-final-web.log)。

## 待機アニメーションの検証（2026年10月8日追記）

待機中も呼吸・小さな揺れ・光の動きを継続し、身振りは元の半分に抑えた。表示全体の時計を句の時計から分離し、回答終了後も動きを継続する。非表示時の破棄と「動きを減らす」設定での静止は維持する。

avatarの5試験で長時間の待機、句の切替、通常姿勢への復帰、取消後の古いframe拒否、破棄、静止設定、描画失敗を確認した。専用のブラウザ描画試験では、待機中のcanvas画像が時間とともに変わり、静止設定では同じ画像を維持することを確認した。avatar、conversation、voice-dialogueのdomain verifyは成功した。

全体検証はbackend182件、Web34件、ブラウザ11件、型・境界・ビルドの各検査が通過した。ただし検証中に別作業のソースが変更され、最後の入力hash比較で失敗したため、最終checkout全体の合格とは扱わない。[全体記録](../verification-reports/avatar-idle-all.log)、[描画試験](../verification-reports/avatar-idle-browser.log)。実音声・実機器の受入を示す結果ではない。この依頼のContext Still呼出しはcontext_compile1回・compile_eval1回。

## 表示消失の修正（2026年10月8日追記）

実行中の開発サーバーで、model.jsが参照するThree.jsの依存URLが504を返し、ブラウザで動的import失敗を確認した。開発用Viteとfixture用Viteの依存キャッシュを分離し、Three.jsを起動時最適化に含めた。修正後は確認用の実ブラウザでready・canvas1枚と表示復帰を確認し、fixture試験終了後も同じ開発用依存URLが200を維持した。

初期化失敗をエラー種類だけで記録し、hostの描画状態で消失原因を判別できるようにした。最初の静止frameで描画が失敗した場合も、一度だけ破棄し、失敗状態を維持する試験を追加した。avatar verify5件、conversation verifyのWeb10件とbackend1件、専用ブラウザ描画1件、全体型チェックは成功。verify:allは別作業のdelivery/inference内4ファイルの書式検査で停止したため、全体合格とは扱わない。[全体記録](../verification-reports/avatar-display-all.log)、[描画試験](../verification-reports/avatar-display-browser.log)。この依頼のContext Still呼出しはcontext_compile1回・compile_eval1回。

## 視認できる待機動作の追加（2026年10月8日追記）

初期の上下・揺れが小さく、neutralには瞬きがなかったため、待機専用の動きを追加した。6秒周期の上下移動、首・身体・腕の揺れと、17秒の周期内に3回の短い瞬きを行う。待機姿勢を回答動作へ加算し、表示時計を維持する。静止設定では時刻0の動きなし・目を開いた姿勢になる。

avatar verify5件、conversation verifyのWeb13件とbackend1件、全体型チェック、専用ブラウザ描画試験1件が成功。振幅・長時間継続・瞬きの閉眼と復帰・静止姿勢を試験し、利用中の実ブラウザでもready/animatedと待機動作を確認した。[動作記録](../verification-reports/avatar-idle-visible.gif)。全体verifyは別作業のdelivery/inference内4ファイルの書式検査で停止しており、全体合格とは扱わない。[全体記録](../verification-reports/avatar-idle-visible-all.log)。この依頼のContext Still呼出しはcontext_compile1回・compile_eval1回。

## 時折の体振りと発話・感情の合成（2026年10月9日追記）

待機中に約30秒間隔で4.8秒だけ体を左右に振る動きを追加した。左右の順を交互にし、開始と終了で振幅と速度が0へ近づく。回答動作や発話中は0.7秒で抑える。発話cueは実再生開始で有効にし、通常の頷き・手振りとLayaのmotionを重ねる。長い音声でも8秒で待機へ戻らず、滑らかに8秒の動作を繰り返し、終了・取消で待機へ戻す。Layaの判断がない場合は通常の話す仕草を行い、消音・静止設定では発話を開始しない。

読み上げ直しは、inferenceの既存writer transactionで採用したreceiptから音声とdeliveryを取り出す公開操作を使う。同じ音声のmotionだけをHTTP headerへ渡し、Webで候補を検証する。HTMLAudioElementのplayingで開始し、終了・取消・古いplaying/endedと遅いplay完了を世代ごとに拒否する。分類要求や音声合成を二重に実行しない。

avatar verify6件、conversation verifyのWeb17件とbackend1件、voice-dialogue verifyのWeb8件とbackend22件が成功。inference全19件とWeb全47件を直接試験し、型・変更箇所lint・Web build、既存の描画ブラウザ試験1件も成功した。時折の動作の静かな時間・両端の連続性、長い発話、感情の区別、再生イベント、取消、消音、HTTPの音声とmotionの対応を確認した。実ブラウザのモデルで発話とjoyfulを重ね、8秒を超えて動くことを確認した。[描画例](../verification-reports/avatar-speaking.gif)。これは音声を伴わない描画確認であり、実TTSやマイク・ヘッドホンの試聴受入は未実施。

inferenceのdomain verifyは別作業のspeech-intonation2ファイルの書式で停止したため、試験を直接実行した。verify:allは別作業のdialogueからsettingsへの依存関係で境界検査に失敗しており、全体合格とは扱わない。[全体記録](../verification-reports/avatar-speaking-all.log)、[inference試験](../verification-reports/avatar-speaking-inference-tests.log)、[Web試験](../verification-reports/avatar-speaking-web.log)。この依頼のContext Still呼出しはcontext_compile1回・compile_eval1回。


### 2026-10-09 回答の名前横に判断を表示

採用済みのLaya motionを13種の絵文字に対応させ、回答の名前横へ表示する。本文は変更しない。確度0.6以上のmotionのみ対象とし、voiceだけ確度が高い場合やfallbackには付けない。名前変更時もその名前の横に表示し、各絵文字には日本語の意味を付ける。

回答生成とTTSの順序に依存しないよう、conversation所有の追加migrationでrunごとの最初の採用済みmotionを保存する。voice chunkのreceipt採用と同じwriter transactionから、dialogueの公開操作を通して保存する。取消・失敗したrunには保存しない。読み上げ直しもrunと本文の句の一致を確認し、取消を確認した後に同じ公開操作を使う。保存によるconversation更新で画面を再取得し、再読込後も表示する。判断未取得の過去回答には付けず、読み上げ直しで判断が得られれば表示する。

fixtureの関連backend47件、conversationのbackend2件・Web18件、voice-dialogueのbackend25件・Web9件、専用ブラウザ1件が成功した。旧schemaからの追加migration、先行する判定、最初の判断の維持、rollback、取消、fallback、独立したmotion確度、読み上げ直し、本文の保持と再読込を確認した。全体型チェックとWeb buildも成功。[表示例](../verification-reports/avatar-emotion-emoji.png)。実Laya/TTS・実機器受入は今回未実施。

verify:allは既存のdialogueからsettingsへの未宣言依存で停止しており、全体合格とは扱わない。[全体記録](../verification-reports/avatar-emoji-all.log)。Context Stillはcontext_compile1回・compile_eval1回。


### 2026-10-09 判定の実経路確認と説明の訂正

前項の画面確認はfixtureによる表示確認であり、実会話の適切な感情判断を確認した結果ではない。実会話APIでは「それは素敵な由来ですね。」に採用済みmotionがなく、前の質問にはsleepyが保存されていた。処理先4つの接続だけで適切な判断ができたと説明してはいけない。

同じbackendの読み上げ直しAPIをrunIdなしで実行し、会話の保存内容を変更せずにlive Laya/TTS経路を確認した。「それは素敵な由来ですね。」「それは素敵な名前ですね。」はともにsource=fallback、reason=low-confidence、motion=neutral。「やった！大成功です！本当にうれしいです！」はsource=laya、motion=joyfulだった。HTTPはいずれも200で音声を返したが、ブラウザ再生や実マイクの受入は行っていない。[判定記録](../verification-reports/laya-judgement-live-decisions.jsonl)。別clientによる独立接続の試行は15秒でタイムアウトしたため、その試行は成功扱いしない。

調査のため、inference.delivery_selectedにsource・motion(kind)・fallbackのreason・所要時間・既存の相関IDを記録するよう変更した。本文・音声・Provider生応答・認証情報はログへ渡さない。fallbackはLayaによるneutralの採用と区別できる。inference fixture19件・変更ファイルlint・全体型チェックは成功。domain verifyとverify:allは別の検証が実行中でlockにより開始できなかった。

短い読み上げ文だけを判断対象にしており、会話文脈を渡す改善や、不自然なsleepyの意味判断の改善は未実装。今回のContext Stillはcontext_compile1回・compile_eval1回。
