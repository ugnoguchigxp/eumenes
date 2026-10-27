# LARM の接続・予算・session 構成

## 画像・音楽生成の待機時間

画像・音楽・効果音の制作はオンデマンド起動を含むため、会話から制作担当へ渡す時点で、既存のrun期限延長操作を使って300秒（5分）の処理時間を確保する。ジャケット画像の共通queueにも同じ300秒を設定する。起動・生成・結果取得を含む有限の総時間であり、進捗のたびに期限を延ばさない。既に長い期限は縮めず、呼出元が明示した期限や委任タスクの予算は超えない。制作計画のLLM、通常会話、保存済み画像・楽曲の一覧取得の時間は変えない。

LARMがHTTPエラーまたは失敗状態を返した場合は既存どおり失敗とし、生成POSTを自動再送しない。取消と期限切れ後の遅い結果は採用しない。音楽の生成受付POSTは最大60秒でjob IDを受け取り、queued/loading/generating/encodingはその同じjobを制作期限まで照会する。モデルの起動完了を60秒で打ち切るものではない。

今回の調整は既存のrun・推論要求の期限延長とqueueの期限設定の再利用に限る。DB・API・ツール選択・LLM指示・LARMの起動制御は変更しない。検証は期限延長と明示期限の部分試験、旧3分を超えた結果の採用・取消・期限切れ・HTTPエラーの固定試験、画像/音楽の会話結合試験、影響domainのverifyの順に行う。サーバー操作と新規の実生成は行わない。

2026-10-27の初回実装確認: 対象の固定試験69件、選択した変更から辿る468ファイルの型検査、整形・lintが成功。4分の起動待ち後の成功、設定上限での期限切れ、取消後の遅い結果の破棄、画像・音楽のHTTP500/503でPOSTを再送しないことを確認した。その後、利用者の指定で待機上限を20分から300秒に調整し、期限・取消・LARM接続の固定試験39件と整形・lintが成功した。初回domain verifyは依存境界通過後に別作業中の指示カタログ未生成で停止し、会話結合試験も変更前から別作業中の`dialogue/service/input-text.ts:35`の構文エラーで起動できなかった。300秒への調整後のdomain verifyでは依存境界・指示カタログ検査を通過したが、別作業中の`createContextKeeper`・`createDialogueService`・`createWorkLedger`の関数サイズ超過で停止し、検証中の変更も検出され結果は無効となった。通し・総合検証の成功とは扱わない。live・ブラウザ・実機器の受入とサーバーの再起動は未実施。

## Spatial監視API

SpatialのLARM Core・CPU・Memory・GPUは、保存済みControl接続先の `GET /v1/monitoring/snapshot` と `GET /v1/monitoring/events` をbackendから読む。認証には既存の `LARM_API_TOKEN` をそのまま使う。新しい認証情報やその保存・設定操作は追加しない。監視GETは接続作成・claim・Provider操作・ダミー推論・期限延長を行わない。

表示中の既存monitoring取得を入口にbackendで60秒ごとに共有し、同時表示・失敗時の即時再試行を抑える。イベントとcursorは同じtransactionで保存し、409/410、再起動、取得品質、coverageの欠落を保持する。一般的な要求失敗をGPU障害にしない。

LARMが返す `observedAt` と `maxAgeMs` を守るため、約10秒の期限を超えた値は参考値となる。受信時刻で更新し直さず、Webは取得間隔の間も古さを再判定する。詳しい計測値・状態・履歴の品質は認証付き `GET /api/monitoring/snapshot` の `larm` に保持する。多くのGPU等がある場合は設定の `larm.monitoringNodeId`・`larm.monitoringGpuId` で対象IDを指定し、一意な対象だけなら自動選択する。

契約は `larm-monitoring.v1`。正本と固定応答は[参照コピー](../spec/reference/larm-monitoring-v1/README.md)、責務・表示規則・配備との区別は[接続設計](../spec/larm-spatial-monitoring-integration-design-2026-10-18.md)。ソース実装とLARM本番APIの公開・Spatial実画面確認は分けて記録する。

LLMのProfileは設定画面で保存した値（`larm.profile`）だけを使います。コード・既定値・手順にProfile名やモデル名を固定しません。未保存のときは `larm_profile_missing` で接続しません。初回の `LARM_PROFILE` 指定は、未保存の設定へ取り込みます。選択肢は、保存済みのLARM接続先に `GET /v3/agent-profiles` をProfile指定なしで送って得たcatalogから作り、`selectionPolicy` が `default` で `deprecated` でなく、`llm` Providerを持つProfileだけを挙げます（`explicit-only` の用途別Profileと `backchannel` だけのProfileは含めません）。catalogを読めないときは保存済みのProfileをモデルなしで1件返します。

