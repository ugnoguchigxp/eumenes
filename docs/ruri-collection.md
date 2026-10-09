# Ruri判定の収集・レビュー

GemmaのSystem Oneは発話態度専用の`ruri-v3-30m-speaking-attitude`を使います。接続先・モデル・認証はLARMのdiscovery/claimから取得します。Layaの互換経路も残しています。分類スコアは合成データ由来の暫定校正であり、実会話で正解する確率ではありません。instructionを変更してもRuriの固定タスクは変わりません。

## 収集を開始・停止する

通常どおりbackendを起動した状態で実行します。Web・CLIからDBを開くことはなく、認証済みのEumenes APIを使います。

```sh
bun run cli -- collection status
bun run cli -- collection start
# 普段のWebまたはCLIで実際に会話する
bun run cli -- collection status
bun run cli -- collection stop
```

開始前・backend再起動後は停止状態です。再開しても既存件数・重複記録は保持します。成功した異なるRuri判定が300件に達すると自動停止します。`successful`、`unreviewed`、`reviewed`、`held`、`skipped`、`skip_reasons`、`pending`、`failed`、`storage_errors`を別に表示します。300件すべてが確認済みという意味ではありません。

既定保存先は`data/attitude-dataset/dataset.sqlite3`です。製品DBを移動した場合、その親の`attitude-dataset/`になります。`EUMENES_ATTITUDE_DATASET`で変更でき、statusの`path`が実際の絶対パスです。backend専用の単一writer、ディレクトリ0700・DB0600で保存し、通常ログ`data/logs/api.jsonl`とは分離しています。保存先・レビュー作業ファイル・exportには会話本文があるため、Git管理外の`data/`などを使用してください。実会話本文をcommitしないでください。

認証ヘッダー・credential・token・設定・Provider生応答はデータセットへ渡しません。Provider応答は必要なフィールドだけを取り出します。本文にBearer/APIキー等の認証文字列と見られる内容があれば、その例全体を`skip:sensitive-text`として除外します。この検査は一般的な個人情報の匿名化ではありません。conversation_idとturn_idは保存先固有のsaltによるHMACで匿名化します。

## 何を1件と数えるか

実際のdialogueの会話ID・run ID・granularity・chunk_orderからHMACでsample_idを作り、その組に対して1回だけ収集します。再試行・同じ回答の読み上げ直しは増えません。採用確度が低い例や候補外棄却も、全6logitとスコアを持つ正常なRuri応答なら、レビューすべき成功判定として数えます。失敗、timeout、Laya、malformed応答、合成fixture、接続probe、速度測定は300件に入りません。失敗した同じ単位の収集再試行は行わず、新しい実発話を収集します。

通常の判定結果を再利用します。候補がなく`not-expressive`等で通常判定を実行しなかった発話だけ、全6候補で1回、非同期に判定します。テキスト接続だけでSystem One未取得の場合も、この非同期処理内でdiscovery/claimを準備します（接続準備を含む上限30秒、判定自体は通常と同じ2秒）。TTSはこの収集用判定を待ちません。通常判定を呼んだ後の失敗・低確度・候補外棄却では追加判定しません。収集用結果を演出へ採用しません。停止・再開始・取消・期限後の結果は新たに保存しません。

Ruriへは`state.current_chunk`だけを送ります。`state.response`は互換入力として受け付けますが、user発言・conversationは送信しません。choiceの候補はnoneを含む6ラベルの範囲に限定します。全6クラスの首位が候補subset外なら棄却し、subset内の再正規化はしません。通常演出の採用条件はanswer_confidence 0.6以上を維持し、トップレベルと旧usage内の切詰め情報の両方を検査します。

**現行の生成経路はanswer単位です。** 回答生成完了後に回答全文から最大600文字（長い場合は冒頭と末尾）を抜粋して判定します。この既存の待機を今回追加したものではありません。`granularity=answer`、`chunk_order=null`、`current_chunk=元の回答全文`、`sent_current_text=実際の抜粋`、`client_excerpted`で区別します。chunkと偽装しません。chunk単位で受け取る公開収集契約もありますが、現行の通常会話から独立したchunk学習例を自動生成するものではありません。全文answerをchunk用の学習・評価へ混ぜないでください。

## 人手レビュー

初回の`show`では、モデルの予測・スコア・選択した演出・送信候補を隠します。日本語のuser発言、対象全文、送信した現在テキスト、直前chunk（取得できた場合）、会話文脈を確認します。予測を見たい場合だけ`predictions`を指定してください。

```sh
bun run cli -- collection list
bun run cli -- collection show <sample_id>
bun run cli -- collection prepare <sample_id> data/review.json
# data/review.jsonをテキストエディタで編集する
bun run cli -- collection review <sample_id> data/review.json
bun run cli -- collection show <sample_id> predictions
bun run cli -- collection report
```

`prepare`は人手用の空欄（既にレビューしていればその値）を作ります。モデル予測を正解欄へコピーしません。既存ファイルは上書きしないため、次の例では別ファイル名を使ってください。

編集する項目は次の通りです。

