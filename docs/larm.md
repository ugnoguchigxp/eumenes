# LARM の接続・予算・session 構成

LARM 接続では毎回接続状態を API で確認し、claim が返した `configuration.fields.baseURL`、`configuration.fields.model`、`credential.token` を使用します。LLM のみなら `providers: ["llm"]`、音声を使う場合は `providers` を省略して Profile 全体を要求します。期限前の renew 後は再claimで token を更新し、終了時に接続を解放します。メインの入力予算は 256072 token、出力上限は 4096 token です。4 セッション構成の目標は、同じ 512K のランタイムを共有するメイン 256K × 1 と補助 64K × 3 です。補助の入力予算は各 59464 token とし、利用側でセッション数と予算を管理します。補助 selector `SAAA-gemma4-26b-64k` は 2026-10-08 時点で catalog が 404 を返すため、コードからも接続を禁止しています。配備後に catalog を確認し、補助の管理処理を実装してから有効化します。

設定は [setup.md](setup.md)(環境変数)と [settings.md](settings.md)(画面)を参照してください。

## 楽曲生成の音声形式

楽曲生成ツールチェーンは、保存済みControl接続先から `SAAA-w-music` の `services` にある `music` / `larm.music-generation.v1` を発見し、返されたendpointとmodelを使います。生成・状態照会・音声取得にはControl認証を使い、Providerのclaimは行いません。

2026-10-11に配備先の `GET /openapi.json` で確認した契約に合わせ、`outputFormat: "opus"` を明示します。出力はOgg Opus・64 kbps固定・48 kHzです。完了確認後に `result.audioUrl` と `metadataUrl` をControlのURLとして解決し、音声のMIMEとOgg / Opus識別ヘッダーを検査します。Eumenesで再変換せず、既存の音声保存・認証済み取得APIへ渡します。保存ファイルの拡張子は `.opus` です。既存のMP3・WAV・FLAC結果の取得にも対応します。

担当の指示・schema・package版は変更していません。非同期ジョブ、生成POSTの自動再送禁止、取消後の結果不採用、Artifactの構成も既存経路を使います。ライブラリ・タグ検索・お気に入り・Range中継と再生プレイヤーの拡張は別作業です。

`bun scripts/music-live.ts --run` は隔離環境から短い確認曲を1曲生成し、Opusのデコード・長さ・既存Artifactでの再生を確認します。完了した確認曲だけをLARMから削除し、404で削除を確認します。

## 画像生成

2026-10-10以降の基本サービスは **Qwen-Image 2.1 Turbo（AD-Q4_K）** です。Profileは `SAAA-w-Image`、モデル指定は `qwen-image-2.1-turbo`、生成APIは `POST /v1/images/generations` です。Controlの接続先はSQLiteの保存済みLARM設定を使います。サービス発見・確保応答の `services[].url` を生成先として使い、`description` で利用条件を確認します。URLを設定や手順に固定しません。現行の `GET /v3/agent-profiles?profile=SAAA-w-Image` は `url` を含まず `endpoint` を返すため、その応答では返された `endpoint` をControlのURLに解決します。試用経路は `url` があればそちらを優先します。

```json
{
  "model": "qwen-image-2.1-turbo",
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

## 保存曲のプレイリストと再生

`open_music_library` は `package:music.playback@1`（同名のprofile/skillと `tool:music.library@1`）を起動する。実行用Skillは `api/domains/capabilities/builtin/music-playback/SKILL.md`。実際のタグ名・全体件数をLLMへ渡し、依頼からq・タグAND・お気に入り・順序を作る。生成担当とは独立し、一覧や音声の取得に生成モデルの起動・Provider claimは使わない。

music domainのプレイリストは会話/run・検索条件・曲IDを保存する。Webは認証済みAPIからsourceを解決し、登録view `music-library`・`music-player`・`playlist` をOpenUI JSONで合成する。Artifactを閉じてもLARM曲は残る。再表示時の選択曲は詳細APIから再取得する。タグはLARMが返すものだけを使い、画面に別の自動タグ生成を加えない。

接続は保存済みsettingsのControl originと既存のbackend Control token。`/api/music/tracks/:id/audio` が詳細のaudioUrlを同じControl originとして検証し、Rangeと206/416、Content-Range・Accept-Ranges・Content-Typeを引き継いでストリーミングする。Webのaudio要素は既存の同一origin認証proxyを通り、URLやHTMLへtokenを埋め込まない。

`/api/music/tracks` はq/tags/favorite/sort/order/limit/cursor、`/api/music/tags` は全体タグ件数を返す。お気に入りPUT/DELETEと曲DELETEは別操作。507では不要曲の削除を案内する。検索変更でcursorを破棄し、検索条件ごとの取消可能な取得で古い検索応答を採用しない。

読取り専用の実接続確認は `bun scripts/music-playback-live.ts --run`。保存済み曲だけを検索・再生し、生成・変更・削除は許可しない。固定試験とは区別して記録する。