主会話と補助のcontrol要求は、どちらも保存済みのProfileを使います。補助のcontrol要求は別のclient識別子で独立したConnectionと履歴を持ち、Profileの名前によらず同じ構成になります。LARMは共有KVとSessionを管理し、各Connectionのcontext window・出力予約はclaimを正本とします。モデル名はcatalogとclaimが返す値を使い、送信にはclaim値を使います。主会話の同一接続上の推論は順番に実行します。LARMの入力キャッシュはConnectionに結び付くため、主会話のConnectionはbackendの稼働中ずっと保ち、終了時にも解放しません。client識別子は保存済み設定とsettingsの鍵から導いた再起動をまたいで同じ値で、再起動後のbackendは生きているConnectionをキャッシュごと取り戻します。補助要求は、先頭（最初のmessageとtool定義）ごとに保つ最大2本のConnectionへ順に送り、新しい先頭は使われていない最も古い補助Connectionを解放して使います（[設計](../spec/larm-connection-cache-design-2026-10-25.md)）。待機中の要求はLARMのConnection lifecycleと呼出元の期限・取消に従い、readyとclaimableを確認するまで推論しません。control要求の出力schemaは、LARMには `response_format: json_schema`（strict）、OpenAI互換のcloudには `response_format: json_schema`、Codexには `outputSchema`、Claude Agent SDKには `outputFormat` で渡します。

`GET /v3/agent-profiles?profile=...` から構成と `catalogRevision` を取得し、作成時に `expectedCatalogRevision` を指定します。同じclientとProfileの要求ではLARMが既存Connectionを再利用するため、各sessionに固有のclient識別子を使い、renew・再接続では同じ識別子を維持します。入力予算はclaimのcontext windowと正式なchat input計数から求めます。出力予約はclaimの上限以内で明示します。

LLMのみの要求は `providers: ["llm"]`、音声の要求は `providers` を省略して選択Profile全体を取得します。不要なProviderを事前予約しません。Providerの接続先・model・tokenはclaimの `configuration.fields.baseURL` / `daemonURL`、`configuration.fields.model`、`credential.token` を使い、公開endpointとの整合性を確認します。ASR、日英TTS、Ruriの態度判定とembeddingは新Profileのcatalogから発見する既存経路を使います。期限前のrenew後は再claimでtokenを更新し、終了時に解放し、失効時は既存の再接続処理を使います。

2026-10-12の実接続で主1＋補助3の同時応答、履歴分離、5つ目の待機と解放後の利用、ASR、日英TTS、Ruri両Provider、384次元embeddingを確認しました。設定の初期選択・保存済み選択の維持、renew・再claim・再接続・取消は固定試験でも検証しています。詳細は [検証記録](../spec/verification/ornith-profile-2026-10-12/README.md)。音声ファイルの取得は実機器の3往復受入に数えません。

設定は [setup.md](setup.md)(環境変数)と [settings.md](settings.md)(画面)を参照してください。

## チャット画面表示中のProfile利用依頼

表示中のチャット画面から30秒周期でbackendへ生存通知を送り、有効な通知がある間だけ既存の`POST /v1/agent-connections`を30秒周期で繰り返します。同じclient・Profile・audience・Provider構成・catalog revisionを使い、新しい利用依頼ごとにIdempotency-Keyを発行します。認証は既存の`LARM_API_TOKEN`のままです。専用の所有更新API・別トークン・ダミー推論は使いません。

非表示・画面終了では停止を通知し、通知が届かなくても最後の生存通知から90秒でbackendが定期要求を止めます。複数画面では一つ以上が有効な間継続し、設定変更とbackend終了でも旧接続への送信を止めます。返されたConnectionの対象・Profile・Provider構成を確認し、別Connectionの取得を占有延長の成功として扱いません。

取得済みConnectionの保持応答は、Connection・Profile・Providerの一致とready状態を検証します。`claimable`はLARMの短い疎通確認キャッシュの有無でも変わるため、取得済みclaimを使う保持処理の成功条件にはしません。初回claimと期限更新の既存処理は維持します。

