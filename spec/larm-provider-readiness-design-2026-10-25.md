# Providerごとに音声を開始する

2026-10-25。利用者からの実装・実接続受入・本番反映依頼を対象とする。LARM対象releaseは `cab4d8a6df382905e9b025e5c87a30960ca7d3eb`。

## 仕様確認と実装方針

既存のcatalog検証、control通信、claimのendpoint/model/credential照合、保持要求、取消、ASRの15秒のlocal試行を再利用する。LLMへの指示・意味判断は変更しない。Connection全体のreadyをProviderのreadyと混同しない。

保存済みProfile・audienceと一意な試験clientを用いた実接続で、同じclientでもLLMのみからProfile全体へ要求すると別Connectionになることを確認した。従来の拡張時DELETEを除き、LLMのみの接続と音声用Profile全体の接続を同じclientの各構成として保持する。背景LLMの接続・保持規則は維持する。音声用ではConnection取得だけを共有し、各ProviderのGET待機・claim・credential更新を独立させる。

- 音声用POSTはPreferを省略する。LARM公開routeで省略時の全体待機は0、Prefer: wait=1では全体readyを最大1秒待つことと実測POST約1.06秒を確認した。LLMのみのPOSTは自身のreadyのため既存指定を維持する。
- POSTのProfile/client/audience/Provider構成は既存値を使う。音声は従来どおりProfile全体、LLMだけの要求はllmのみ。
- GETをProviderごとに判定し、対象がreadyならprobing/failedのConnectionでも部分claimする。claim bodyのprovidersには対象の外部名を明示する。optional Providerの名前はcatalogから解決する。
- released/expired/404/410はConnection寿命として扱う。対象Providerのfailed、期限、呼出元の取消は他Providerのclaimや接続を破棄しない。
- 各待機は呼出元signal・port lifetimeと準備上限60秒の早い方。ASR要求は既存の15秒のlocal試行が先に切れる。GET/claimにこのsignalを渡す。準備成功後の実処理は従来の呼出元期限を使う。
- credentialはProviderごとに有効期限を管理する。LARMの明示renewは音声全体のgenerationを更新するため、既存どおり使用中要求の完了後に更新し、古いcredentialをまとめて失効扱いにする。各Providerは自身のGET/部分claimで取り直し、他Providerの未準備を待たない。別Providerのtokenを借用しない。
- 音声開始のprepareVoiceはASRの準備だけで完了する。TTS/判断器は使用時に自身を取得する。録音開始はbackendのprepareを待たない既存方式を維持し、保持WAVをASRへ渡す。取消後の結果は採用しない。
- renew開始を認証世代で記録し、更新前に発行され更新後に届いたclaim応答は採用しない。対象Providerの部分claimだけを取り直す。遅れたTTS claimとASR更新の競合で旧tokenを使う再現試験を追加した。
- DELETEはportの明示close・設定変更・試験cleanup等の所有終了に限る。Provider失敗・取消によるDELETEは禁止。通常終了のKV保持指定を維持する。
- 準備状態の変化、POST基準のready/claim/初回要求時間は固定状態値・Provider役割・数値・Connection IDだけを記録する。本文・音声・設定・credential・生応答は保存しない。

## 作業順・完了条件

1. 部分claim、失敗分離、並行待機、認証更新、取消のfixtureを追加し実装する。
2. larm → inference/voice-dialogue/audio利用側のdomain verifyを行う。録音buffer・取消のWeb試験を含める。ブラウザE2Eは既存サーバー利用可否を確認し、対象ファイルを指定する。
3. 保存済み接続へ合成音声・テキストで、新規/再依頼、主会話・背景生成中、KV満枠、音声10分無使用後、障害・期限・取消を確認する。実際に作れない状態は未検証と明記し、fixtureをliveと混同しない。他consumerを解放しない。
4. 差分点検後に本番反映する。サーバー再起動が必要な場合はAGENTS.mdに従って明示許可を得る。実装・fixture・live・本番を分けて記録する。

設定、DB schema、LLMモデル選択、fallback優先順位、他domainの不具合は変更対象外。既存の担当外差分を保持する。

## 残作業

- [x] 実装と回帰試験
- [x] 利用側を含むdomain検証
- [x] 実接続受入と10分待機
- [ ] 本番反映と稼働確認

## 固定試験と実接続の区別