| 項目 | 入力 |
| --- | --- |
| primary_label | none / warmth / joy / empathy / curiosity / surprise。未レビューはnull |
| acceptable_labels | 許容できるラベルの配列。確認済みの場合はprimary_labelを含める |
| expression_transition | initial（最初）/ hold（保持）/ change（変更）。判断できなければnull |
| review_status | unreviewed / held（保留）/ reviewed |
| correction_reason | 判断・修正理由。未入力はnull |
| template_group_id | 類似テンプレート群で共通のID。初期値は文字・数字・句読点を正規化した文のHMAC |
| template_group_confirmed | 類似文を確認し、必要ならグループIDを揃えた後にtrue |
| coverage_tags | 下表の該当する場面。複数指定可 |
| revision | prepareで得た番号を維持。同時編集による上書きは409で拒否 |

文章中の感情語やユーザーの気分ではなく、**現在の回答をアシスタント自身がどの表情・声色で話すべきか**を判断します。技術説明の「失敗」は通常noneです。喪失への応答もアシスタント自身を悲しい表情にするラベルではなく、穏やかな寄り添いならempathyです。最初に見た例を機械的にinitialにせず、その発話位置と文脈で判断します。answer単位で遷移を判断できない場合はheldにします。

修正理由・テンプレートIDにもcredentialやtokenを入力しないでください。認証文字列と見られる内容があれば、レビューを保存せずエラーにします。chunk単位の収集契約では現在chunkを判定対象に固定し、contextに回答全文が含まれていてもEncoder入力へ流用しません。トップレベルと旧usage内の切詰め情報が食い違う場合は、切詰めあり・最大の欠落数を記録します。

| 場面 | coverage_tags |
| --- | --- |
| 短い応答 | short |
| 通常の説明・設定・技術的な失敗の説明 | technical |
| 達成や良い知らせへの祝福 | celebration |
| 回復への安心 | recovery |
| 喪失への穏やかな寄り添い | loss |
| 続きを知りたい反応 | curiosity |
| 予想外への反応 | surprise |
| 否定・引用・コード中の感情表現 | negation-quotation |
| 祝福から手順説明に移る連続した応答 | celebration-to-instructions |
| 同じ「それはよかったですね。」等でuser発言が異なる実例 | contrast-same-text |

これらを実際の会話の中で収集し、reportの不足場面・クラス・偏りを確認します。対照例の対象文が同一でuser発言が異なる組は`contrasting_context_groups`にも表示します。モデル出力の多いクラスを人手ラベルで水増ししたり、合成例で300件を埋めたりしません。answer内の連続発話が単一ラベルで判断できなければ保留し、後のchunk収集と区別します。

## 分割と受け渡し

```sh
bun run cli -- collection stop
bun run cli -- collection split
bun run cli -- collection export data/ruri-export-01
```

会話・正規化した同一文・人手で確認したテンプレートIDを連結し、さらに文字3-gram Dice類似度0.8以上の近似文も同じグループにします。未レビューの例もグループをつなぐ根拠に使います。人手で類似テンプレートの確認を行うことが前提です。グループを分割せず、件数が60/20/20に近づくよう決定的にtrain/calibration/evalへ配分します。独立した確認済み群が3つ以上なら各用途に最低1群を確保します。大きな会話群で比率が崩れる場合もグループ保護を優先します。独立群が3未満なら警告します。

人手確認済みだけをexportします。未レビュー・保留は除外されます。新しい例の追加や人手レビュー・グループ変更で全splitを無効化し、再分割を必要にします。

- `train.jsonl`: 分類ヘッドの学習用。
- `calibration.jsonl`: 温度校正・閾値検討用。
- `eval.jsonl`: 最終評価用。ヘッド学習、温度校正、閾値調整に使わない。
- `reviewed.jsonl`: 分割情報を含む全確認済み例の監査用。これを丸ごと学習に投入しない。
- `report.json`: クラス別件数、モデルと人手ラベルの差分、未レビュー・保留・スキップ・失敗、場面別不足、分割件数。
- `schema.json`: JSONLのJSON Schema、重複判定、分割方針。

exportは新しいディレクトリ名を指定してください。既存ディレクトリは空でも拒否し、一部だけ出力して既存ファイルと混ざることを防ぎます。分割結果を受け渡した後に再収集・再分割する場合は別バージョンとして管理し、過去のevalを学習に混ぜないよう受領側でも確認してください。この機能は追加学習・モデル適用・LARM再設定を実行しません。

## JSONLの主なフィールド

`sample_id`、匿名conversation/turn ID、判定開始のUTC時刻、granularity、chunk_order、テンプレートIDに加え、元の日本語テキストと実送信文・criteria・候補順序を保持します。`decision`にはmodel、encoder/head/calibration revision、input_mode、runtime（応答のexecution_providers）、precision、method、preliminary、校正状態、6logit・スコア、モデル首位、APIラベル、answer_confidence、切詰め、inference_msを保存します。取得できない値はnullです。

`round_trip_ms`はEumenesのjudge呼出しから戻るまでの時間です。`inference_ms`とは別です。実再生開始遅延は未計測のため`tts_start_delay_ms=null`です。`selected_delivery`は元の演出選択、`adopted`は既存のwriterによるreceipt採用を確認した結果です。`adopted`もスピーカーで実際に再生したことを意味せず、未確認はnullです。toneはTTS receipt採用までnull、手動音声でもnullです。voice_applicationでpreset（自動適用）・baseline・manual・unmeasuredを区別します。元のモデル出力を保持したまま、人のprimary_label・acceptable_labels・遷移・修正理由を更新します。

APIは`/api/attitude-dataset/`以下にstatus、start、stop、samples、samples/:id、samples/:id/review、report、split、exportを用意します。既存のBearer認証とOrigin制限を引き継ぎ、本文・Provider応答・認証情報を通常ログに追加しません。
