# LARM の接続・予算・session 構成

LLMのProfileは設定画面で保存した値（`larm.profile`）だけを使います。コード・既定値・手順にProfile名やモデル名を固定しません。未保存のときは `larm_profile_missing` で接続しません。初回の `LARM_PROFILE` 指定は、未保存の設定へ取り込みます。選択肢は、保存済みのLARM接続先に `GET /v3/agent-profiles` をProfile指定なしで送って得たcatalogから作り、`llm` Providerを持つProfileだけを挙げます（`backchannel` だけのProfileは含めません）。catalogを読めないときは保存済みのProfileをモデルなしで1件返します。

主会話と補助のcontrol要求は、どちらも保存済みのProfileを使います。補助のcontrol要求は別のclient識別子で独立したConnectionと履歴を持ち、Profileの名前によらず同じ構成になります。LARMは共有KVとSessionを管理し、各Connectionのcontext window・出力予約はclaimを正本とします。モデル名はcatalogとclaimが返す値を使い、送信にはclaim値を使います。主会話の同一接続上の推論は順番に実行し、補助要求は独立したConnectionと履歴を使い、終了・取消時に解放します。待機中の要求はLARMのConnection lifecycleと呼出元の期限・取消に従い、readyとclaimableを確認するまで推論しません。control要求の出力schemaは、LARMには `response_format: json_schema`（strict）、OpenAI互換のcloudには `response_format: json_schema`、Codexには `outputSchema`、Claude Agent SDKには `outputFormat` で渡します。Managed Agentsには渡さず、指示文とhostの検証で受けます。

`GET /v3/agent-profiles?profile=...` から構成と `catalogRevision` を取得し、作成時に `expectedCatalogRevision` を指定します。同じclientとProfileの要求ではLARMが既存Connectionを再利用するため、各sessionに固有のclient識別子を使い、renew・再接続では同じ識別子を維持します。入力予算はclaimのcontext windowと正式なchat input計数から求めます。出力予約はclaimの上限以内で明示します。

LLMのみの要求は `providers: ["llm"]`、音声の要求は `providers` を省略して選択Profile全体を取得します。不要なProviderを事前予約しません。Providerの接続先・model・tokenはclaimの `configuration.fields.baseURL` / `daemonURL`、`configuration.fields.model`、`credential.token` を使い、公開endpointとの整合性を確認します。ASR、日英TTS、Ruriの態度・文章言語判定とembeddingは新Profileのcatalogから発見する既存経路を使います。期限前のrenew後は再claimでtokenを更新し、終了時に解放し、失効時は既存の再接続処理を使います。

2026-10-12の実接続で主1＋補助3の同時応答、履歴分離、5つ目の待機と解放後の利用、ASR、日英TTS、Ruri両Provider、384次元embeddingを確認しました。設定の初期選択・保存済み選択の維持、renew・再claim・再接続・取消は固定試験でも検証しています。詳細は [検証記録](../spec/verification/ornith-profile-2026-10-12/README.md)。音声ファイルの取得は実機器の3往復受入に数えません。

設定は [setup.md](setup.md)(環境変数)と [settings.md](settings.md)(画面)を参照してください。

## 楽曲生成の音声形式

楽曲生成ツールチェーンは、保存済みControl接続先のcatalogから、capability `media.music.generate` を持つ `services` のサービス（`larm.music-generation.v1`）を発見し、返されたendpointとmodelを使います。複数あるときはcatalogの順で最初のサービスです。生成・状態照会・音声取得にはControl認証を使い、Providerのclaimは行いません。

2026-10-11に配備先の `GET /openapi.json` で確認した契約に合わせ、`outputFormat: "opus"` を明示します。出力はOgg Opus・64 kbps固定・48 kHzです。完了確認後に `result.audioUrl` と `metadataUrl` をControlのURLとして解決し、音声のMIMEとOgg / Opus識別ヘッダーを検査します。Eumenesで再変換せず、既存の音声保存・認証済み取得APIへ渡します。保存ファイルの拡張子は `.opus` です。既存のMP3・WAV・FLAC結果の取得にも対応します。

担当の指示・schema・package版は変更していません。非同期ジョブ、生成POSTの自動再送禁止、取消後の結果不採用、Artifactの構成も既存経路を使います。ライブラリ・タグ検索・お気に入り・Range中継と再生プレイヤーの拡張は別作業です。