- 最終の固定ソース検証: backend 595件・Web 111件成功。型・境界・整形・lint・SystemContext・サイズ・DesignSystem buildも成功。対象はlarm/inference/voice-dialogue/audio。POSTの全体待機を外し、遅延claimの認証世代も検証したreportは `verification-reports/larm-provider-readiness-2026-10-25/domain-verify/2026-10-25T14-54-23-013Z-6a8763be-00f4-457a-a2cd-1c22b3cac9e3/report.json`。
- 個別・結合: 全体probing/failedとready音声、LLM scope保持、Provider固有の失敗・期限、取消、部分claim、更新後の古い認証不使用を確認。ASRのlocal試行は既定15秒。LLM/TTS未準備ではcloudを選ばず、ASR自身の失敗/期限で既存fallbackを使う。
- 制御付き実接続試験: `scripts/larm-provider-isolation-live.ts --run`。LLM失敗、ASR失敗、15秒期限、実ASR応答の取消後不採用、実renewと部分再claimの5件が成功。故障状態はconsumer通信境界への注入であり、本番Providerの障害発生を意味しない。認証試験はclaimで消費側に通知する期限だけを60秒へ短縮し、実際のrenewと新しい認証でのASR/TTSを行った。対象外Providerと本番サーバーは停止していない。結果は `verification-reports/larm-provider-readiness-2026-10-25/isolation/live.json`。
- 先行liveのASR約1.38秒の内訳から、音声用POSTのPrefer指定による約1.06秒の全体待ちを特定した。指定を外した版で正常系と10分無使用を取り直す。旧版の10分区間は他の検証で音声を使用したため、最終受入の証拠にはしない。
- LARM稼働releaseの `release-gate.json` は `ae08a8b84a80ba0e254d8cdd0dd9bb4bffe0400d`。依頼対象の `cab4d8a6df382905e9b025e5c87a30960ca7d3eb` がその祖先であることを確認した。作業checkoutのHEADと稼働releaseは区別した。
- 主ディレクトリでは別作業による編集・commit・検証が並行していたため、製品DB・秘密・設定をコピーせず、コードと依存ライブラリ参照だけの固定コピーで検証した。今回の対象ファイルは最後にhash照合する。別作業のサーバー終了を23:28:40のログで確認したが、本作業ではまだ起動・停止・再起動していない。
- ブラウザE2Eは隔離サーバーの起動・停止を伴うため未実施。Webの録音・buffer・取消はaudio/voice-dialogueの111件で確認し、実音声はデバイスを使わず合成音声で確認した。実機器の音声MVP完成とはしない。
- context_compile 1回、compile_eval 1回。評価runIdは `00000000-0000-0000-18e1-caf34e3fb18d`。

### 認証更新の並行応答の補強

明示renewの直前に発行されたTTS claimの応答を遅らせ、ASRの更新後に渡すと、旧世代のtokenを使うことをfixtureで再現した。`credential-generation.test.ts` を追加し、renew開始ごとに世代を進め、更新をまたいだ応答は破棄してそのProviderの部分claimだけを取り直す。追加試験と関連domain検証は成功した。上の旧版live完了後に補強し、最終版の通常・10分無使用も別directory `final-generation-guard` で取り直している。

主会話・背景LLMの保持方式、設定、LLMの意味判断は変更していない。コード上の状態判定は、LARMの公開契約と認証世代の整合性の検証に限る。音声用の新しいscopeが必要な根拠は、同じclientでもProvider構成が異なると別Connectionが返る実測であり、主会話scopeを置換・DELETEしないためである。

## 最終版の実接続結果

`final-generation-guard/live.json` と `timings.json` に、Provider別のready・claim・初回要求までの時間、GETのreadiness、処理時間を記録した。

| 条件 | 新規ASR準備を含む処理完了 | TTS処理完了 | 結果 |
| --- | ---: | ---: | --- |
| 新規 | 286ms | 285ms | 成功 |
| 同じ構成の再依頼 | POST 11ms | ready維持 | 同じConnection、2秒以内 |
| 主会話・背景LLMが出力中 | 456ms | 413ms | 両LLMのdeltaと実重複を確認、接続を保持 |
| LLM枠待ち | 277ms | 426ms | waiting-capacityを確認。既存LLMを解放せず部分claim成功 |
| 音声10分無使用後 | 522ms | 258ms | 600,106ms、試験側の音声要求0件、その後も成功 |

すべての音声claimはprovidersを1つずつ明示した。正常系のASRはLARM adapterを直接使い、cloud切替なし。通常のinferenceを通す結合3件でも、LLM失敗だけでは切り替わらず、ASR自身の失敗/期限でのみ既存cloud経路を使うことを確認した。本文・音声・credential・Provider生応答は報告に保存していない。

