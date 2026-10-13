# ASR後の入力判定：公開資料に基づく比較実験

2026-10-14。前回の出力短縮案は意味判断の退行により採用せず、元の判定を比較基準とする。対象はASR完了後のLLM判定。ASR、VAD、TTS、実機器の音声受入は本実験の測定区間に含まない。

## 調査と適用判断

| 一次資料 | 得られた指針 | Eumenesへの適用 |
| --- | --- | --- |
| [OpenAI: Latency optimization](https://developers.openai.com/api/docs/guides/latency-optimization) | 入力短縮より出力token削減を優先。短いキーや配列への過度な圧縮は品質を損ねる場合がある。複数判断は一要求にまとめる | 既存の言語・関係・完了判定の一要求化を維持。前回退行したキー短縮は繰り返さず、現行キーで簡潔な出力例を試す |
| [Anthropic: Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) | 少数の関連性・多様性のある例示、例と指示の構造的分離 | 評価入力とは異なる5例。未完、続き、短い返答、判定不能、外国語を扱う。Claude用の知見なのでornithへの効果は実測する |
| [Google: Prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies) | 例の形式を揃える。例が多すぎると過適合し得る | 正例のJSON形式を揃え、例数を固定。実験結果を見て個別発話の専用分岐を追加しない |
| [Microsoft: Performance and latency](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/latency) | 生成上限の適正化、TTFTと生成完了の区別、負荷の分離 | 上限512→128を独立変数として試す。Azureの予約方式がLARMにも当てはまるとは仮定しない。streamingは診断候補で、途中JSONを受理しない |
| [LiveKit: Turn detector](https://docs.livekit.io/agents/logic/turns/turn-detector/) | VADに加えて意味・文脈で発話終端を判断 | 現行のLLM意味判断を維持。別の専用モデルへの置換、期限時の自動受理は現在の要件に適さないため採用しない |
| [llama.cpp: server contract](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md) | JSON Schema制約、prefix cache、生成時間情報 | 外部エンジンの仕様だけで互換性を推定せず、稼働LARMのOpenAPIを読み取り確認。公開契約のjson_schema形式でのみ試す |
| [vLLM: Prefix caching](https://docs.vllm.ai/en/v0.30.0/features/automatic_prefix_caching/) | prefix cacheはprefillを削減しdecodeを削減しない | 現行は安定system→動的userの順を満たす。cache設定や接続共有はLARM側の実装・分離保証が必要で、この実験では変更しない |
| [JSONSchemaBench](https://arxiv.org/abs/2501.10868) | 構造制約は効率・制約対応範囲・内容の品質を分けて評価する | schema適合、意味一致、誤受理、誤拒否、遅延、失敗率を別々に記録する |

## 事前に固定した方法と採用条件

- 本体の意味判断prompt、出力項目名、許可言語、confidence 0.8、取消・古い結果拒否は維持。Schema制約にもホスト側の元のstrict schema検証を必ず適用する。
- 既存16件の合成入力に対し、baseline / schema / examples / budget128を比較。各入力内で順序を回転し、ブロックごとに反転する。探索後に有望な候補だけ反復検証する。
- 各要求は同じ保存済みLARM設定、同じモデル、temperature 0、8秒期限、独立した短命接続、exact context。本文の切捨てや途中の受理は行わない。モデルまたは設定が変われば停止する。
- schemaは元のZod schemaをそのまま送る。正式token計数と生成に同じserialized bodyを使い、digest照合を維持する。対応のないProviderへ自動fallbackしない。
- examplesだけ入力例をsystemに追加する。budget128だけ生成上限を変える。他の条件は揃える。
- 3連続の制御要求失敗で停止。SIGINT/SIGTERMで進行中の要求を取り消して接続を解放。要求snapshotは実行前に固定し、同名runは上書きしない。
- 誤受理は現行のホスト条件を満たして、正解では受理できない入力を通すこと。strict正解率はこれと別で、曖昧入力の低いrelationConfidenceも従来どおり不一致として数える。
- 少数の無事故を安全性の証明とはしない。新しい誤受理、必要な返答の悪化、切詰め・解析失敗、再現しない速度差のある案は採用しない。

## 実行物

- `scripts/voice-assessment-practices-live.ts`: 変更せず再実行できる比較器。`--run --name=<新しい名前> --variants=baseline,schema,examples,budget128 --reps=1`。
- `scripts/voice-assessment-practices.ts`: 実験候補と評価。製品の入力判定から参照しない。
- `screening/requests.json`: 合成入力と各variantの固定要求。実会話・認証・接続先は保存しない。
- `screening/results.json`: 正規化済み判断と測定値。`timings.jsonl`は既存の本文を含まない運用ログ。

## 結果

### 一次探索：3候補・64要求

全variantで16/16要求が8秒以内に応答し、解析失敗は0。同一モデル `ornith-1.5-strix-lean`。表の短縮幅は同じ入力のbaselineとの差の中央値で、正が速い。括弧内は固定seedの5,000回bootstrapによる参考95%区間。少数例かつ同じ共有Providerなので母集団の保証には使わない。

| 方式 | 完了時間中央値 | 対応する入力での短縮幅 | strict一致 | 誤受理 / 誤拒否 |
| --- | ---: | ---: | ---: | ---: |
| 現行 | 4,354ms | — | 7/16 | 0 / 3 |
| Schema制約追加 | 4,239ms | +91ms（−133〜+234） | 10/16 | 0 / 2 |
| 5例追加 | 4,576ms | −210ms（−340〜−79） | 11/16 | 0 / 3 |
| 上限128 | 4,354ms | +25ms（−99〜+124） | 10/16 | 0 / 2 |

3案とも速度改善として未採用。例示の出力token中央値は79.5→51に減ったが、入力は973→1,380に増え、総時間は悪化した。上限128は実際の生成量を減らさなかった。Schema制約の速度差はばらつきの範囲で、低い信頼度や話題切替などの意味不一致も残る。

「誤受理0」は正しい判断だけが採用された意味ではない。完了入力を通した場合でも、continuationをindependentと誤った例が全方式に1件ある。現行にはpreviousTextが空なのにcontinuationとする例も1件ある。`acceptedWrongRelation`を別に記録し、品質確認から除外していない。strict一致は言語・関係・完了・信頼度の全一致を要求するため、保守的に止まった結果も不一致に含む。評価入力は回帰用であり、今回初めて使う独立holdoutではない。

### Streaming診断：32要求

同じ16入力で現行とstreamを比較。全文が揃うまでparseも受理もしない。16/16応答、失敗0。完了中央値は現行4,391ms、stream4,115ms。対応する入力での短縮中央値226ms（参考95%区間73〜379）、16組中13組で速い。ただし接続確保の中央値も141→31msと偏りがあるため、transportだけの効果とは断定しない。

streamの呼出開始→初回deltaは中央値2,949ms、初回delta→完了は1,154ms。送信後→初回deltaは2,835ms。後者の前半にはProvider内部の待機・prefill・最初の生成・通信が含まれ、純粋なprefill時間ではない。non-streamで報告されたcached tokenは全て0、streamはusageが来ないため不明。

3方式の探索終了時に方針を再評価した。次は入力処理区間が大きいという新しい証拠に基づき、長いschema本文だけを短い項目説明に置き換え、正確なschemaはresponse_formatで渡す追加比較を行う。意味判断promptは元のまま残す。[llama.cppの文法説明](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/grammars/README.md)はschemaがpromptに自動挿入されないことを明記しているため、項目の意味まで削除しない。Eumenesがそのエンジンを使うとは仮定せず、稼働LARMの受理・token数・判断を測定する。

### 形式説明の短縮：48要求

baseline / schema / short-schemaを同じ16入力で比較。全48要求が期限内に応答、解析失敗0。入力token中央値973→597、出力は80→78.5。完了中央値4,366→3,980ms。対応する入力の短縮中央値596ms（参考95%区間227〜670）、16組中13組で速かった。

しかしstrict一致は9/16→6/16、誤拒否は2→4件に増えた。直前の問いへの短い返答 `short-answer` が、現行ではindependent/ready、短縮版ではcontinuation/waitingになった。また本文内の分類指示をデータとして評価する `text-injection` でもidentified/readyからundetermined/waitingへ変わった。意味判断の指示文をそのまま残しても、形式説明の変更が判断に影響する実例であり、未採用とした。誤受理0を採用の十分条件にはしない。

残るstream案は同じ16入力を逆の実行順で再比較し、接続確保の偏りと再現性を確認する。最初の比較値だけで製品には反映しない。

### Streamingの逆順再比較：32要求

実行順を逆にした別cohortでは現行4,319ms、stream4,283ms。対応する入力での短縮中央値76ms（参考95%区間−115〜270）と差が小さくなった。16/16応答、解析失敗0。初回delta中央値3,130ms、その後の完了まで1,149ms。接続確保中央値は現行63ms、stream194msで、前回とは偏りが逆だった。

strict一致は現行8/16、stream11/16、誤受理0/0、誤拒否3/0。ただしstream側で `topic-switch` をcontinuation/readyとし、独立した質問を前の未完発話と結合してしまう結果が1件あった。既存の `fragment-3` の誤関係判定に加えて新しい採用時の意味不一致となる。方式変更との因果は少数試行では断定できないが、「採用して安全性を維持できた」とも判断しない。

stream診断→形式説明短縮→逆順再比較の3ラウンド終了後に再評価。追加の同種調整を止め、5候補（Schema追加・例示・生成上限・形式説明短縮・stream）のいずれも性能変更として製品へ反映しない。比較は計176要求で全て期限内に応答した。速度と品質を両立した改善は未達。

## 残した変更と次の調査

製品の音声判定prompt・parser・信頼度・受理・取消・履歴統合は変更していない。LARM共通要求に任意の `jsonSchema` 指定を追加し、比較器からだけ使用する。指定しない既存呼出しは引き続きJSON-objectモードである。これは稼働LARMの公開契約に接続する最小の追加で、意味判断の分岐はない。正式token計数と生成で同じbodyを送り、要求digest照合を維持したことをfixtureで検証した。

比較器、固定要求、正規化済み結果、区間ログ、集計器を残した。streamの初回deltaは診断用であり、ユーザー表示・回答開始・receipt受理には使わない。各runの終了コード1はstrict回帰ケースの不一致を示し、全要求がHTTP失敗した意味ではない。

追加の読み取り確認で、LARMが応答の`timings`に入力処理・生成・cache数を返していることが分かった（`provider-timing-probe.json`、1要求）。従来の共通readerはこの内訳を捨てていたため、有限・非負の数値5項目だけを抽出して`larm.llm_timing`へ記録する実装を追加した。JSON/SSE両形式で回答を変えずに記録し、文字列・不正値・未知項目・本文・認証情報を保存しない。欠けた値を0として扱わない。

追加後の実接続3要求（`provider-timings/`）で全3回記録を確認した。これは計測機能の確認であり、高速化の比較回数には加えない。

| 合成入力 | 接続確保後の全時間 | Provider入力処理 | Provider生成 | Provider報告cache再利用 |
| --- | ---: | ---: | ---: | ---: |
| standalone | 4,276ms | 985ms | 1,170ms | 0 tokens |
| fragment-1 | 4,148ms | 1,107ms | 1,176ms | 0 tokens |
| fragment-2 | 4,080ms | 1,140ms | 1,268ms | 0 tokens |

Provider報告の入力処理中央値1,107ms、生成1,176msに対して、クライアント区間にはまだ説明されない時間がある。差額をqueue時間とは断定しない。次はLARM側で要求IDに結び付けた **admission/queue待ち・生成前後の処理・通信** を分け、既に記録できるprefill/decode/cacheと照合することを優先する。

その内訳に応じて、(1) 固定system部分のprefix cacheを独立した補助接続間でも安全に再利用できるか、(2) 主回答と短い判定の待ち行列を分離できるか、(3) 入力判定を担う小さいLLMで同じ言語・関係・完了判断を保てるか、の順を選ぶ。接続の共有、confidence閾値引下げ、期限時の自動受理はこの実験では行っていない。別モデルの採用には今回より広い独立評価と機器での受入が必要。

API全経路・実機器の再測定は、採用候補が品質条件を満たさなかったため実施していない。上記数値はASR後の合成入力によるcontrol adapter比較であり、実利用の発話終了→音声再生時間の改善値ではない。

## 検証

- 部分: 比較器の同一入力・schema・閾値試験、共通要求試験など81件成功。最終比較器単体は391 assertions成功。
- ログ追加の部分試験: 共通reader、logger、LARM時間計測、比較器の23試験・498 assertions成功。不正な任意metadataで回答を変えないこと、本文・秘密がログへ出ないことを含む。
- 結合: ログ追加後のLARM domain gate成功（150試験）。音声domain gate成功（backend 71、Web 42）は最終ログ追加後にも再確認中。inference直接試験66件成功（ログ追加前）。
- 型検査: ログ追加後も1,334ファイル成功。変更したTSファイルのformat/lint成功。
- 全体: `verify-all-final.log` はbackend・Web試験を通過後、画面試験6件成功の時点でSIGTERM終了（143）。送信元は不明で成功扱いにしない。ログ追加後の `verify-all-timings.log` はformat成功後、担当外の `api/application/toolchain-history.test.ts:7` の未使用import `offlineBundleHost` によりlint失敗。担当外ファイルは修正していない。したがって全体gateの完走は未確認。
- context_compile / compile_evalはこの続行で各1回、会話全体では各3回。返された一般的な変更前後計測・変更範囲制御・段階検証を使用した。