楽曲イメージは楽曲と同時には作りません。完成した楽曲の「楽曲イメージ」表示で利用者が「イメージを作成」を押すと、`POST /api/music/:id/artwork` が music domain のジョブ `music.artwork` を積み、その曲のタイトル・説明・制作プロンプトから画像プロンプトを組み立てて 画像生成サービス（capability `media.image.generate`）で256×256のPNGを1枚生成します（文字は描かせず、曲名は画面側で重ねて表示）。画像は楽曲行に保存し、`GET /api/music/:id/artwork` で取得します。LARM側に作られた画像は取得後に削除し、画像スタジオの一覧には残しません。完成後は「作り直す」で新しいrevisionとして再生成でき、古いジョブの結果は採用しません。画面操作は `artifact:music.generation@2` の `music-artwork` actionです。プレイリストでは、LARMのtrack idが生成時のLARM job id（`music_<uuid>`）と一致する楽曲だけ、`GET /api/music/tracks/:id/generation` で生成レコードを引き、同じ画像の表示・作り直しができます。Eumenesで生成していないLARMの楽曲には画像がありません。

`bun scripts/music-live.ts --run` は隔離環境から短い確認曲を1曲生成し、Opusのデコード・長さ・既存Artifactでの再生を確認します。完了した確認曲だけをLARMから削除し、404で削除を確認します。

## 画像生成

画像生成は、保存済みControl接続先のcatalogから、capability `media.image.generate`（protocol `larm.image-generation.v1`）を持つ `services` のサービスを発見して使います。複数あるときはcatalogの順で最初のサービスです。Profile名・モデル名は設定・コード・手順に固定せず、サービス発見・確保応答が返す値を使います。生成APIは `POST /v1/images/generations` です。Controlの接続先はSQLiteの保存済みLARM設定を使います。サービス発見・確保応答の `services[].url` を生成先として使い、`description` で利用条件を確認します。URLを設定や手順に固定しません。Profile指定なしの `GET /v3/agent-profiles` は `services` を省くことがあるため、`services` が空のProfileはIDを指定して取り直します。取り直した応答が `url` を含まず `endpoint` を返す場合は、返された `endpoint` をControlのURLに解決します。試用経路は `url` があればそちらを優先します。

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