最後の正常系試験の所有接続8件は8件ともDELETEを確認した。他consumerの接続は解放していない。最終版での制御付き異常試験5件も再確認済み。2回の試験で確保した10接続は10件とも解放を確認した。本番起動確認だけを残す。本番起動はAGENTS.mdの明示許可条件に従う。


最終点検: 固定検証との対象118ファイルのhash不一致は0件。実接続runnerが採取した114ファイルのhash不一致も0件。追加した判断はProvider契約と認証世代の検証だけであり、発話・語句・個別シナリオに依存する製品分岐や固定返答は追加していない。担当外の `spec/README.md` と新しい文脈設計書の差分を保持した。別チャットへの送信、LARM設定変更、Provider再起動、他consumerの接続解放は行っていない。

本番反映: この会話でAPI・画面サーバーの起動許可を確認中。許可が来るまでは未反映。`scripts/larm-provider-deployment-check.ts --run` は起動済みAPIのsample→previewを合成音声で確認し、ASRのsource/切替と試験session停止だけを報告する。server自体は起動しない。

## コードレビューと改善（2026-10-26）

利用者の「コードレビューを行い、改善点がなくなるまで改善する」依頼を受け、今回の変更と試験・受入runnerを再点検する。既存の状態通知・保持・claim検証・認証世代の仕組みを補強して解決し、新しい意味判断・モデル選択・DB schema・fallback優先順位は導入しない。担当外差分とサーバーの起動許可待ちを維持する。

実施順は、1) 契約・寿命・並行処理・報告の判定をレビューし再現試験を先に作る、2) 確認できた問題を最小修正する、3) 関連domainと部分claim/認証更新の実接続を検証する、4) 修正を含む差分を再レビューして具体的な未解決指摘がないことを確認する。残作業と結果はこの節へ追記する。通常の長時間試験中には製品コードを編集しない。

初回の点検対象:

- 音声scopeだけの準備中・失敗と、兄弟Providerが利用できる状態の通知。
- retain(false)、close後の遅れた呼出し、未完了の作成/保持要求の扱い。
- Providerの認証期限とConnectionの失効を区別すること。
- 更新/claimの並行処理と、失敗した呼出しによる他の成功claimの破棄。
- 公開仕様でselected Provider集合のreadyを意味するclaim status、既知readiness値、異なるConnection IDの拒否。
- live runnerが失敗を非0終了で報告し、開始済み保持POSTの終了後に試験Connectionを後片付けすること。

完了条件は、上記の問題の再現と回帰試験、関連domainの検証、影響する実接続経路、最終差分点検を完了し、対象内の具体的な未解決指摘を残さないこと。本番起動は本レビューの許可には含まれない。


### レビューで修正した指摘

| 問題 | 修正・再現確認 |
| --- | --- |
| 音声だけの準備・失敗がidleと表示され、兄弟の失敗で利用可能なTTSも失敗と見える | 主scopeがidleの場合の音声状態を採用。取得済みの有効な兄弟claimを保持。状態通知の回帰試験を追加 |
| 主LLMの取得失敗後に音声scopeができると、retain(false)で主側の保持が止まらない | 停止通知は常に主側にも渡す。画面非表示後にPOSTが増えないことを確認 |
| 遅れた同じProviderのclaim失敗が、別の呼出しの成功claimを消す | その呼出しが見ていた旧bindingと同一の場合だけ破棄。成功claimは維持 |
| ASRの短いcredential期限をConnection失効として再作成し、TTSも失う | Provider固有のcredential_expiredへ分類。Connectionの再作成・DELETEなしでTTSを維持 |
| 音声子Allocationのidle releaseで公開ConnectionごとDELETEする | 公開ConnectionのGETで終了を確認。親が有効なら対象Providerだけ再claimし一度だけ再要求 |
| claimのprobing/failed/欠落statusを受け入れる | 部分claimのstatus=readyは選択集合のreadyを意味する公開契約に従い、厳密に検証。GETの全体failed/probing許容とは区別 |
| 別Connection IDのreleased応答で現在の接続を捨てる | IDを終端statusより先に検証。不一致で兄弟claimを消さない |
| 通知先の例外で後続の通知先も呼ばれない | 既存createStatusChangesを再利用し、各通知を独立させる |
| 任意判断器のmodelに不正な型があっても公開する | optionalのcapability・protocol・endpointとmodel文字列を検証。不正値はnull |
| 任意Provider名がObjectの継承プロパティと一致すると誤って既知role扱いになる | hasOwnで自分の定義だけを照合。catalogで別名を選んだ英語TTSの試験で確認 |
| 受入runnerに失敗があっても終了0、保持POSTとcleanupが競合する | 失敗判定を終了値へ反映。開始済みPOSTを待ち、全所有接続へcleanupを試行。実行ごとに証拠directoryを分離 |
| 本番確認がログ反映前・経路未確認・session停止失敗でも成功を示す | ログの遅延を上限2秒で待つ。ASR/TTSのLARM成功とsession停止を確認できなければ成功にしない |