2026-10-18、改修済みEumenesの画面通知APIから実LARMまでの結合試験で、同じConnection・Allocationを6分2秒保持し、`idleReleaseAt`の約6分延長を確認しました。保持区間の推論要求・追加claimは0回。同じKeyの再送では期限が変わらず、送信停止後は最終利用依頼から300.067秒で自動解放されました。利用者によるbackend再起動後、画面通知APIの204と、起動後5分を超えた実画面・status APIの接続済みも確認しています。詳細は[作業記録](../spec/larm-connection-retention-design-2026-10-18.md#12-larm更新後の実接続受入と稼働反映確認)を参照してください。

## gzip圧縮通信

LLM・TTS・ASR・画像生成・音楽生成の通信は、backendの共通入口で `Accept-Encoding: gzip` を指定します。推論・生成のJSONとASRのmultipart本文はBunの `fetch` の `compress: "gzip"` で送信時に圧縮し、`Content-Encoding: gzip` の付与もBunに委ねます。multipartは境界・音声・送信項目を含めて一度だけBlobへ直列化します。正式token計数とembeddingも同じ圧縮送信を使います。

態度判定などの判断器（`system-one` の判定呼出し）は、本文が小さく応答速度を優先するため、送信・受信とも圧縮しません（`Accept-Encoding: identity`）。

接続の作成・claim・renewなどの管理APIは、送信本文を圧縮しません。2026-10-18の配備先で、gzipの本文はJSON読取り時にHTTP400となり、通常のJSONは入力検証まで進むことを確認しました。catalog・接続管理・保存画像や楽曲の取得も圧縮応答の受信には対応します。送信の圧縮可否は呼出し元のAPI契約で指定し、失敗後の自動再送やURL・本文による推測は行いません。

応答はBunの標準展開（`decompress: true`）を使います。JSON、SSE、音声、画像の既存の読取り・サイズ制限は展開後の本文に適用し、共通入口では応答全体を待ちません。token計数のdigestと入力サイズの検査は圧縮前のJSONを使います。音声のRange取得は保存表現のバイト位置を維持するため `Accept-Encoding: identity` とします。認証、期限、取消、生成POSTの再送禁止は既存経路のままです。

## 楽曲生成の音声形式

楽曲生成ツールチェーンは、保存済みControl接続先のcatalogから、capability `media.music.generate` を持つ `services` のサービス（`larm.music-generation.v1`）を発見し、返されたendpointを使い、生成要求のmodelは自動選択の`auto`を送ります。複数あるときはcatalogの順で最初のサービスです。生成・状態照会・音声取得にはControl認証を使い、Providerのclaimは行いません。

サービス発見は画像・音楽で共通です。保存済みProfileと全Profileのcatalogを読み、サービスが空のProfileをIDで取り直すほか、同じControlの `GET /openapi.json` が公開する `/v3/agent-profiles` の `profile` queryの `schema.enum` から公開選択名を取得して照会します。公開選択名と内部Profile IDが異なる場合にも対応し、名前やモデルを固定しません。各応答の `catalogRevision` が変わった場合は一覧を採用しません。OpenAPIが404の配備先では従来のProfile取得を続け、それ以外の取得失敗はcatalogの `errors` に返します。一覧取得だけではモデルを起動しません。

音楽・ボーカル・効果音は同じ `POST /v1/music/generations` へ送ります。歌なし音楽は `task: "music", instrumental: true`、ボーカルは `task: "music", instrumental: false` と歌詞を `lyrics`、効果音は `task: "sound-effect"` とし歌詞・歌詞言語を送りません。用途の解釈は担当LLMが行い、promptの語句をコードで判別しません。`instrumental: true` と歌詞、効果音と歌詞の混在は拒否します。

`GET /v1/music/providers` の `providers[].models`（id、task、defaultDurationSeconds、maxDurationSeconds）を、backend・担当への情報・画面へ渡します。ここでのtask=vocalsはモデル情報の分類で、生成要求のtaskには使いません。秒数は小数を保持し、未指定なら送信を省略します。現在のLARM契約は歌なし1〜120秒（省略120秒）、ボーカル1〜600秒（省略180秒）、効果音1〜120秒（省略5秒）です。指定値を短縮せず、modelsの用途別上限を超える場合は生成POST前に拒否します。`GET /api/music/providers` は認証済みWeb向けにこの情報だけを返します。

`outputFormat` はopus・wav・flac・mp3、既定はopus。`quality` はfast・balanced・high、既定はbalancedで、highによる音質改善は保証しません。bpm・key・timeSignatureは生成へのヒントです。`providerOptions` はguidance_scale（0〜10）だけを受け付け、内部オプションや参照音源編集は公開しません。HTTP400は用途・長さ・歌詞・オプションを確認する案内として表示します。

202応答のjobIdで状態照会し、queued・loading・generating・encodingを待ちます。完了までPOSTを再送しません。取消は同じjobIdへのDELETEで行い、取消後の結果は採用しません。failed・cancelledは再生可能な成功にしません。`result.audioUrl` とmetadataUrlをControlのURLとして解決し、既存のMIME・内容検査と保存経路を使います。`result.model` と `result.metadata.runtime` を記録します。Provider識別子やモデル名への固定分岐はありません。過去の音声の再生・保存・検索・タグ・お気に入りは従来経路を維持します。

`music.create@3`・`music.generate@3`・担当手順は `music-routing.bundle.json`、操作画面は `music.generation@3` です。旧V1/V2の登録定義・契約は保持し、既存music planner/generatorと登録済みmusic-screen adapterを再利用します。画面では3用途を選べ、効果音も共通プレイヤー、Visualizer、履歴・詳細・保存を使います。表示JSONに実行時URLや音声を保存しません。詳細は[今回の作業記録](../spec/audio-routing-work-record-2026-10-20.md)。

サーバーを起動せず実LARMの3用途を1回ずつ確認するには `bun scripts/music-routing-live.ts --run` を使います。保存済み接続と認証で短い音声を生成し、デコード・長さ・ブラウザ再生を確認します。この実行が生成した確認音声だけをLARMから削除します。実スピーカーの聴取とは区別します。

楽曲イメージは楽曲と同時には作りません。完成した楽曲の「楽曲イメージ」表示で利用者が「イメージを作成」を押すと、`POST /api/music/:id/artwork` が music domain のジョブ `music.artwork` を積み、その曲のタイトル・説明・制作プロンプトから画像プロンプトを組み立てて 画像生成サービス（capability `media.image.generate`）で256×256のPNGを1枚生成します（文字は描かせず、曲名は画面側で重ねて表示）。画像は楽曲行に保存し、`GET /api/music/:id/artwork` で取得します。LARM側に作られた画像は取得後に削除し、画像スタジオの一覧には残しません。完成後は「作り直す」で新しいrevisionとして再生成でき、古いジョブの結果は採用しません。画面操作は `artifact:music.generation@2` の `music-artwork` actionです。プレイリストでは、LARMのtrack idが生成時のLARM job id（`music_<uuid>`）と一致する楽曲だけ、`GET /api/music/tracks/:id/generation` で生成レコードを引き、同じ画像の表示・作り直しができます。Eumenesで生成していないLARMの楽曲には画像がありません。

`bun scripts/music-live.ts --run` は隔離環境から短い確認曲を1曲生成し、Opusのデコード・長さ・既存Artifactでの再生を確認します。完了した確認曲だけをLARMから削除し、404で削除を確認します。

## 画像生成

画像生成は、保存済みControl接続先のcatalogから、capability `media.image.generate`（protocol `larm.image-generation.v1`）を持つ `services` のサービスを発見して使います。複数あるときはcatalogの順で最初のサービスです。Profile名・モデル名は設定・コード・手順に固定せず、サービス発見・確保応答が返す値を使います。発見したサービスの公開Profile selectorとcatalog revisionで `POST /v1/agent-connections` に接続を依頼します。画像は生成POSTで起動するため、Providerのreadyを待たず、pending・probing・readyの接続応答に含まれるサービスを使います。サービス選択用の要求フィールドがないため、既存のLLM接続と同じ `providers: ["llm"]` で接続し、その応答に含まれる画像サービスを使います。Profile全体を予約して音声等の準備を待たないようにします。接続応答のProfile・revisionと対象サービスのcapability・protocol・modelを照合し、その応答のURL・descriptionを使います。Providerのclaimは行いません。画像取得後、失敗時、取消時は接続を解放します。生成APIは `POST /v1/images/generations` です。Controlの接続先はSQLiteの保存済みLARM設定を使います。サービス発見・確保応答の `services[].url` を生成先として使い、`description` で利用条件を確認します。URLを設定や手順に固定しません。Profile指定なしの `GET /v3/agent-profiles` は `services` を省くことがあるため、`services` が空のProfileはIDを指定して取り直します。取り直した応答が `url` を含まず `endpoint` を返す場合は、返された `endpoint` をControlのURLに解決します。試用経路は `url` があればそちらを優先します。

```json
{
  "model": "<発見したサービスのmodel>",
  "prompt": "自然光の入る室内。木目と布地を自然な質感で描いた写真。",
  "width": 1200,
  "height": 800,
  "seed": 42,
  "format": "png"
}
```

| 項目 | 指定方法・省略時の値 |
| --- | --- |
| `width` / `height` | 各辺100〜1280の整数。省略した辺は512。縦横を別々に指定できる。 |
| `steps` | 8固定。省略可能。 |
| `seed` | 省略時0。 |
| `format` | `webp` または `png`。省略時 `webp`。 |
| 品質・画風 | `prompt` に具体的に記述する。品質指定の別パラメータは使わない。 |

内部では各辺を32ピクセル刻みに合わせて生成し、保存・返却画像は指定どおりの寸法に縮小されます。利用側では32の倍数に丸めません。下書きには小さめのサイズ、写真風・イラストの仕上げには大きめのサイズと具体的な描写指示を使います。参照画像による編集は現行APIでは未対応です。

要求時にモデルを起動し、画像保存後に停止します。生成APIは同期応答で、起動・生成・停止の待ち時間を含みます。応答の `artifacts[0].contentUrl` または `artifact.contentUrl` をControlのURLに解決してGETします。保存画像はモデル停止後も取得できるため、取得失敗時はGETだけを再試行します。生成POSTは自動再送しません。

利用者が示したこのPCでの実測目安（2026-10-10）は、512角約16秒、768角約31秒、1024角約58秒、1200×777約53秒、1280角約102秒です。負荷や起動状態で変わります。試用の待機上限は既存の15分を維持します。

ASRの文字起こしは会話入力になり、発話の続き判定や言語判定のcontrolは呼びません。ASR要求には設定から選んだ `language` を1つ渡します。ASR receiptの受理、取消、回答/TTSへの検証parentはbackendが管理します。詳細は [toolchain](toolchain.md#タイマーと音声) を参照してください。

現在の接続先ASRには1要求12秒の制限があるため、長いPCM WAVはlarm adapterで12秒以内に分割します。PCM16は上限直前に200ms以上の低振幅区間があればそこで区切り、すべての区間が成功してから一つの認識結果として採用します。音声サンプルの省略・重複、意味による語句の補正は行いません。途中の失敗・取消では部分結果を会話へ渡しません。録音側の60秒上限は維持します。認識精度・会話の短さの未受入を含む結果は[音声修正記録](../spec/voice-repair-work-record-2026-10-25.md)を参照してください。

画像生成ツールチェーンと、プロンプト編集・全画面の画像一覧を接続しました。保存画像の一覧と取得はControlの `/v1/image-artifacts` を使用し、生成やProvider claimは不要です。2026-10-13の配備OpenAPIで `DELETE /v1/image-artifacts/{id}`、Bearer認証、HTTP200と`{id,deleted:true}`を確認しました。一覧から保存画像を物理削除し、Eumenesでは応答IDが対象と一致することを検査します。生成履歴は維持し、削除を自動再送しません。詳細は[画像生成](images.md)を参照してください。

端末画像・Googleフォトの選択写真は、Eumenesで正規化したWebPを本番 `POST /v1/image-artifacts/imports` へ送る。Control認証とUUIDを使い、receiptを `GET /v1/image-imports/{requestId}` で照会する。取込だけではGPU・画像生成・3D生成を起動しない。[現行契約](../spec/reference/larm-image-import-v1/README.txt)と[取込処理](images.md#画像の取込)を参照。

## 保存曲のプレイリストと再生

`open_music_library` は `package:music.playback@1`（同名のprofile/skillと `tool:music.library@1`）を起動する。実行用Skillは `api/domains/capabilities/builtin/music-playback/SKILL.md`。実際のタグ名・全体件数をLLMへ渡し、依頼からq・タグAND・お気に入り・順序を作る。生成担当とは独立し、一覧や音声の取得に生成モデルの起動・Provider claimは使わない。

music domainのプレイリストは会話/run・検索条件・曲IDを保存する。Webは認証済みAPIからsourceを解決し、登録view `music-library`・`music-player`・`playlist` をOpenUI JSONで合成する。Artifactを閉じてもLARM曲は残る。再表示時の選択曲は詳細APIから再取得する。タグはLARMが返すものだけを使い、画面に別の自動タグ生成を加えない。

接続は保存済みsettingsのControl originと既存のbackend Control token。`/api/music/tracks/:id/audio` が詳細のaudioUrlを同じControl originとして検証し、Rangeと206/416、Content-Range・Accept-Ranges・Content-Typeを引き継いでストリーミングする。Webのaudio要素は既存の同一origin認証proxyを通り、URLやHTMLへtokenを埋め込まない。

`/api/music/tracks` はq/tags/favorite/sort/order/limit/cursor、`/api/music/tags` は全体タグ件数を返す。お気に入りPUT/DELETEと曲DELETEは別操作。507では不要曲の削除を案内する。検索変更でcursorを破棄し、検索条件ごとの取消可能な取得で古い検索応答を採用しない。

読取り専用の実接続確認は `bun scripts/music-playback-live.ts --run`。保存済み曲だけを検索・再生し、生成・変更・削除は許可しない。固定試験とは区別して記録する。

## 日英混在文の読み上げ振分け

読み上げ本文を句読点の句に分け、さらに日本語とラテン文字の境界で区間に分ける（`delivery` の `speechSegments`）。各区間の言語は文字種と語の形だけで決め、LARM の分類器・単語辞書は使わない。日本語を含む句ではラテン文字の通常語が2語以上続く部分を `en` とし、略語（`API`）、コード・アドレス形（`example.com`）、語中に大文字を含む語（`iPhone`）は語数に数えない。全語が大文字始まりの部分は固有名詞として `ja` に残す。日本語を含まない句は通常語が1語以上あれば `en`。規則と評価表は [計画](../spec/.archived/regex-speech-language-routing-plan-2026-10-16.md) と `api/domains/delivery/test/speech-language.test.ts`。

合成要求ごとに inference が本文から `speechLanguage` を再計算する（区間は再計算しても同じ言語になる）。`en` は catalog の `speech.tts.english` capability を持つ Provider へ、`ja` は既存の日本語TTSへ渡す。区間に分かれていない混在本文（設定画面の試聴など）は `ja`。合成は最大3区間まで先行させ、再生は前の区間終了後に進める。回答LLMの出力形式は変更しない。

[全体コンセプト](https://chatgpt.com/space/page_9fab9c53bce8819181c9c8256a3b303a)の原則に従い、公開Profileを正本とする。英語TTSは独立したProviderの認証を使い、確保・claim・renew後の再claim・解放を共通機構で扱う。

接続の内部設定は `larm.englishSpeechEnabled`（省略時無効）。旧 `sentenceLanguageEnabled` は保存文書の移行で引き継ぎ、`sentenceLanguageProvider` は削除する。英語の声は日本語の公開 `voice_presentation` が女性・中性ならRosie、男性ならJasperへ固定し、速度は常に1.0。旧 `englishVoice` / `englishMasculineVoice` / `englishSpeed` は保存文書の互換読取り用に受理するが実行には使わない。`en` 区間には日本語の声・style・pitch・intonation・速度・読み辞書を使わない。逐次音声の表情は英語区間も句ごとに判定するが、日本語向けの抑揚パラメーターは英語TTSへ渡さない。英語TTSの到達確認は `/api/inference/voices?language=en`。言語の任意指定は合成APIに公開しない。

英語TTSを確保できない場合（`speech_tts_target_unavailable`）は、その区間を `ja` として日本語TTSで合成し、読み辞書と話し方判定を適用する（`inference.english_speech_fallback` を warn で記録）。英語TTSの合成エラーは日本語TTSへ転送しない。LARM の合成がフォールバック対象の失敗で終わり、route が許せばクラウドTTS（Cloudflare Workers AI など）へ進む。クラウドでは言語判定を行わず、日本語読み辞書を適用する。

再確認は `bun scripts/mixed-speech-live.ts --run`。隔離backendに保存済みLARM設定を保存し、固定の日英混在回答を区間化して、区間ごとに日本語・英語TTSのどちらで合成されたか（attemptのmodel）とWAV取得を `verification-reports/mixed-speech-live/` に記録する。合成音声の取得はスピーカー再生の実機器受入に数えない。旧Ruri分類の接続記録は [検証記録](../spec/verification/ruri-sentence-language-2026-10-12/README.md) に残す。

## チャットの画像入力

画像入力（JPG・PNG・BMP）は、Providerの`llm.vision`と`chatInput`を確認して使います。保存、履歴再送、正式token計数と保持説明は[チャット画像入力](chat-images.md)を参照してください。

## Docling Deskの入口

Docling Deskは既存LARM資格情報とgatewayのUI-ticket契約で別タブに開く。独自leaseやExcalidraw専用キーは使わない。中継・Cookie・起動待ち・受入は[Docling Desk](docling.md)を参照。