非空ASRの本入力には、会話開始前の言語判定controlが一回加わります。既定モデルを使い、8秒・256 token以内、confidence 0.8以上、主要言語すべてが利用者の許可リスト内であることが条件です。英字略語やLatin文字の有無では分類しません。判定不在・不正・判定不能では会話を開始しません。ASRと判定receiptの受理、取消、回答/TTSへの検証parentはbackendが管理します。詳細と検証laneは [toolchain](toolchain.md#タイマーと音声) を参照してください。

画像生成ツールチェーンと、プロンプト編集・全画面の画像一覧を接続しました。保存画像の一覧と取得はControlの `/v1/image-artifacts` を使用し、生成やProvider claimは不要です。2026-10-13の配備OpenAPIで `DELETE /v1/image-artifacts/{id}`、Bearer認証、HTTP200と`{id,deleted:true}`を確認しました。一覧から保存画像を物理削除し、Eumenesでは応答IDが対象と一致することを検査します。生成履歴は維持し、削除を自動再送しません。詳細は[画像生成](images.md)を参照してください。

## 保存曲のプレイリストと再生

`open_music_library` は `package:music.playback@1`（同名のprofile/skillと `tool:music.library@1`）を起動する。実行用Skillは `api/domains/capabilities/builtin/music-playback/SKILL.md`。実際のタグ名・全体件数をLLMへ渡し、依頼からq・タグAND・お気に入り・順序を作る。生成担当とは独立し、一覧や音声の取得に生成モデルの起動・Provider claimは使わない。

music domainのプレイリストは会話/run・検索条件・曲IDを保存する。Webは認証済みAPIからsourceを解決し、登録view `music-library`・`music-player`・`playlist` をOpenUI JSONで合成する。Artifactを閉じてもLARM曲は残る。再表示時の選択曲は詳細APIから再取得する。タグはLARMが返すものだけを使い、画面に別の自動タグ生成を加えない。

接続は保存済みsettingsのControl originと既存のbackend Control token。`/api/music/tracks/:id/audio` が詳細のaudioUrlを同じControl originとして検証し、Rangeと206/416、Content-Range・Accept-Ranges・Content-Typeを引き継いでストリーミングする。Webのaudio要素は既存の同一origin認証proxyを通り、URLやHTMLへtokenを埋め込まない。

`/api/music/tracks` はq/tags/favorite/sort/order/limit/cursor、`/api/music/tags` は全体タグ件数を返す。お気に入りPUT/DELETEと曲DELETEは別操作。507では不要曲の削除を案内する。検索変更でcursorを破棄し、検索条件ごとの取消可能な取得で古い検索応答を採用しない。

読取り専用の実接続確認は `bun scripts/music-playback-live.ts --run`。保存済み曲だけを検索・再生し、生成・変更・削除は許可しない。固定試験とは区別して記録する。

## 文章言語による読み上げの振分け（試用）

本文を採用してから、読み上げ対象の全文を一度 `ja` / `en` に分類する。`ja` は既存の日本語TTS、`en` はcatalogの `speech.tts.english` capabilityを持つProviderへ渡す。回答LLMの出力形式は変更しない。句読点で分割した区間は同じラベルを共有し、合成を最大3区間まで先行させ、再生は前の区間終了後に進める。生成中の逐次発声と日英混在文の区間分割は今回の対象外。

[全体コンセプト](https://chatgpt.com/space/page_9fab9c53bce8819181c9c8256a3b303a)の原則に従い、公開Profileを正本とする。実験モデルの名前・ローカル保存先・起動済みポートから接続先を推測しない。保存済みsettingsからProfileを発見し、確保・ready・claim・専用認証・renew後の再claim・解放を共通機構で扱う。英語TTSも態度判定も分類器も、独立したProviderの認証を使う。

接続の内部設定は `larm.sentenceLanguageEnabled`（省略時無効）、`sentenceLanguageProvider`（分類用Provider名。省略時は `decision.sentence-language` の唯一の候補を自動選択）。通常環境は有効化済み。2026-10-12のユーザー指定で、Webの分類・英語声・英語速度の設定欄を削除した。英語の声は日本語の公開 `voice_presentation` が女性・中性ならRosie、男性ならJasperへ固定し、速度は常に1.0。旧 `englishVoice` / `englishMasculineVoice` / `englishSpeed` は保存文書の互換読取り用に受理するが実行には使わない。日本語の声・style・pitch・intonation・速度を英語へ流用せず、日本語の読み辞書も適用しない。接続確認API `/api/inference/speech-routing` と `/api/inference/voices?language=en` は維持し、言語の任意指定を通常回答の合成APIには公開しない。

分類のadapterは既存 `larm.system-one.v1` / `/v1/systemone` のchoice契約に対応する。catalogの `decision.sentence-language` を発見し、選択したProviderのclaim endpoint・model・専用tokenを使ってHTTP要求を送る。文字列の `state` に全文を入れ、`questions.language` の `ja/en` choiceを要求する。応答の `answers.language.type=choice` / `choice=ja|en` を検証する。返されたmodelがclaimと異なる場合、切詰め・入力tokenの破棄が報告された場合は拒否する。態度用 `system-one` Providerには送らない。別protocolで公開された場合はその契約の確認とadapter追加が必要。

共有結果はbackendのメモリ内、64件・10分まで。同一回答・本文・設定で再利用し、失敗や取消中の遅着結果は保持しない。初回の接続準備は既存TTS期限内で行い、その後の分類に暫定2秒の上限を置く。この上限は待ち続けないための期限であり、通常の処理時間ではない。分類の不足・不正・失敗・timeoutと選択先TTS不在は読み上げの失敗として扱い、区間ごとの再試行や別TTSへの推測転送を行わない。本文は残す。

2026-10-12夕方の配備後、`SAAA-gemma4-26b` の `sentence-language` / `ruri-v3-30m-sentence-language` と既存態度用 `system-one` の共存を確認した。接続を保持し、分類のHTTP要求ごとにモデルを初期化しない。分類結果を使った日英両TTSと、Eumenes公開APIからの音声取得・receipt採用が成功した。実機器3往復は未実施。

再確認は `bun scripts/sentence-language-live.ts --run`。保存済みbackend設定と公開接続だけを使い、既知の日英文で両TTSの通信とWAV取得を確認する。保存されたProvider、またはcapabilityに合う唯一の候補を使って二分類を確認する。`--benchmark` を付けると日本語・英語・態度との同時要求を各200回測る。このPCでの通常分類P95は日本語27.36ms・英語52.68ms。同時要求の両方完了までのP95は107.82ms、失敗0/600、同じConnectionを使用した。LARMホスト内の測定とネットワークを含むこの測定を区別する。公開API経路は `bun scripts/sentence-language-api-live.ts --run` で隔離backendの設定API・分類・合成・receipt採用を確認する。結果は `verification-reports/sentence-language-live/`、実施記録は [検証記録](../spec/verification/ruri-sentence-language-2026-10-12/README.md)。合成音声の取得はスピーカー再生の実機器受入に数えない。

## チャットの画像入力

画像入力（JPG・PNG・BMP）は、Providerの`llm.vision`と`chatInput`を確認して使います。保存、履歴再送、正式token計数と保持説明は[チャット画像入力](chat-images.md)を参照してください。