レビュー追加の14試験は成功。関連4domainの固定検証はbackend 609件・Web 111件、上位の音声結合は6件成功。型・境界・整形・lint・SystemContext・サイズ・DesignSystem buildも成功。最新reportは `verification-reports/larm-provider-readiness-2026-10-25/review-domain-verify/2026-10-25T15-29-40-118Z-63bdfa21-1437-4f21-ac5a-cae68ba7f468/report.json`。

制御付き実接続は7件成功。LLM失敗、ASR失敗、15秒期限、取消後の遅延応答、実renew、ASRだけのidle release、ASRだけのcredential期限を確認し、全件で兄弟TTSが成功・close前DELETEは0件。故障はconsumer通信境界に注入し、本番Providerの停止は行っていない。結果は `verification-reports/larm-provider-readiness-2026-10-25/review-isolation/2026-10-25T15-27-26.706Z/live.json`。

修正後の差分再レビューでは、対象内に具体的な未解決指摘は見つかっていない。コードを固定した通常系・10分無使用後の最終live受入を待っている。本番APIの起動と本番確認用runnerの実行は、引き続き許可待ち。レビューだけを根拠に起動していない。

このレビューのcontext_compile 1回・compile_eval 1回（会話累計各2回）。評価runIdは `00000000-0000-0000-18e1-ce58e26bddc0`。


### 取得済みProviderの後発失敗の最終補強

最終点検で、取得済みASRの再確認がfailedになっても旧bindingを一覧に残すことを再現した。準備確認GETの開始時点のbindingを記録し、同じbindingが残っている場合に限り失敗した対象だけを無効化する。遅れたfailed応答が、その間に成功した新claimを消さないことも確認した。`provider-cache-review.test.ts` の2件が成功した。

旧版の10分試験が正常に終わるまで製品コードの編集を待ち、結果確認後に補強した。新しい試験ファイルの追加は実行中のProvider処理を変更しない。補強後の関連domainはbackend 611件・Web 111件、制御付き実接続は8件成功。ASRを一度取得してからfailedにする試験でも兄弟TTSは成功し、close前のDELETEは0件。最新の異常系結果は `verification-reports/larm-provider-readiness-2026-10-25/review-isolation/2026-10-25T15-45-48.166Z/live.json`。

最新の固定検証reportは `verification-reports/larm-provider-readiness-2026-10-25/review-domain-verify/2026-10-25T15-45-49-330Z-31267cea-bba0-4a2e-9ffa-cbe0e3f64933/report.json`。レビュー追加の回帰は計16件。対象内の具体的な未解決指摘はなく、製品コードを固定して最後の通常系・10分無使用後の結果とcleanupを確認中。本番起動の許可待ちは維持する。


### レビュー完了

最終版の通常系も成功した。新規ASR 349ms、同構成再依頼14ms、主・背景LLM生成中の新規ASR 485ms、枠待ち中381ms。音声要求0件の600,107ms経過後もASR 535ms・TTS 272msで成功。すべて部分claimで、正常系の直接LARM処理にcloud切替はない。試験用Connection 8件は8件ともcleanupを確認した。

結果とProvider別ready/claim/初回要求の時間は `verification-reports/larm-provider-readiness-2026-10-25/review/2026-10-25T15-46-55.545Z/live.json` と同じdirectoryの `timings.json`。検証対象121ファイル、実接続採取116ファイルのhash不一致はいずれも0件。`review-summary.json` に固定試験・上位結合・制御付き実接続・通常実接続を分けて記録した。

対象内の再現できた問題は修正済みで、最終の再レビューに具体的な未解決指摘は残っていない。個別発話の分岐、辞書、固定応答、LLM判断の代替は追加していない。担当外差分を保持し、別チャットへの送信、他consumerの解放、サーバー操作は行っていない。本番起動と本番APIの確認は、利用者の明示許可待ちのままとする。今回のレビューを本番反映完了として扱わない。
